import { Injectable } from '@nestjs/common';
import * as path from 'node:path';
import {
  PlatformImporter,
  ParsedConversation,
  JsonFileEntry,
} from '../../common/interfaces/importer.interface.js';
import { DeepseekParser } from './deepseek.parser.js';

@Injectable()
export class DeepseekImporter implements PlatformImporter {
  shouldExpandZip(_entryPath: string): boolean {
    return true;
  }

  shouldParseJson(entryPath: string): boolean {
    return path.basename(entryPath) === 'conversations.json';
  }

  constructor(private readonly parser: DeepseekParser) {}

  async *parseZipEntries(
    jsonFiles: JsonFileEntry[],
  ): AsyncGenerator<ParsedConversation> {
    for (const { absolutePath } of jsonFiles) {
      for await (const conversation of this.parser.parseReadStream(
        absolutePath,
      )) {
        yield { conversation, zipDir: '', skipAttachmentFiles: true };
      }
    }
  }
}
