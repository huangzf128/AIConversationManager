// Common data shape all platform parsers must produce.
export type AiPlatform = 'chatgpt' | 'gemini' | 'claude' | 'deepseek';

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  hidden?: boolean; // manually hidden by the user, not part of the raw export
  attachments?: ConversationAttachment[];
}

export interface Conversation {
  id: string;
  platform: AiPlatform;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessage[];
}

export interface ConversationAttachment {
  /** Filename as referenced inside the export (e.g. Gemini's `attachedFiles`).
   * Used to locate the file inside the source zip; not shown to the user. */
  storedName: string;
  /** Original filename to show in the UI and use for downloads. */
  displayName: string;
}