import { Injectable } from '@nestjs/common';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  PlatformImporter,
  ParsedConversation,
  JsonFileEntry,
} from '../../common/interfaces/importer.interface.js';
import { ClaudeParser } from './claude.parser.js';

@Injectable()
export class ClaudeImporter implements PlatformImporter {
  shouldExpandZip(_entryPath: string): boolean {
    return true;
  }

  shouldParseJson(_entryPath: string): boolean {
    return true;
  }

  constructor(private readonly parser: ClaudeParser) {}

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
