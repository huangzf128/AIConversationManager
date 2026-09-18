import { Conversation } from './conversation.interface.js';

export interface JsonFileEntry {
  entryPath: string;
  absolutePath: string;
}

export interface ParsedConversation {
  conversation: Conversation;
  zipDir: string;
  skipAttachmentFiles?: boolean;
}

export interface PlatformImporter {
  shouldExpandZip?(entryPath: string): boolean;
  shouldParseJson?(entryPath: string): boolean;
  parseZipEntries(
    jsonFiles: JsonFileEntry[],
  ): Iterable<ParsedConversation> | AsyncIterable<ParsedConversation>;
}
