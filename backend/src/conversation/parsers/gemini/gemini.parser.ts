import { Injectable } from '@nestjs/common';
import { ConversationParser } from '../../../common/interfaces/parser.interface.js';
import {
  Conversation,
  ConversationMessage,
  ConversationAttachment,
} from '../../../common/interfaces/conversation.interface.js';

/**
 * Raw shape of a single activity record inside a Google Takeout
 * "Gemini Apps" export (the JSON found under MyActivity/Gemini Apps).
 */
interface TakeoutDetail {
  name?: string;
  url?: string;
}

interface TakeoutSafeHtmlItem {
  html?: string;
}

// Some subtitle entries describe an attachment: { name: '-  original.sql',
// url: 'original-<hash>.sql' }. `url` here matches an entry in
// `attachedFiles` and is the filename actually stored in the export;
// `name` carries the original filename, locale-independent (just a
// leading bullet character before the name).
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
}

// Matches the chat id in a Gemini share URL, e.g.
// https://gemini.google.com/app/9d0b8ac907c407f0 -> 9d0b8ac907c407f0
const CHAT_ID_PATTERN = /\/app\/([0-9a-fA-F]+)/;

// "Message sent" titles are prefixed with a locale-specific label followed
// by a colon, e.g. "送信したメッセージ: <actual prompt>". We only care about
// whatever comes after the first colon, so this works across locales
// without hardcoding the label text itself.
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

    // Group records by chat_id. Records with no extractable chat_id are
    // non-conversation noise (e.g. "previous feedback cleared" entries,
    // which never carry a details[].url) and are dropped here — this is
    // locale-independent, unlike matching on the noise entry's title text.
    const grouped = new Map<string, TakeoutRecord[]>();
    for (const record of records) {
      const chatId = this.extractChatId(record);
      if (!chatId) continue;

      const bucket = grouped.get(chatId) ?? [];
      bucket.push(record);
      grouped.set(chatId, bucket);
    }

    const conversations: Conversation[] = [];
    for (const [chatId, bucket] of grouped) {
      // Takeout entries come back newest-first; conversations should read
      // chronologically (oldest message first).
      bucket.sort(
        (a, b) => new Date(a.time ?? 0).getTime() - new Date(b.time ?? 0).getTime(),
      );

      const messages: ConversationMessage[] = [];
      for (const record of bucket) {
        messages.push(...this.toMessages(record, chatId));
      }
      if (messages.length === 0) continue;

      conversations.push({
        id: chatId,
        platform: 'gemini',
        title: this.deriveTitle(bucket),
        createdAt: bucket[0].time ?? new Date().toISOString(),
        updatedAt: bucket[bucket.length - 1].time ?? new Date().toISOString(),
        messages,
      });
    }

    return conversations;
  }

  private extractChatId(record: TakeoutRecord): string | null {
    for (const detail of record.details ?? []) {
      const match = detail.url?.match(CHAT_ID_PATTERN);
      if (match) return match[1];
    }
    return null;
  }

  /**
   * Each Takeout record represents one turn: the user's prompt (encoded
   * in `title`) and, when present, Gemini's reply (encoded as raw HTML
   * in `safeHtmlItem`). Split that into up to two ConversationMessage
   * entries, in user-then-assistant order.
   */
  private toMessages(record: TakeoutRecord, chatId: string): ConversationMessage[] {
    const time = record.time ?? new Date().toISOString();
    const messages: ConversationMessage[] = [];

    const userText = this.extractUserText(record.title);
    if (userText) {
      messages.push({
        id: `${chatId}-${time}-user`,
        role: 'user',
        content: userText,
        createdAt: time,
        attachments: this.extractAttachments(record),
      });
    }

    // NOTE: this HTML is rendered as-is for now. If it needs to be shown
    // as plain text or sanitized before persisting, that conversion should
    // happen here (or in ConversationService before saving to Prisma).
    const replyHtml = record.safeHtmlItem?.[0]?.html;
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

  // `attachedFiles` gives the filenames actually stored in the export
  // (relative to the same folder as the JSON file). `subtitles` maps
  // each of those back to the original filename the user uploaded.
  private extractAttachments(record: TakeoutRecord): ConversationAttachment[] | undefined {
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

  private deriveTitle(bucket: TakeoutRecord[]): string {
    const firstUserText = this.extractUserText(bucket[0]?.title);
    return firstUserText ? firstUserText.slice(0, 60) : 'Gemini conversation';
  }
}