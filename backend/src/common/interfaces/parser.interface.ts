import { Conversation } from './conversation.interface.js';

// Every platform-specific parser implements this so ConversationService
// can treat all platforms uniformly.
export interface ConversationParser {
  parse(rawFileContent: string): Conversation[];
}