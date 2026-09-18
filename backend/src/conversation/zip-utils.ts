import AdmZip from 'adm-zip';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

export interface ExtractedEntry {
  entryPath: string;
  absolutePath: string;
}

export interface ExtractedZip {
  tempDir: string;
  allFiles: ExtractedEntry[];
  jsonFiles: ExtractedEntry[];
}

export function extractZipToTempDir(
  zipBuffer: Buffer,
  filters?: {
    shouldExpandZip?: (entryPath: string) => boolean;
    shouldParseJson?: (entryPath: string) => boolean;
  },
): ExtractedZip {
  const tempDir = path.join(os.tmpdir(), `aicm-${crypto.randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const zip = new AdmZip(zipBuffer);
  zip.extractAllTo(tempDir, true);

  expandNestedZips(tempDir, '', filters?.shouldExpandZip);

  const allFiles: ExtractedEntry[] = [];
  const jsonFiles: ExtractedEntry[] = [];
  collectFiles(tempDir, '', allFiles, jsonFiles, filters?.shouldParseJson);

  return { tempDir, allFiles, jsonFiles };
}

function expandNestedZips(
  dir: string,
  prefix: string,
  shouldExpandZip?: (entryPath: string) => boolean,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      expandNestedZips(fullPath, entryPath, shouldExpandZip);
      continue;
    }

    if (entry.name.toLowerCase().endsWith('.zip')) {
      if (shouldExpandZip && !shouldExpandZip(entryPath)) {
        continue;
      }
      try {
        const zipBuffer = fs.readFileSync(fullPath);
        fs.unlinkSync(fullPath);
        fs.mkdirSync(fullPath, { recursive: true });
        const innerZip = new AdmZip(zipBuffer);
        innerZip.extractAllTo(fullPath, true);
        expandNestedZips(fullPath, entryPath, shouldExpandZip);
      } catch {
        // If extraction fails, the .zip file was already deleted;
        // nothing more to do.
      }
    }
  }
}

function collectFiles(
  dir: string,
  prefix: string,
  allFiles: ExtractedEntry[],
  jsonFiles: ExtractedEntry[],
  shouldParseJson?: (entryPath: string) => boolean,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      collectFiles(fullPath, entryPath, allFiles, jsonFiles, shouldParseJson);
      continue;
    }

    allFiles.push({ entryPath, absolutePath: fullPath });
    if (entry.name.toLowerCase().endsWith('.json')) {
      if (shouldParseJson && !shouldParseJson(entryPath)) {
        continue;
      }
      jsonFiles.push({ entryPath, absolutePath: fullPath });
    }
  }
}

const DUP_SUFFIX = /\(\d+\)$/;

export function toFuzzyPrefix(entryPath: string): string {
  const dir = path.dirname(entryPath);
  let base = path.basename(entryPath, path.extname(entryPath));
  base = base.replace(DUP_SUFFIX, '');
  return dir === '.' ? base : `${dir}/${base}`;
}

export function toFullPrefix(entryPath: string): string {
  const dir = path.dirname(entryPath);
  const base = path.basename(entryPath).replace(DUP_SUFFIX, '');
  return dir === '.' ? base : `${dir}/${base}`;
}

export function hasDupSuffix(entryPath: string): boolean {
  const base = path.basename(entryPath, path.extname(entryPath));
  return DUP_SUFFIX.test(base);
}

export interface FuzzyFileMap {
  fuzzyEntryMap: Map<string, ExtractedEntry[]>;
  consumed: Set<ExtractedEntry>;
}

export function buildFuzzyFileMap(files: ExtractedEntry[]): FuzzyFileMap {
  const map = new Map<string, ExtractedEntry[]>();
  const consumed = new Set<ExtractedEntry>();

  for (const entry of files) {
    const fuzzyKey = toFuzzyPrefix(entry.entryPath);
    const fullKey = toFullPrefix(entry.entryPath);

    const fuzzyList = map.get(fuzzyKey) ?? [];
    fuzzyList.push(entry);
    map.set(fuzzyKey, fuzzyList);

    if (fullKey !== fuzzyKey) {
      const fullList = map.get(fullKey) ?? [];
      fullList.push(entry);
      map.set(fullKey, fullList);
    }
  }

  const dupNum = /\((\d+)\)$/;
  for (const list of map.values()) {
    list.sort((a, b) => {
      const aHas = hasDupSuffix(a.entryPath);
      const bHas = hasDupSuffix(b.entryPath);
      if (aHas !== bHas) return aHas ? 1 : -1;
      const aBase = path.basename(a.entryPath, path.extname(a.entryPath));
      const bBase = path.basename(b.entryPath, path.extname(b.entryPath));
      const aM = aBase.match(dupNum);
      const bM = bBase.match(dupNum);
      return (aM ? parseInt(aM[1], 10) : 0) - (bM ? parseInt(bM[1], 10) : 0);
    });
  }

  return { fuzzyEntryMap: map, consumed };
}

export function findFile(
  fuzzyEntryMap: Map<string, ExtractedEntry[]>,
  consumed: Set<ExtractedEntry>,
  entryPath: string,
): ExtractedEntry | null {
  const prefix = toFuzzyPrefix(entryPath);
  const candidates = fuzzyEntryMap.get(prefix);
  if (!candidates) return null;

  let idx = candidates.findIndex(
    (e) => !consumed.has(e) && e.entryPath === entryPath,
  );
  if (idx !== -1) {
    const entry = candidates[idx];
    consumed.add(entry);
    return entry;
  }

  idx = candidates.findIndex(
    (e) => !consumed.has(e) && !hasDupSuffix(e.entryPath),
  );
  if (idx !== -1) {
    const entry = candidates[idx];
    consumed.add(entry);
    return entry;
  }

  const fallback = candidates.find((e) => !consumed.has(e));
  if (fallback) {
    consumed.add(fallback);
    return fallback;
  }

  return null;
}

export function findFileByBasename(
  fuzzyEntryMap: Map<string, ExtractedEntry[]>,
  consumed: Set<ExtractedEntry>,
  storedName: string,
): ExtractedEntry | null {
  const targetBase = path.basename(storedName).toLowerCase();
  const targetNoExt = targetBase.replace(/\.[^.]+$/, '');

  for (const list of fuzzyEntryMap.values()) {
    for (const entry of list) {
      if (consumed.has(entry)) continue;
      const base = path.basename(entry.entryPath).toLowerCase();
      if (base === targetBase || base.replace(/\.[^.]+$/, '') === targetNoExt) {
        consumed.add(entry);
        return entry;
      }
    }
  }
  return null;
}
