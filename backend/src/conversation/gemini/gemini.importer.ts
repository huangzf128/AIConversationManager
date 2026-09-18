import { Injectable } from '@nestjs/common';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  PlatformImporter,
  ParsedConversation,
  JsonFileEntry,
} from '../../common/interfaces/importer.interface.js';
import { GeminiParser } from './gemini.parser.js';

@Injectable()
export class GeminiImporter implements PlatformImporter {
  shouldExpandZip(entryPath: string): boolean {
    const segments = entryPath.toLowerCase().split(/[/\\]/);
    return segments.some((s) => s.includes('gemini') || s.includes('bard'));
  }

  shouldParseJson(entryPath: string): boolean {
    const segments = entryPath.toLowerCase().split(/[/\\]/);
    return segments.some((s) => s.includes('gemini') || s.includes('bard'));
  }

  constructor(private readonly parser: GeminiParser) {}

  async *parseZipEntries(
    jsonFiles: JsonFileEntry[],
  ): AsyncGenerator<ParsedConversation> {
    for (const { entryPath, absolutePath } of jsonFiles) {
      let text: string;
      try {
        text = fs.readFileSync(absolutePath, 'utf-8');
      } catch {
        continue;
      }

      let parsed;
      try {
        parsed = this.parser.parse(text);
      } catch {
        continue;
      }
      if (parsed.length === 0) continue;

      const dir = path.dirname(entryPath);
      for (const conversation of parsed) {
        yield { conversation, zipDir: dir };
      }
    }
  }
}
