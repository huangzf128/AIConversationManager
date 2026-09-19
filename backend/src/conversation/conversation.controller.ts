import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { ConversationService } from './conversation.service.js';
import { AiPlatform } from '../common/interfaces/conversation.interface.js';

const SUPPORTED_PLATFORMS: AiPlatform[] = [
  'chatgpt',
  'gemini',
  'claude',
  'deepseek',
];

@Controller('conversations')
export class ConversationController {
  constructor(private readonly conversationService: ConversationService) {}

  @Get()
  findAll(@Query('take') take?: string, @Query('skip') skip?: string) {
    return this.conversationService.findAll(
      take ? parseInt(take, 10) : undefined,
      skip ? parseInt(skip, 10) : undefined,
    );
  }

  @Get('attachments/:id/download')
  async downloadAttachment(@Param('id') id: string, @Res() res: Response) {
    const attachment = await this.conversationService.findAttachment(id);
    if (!attachment) throw new NotFoundException('Attachment not found');

    // Get the platform from the parent conversation to build the correct path
    const platform = attachment.message?.conversation?.platform || 'gemini';
    const absolutePath = this.conversationService.resolveAttachmentPath(
      attachment.storagePath,
      platform,
    );
    res.download(absolutePath, attachment.displayName);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.conversationService.findOne(id);
  }

  @Patch(':id/hidden')
  setHidden(@Param('id') id: string, @Body('hidden') hidden: boolean) {
    return this.conversationService.setHidden(id, hidden);
  }

  @Patch(':id/starred')
  setStarred(@Param('id') id: string, @Body('starred') starred: boolean) {
    return this.conversationService.setStarred(id, starred);
  }

  @Patch(':id/messages/:messageId/hidden')
  setMessageHidden(
    @Param('messageId') messageId: string,
    @Body('hidden') hidden: boolean,
  ) {
    return this.conversationService.setMessageHidden(messageId, hidden);
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body('platform') platform?: string,
    @Body('syncDelete') syncDelete?: string,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    const resolvedPlatform = (platform ?? 'gemini') as AiPlatform;
    if (!SUPPORTED_PLATFORMS.includes(resolvedPlatform)) {
      throw new BadRequestException(
        `Unsupported platform: ${resolvedPlatform}`,
      );
    }

    const shouldSyncDelete = syncDelete === 'true';

    const isZip =
      file.originalname.toLowerCase().endsWith('.zip') ||
      file.mimetype === 'application/zip';

    if (isZip) {
      return this.conversationService.importFromZip(
        resolvedPlatform,
        file.buffer,
        shouldSyncDelete,
      );
    }

    const rawFileContent = file.buffer.toString('utf-8');
    return this.conversationService.importFromFile(
      resolvedPlatform,
      rawFileContent,
      shouldSyncDelete,
    );
  }
}
