import { Injectable } from '@nestjs/common';
import { ConversationParser } from '../../../common/interfaces/parser.interface.js';
import { Conversation } from '../../../common/interfaces/conversation.interface.js';

@Injectable()
export class ChatgptParser implements ConversationParser {
  // TODO: implement real parsing of ChatGPT's conversations.json export
  parse(rawFileContent: string): Conversation[] {
    console.log('ChatGPT parser not implemented yet');
    return [];
  }
}