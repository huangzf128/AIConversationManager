import { Injectable } from '@nestjs/common';
import { ConversationParser } from '../../common/interfaces/parser.interface.js';
import {
  Conversation,
  ConversationMessage,
} from '../../common/interfaces/conversation.interface.js';

interface ClaudeChatMessage {
  uuid?: string;
  sender?: string;
  created_at?: string;
  text?: string;
}

interface ClaudeConversation {
  uuid?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  chat_messages?: ClaudeChatMessage[];
}

@Injectable()
export class ClaudeParser implements ConversationParser {
  parse(rawFileContent: string): Conversation[] {
    let rawConversations: ClaudeConversation[];
    try {
      rawConversations = JSON.parse(rawFileContent) as ClaudeConversation[];
    } catch {
      console.log('ClaudeParser: failed to parse conversations JSON');
      return [];
    }
    if (!Array.isArray(rawConversations)) return [];

    const conversations: Conversation[] = [];
    for (const raw of rawConversations) {
      const conversation = this.toConversation(raw);
      if (conversation) conversations.push(conversation);
    }
    return conversations;
  }

  parseOne(itemJson: string): Conversation | null {
    let raw: ClaudeConversation;
    try {
      raw = JSON.parse(itemJson) as ClaudeConversation;
    } catch {
      return null;
    }
    return this.toConversation(raw);
  }

  private toConversation(raw: ClaudeConversation): Conversation | null {
    if (!raw.uuid) return null;

    const messages = (raw.chat_messages ?? [])
      .slice()
      .sort(
        (a, b) =>
          new Date(a.created_at ?? 0).getTime() -
          new Date(b.created_at ?? 0).getTime(),
      )
      .map((message) => this.toMessage(raw.uuid!, message))
      .filter((m): m is ConversationMessage => m !== null);
    if (messages.length === 0) return null;

    return {
      id: raw.uuid,
      platform: 'claude',
      title: raw.name?.trim() || this.deriveTitle(messages),
      createdAt: raw.created_at ?? messages[0].createdAt,
      updatedAt: raw.updated_at ?? messages[messages.length - 1].createdAt,
      messages,
    };
  }

  private toMessage(
    conversationId: string,
    message: ClaudeChatMessage,
  ): ConversationMessage | null {
    if (message.sender !== 'human' && message.sender !== 'assistant')
      return null;

    const text = this.stripUnsupportedBlocks(message.text ?? '').trim();
    if (!text) return null;

    return {
      id:
        message.uuid ??
        `${conversationId}-${message.created_at ?? ''}-${message.sender}`,
      role: message.sender === 'human' ? 'user' : 'assistant',
      content: text,
      createdAt: message.created_at ?? new Date().toISOString(),
    };
  }

  private stripUnsupportedBlocks(text: string): string {
    return text
      .replace(
        /```[ \t]*\n?This block is not supported on your current device yet\.[ \t]*\n?```[ \t]*\n?/g,
        '',
      )
      .replace(
        /^This block is not supported on your current device yet\.[ \t]*\n?/gm,
        '',
      );
  }

  private deriveTitle(messages: ConversationMessage[]): string {
    const firstUserMessage = messages.find((m) => m.role === 'user');
    return firstUserMessage
      ? firstUserMessage.content.slice(0, 60)
      : 'Claude conversation';
  }
}
