import { Module } from '@nestjs/common';
import { ConversationController } from './conversation.controller.js';
import { ConversationService } from './conversation.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AttachmentStorageService } from './attachment-storage.service.js';
import { ChatgptParser } from './chatgpt/chatgpt.parser.js';
import { GeminiParser } from './gemini/gemini.parser.js';
import { ClaudeParser } from './claude/claude.parser.js';
import { DeepseekParser } from './deepseek/deepseek.parser.js';
import { ChatgptImporter } from './chatgpt/chatgpt.importer.js';
import { GeminiImporter } from './gemini/gemini.importer.js';
import { ClaudeImporter } from './claude/claude.importer.js';
import { DeepseekImporter } from './deepseek/deepseek.importer.js';

@Module({
  controllers: [ConversationController],
  providers: [
    ConversationService,
    PrismaService,
    AttachmentStorageService,
    ChatgptParser,
    GeminiParser,
    ClaudeParser,
    DeepseekParser,
    ChatgptImporter,
    GeminiImporter,
    ClaudeImporter,
    DeepseekImporter,
  ],
})
export class ConversationModule {}
