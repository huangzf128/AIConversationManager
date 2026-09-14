import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConversationService } from './conversation.service.js';
import { AiPlatform } from '../common/interfaces/conversation.interface.js';

const SUPPORTED_PLATFORMS: AiPlatform[] = ['chatgpt', 'gemini', 'claude', 'deepseek'];

@Controller('conversations')
export class ConversationController {
  constructor(private readonly conversationService: ConversationService) {}

  @Get()
  findAll() {
    return this.conversationService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.conversationService.findOne(id);
  }

  @Patch(':id/hidden')
  setHidden(@Param('id') id: string, @Body('hidden') hidden: boolean) {
    return this.conversationService.setHidden(id, hidden);
  }

  @Patch(':id/messages/:messageId/hidden')
  setMessageHidden(@Param('messageId') messageId: string, @Body('hidden') hidden: boolean) {
    return this.conversationService.setMessageHidden(messageId, hidden);
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  upload(@UploadedFile() file: Express.Multer.File, @Body('platform') platform?: string) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    // Default to 'gemini' for now since it's the only parser implemented.
    const resolvedPlatform = (platform ?? 'gemini') as AiPlatform;
    if (!SUPPORTED_PLATFORMS.includes(resolvedPlatform)) {
      throw new BadRequestException(`Unsupported platform: ${resolvedPlatform}`);
    }

    const rawFileContent = file.buffer.toString('utf-8');
    return this.conversationService.importFromFile(resolvedPlatform, rawFileContent);
  }
}
