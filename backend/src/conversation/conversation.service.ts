import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  AiPlatform,
  Conversation,
  ConversationMessage,
  ConversationAttachment,
} from '../common/interfaces/conversation.interface.js';
import {
  PlatformImporter,
  JsonFileEntry,
} from '../common/interfaces/importer.interface.js';
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
  FuzzyFileMap,
} from './utils/zip-utils.js';

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);
  private readonly importers: Record<AiPlatform, PlatformImporter>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly attachmentStorage: AttachmentStorageService,
    chatgptImporter: ChatgptImporter,
    geminiImporter: GeminiImporter,
    claudeImporter: ClaudeImporter,
    deepseekImporter: DeepseekImporter,
  ) {
    this.importers = {
      chatgpt: chatgptImporter,
      gemini: geminiImporter,
      claude: claudeImporter,
      deepseek: deepseekImporter,
    };
  }

  async findAll(take = 20, skip = 0, searchId?: string) {
    const where = searchId ? { id: { contains: searchId } } : {};

    const [conversations, total] = await Promise.all([
      this.prisma.conversation.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take,
        skip,
      }),
      this.prisma.conversation.count({ where }),
    ]);

    if (conversations.length === 0) {
      return { data: [], total, hasMore: false };
    }

    const conversationIds = conversations.map((c) => c.id);
    const messageCounts = await this.prisma.message.groupBy({
      by: ['conversationId'],
      where: { conversationId: { in: conversationIds } },
      _count: { id: true },
    });

    const countMap = new Map(
      messageCounts.map((c) => [c.conversationId, c._count.id]),
    );

    return {
      data: conversations.map((c) => ({
        ...c,
        _count: { messages: countMap.get(c.id) ?? 0 },
      })),
      total,
      hasMore: skip + conversations.length < total,
    };
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

  async findOne(id: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
    });

    if (!conversation) return null;

    const messages = await this.prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
    });

    if (messages.length === 0) {
      return { ...conversation, messages: [] };
    }

    const messageIds = messages.map((m) => m.id);
    const attachments = await this.prisma.attachment.findMany({
      where: { messageId: { in: messageIds } },
    });

    const attachmentMap = new Map<string, typeof attachments>();
    for (const att of attachments) {
      const list = attachmentMap.get(att.messageId) ?? [];
      list.push(att);
      attachmentMap.set(att.messageId, list);
    }

    return {
      ...conversation,
      messages: messages.map((m) => ({
        ...m,
        attachments: attachmentMap.get(m.id) ?? [],
      })),
    };
  }

  async findAttachment(id: string) {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id },
    });

    if (!attachment) return null;

    const message = await this.prisma.message.findUnique({
      where: { id: attachment.messageId },
    });

    if (!message) {
      return { ...attachment, message: null };
    }

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: message.conversationId },
      select: { platform: true },
    });

    return {
      ...attachment,
      message: {
        ...message,
        conversation: conversation ?? null,
      },
    };
  }

  resolveAttachmentPath(storagePath: string, platform: string): string {
    return this.attachmentStorage.resolveAbsolutePath(storagePath, platform);
  }

  async importFromFile(
    platform: AiPlatform,
    rawFileContent: string,
    syncDelete = false,
  ) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-import-'));
    const tmpFile = path.join(tmpDir, 'conversations.json');
    try {
      fs.writeFileSync(tmpFile, rawFileContent, 'utf-8');

      const jsonFiles: JsonFileEntry[] = [
        { entryPath: 'conversations.json', absolutePath: tmpFile },
      ];

      if (platform === 'gemini') {
        return await this.importGeminiStreamed(
          jsonFiles,
          undefined,
          syncDelete,
        );
      }

      return await this.importStreamed(
        platform,
        jsonFiles,
        undefined,
        syncDelete,
      );
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }

  private async importStreamed(
    platform: AiPlatform,
    jsonFiles: JsonFileEntry[],
    attachmentLookup: FuzzyFileMap | undefined,
    syncDelete: boolean,
  ) {
    const importer = this.importers[platform];
    if (!importer) {
      throw new BadRequestException(`Unsupported platform: ${platform}`);
    }

    let imported = 0;
    const importedIds = new Set<string>();

    for await (const parsed of importer.parseZipEntries(jsonFiles)) {
      const { conversation, zipDir, skipAttachmentFiles } = parsed;
      const insertedIds = new Set(await this.upsertConversation(conversation));
      imported++;
      importedIds.add(conversation.id);

      if (insertedIds.size === 0) continue;

      for (const message of conversation.messages) {
        if (!insertedIds.has(message.id)) continue;
        if (!message.attachments?.length) continue;

        for (const attachment of message.attachments) {
          if (attachmentLookup && !skipAttachmentFiles) {
            const { fuzzyEntryMap, consumed } = attachmentLookup;
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
          } else {
            const placeholderHash = `${message.id}:${attachment.storedName}`;
            try {
              await this.prisma.attachment.upsert({
                where: {
                  messageId_contentHash: {
                    messageId: message.id,
                    contentHash: placeholderHash,
                  },
                },
                create: {
                  messageId: message.id,
                  displayName: attachment.displayName,
                  storagePath: attachment.storedName,
                  contentHash: placeholderHash,
                  size: 0,
                },
                update: {},
              });
            } catch (err) {
              this.logger.error(
                `Failed to save attachment metadata [${attachment.displayName}] for message ${message.id} in conversation ${conversation.id}`,
                err,
              );
            }
          }
        }
      }
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
    if (platform === 'gemini') {
      return this.importFromZipGemini(zipBuffer, syncDelete);
    }

    const importer = this.importers[platform];
    if (!importer) {
      throw new BadRequestException(`Unsupported platform: ${platform}`);
    }

    const { tempDir, allFiles, jsonFiles } = extractZipToTempDir(zipBuffer, {
      shouldExpandZip: importer.shouldExpandZip?.bind(importer),
      shouldParseJson: importer.shouldParseJson?.bind(importer),
    });
    const attachmentLookup = buildFuzzyFileMap(allFiles);

    try {
      return await this.importStreamed(
        platform,
        jsonFiles,
        attachmentLookup,
        syncDelete,
      );
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }

  async importFromZipGemini(zipBuffer: Buffer, syncDelete = false) {
    const geminiImporter = this.importers['gemini'] as GeminiImporter;
    const { tempDir, allFiles, jsonFiles } = extractZipToTempDir(zipBuffer, {
      shouldExpandZip: geminiImporter.shouldExpandZip?.bind(geminiImporter),
      shouldParseJson: geminiImporter.shouldParseJson?.bind(geminiImporter),
    });
    const attachmentLookup = buildFuzzyFileMap(allFiles);

    try {
      return await this.importGeminiStreamed(
        jsonFiles,
        attachmentLookup,
        syncDelete,
      );
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }

  private async importGeminiStreamed(
    jsonFiles: JsonFileEntry[],
    attachmentLookup: FuzzyFileMap | undefined,
    syncDelete = false,
  ) {
    const geminiImporter = this.importers['gemini'] as GeminiImporter;

    interface ConversationMeta {
      title: string;
      titleTime: number;
      updatedAt: number;
      createdAt: string;
      dbExists: boolean;
      dbUpdatedAt: number;
    }

    const conversationMap = new Map<string, ConversationMeta>();
    const pendingAttachments: {
      messageId: string;
      chatId: string;
      attachment: ConversationAttachment;
      zipDir: string;
    }[] = [];
    let imported = 0;
    const importedIds = new Set<string>();

    await this.prisma.$transaction(
      async (tx) => {
        for await (const {
          result,
          zipDir,
        } of geminiImporter.parseZipEntriesStreamed(jsonFiles)) {
          const { chatId, messages, recordTime, title } = result;
          const recordTimeMs = new Date(recordTime).getTime();

          let meta = conversationMap.get(chatId);
          if (!meta) {
            const existing = await tx.conversation.findUnique({
              where: { id: chatId },
              select: { updatedAt: true, createdAt: true },
            });

            if (existing) {
              meta = {
                title: '',
                titleTime: 0,
                updatedAt: existing.updatedAt.getTime(),
                createdAt: existing.createdAt.toISOString(),
                dbExists: true,
                dbUpdatedAt: existing.updatedAt.getTime(),
              };
            } else {
              meta = {
                title,
                titleTime: recordTimeMs,
                updatedAt: recordTimeMs,
                createdAt: recordTime,
                dbExists: false,
                dbUpdatedAt: 0,
              };
            }
            conversationMap.set(chatId, meta);
          }

          if (meta.dbExists && recordTimeMs <= meta.dbUpdatedAt) continue;

          if (!meta.dbExists && recordTimeMs < meta.titleTime) {
            meta.title = title;
            meta.titleTime = recordTimeMs;
          }

          meta.updatedAt = Math.max(meta.updatedAt, recordTimeMs);
          for (const message of messages) {
            await tx.message.upsert({
              where: { id: message.id },
              create: {
                id: message.id,
                role: message.role,
                content: message.content,
                conversationId: chatId,
                createdAt: new Date(message.createdAt),
                hidden: false,
                parentMessageId: message.parentMessageId ?? null,
              },
              update: {},
            });
            if (message.attachments?.length) {
              for (const attachment of message.attachments) {
                pendingAttachments.push({
                  messageId: message.id,
                  chatId,
                  attachment,
                  zipDir,
                });
              }
            }
          }
        }

        for (const [chatId, meta] of conversationMap) {
          await tx.conversation.upsert({
            where: { id: chatId },
            create: {
              id: chatId,
              platform: 'gemini',
              title: meta.title,
              createdAt: new Date(meta.createdAt),
              updatedAt: new Date(meta.updatedAt),
            },
            update: {
              updatedAt: new Date(meta.updatedAt),
            },
          });
          imported++;
          importedIds.add(chatId);
        }
      },
      { timeout: 300_000 },
    );

    if (attachmentLookup) {
      const { fuzzyEntryMap, consumed } = attachmentLookup;
      for (const {
        messageId,
        chatId,
        attachment,
        zipDir,
      } of pendingAttachments) {
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
            `Attachment not found in zip [Chat ID: ${chatId}]: ${primaryPath}`,
          );
          continue;
        }

        try {
          const attachmentData = fs.readFileSync(match.absolutePath);
          const { storagePath, contentHash } =
            await this.attachmentStorage.save(
              attachmentData,
              attachment.displayName,
              'gemini',
            );

          await this.prisma.attachment.upsert({
            where: {
              messageId_contentHash: {
                messageId,
                contentHash,
              },
            },
            create: {
              messageId,
              displayName: attachment.displayName,
              storagePath,
              contentHash,
              size: attachmentData.length,
            },
            update: {},
          });
        } catch (err) {
          this.logger.error(
            `Failed to save attachment [${attachment.displayName}] for message ${messageId} in conversation ${chatId}`,
            err,
          );
        }
      }
    }

    let deleted = 0;
    if (syncDelete) {
      deleted = await this.syncDeleteMissing('gemini', importedIds);
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
    if (toDeleteIds.length === 0) {
      this.logger.log(
        `Sync-deleted 0 conversation(s) for platform "${platform}"`,
      );
      return 0;
    }

    const BATCH_SIZE = 900;
    let deleted = 0;

    for (let offset = 0; offset < toDeleteIds.length; offset += BATCH_SIZE) {
      const batch = toDeleteIds.slice(offset, offset + BATCH_SIZE);

      const conversations = await this.prisma.conversation.findMany({
        where: { id: { in: batch } },
        select: { id: true },
      });

      for (const conversation of conversations) {
        const messages = await this.prisma.message.findMany({
          where: { conversationId: conversation.id },
          select: { id: true },
        });

        const messageIds = messages.map((m) => m.id);

        if (messageIds.length > 0) {
          const attachments = await this.prisma.attachment.findMany({
            where: { messageId: { in: messageIds } },
            select: { storagePath: true },
          });

          for (const attachment of attachments) {
            await this.attachmentStorage.delete(
              attachment.storagePath,
              platform,
            );
          }

          await this.prisma.attachment.deleteMany({
            where: { messageId: { in: messageIds } },
          });
        }

        await this.prisma.message.deleteMany({
          where: { conversationId: conversation.id },
        });

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
        },
      });

      if (uniqueMessages.length > 0) {
        await this.prisma.message.createMany({
          data: uniqueMessages.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            conversationId: conversation.id,
            createdAt: new Date(message.createdAt),
            hidden: false,
            parentMessageId: message.parentMessageId ?? null,
          })),
        });
      }

      return uniqueMessages.map((m) => m.id);
    }

    if (existing.updatedAt.getTime() >= jsonUpdatedAt) {
      return [];
    }

    const existingMessages = await this.prisma.message.findMany({
      where: { conversationId: conversation.id },
      select: { id: true },
    });
    const existingIdSet = new Set(existingMessages.map((m) => m.id));

    const newMessages = uniqueMessages.filter((m) => !existingIdSet.has(m.id));

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        title: conversation.title,
        updatedAt: new Date(conversation.updatedAt),
      },
    });

    if (newMessages.length > 0) {
      await this.prisma.message.createMany({
        data: newMessages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          conversationId: conversation.id,
          createdAt: new Date(message.createdAt),
          hidden: false,
          parentMessageId: message.parentMessageId ?? null,
        })),
      });
    }

    return newMessages.map((m) => m.id);
  }
}
