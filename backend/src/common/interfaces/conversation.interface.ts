// Common data shape all platform parsers must produce.
export type AiPlatform = 'chatgpt' | 'gemini' | 'claude' | 'deepseek';

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  hidden?: boolean; // manually hidden by the user, not part of the raw export
}

export interface Conversation {
  id: string;
  platform: AiPlatform;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessage[];
}