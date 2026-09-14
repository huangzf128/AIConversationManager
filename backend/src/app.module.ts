import { Module } from '@nestjs/common';
import { ConversationModule } from './conversation/conversation.module.js';

@Module({
  imports: [ConversationModule],
  controllers: [],
  providers: [],
})
export class AppModule {}