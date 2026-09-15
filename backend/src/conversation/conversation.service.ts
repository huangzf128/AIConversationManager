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

    for (const conversation of conversations) {
      await this.upsertConversation(conversation);
      const dir = conversationDirs.get(conversation.id) ?? '.';

      for (const message of conversation.messages) {
        if (!message.attachments?.length) continue;

        for (const attachment of message.attachments) {
          const entryPath = dir === '.' ? attachment.storedName : `${dir}/${attachment.storedName}`;
          const zipEntry = zip.getEntry(entryPath);
          
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