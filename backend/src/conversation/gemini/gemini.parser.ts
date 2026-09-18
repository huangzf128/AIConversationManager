import { Injectable } from '@nestjs/common';
import { ConversationParser } from '../../common/interfaces/parser.interface.js';
import {
  Conversation,
  ConversationMessage,
  ConversationAttachment,
} from '../../common/interfaces/conversation.interface.js';

interface TakeoutDetail {
  name?: string;
  url?: string;
}

interface TakeoutSafeHtmlItem {
  html?: string;
}

interface TakeoutSubtitle {
  name?: string;
  url?: string;
}

interface TakeoutRecord {
  header?: string;
  title?: string;
  time?: string;
  details?: TakeoutDetail[];
  safeHtmlItem?: TakeoutSafeHtmlItem[];
  subtitles?: TakeoutSubtitle[];
  attachedFiles?: string[];
  imageFile?: string;
}

const CHAT_ID_PATTERN = /\/app\/([0-9a-fA-F]+)/;
const SENT_MESSAGE_PATTERN = /^[^:：]+[:：]\s*(.*)$/s;

@Injectable()
export class GeminiParser implements ConversationParser {
  parse(rawFileContent: string): Conversation[] {
    let records: TakeoutRecord[];
    try {
      records = JSON.parse(rawFileContent) as TakeoutRecord[];
    } catch {
      console.log('GeminiParser: failed to parse Takeout JSON');
      return [];
    }

    interface IndexedRecord {
      record: TakeoutRecord;
      detailIndex: number;
    }

    const grouped = new Map<string, IndexedRecord[]>();
    for (const record of records) {
      const chatIds = this.extractChatIds(record);
      if (chatIds.length === 0) continue;

      for (let i = 0; i < chatIds.length; i++) {
        const bucket = grouped.get(chatIds[i]) ?? [];
        bucket.push({ record, detailIndex: i });
        grouped.set(chatIds[i], bucket);
      }
    }

    const conversations: Conversation[] = [];
    for (const [chatId, bucket] of grouped) {
      bucket.sort(
        (a, b) =>
          new Date(a.record.time ?? 0).getTime() -
          new Date(b.record.time ?? 0).getTime(),
      );

      const messages: ConversationMessage[] = [];
      for (const { record, detailIndex } of bucket) {
        messages.push(...this.toMessages(record, chatId, detailIndex));
      }
      if (messages.length === 0) continue;

      conversations.push({
        id: chatId,
        platform: 'gemini',
        title: this.deriveTitle(bucket[0].record),
        createdAt: bucket[0].record.time ?? new Date().toISOString(),
        updatedAt:
          bucket[bucket.length - 1].record.time ?? new Date().toISOString(),
        messages,
      });
    }

    return conversations;
  }

  private extractChatIds(record: TakeoutRecord): string[] {
    const ids: string[] = [];
    for (const detail of record.details ?? []) {
      const match = detail.url?.match(CHAT_ID_PATTERN);
      if (match) ids.push(match[1]);
    }
    return ids;
  }

  private toMessages(
    record: TakeoutRecord,
    chatId: string,
    detailIndex: number,
  ): ConversationMessage[] {
    const time = record.time ?? new Date().toISOString();
    const messages: ConversationMessage[] = [];

    const userText = this.extractUserText(record.title);
    const attachments = this.extractAttachments(record);
    if (userText || attachments?.length) {
      messages.push({
        id: `${chatId}-${time}-user`,
        role: 'user',
        content: userText || '[画像]',
        createdAt: time,
        attachments,
      });
    }

    const replyHtml = record.safeHtmlItem?.[detailIndex]?.html;
    if (replyHtml) {
      messages.push({
        id: `${chatId}-${time}-assistant`,
        role: 'assistant',
        content: replyHtml,
        createdAt: time,
      });
    }

    return messages;
  }

  private extractAttachments(
    record: TakeoutRecord,
  ): ConversationAttachment[] | undefined {
    const storedNames = record.attachedFiles ?? [];
    if (storedNames.length === 0) return undefined;

    return storedNames.map((storedName) => {
      const subtitle = record.subtitles?.find((s) => s.url === storedName);
      const displayName = subtitle?.name
        ? subtitle.name.replace(/^[-\s]+/, '')
        : storedName;
      return { storedName, displayName };
    });
  }

  private extractUserText(title?: string): string | null {
    if (!title) return null;
    const match = title.match(SENT_MESSAGE_PATTERN);
    return match ? match[1].trim() : title.trim();
  }

  private deriveTitle(firstRecord: TakeoutRecord): string {
    const firstUserText = this.extractUserText(firstRecord?.title);
    return firstUserText ? firstUserText.slice(0, 60) : 'Gemini conversation';
  }
}
