import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

// Attachments extracted from imports are written here, named by content
// hash. This dedupes identical files (e.g. the same attachment appearing
// across re-imports) and keeps the DB free of large binary blobs.
const STORAGE_ROOT = path.resolve(process.cwd(), 'storage', 'files');

@Injectable()
export class AttachmentStorageService {
  async save(
    buffer: Buffer,
    displayName: string,
    platform: string,
  ): Promise<{ storagePath: string; contentHash: string }> {
    const contentHash = createHash('sha256').update(buffer).digest('hex');
    const ext = path.extname(displayName);
    // Store ONLY the filename in database, directory structure is handled by backend
    const filename = `${contentHash}${ext}`;
    const platformDir = platform.toLowerCase();
    const absolutePath = path.join(STORAGE_ROOT, platformDir, filename);

    // Create the full directory path including platform subdirectory
    await fs.mkdir(path.join(STORAGE_ROOT, platformDir), { recursive: true });
    try {
      await fs.access(absolutePath);
    } catch {
      await fs.writeFile(absolutePath, buffer);
    }

    // Database only stores the raw filename, not the full path - directory logic is backend responsibility
    return { storagePath: filename, contentHash };
  }

  resolveAbsolutePath(storagePath: string, platform: string = 'gemini'): string {
    // Always use the platform to build the full path, keeps database lean and path logic centralized
    const platformDir = platform.toLowerCase();
    return path.join(STORAGE_ROOT, platformDir, storagePath);
  }
}