import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  AiPlatform,
  Conversation,
  ConversationMessage,
} from '../common/interfaces/conversation.interface.js';
import { ConversationParser } from '../common/interfaces/parser.interface.js';
import { PlatformImporter } from '../common/interfaces/importer.interface.js';
import { ChatgptParser } from './chatgpt/chatgpt.parser.js';
import { GeminiParser } from './gemini/gemini.parser.js';
import { ClaudeParser } from './claude/claude.parser.js';
import { DeepseekParser } from './deepseek/deepseek.parser.js';
import { ChatgptImporter } from './chatgpt/chatgpt.importer.js';
import { GeminiImporter } from './gemini/gemini.importer.js';
import { ClaudeImporter } from './claude/claude.importer.js';
import { DeepseekImporter } from './deepseek/deepseek.importer.js';
import { AttachmentStorageService } from './attachment-storage.service.js';
import {
  extractZipToTempDir,
  buildFuzzyFileMap,
  findFile,
  findFileByBasename,
} from './utils/zip-utils.js';

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);
  private readonly parsers: Record<AiPlatform, ConversationParser>;
  private readonly importers: Record<AiPlatform, PlatformImporter>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly attachmentStorage: AttachmentStorageService,
    chatgptParser: ChatgptParser,
    geminiParser: GeminiParser,
    claudeParser: ClaudeParser,
    deepseekParser: DeepseekParser,
    chatgptImporter: ChatgptImporter,
    geminiImporter: GeminiImporter,
    claudeImporter: ClaudeImporter,
    deepseekImporter: DeepseekImporter,
  ) {
    this.parsers = {
      chatgpt: chatgptParser,
      gemini: geminiParser,
      claude: claudeParser,
      deepseek: deepseekParser,
    };
    this.importers = {
      chatgpt: chatgptImporter,
      gemini: geminiImporter,
      claude: claudeImporter,
      deepseek: deepseekImporter,
    };
  }

  findAll() {
    return this.prisma.conversation.findMany({
      orderBy: { updatedAt: 'desc' },
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

  async importFromFile(
    platform: AiPlatform,
    rawFileContent: string,
    syncDelete = false,
  ) {
    const parser = this.parsers[platform];
    if (!parser) {
      throw new BadRequestException(`Unsupported platform: ${platform}`);
    }

    if (
      platform === 'deepseek' &&
      'parseStream' in parser &&
      typeof parser.parseStream === 'function'
    ) {
      return this.importFromFileStreamed(
        platform,
        parser as DeepseekParser,
        rawFileContent,
        syncDelete,
      );
    }

    const conversations = parser.parse(rawFileContent);
    for (const conversation of conversations) {
      await this.upsertConversation(conversation);
    }

    let deleted = 0;
    if (syncDelete) {
      const importedIds = new Set(conversations.map((c) => c.id));
      deleted = await this.syncDeleteMissing(platform, importedIds);
    }

    return { imported: conversations.length, deleted };
  }

  private async importFromFileStreamed(
    platform: AiPlatform,
    parser: DeepseekParser,
    rawFileContent: string,
    syncDelete: boolean,
  ) {
    let imported = 0;
    const importedIds = new Set<string>();

    for (const conversation of parser.parseStream(rawFileContent)) {
      await this.upsertConversation(conversation);
      imported++;
      importedIds.add(conversation.id);
    }

    let deleted = 0;
    if (syncDelete) {
      deleted = await this.syncDeleteMissing(platform, importedIds);
    }

    return { imported, deleted };
  }

  async importFromZip(
    platform: AiPlatform,
    zipBuffer: Buffer,
    syncDelete = false,
  ) {
    const importer = this.importers[platform];
    if (!importer) {
      throw new BadRequestException(`Unsupported platform: ${platform}`);
    }

    const { tempDir, allFiles, jsonFiles } = extractZipToTempDir(zipBuffer, {
      shouldExpandZip: importer.shouldExpandZip?.bind(importer),
      shouldParseJson: importer.shouldParseJson?.bind(importer),
    });
    const { fuzzyEntryMap, consumed } = buildFuzzyFileMap(allFiles);

    let imported = 0;
    const importedIds = new Set<string>();

    try {
      for await (const parsed of importer.parseZipEntries(jsonFiles)) {
        const { conversation, zipDir, skipAttachmentFiles } = parsed;
        const insertedIds = new Set(
          await this.upsertConversation(conversation),
        );
        imported++;
        importedIds.add(conversation.id);

        if (insertedIds.size === 0 || skipAttachmentFiles) continue;

        for (const message of conversation.messages) {
          if (!insertedIds.has(message.id)) continue;
          if (!message.attachments?.length) continue;

          for (const attachment of message.attachments) {
            const primaryPath =
              zipDir === '.' || zipDir === ''
                ? attachment.storedName
                : `${zipDir}/${attachment.storedName}`;
            let match = findFile(fuzzyEntryMap, consumed, primaryPath);

            if (!match) {
              match = findFileByBasename(
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
              const attachmentData = fs.readFileSync(match.absolutePath);
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
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }

    let deleted = 0;
    if (syncDelete) {
      deleted = await this.syncDeleteMissing(platform, importedIds);
    }

    return { imported, deleted };
  }

  private async syncDeleteMissing(
    platform: AiPlatform,
    importedIds: Set<string>,
  ) {
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

  private async upsertConversation(
    conversation: Conversation,
  ): Promise<string[]> {
    const existing = await this.prisma.conversation.findUnique({
      where: { id: conversation.id },
      select: { updatedAt: true },
    });
    const jsonUpdatedAt = new Date(conversation.updatedAt).getTime();

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
              parentMessageId: message.parentMessageId ?? null,
            })),
          },
        },
      });
      return uniqueMessages.map((m) => m.id);
    }

    if (existing.updatedAt.getTime() >= jsonUpdatedAt) {
      return [];
    }

    const existingWatermark = existing.updatedAt.getTime();
    const newMessages = uniqueMessages.filter(
      (m) => new Date(m.createdAt).getTime() > existingWatermark,
    );

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        title: conversation.title,
        updatedAt: new Date(conversation.updatedAt),
        messages: {
          create: newMessages.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            createdAt: new Date(message.createdAt),
            hidden: false,
            parentMessageId: message.parentMessageId ?? null,
          })),
        },
      },
    });
    return newMessages.map((m) => m.id);
  }
}
