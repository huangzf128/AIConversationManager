import { Injectable } from '@nestjs/common';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  PlatformImporter,
  ParsedConversation,
  JsonFileEntry,
} from '../../common/interfaces/importer.interface.js';
import {
  Conversation,
  ConversationMessage,
} from '../../common/interfaces/conversation.interface.js';
import { ChatgptParser } from './chatgpt.parser.js';
import { splitJsonArrayFile } from '../utils/streaming-json-splitter.js';

interface LibraryFileEntry {
  fileId: string;
  fileName: string;
  messageId: string;
  uploadTime: string;
}

@Injectable()
export class ChatgptImporter implements PlatformImporter {
  shouldExpandZip(entryPath: string): boolean {
    const name = path.basename(entryPath);
    return name.startsWith('Conversations');
  }

  shouldParseJson(entryPath: string): boolean {
    const name = path.basename(entryPath);
    return name.startsWith('conversations') || name === 'library_files.json';
  }

  constructor(private readonly parser: ChatgptParser) {}

  async *parseZipEntries(
    jsonFiles: JsonFileEntry[],
  ): AsyncGenerator<ParsedConversation> {
    const libraryFilesByDir = this.collectLibraryFiles(jsonFiles);

    for (const { entryPath, absolutePath } of jsonFiles) {
      if (entryPath.endsWith('library_files.json')) continue;

      const dir = path.dirname(entryPath);
      const byThread = libraryFilesByDir.get(dir);

      for await (const itemJson of splitJsonArrayFile(absolutePath)) {
        const conversation = this.parser.parseOneUnordered(itemJson);
        if (!conversation) continue;

        if (byThread) {
          const parentLookup = this.parser.buildMessageParentLookup(itemJson);
          this.supplementDalleAttachments(conversation, byThread, parentLookup);
        }

        this.parser.ensureChronologicalOrder(conversation.messages);
        conversation.updatedAt =
          conversation.messages[conversation.messages.length - 1].createdAt;
        yield { conversation, zipDir: dir };
      }
    }
  }

  private collectLibraryFiles(
    jsonFiles: JsonFileEntry[],
  ): Map<string, Map<string, LibraryFileEntry[]>> {
    const result = new Map<string, Map<string, LibraryFileEntry[]>>();

    for (const { entryPath, absolutePath } of jsonFiles) {
      if (!entryPath.endsWith('library_files.json')) continue;

      try {
        const libDir = path.dirname(entryPath);
        const arr = JSON.parse(fs.readFileSync(absolutePath, 'utf-8'));
        if (!Array.isArray(arr)) continue;

        const byThread = new Map<string, LibraryFileEntry[]>();
        for (const item of arr) {
          if (!item.origination_thread_id || !item.file_id) continue;
          if (!item.image_gen_generation_id) continue;
          const list = byThread.get(item.origination_thread_id) ?? [];
          const uploadTime = item.file_upload_time
            ? new Date(item.file_upload_time).toISOString()
            : new Date(0).toISOString();
          list.push({
            fileId: item.file_id,
            fileName: item.file_name ?? item.file_id,
            messageId: item.origination_message_id ?? '',
            uploadTime,
          });
          byThread.set(item.origination_thread_id, list);
        }
        result.set(libDir, byThread);
      } catch {
        continue;
      }
    }

    return result;
  }

  private supplementDalleAttachments(
    conv: Conversation,
    byThread: Map<string, LibraryFileEntry[]>,
    parentLookup: Map<string, string>,
  ): void {
    const dalleFiles = byThread.get(conv.id);
    if (!dalleFiles?.length) return;

    const convAttachmentIds = new Set<string>();
    for (const msg of conv.messages) {
      for (const att of msg.attachments ?? []) {
        convAttachmentIds.add(att.storedName);
      }
    }

    const missing = dalleFiles
      .filter((f) => !convAttachmentIds.has(`${f.fileId}.dat`))
      .sort((a, b) => a.uploadTime.localeCompare(b.uploadTime));
    if (missing.length === 0) return;

    const insertions: { index: number; msg: ConversationMessage }[] = [];

    for (const f of missing) {
      const storedName = `${f.fileId}.dat`;
      convAttachmentIds.add(storedName);

      const compoundId = f.messageId ? `${conv.id}-${f.messageId}` : '';
      const existingMsg = compoundId
        ? conv.messages.find((m) => m.id === compoundId)
        : undefined;

      if (existingMsg) {
        if (!existingMsg.attachments) existingMsg.attachments = [];
        existingMsg.attachments.push({ storedName, displayName: f.fileName });
        if (!existingMsg.content.trim()) {
          existingMsg.content = '[图片]';
        }
        continue;
      }

      let insertIdx = this.findDalleInsertIndex(conv, f, parentLookup);

      const dalleMsg: ConversationMessage = {
        id: `${conv.id}-dalle-${f.fileId}`,
        role: 'assistant',
        content: '[图片]',
        createdAt: f.uploadTime,
        attachments: [{ storedName, displayName: f.fileName }],
      };

      insertions.push({ index: insertIdx, msg: dalleMsg });
    }

    insertions.sort((a, b) => b.index - a.index);
    for (const { index, msg } of insertions) {
      const clamped = Math.min(index, conv.messages.length);
      conv.messages.splice(clamped, 0, msg);
    }
  }

  private findDalleInsertIndex(
    conv: Conversation,
    file: LibraryFileEntry,
    parentLookup: Map<string, string>,
  ): number {
    if (file.messageId) {
      const parentMsgId = parentLookup.get(file.messageId);
      if (parentMsgId) {
        const parentCompoundId = `${conv.id}-${parentMsgId}`;
        const parentIdx = conv.messages.findIndex(
          (m) => m.id === parentCompoundId,
        );
        if (parentIdx !== -1) {
          return parentIdx + 1;
        }
      }
    }

    let insertIdx = conv.messages.length;
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      if (conv.messages[i].createdAt <= file.uploadTime) {
        insertIdx = i + 1;
        break;
      }
    }
    return insertIdx;
  }
}
