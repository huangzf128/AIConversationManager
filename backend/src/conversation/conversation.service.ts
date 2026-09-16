import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import AdmZip from 'adm-zip';
import * as path from 'node:path';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  AiPlatform,
  Conversation,
  ConversationMessage,
} from '../common/interfaces/conversation.interface.js';
import { ConversationParser } from '../common/interfaces/parser.interface.js';
import { ChatgptParser } from './parsers/chatgpt/chatgpt.parser.js';
import { GeminiParser } from './parsers/gemini/gemini.parser.js';
import { ClaudeParser } from './parsers/claude/claude.parser.js';
import { DeepseekParser } from './parsers/deepseek/deepseek.parser.js';
import { AttachmentStorageService } from './attachment-storage.service.js';

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);
  private readonly parsers: Record<AiPlatform, ConversationParser>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly attachmentStorage: AttachmentStorageService,
    chatgptParser: ChatgptParser,
    geminiParser: GeminiParser,
    claudeParser: ClaudeParser,
    deepseekParser: DeepseekParser,
  ) {
    this.parsers = {
      chatgpt: chatgptParser,
      gemini: geminiParser,
      claude: claudeParser,
      deepseek: deepseekParser,
    };
  }

  findAll() {
    return this.prisma.conversation.findMany({
      orderBy: { updatedAt: 'desc' },
      // Sidebar shows a message count per conversation; count() avoids
      // pulling every message's content just to display a number.
      include: { _count: { select: { messages: true } } },
    });
  }

  setHidden(id: string, hidden: boolean) {
    return this.prisma.conversation.update({
      where: { id },
      data: { hidden },
    });
  }

  setStarred(id: string, starred: boolean) {
    return this.prisma.conversation.update({
      where: { id },
      data: { starred },
    });
  }

  setMessageHidden(messageId: string, hidden: boolean) {
    return this.prisma.message.update({
      where: { id: messageId },
      data: { hidden },
    });
  }

  findOne(id: string) {
    return this.prisma.conversation.findUnique({
      where: { id },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          include: { attachments: true },
        },
      },
    });
  }

  async findAttachment(id: string) {
    // Include the parent conversation to get its platform for correct path resolution
    return this.prisma.attachment.findUnique({
      where: { id },
      include: {
        message: { include: { conversation: { select: { platform: true } } } },
      },
    });
  }

  resolveAttachmentPath(storagePath: string, platform: string): string {
    return this.attachmentStorage.resolveAbsolutePath(storagePath, platform);
  }

  /**
   * Parse an uploaded export file for the given platform and persist the
   * resulting conversations. Safe to call repeatedly with a newer export of
   * the same platform: conversations and messages are matched by id and
   * upserted, so nothing is duplicated and manually hidden messages stay
   * hidden.
   */
  async importFromFile(
    platform: AiPlatform,
    rawFileContent: string,
    syncDelete = false,
  ) {
    const parser = this.parsers[platform];
    if (!parser) {
      throw new BadRequestException(`Unsupported platform: ${platform}`);
    }

    const conversations = parser.parse(rawFileContent);
    for (const conversation of conversations) {
      await this.upsertConversation(conversation);
    }

    let deleted = 0;
    if (syncDelete) {
      deleted = await this.syncDeleteMissing(platform, conversations);
    }

    return { imported: conversations.length, deleted };
  }

  /**
   * Import from a platform export delivered as a zip (e.g. Google Takeout
   * or OpenAI export). Every .json entry in the zip (including inside
   * nested zips) is tried against the platform's parser — entries that
   * don't match the expected shape simply yield zero conversations.
   * Nested .zip entries (e.g. Conversations__xxx.zip inside the outer
   * export) are recursively expanded so their JSON and attachment files
   * are processed as if they were at the top level.
   */
  async importFromZip(
    platform: AiPlatform,
    zipBuffer: Buffer,
    syncDelete = false,
  ) {
    const parser = this.parsers[platform];
    if (!parser) {
      throw new BadRequestException(`Unsupported platform: ${platform}`);
    }

    const { allEntries, jsonEntries } = this.flattenZipEntries(zipBuffer);

    const conversations: Conversation[] = [];
    const conversationDirs = new Map<string, string>();

    const libraryFilesByDir = new Map<
      string,
      Map<
        string,
        {
          fileId: string;
          fileName: string;
          messageId: string;
          uploadTime: string;
        }[]
      >
    >();

    for (const { entryPath, data } of jsonEntries) {
      if (platform === 'chatgpt' && entryPath.endsWith('library_files.json')) {
        try {
          const libDir = path.dirname(entryPath);
          const arr = JSON.parse(data.toString('utf-8'));
          if (!Array.isArray(arr)) continue;
          const byThread = new Map<
            string,
            {
              fileId: string;
              fileName: string;
              messageId: string;
              uploadTime: string;
            }[]
          >();
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
          libraryFilesByDir.set(libDir, byThread);
        } catch {
          continue;
        }
        continue;
      }

      let text: string;
      try {
        text = data.toString('utf-8');
      } catch {
        continue;
      }

      let parsed: Conversation[];
      try {
        parsed = parser.parse(text);
      } catch {
        continue;
      }
      if (parsed.length === 0) continue;

      const dir = path.dirname(entryPath);
      for (const conversation of parsed) {
        conversationDirs.set(conversation.id, dir);
      }
      conversations.push(...parsed);
    }

    if (platform === 'chatgpt') {
      this.supplementDalleAttachments(
        conversations,
        conversationDirs,
        libraryFilesByDir,
      );
    }

    const { fuzzyEntryMap, consumed } =
      this.buildFuzzyEntryMapFromEntries(allEntries);

    for (const conversation of conversations) {
      const insertedIds = new Set(await this.upsertConversation(conversation));
      // Nothing was written for this conversation (already up to date),
      // so there are no messages to attach files to.
      if (insertedIds.size === 0) continue;

      const dir = conversationDirs.get(conversation.id) ?? '';

      for (const message of conversation.messages) {
        // Only write attachments for messages that were just inserted.
        if (!insertedIds.has(message.id)) continue;
        if (!message.attachments?.length) continue;

        for (const attachment of message.attachments) {
          if (platform === 'deepseek') {
            try {
              await this.prisma.attachment.upsert({
                where: {
                  messageId_contentHash: {
                    messageId: message.id,
                    contentHash: attachment.storedName,
                  },
                },
                create: {
                  messageId: message.id,
                  displayName: attachment.displayName,
                  storagePath: '',
                  contentHash: attachment.storedName,
                  size: 0,
                },
                update: {},
              });
            } catch (err) {
              this.logger.error(
                `Failed to save deepseek attachment [${attachment.displayName}] for message ${message.id}`,
                err,
              );
            }
            continue;
          }

          const primaryPath =
            dir === '.' || dir === ''
              ? attachment.storedName
              : `${dir}/${attachment.storedName}`;
          let match = this.findEntry(fuzzyEntryMap, consumed, primaryPath);

          // Fallback: match by basename anywhere in the archive, in case
          // the export keeps attachments in a sibling directory.
          if (!match) {
            match = this.findEntryByBasename(
              fuzzyEntryMap,
              consumed,
              attachment.storedName,
            );
          }
          if (!match) {
            this.logger.warn(
              `Attachment not found in zip [Chat ID: ${conversation.id}]: ${primaryPath}`,
            );
            continue;
          }

          try {
            const attachmentData = match.getData();
            const { storagePath, contentHash } =
              await this.attachmentStorage.save(
                attachmentData,
                attachment.displayName,
                conversation.platform,
              );

            await this.prisma.attachment.upsert({
              where: {
                messageId_contentHash: {
                  messageId: message.id,
                  contentHash,
                },
              },
              create: {
                messageId: message.id,
                displayName: attachment.displayName,
                storagePath,
                contentHash,
                size: attachmentData.length,
              },
              update: {},
            });
          } catch (err) {
            this.logger.error(
              `Failed to save attachment [${attachment.displayName}] for message ${message.id} in conversation ${conversation.id}`,
              err,
            );
          }
        }
      }
    }

    let deleted = 0;
    if (syncDelete) {
      deleted = await this.syncDeleteMissing(platform, conversations);
    }

    return { imported: conversations.length, deleted };
  }

  private supplementDalleAttachments(
    conversations: Conversation[],
    conversationDirs: Map<string, string>,
    libraryFilesByDir: Map<
      string,
      Map<
        string,
        {
          fileId: string;
          fileName: string;
          messageId: string;
          uploadTime: string;
        }[]
      >
    >,
  ): void {
    if (libraryFilesByDir.size === 0) return;

    for (const conv of conversations) {
      const dir = conversationDirs.get(conv.id) ?? '';
      const byThread = libraryFilesByDir.get(dir);
      if (!byThread) continue;

      const dalleFiles = byThread.get(conv.id);
      if (!dalleFiles?.length) continue;

      const convAttachmentIds = new Set<string>();
      for (const msg of conv.messages) {
        for (const att of msg.attachments ?? []) {
          convAttachmentIds.add(att.storedName);
        }
      }

      const missing = dalleFiles
        .filter((f) => !convAttachmentIds.has(`${f.fileId}.dat`))
        .sort((a, b) => a.uploadTime.localeCompare(b.uploadTime));
      if (missing.length === 0) continue;

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

        let insertIdx = conv.messages.length;
        for (let i = conv.messages.length - 1; i >= 0; i--) {
          if (conv.messages[i].createdAt <= f.uploadTime) {
            insertIdx = i + 1;
            break;
          }
        }

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
  }

  /**
   * Recursively flatten a zip buffer into two lists,
   *  - allEntries: every non-directory file (including inside nested zips),
   *    with a virtual path that preserves the outer directory structure.
   *  - jsonEntries: the subset whose path ends with .json.
   * Nested .zip entries are expanded in-place: if the outer zip contains
   * "User Online Activity/Conversations__xxx.zip", the inner zip's
   * "conversations-000.json" appears as
   * "User Online Activity/Conversations__xxx.zip/conversations-000.json".
   */
  private flattenZipEntries(
    zipBuffer: Buffer,
    prefix = '',
  ): {
    allEntries: { entryPath: string; getData: () => Buffer }[];
    jsonEntries: { entryPath: string; data: Buffer }[];
  } {
    const allEntries: { entryPath: string; getData: () => Buffer }[] = [];
    const jsonEntries: { entryPath: string; data: Buffer }[] = [];

    const zip = new AdmZip(zipBuffer);

    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;

      const entryPath = prefix
        ? `${prefix}/${entry.entryName}`
        : entry.entryName;
      const lowerName = entry.entryName.toLowerCase();

      if (lowerName.endsWith('.zip')) {
        const data = entry.getData();
        try {
          const inner = this.flattenZipEntries(data, entryPath);
          allEntries.push(...inner.allEntries);
          jsonEntries.push(...inner.jsonEntries);
        } catch {
          allEntries.push({ entryPath, getData: () => data });
        }
      } else if (lowerName.endsWith('.json')) {
        const data = entry.getData();
        allEntries.push({ entryPath, getData: () => data });
        jsonEntries.push({ entryPath, data });
      } else {
        const ref = entry;
        allEntries.push({ entryPath, getData: () => ref.getData() });
      }
    }

    return { allEntries, jsonEntries };
  }

  /**
   * Delete conversations in the DB for the given platform that are not
   * present in the uploaded export. Starred conversations are always kept.
   * Returns the number of conversations deleted.
   */
  private async syncDeleteMissing(
    platform: AiPlatform,
    imported: Conversation[],
  ) {
    const importedIds = new Set(imported.map((c) => c.id));

    const dbIds = await this.prisma.conversation.findMany({
      where: { platform, starred: false },
      select: { id: true },
    });

    const toDeleteIds = dbIds
      .map((c) => c.id)
      .filter((id) => !importedIds.has(id));
    if (toDeleteIds.length === 0) return 0;

    const BATCH_SIZE = 900;
    let deleted = 0;

    for (let offset = 0; offset < toDeleteIds.length; offset += BATCH_SIZE) {
      const batch = toDeleteIds.slice(offset, offset + BATCH_SIZE);

      const conversations = await this.prisma.conversation.findMany({
        where: { id: { in: batch } },
        select: {
          id: true,
          messages: {
            select: {
              attachments: {
                select: { storagePath: true },
              },
            },
          },
        },
      });

      for (const conversation of conversations) {
        for (const message of conversation.messages) {
          for (const attachment of message.attachments) {
            await this.attachmentStorage.delete(
              attachment.storagePath,
              platform,
            );
          }
        }
        await this.prisma.conversation.delete({
          where: { id: conversation.id },
        });
        deleted++;
      }
    }

    this.logger.log(
      `Sync-deleted ${deleted} conversation(s) for platform "${platform}"`,
    );
    return deleted;
  }

  private static readonly DUP_SUFFIX = /\(\d+\)$/;

  /**
   * Strip extension and "(N)" duplicate suffix to produce a fuzzy key.
   * e.g. "dir/Folder-abc.md"  → "dir/Folder-abc"
   *      "dir/Folder-abc(1)"  → "dir/Folder-abc"
   */
  private toFuzzyPrefix(entryPath: string): string {
    const dir = path.dirname(entryPath);
    let base = path.basename(entryPath, path.extname(entryPath));
    base = base.replace(ConversationService.DUP_SUFFIX, '');
    return dir === '.' ? base : `${dir}/${base}`;
  }

  /**
   * Strip only "(N)" duplicate suffix, keeping the rest of the filename
   * (including any dots) intact. This handles files like
   * "2.GT723601-abc" where path.extname would incorrectly treat
   * ".GT723601-abc" as the extension.
   * e.g. "dir/2.GT723601-abc"  → "dir/2.GT723601-abc"
   *      "dir/2.GT723601-abc(1)" → "dir/2.GT723601-abc"
   */
  private toFullPrefix(entryPath: string): string {
    const dir = path.dirname(entryPath);
    const base = path
      .basename(entryPath)
      .replace(ConversationService.DUP_SUFFIX, '');
    return dir === '.' ? base : `${dir}/${base}`;
  }

  private hasDupSuffix(entryPath: string): boolean {
    const base = path.basename(entryPath, path.extname(entryPath));
    return ConversationService.DUP_SUFFIX.test(base);
  }

  /**
   * Build a map from fuzzy-prefix → list of zip entries for one-to-one
   * assignment. Each zip entry is registered under TWO keys:
   *  - toFuzzyPrefix: strips extension + (N)  → handles different extensions
   *  - toFullPrefix:  strips only (N)          → handles files with dots in name
   * A consumed Set tracks which entries have already been assigned.
   */
  private buildFuzzyEntryMap(zip: AdmZip): {
    fuzzyEntryMap: Map<string, AdmZip.IZipEntry[]>;
    consumed: Set<AdmZip.IZipEntry>;
  } {
    const map = new Map<string, AdmZip.IZipEntry[]>();
    const consumed = new Set<AdmZip.IZipEntry>();

    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;

      const fuzzyKey = this.toFuzzyPrefix(entry.entryName);
      const fullKey = this.toFullPrefix(entry.entryName);

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
        const aHas = this.hasDupSuffix(a.entryName);
        const bHas = this.hasDupSuffix(b.entryName);
        if (aHas !== bHas) return aHas ? 1 : -1;
        const aBase = path.basename(a.entryName, path.extname(a.entryName));
        const bBase = path.basename(b.entryName, path.extname(b.entryName));
        const aM = aBase.match(dupNum);
        const bM = bBase.match(dupNum);
        return (aM ? parseInt(aM[1], 10) : 0) - (bM ? parseInt(bM[1], 10) : 0);
      });
    }

    return { fuzzyEntryMap: map, consumed };
  }

  /**
   * Find a zip entry for the given path using tiered matching:
   *  1. Exact match (same full path including extension, case-sensitive)
   *  2. Same dir+basename ignoring extension, no "(N)" suffix
   *  3. Same dir+basename after stripping "(N)" and extension
   * Found entries are added to the consumed Set so they are never
   * assigned to another attachment, even when the same entry appears
   * under multiple map keys.
   */
  private findZipEntry(
    fuzzyEntryMap: Map<string, AdmZip.IZipEntry[]>,
    consumed: Set<AdmZip.IZipEntry>,
    entryPath: string,
  ): AdmZip.IZipEntry | null {
    const prefix = this.toFuzzyPrefix(entryPath);
    const candidates = fuzzyEntryMap.get(prefix);
    if (!candidates) return null;

    let idx = candidates.findIndex(
      (e) => !consumed.has(e) && e.entryName === entryPath,
    );
    if (idx !== -1) {
      const entry = candidates[idx];
      consumed.add(entry);
      return entry;
    }

    idx = candidates.findIndex(
      (e) => !consumed.has(e) && !this.hasDupSuffix(e.entryName),
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

  /**
   * Fallback lookup: ignore directories and match by basename (with or
   * without extension) anywhere in the archive. Used when an attachment is
   * not stored next to the json that references it.
   */
  private findEntryByBasename(
    fuzzyEntryMap: Map<string, { entryPath: string; getData: () => Buffer }[]>,
    consumed: Set<{ entryPath: string; getData: () => Buffer }>,
    storedName: string,
  ): { entryPath: string; getData: () => Buffer } | null {
    const targetBase = path.basename(storedName).toLowerCase();
    const targetNoExt = targetBase.replace(/\.[^.]+$/, '');

    for (const list of fuzzyEntryMap.values()) {
      for (const entry of list) {
        if (consumed.has(entry)) continue;
        const base = path.basename(entry.entryPath).toLowerCase();
        if (
          base === targetBase ||
          base.replace(/\.[^.]+$/, '') === targetNoExt
        ) {
          consumed.add(entry);
          return entry;
        }
      }
    }
    return null;
  }

  private buildFuzzyEntryMapFromEntries(
    entries: { entryPath: string; getData: () => Buffer }[],
  ): {
    fuzzyEntryMap: Map<string, { entryPath: string; getData: () => Buffer }[]>;
    consumed: Set<{ entryPath: string; getData: () => Buffer }>;
  } {
    const map = new Map<
      string,
      { entryPath: string; getData: () => Buffer }[]
    >();
    const consumed = new Set<{ entryPath: string; getData: () => Buffer }>();

    for (const entry of entries) {
      const fuzzyKey = this.toFuzzyPrefix(entry.entryPath);
      const fullKey = this.toFullPrefix(entry.entryPath);

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
        const aHas = this.hasDupSuffix(a.entryPath);
        const bHas = this.hasDupSuffix(b.entryPath);
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

  private findEntry(
    fuzzyEntryMap: Map<string, { entryPath: string; getData: () => Buffer }[]>,
    consumed: Set<{ entryPath: string; getData: () => Buffer }>,
    entryPath: string,
  ): { entryPath: string; getData: () => Buffer } | null {
    const prefix = this.toFuzzyPrefix(entryPath);
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
      (e) => !consumed.has(e) && !this.hasDupSuffix(e.entryPath),
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

  /**
   * Incrementally merge a parsed conversation into the DB.
   *
   * Conversation.updatedAt acts as a watermark: messages with createdAt
   * <= the stored updatedAt are already imported and are skipped; only
   * newer messages get appended. Duplicate ids inside a single nested
   * create are dropped, since SQLite silently loses one row in that case
   * and the missing row would break attachment foreign keys.
   *
   * Returns the ids of messages actually written in this call. Callers
   * must only attach files to these messages: their parent rows are
   * guaranteed to exist, so attachment foreign keys can't fail.
   */
  private async upsertConversation(
    conversation: Conversation,
  ): Promise<string[]> {
    const existing = await this.prisma.conversation.findUnique({
      where: { id: conversation.id },
      select: { updatedAt: true },
    });
    const jsonUpdatedAt = new Date(conversation.updatedAt).getTime();

    // Deduplicate by id: a repeated id inside a single nested create makes
    // SQLite silently drop one row, which then breaks attachment FKs.
    const seen = new Set<string>();
    const uniqueMessages = conversation.messages.filter((m) => {
      if (seen.has(m.id)) {
        this.logger.warn(
          `Dropping duplicate message id ${m.id} in conversation ${conversation.id}`,
        );
        return false;
      }
      seen.add(m.id);
      return true;
    });

    // Already up to date: nothing written, so no attachments should be added.
    if (existing && existing.updatedAt.getTime() >= jsonUpdatedAt) {
      return [];
    }

    if (!existing) {
      await this.prisma.conversation.create({
        data: {
          id: conversation.id,
          platform: conversation.platform,
          title: conversation.title,
          createdAt: new Date(conversation.createdAt),
          updatedAt: new Date(conversation.updatedAt),
          messages: {
            create: uniqueMessages.map((message) => ({
              id: message.id,
              role: message.role,
              content: message.content,
              createdAt: new Date(message.createdAt),
              hidden: false,
            })),
          },
        },
      });
      return uniqueMessages.map((m) => m.id);
    }

    await this.prisma.message.deleteMany({
      where: { conversationId: conversation.id },
    });
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        title: conversation.title,
        updatedAt: new Date(conversation.updatedAt),
        messages: {
          create: uniqueMessages.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            createdAt: new Date(message.createdAt),
            hidden: false,
          })),
        },
      },
    });
    return uniqueMessages.map((m) => m.id);
  }
}
