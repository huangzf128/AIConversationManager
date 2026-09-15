import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import AdmZip from 'adm-zip';
import * as path from 'node:path';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiPlatform, Conversation } from '../common/interfaces/conversation.interface.js';
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
          include: { attachments: true }
        } 
      },
    });
  }

  async findAttachment(id: string) {
    // Include the parent conversation to get its platform for correct path resolution
    return this.prisma.attachment.findUnique({ 
      where: { id },
      include: { message: { include: { conversation: { select: { platform: true } } } } }
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
  async importFromFile(platform: AiPlatform, rawFileContent: string) {
    const parser = this.parsers[platform];
    if (!parser) {
      throw new BadRequestException(`Unsupported platform: ${platform}`);
    }

    const conversations = parser.parse(rawFileContent);
    for (const conversation of conversations) {
      await this.upsertConversation(conversation);
    }

    return { imported: conversations.length };
  }

  /**
   * Import from a platform export delivered as a zip (e.g. Google Takeout).
   * Every .json entry in the zip is tried against the platform's parser —
   * entries that don't match the expected shape simply yield zero
   * conversations. This avoids relying on the (often localized) folder
   * names inside the export to find the right file.
   */
  async importFromZip(platform: AiPlatform, zipBuffer: Buffer) {
    const parser = this.parsers[platform];
    if (!parser) {
      throw new BadRequestException(`Unsupported platform: ${platform}`);
    }

    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();

    const conversations: Conversation[] = [];
    // Directory (inside the zip) that each conversation's JSON came from,
    // used to resolve attachment filenames that are relative to it.
    const conversationDirs = new Map<string, string>();

    for (const entry of entries) {
      if (entry.isDirectory || !entry.entryName.toLowerCase().endsWith('.json')) continue;

      let text: string;
      try {
        text = entry.getData().toString('utf-8');
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

      const dir = path.dirname(entry.entryName);
      for (const conversation of parsed) {
        conversationDirs.set(conversation.id, dir);
      }
      conversations.push(...parsed);
    }

    const { fuzzyEntryMap, consumed } = this.buildFuzzyEntryMap(zip);

    for (const conversation of conversations) {
      await this.upsertConversation(conversation);
      const dir = conversationDirs.get(conversation.id) ?? '.';

      for (const message of conversation.messages) {
        if (!message.attachments?.length) continue;

        for (const attachment of message.attachments) {
          const entryPath = dir === '.' ? attachment.storedName : `${dir}/${attachment.storedName}`;
          const zipEntry = this.findZipEntry(fuzzyEntryMap, consumed, entryPath);

          if (!zipEntry) {
            this.logger.warn(`Attachment not found in zip [Chat ID: ${conversation.id}]: ${entryPath}`);
            continue;
          }

          const buffer = zipEntry.getData();
          const { storagePath, contentHash } = await this.attachmentStorage.save(
            buffer,
            attachment.displayName,
            conversation.platform,
          );

          await this.prisma.attachment.upsert({
            where: { messageId_contentHash: { messageId: message.id, contentHash } },
            create: {
              messageId: message.id,
              displayName: attachment.displayName,
              storagePath,
              contentHash,
              size: buffer.length,
            },
            update: {},
          });
        }
      }
    }

    return { imported: conversations.length };
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
    const base = path.basename(entryPath).replace(ConversationService.DUP_SUFFIX, '');
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

    let idx = candidates.findIndex(e => !consumed.has(e) && e.entryName === entryPath);
    if (idx !== -1) {
      const entry = candidates[idx];
      consumed.add(entry);
      return entry;
    }

    idx = candidates.findIndex(e => !consumed.has(e) && !this.hasDupSuffix(e.entryName));
    if (idx !== -1) {
      const entry = candidates[idx];
      consumed.add(entry);
      return entry;
    }

    const fallback = candidates.find(e => !consumed.has(e));
    if (fallback) {
      consumed.add(fallback);
      return fallback;
    }

    return null;
  }

  private async upsertConversation(conversation: Conversation) {
    await this.prisma.conversation.upsert({
      where: { id: conversation.id },
      create: {
        id: conversation.id,
        platform: conversation.platform,
        title: conversation.title,
        createdAt: new Date(conversation.createdAt),
        updatedAt: new Date(conversation.updatedAt),
      },
      update: {
        title: conversation.title,
        updatedAt: new Date(conversation.updatedAt),
      },
    });

    for (const message of conversation.messages) {
      await this.prisma.message.upsert({
        where: { id: message.id },
        create: {
          id: message.id,
          role: message.role,
          content: message.content,
          createdAt: new Date(message.createdAt),
          hidden: false,
          conversationId: conversation.id,
        },
        update: {
          // Content can change if the source export is re-run after edits.
          // `hidden` is intentionally left untouched here so the user's
          // manual hide/show choices survive re-imports.
          content: message.content,
        },
      });
    }
  }
}