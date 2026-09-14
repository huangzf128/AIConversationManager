import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiPlatform, Conversation } from '../common/interfaces/conversation.interface.js';
import { ConversationParser } from '../common/interfaces/parser.interface.js';
import { ChatgptParser } from './parsers/chatgpt/chatgpt.parser.js';
import { GeminiParser } from './parsers/gemini/gemini.parser.js';
import { ClaudeParser } from './parsers/claude/claude.parser.js';
import { DeepseekParser } from './parsers/deepseek/deepseek.parser.js';

@Injectable()
export class ConversationService {
  private readonly parsers: Record<AiPlatform, ConversationParser>;

  constructor(
    private readonly prisma: PrismaService,
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
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
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
