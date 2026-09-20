import { Injectable } from '@nestjs/common';
import * as path from 'node:path';
import {
  PlatformImporter,
  ParsedConversation,
  JsonFileEntry,
} from '../../common/interfaces/importer.interface.js';
import { ClaudeParser } from './claude.parser.js';
import { splitJsonArrayFile } from '../utils/streaming-json-splitter.js';

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
      const dir = path.dirname(entryPath);

      for await (const itemJson of splitJsonArrayFile(absolutePath)) {
        const conversation = this.parser.parseOne(itemJson);
        if (!conversation) continue;
        yield { conversation, zipDir: dir, skipAttachmentFiles: true };
      }
    }
  }
}
