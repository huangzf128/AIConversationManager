import { Module } from '@nestjs/common';
import { ConversationController } from './conversation.controller.js';
import { ConversationService } from './conversation.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ChatgptParser } from './parsers/chatgpt/chatgpt.parser.js';
import { GeminiParser } from './parsers/gemini/gemini.parser.js';
import { ClaudeParser } from './parsers/claude/claude.parser.js';
import { DeepseekParser } from './parsers/deepseek/deepseek.parser.js';

@Module({
  controllers: [ConversationController],
  providers: [
    ConversationService,
    PrismaService,
    ChatgptParser,
    GeminiParser,
    ClaudeParser,
    DeepseekParser,
  ],
})
export class ConversationModule {}
