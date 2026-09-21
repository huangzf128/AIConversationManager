import { Injectable } from '@nestjs/common';
import { ConversationParser } from '../../common/interfaces/parser.interface.js';
import {
  Conversation,
  ConversationMessage,
  ConversationAttachment,
} from '../../common/interfaces/conversation.interface.js';

interface ClaudeContentBlock {
  type: string;
  text?: string;
  thinking?: string;
}

interface ClaudeFile {
  file_uuid?: string;
  file_name?: string;
}

interface ClaudeChatMessage {
  uuid?: string;
  sender?: string;
  created_at?: string;
  text?: string;
  content?: ClaudeContentBlock[];
  parent_message_uuid?: string;
  files?: ClaudeFile[];
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
  private static readonly ROOT_SENTINEL =
    '00000000-0000-4000-8000-000000000000';

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
    if (!raw.name?.trim()) return null;

    const messages = this.walkTree(raw);
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

  private walkTree(raw: ClaudeConversation): ConversationMessage[] {
    const rawMessages = raw.chat_messages ?? [];
    if (rawMessages.length === 0) return [];

    const hasTreeStructure = rawMessages.some(
      (m) => m.parent_message_uuid !== undefined,
    );
    if (!hasTreeStructure) {
      return rawMessages
        .slice()
        .sort(
          (a, b) =>
            new Date(a.created_at ?? 0).getTime() -
            new Date(b.created_at ?? 0).getTime(),
        )
        .map((message) => this.toMessage(raw.uuid!, message))
        .filter((m): m is ConversationMessage => m !== null);
    }

    const byUuid = new Map<string, ClaudeChatMessage>();
    const childrenOf = new Map<string, string[]>();

    for (const msg of rawMessages) {
      const uuid = msg.uuid;
      if (!uuid) continue;
      byUuid.set(uuid, msg);

      const parentUuid = msg.parent_message_uuid ?? ClaudeParser.ROOT_SENTINEL;
      const siblings = childrenOf.get(parentUuid) ?? [];
      siblings.push(uuid);
      childrenOf.set(parentUuid, siblings);
    }

    for (const children of childrenOf.values()) {
      children.sort((a, b) => {
        const mA = byUuid.get(a);
        const mB = byUuid.get(b);
        return (
          new Date(mA?.created_at ?? 0).getTime() -
          new Date(mB?.created_at ?? 0).getTime()
        );
      });
    }

    const rootChildren = childrenOf.get(ClaudeParser.ROOT_SENTINEL) ?? [];
    const order: string[] = [];
    const visited = new Set<string>();
    const queue: string[] = [...rootChildren];
    let head = 0;

    while (head < queue.length) {
      const uuid = queue[head++];
      if (visited.has(uuid) || !byUuid.has(uuid)) continue;
      visited.add(uuid);
      order.push(uuid);

      for (const childUuid of childrenOf.get(uuid) ?? []) {
        if (!visited.has(childUuid)) queue.push(childUuid);
      }
    }

    for (const msg of rawMessages) {
      if (msg.uuid && !visited.has(msg.uuid)) {
        order.push(msg.uuid);
      }
    }

    const messages: ConversationMessage[] = [];
    const uuidToLastOutputId = new Map<string, string | undefined>();

    for (const uuid of order) {
      const msg = byUuid.get(uuid);
      if (!msg) continue;

      const parentUuid = msg.parent_message_uuid;
      const parentOutputId =
        parentUuid && parentUuid !== ClaudeParser.ROOT_SENTINEL
          ? uuidToLastOutputId.get(parentUuid)
          : undefined;

      const convMsg = this.toMessage(raw.uuid!, msg);
      if (!convMsg) {
        uuidToLastOutputId.set(uuid, parentOutputId);
        continue;
      }

      convMsg.parentMessageId = parentOutputId;
      messages.push(convMsg);
      uuidToLastOutputId.set(uuid, convMsg.id);
    }

    return messages;
  }

  private toMessage(
    conversationId: string,
    message: ClaudeChatMessage,
  ): ConversationMessage | null {
    if (message.sender !== 'human' && message.sender !== 'assistant')
      return null;

    const text = this.extractText(message);
    const attachments = this.extractAttachments(message);

    if (!text.trim() && attachments.length === 0) return null;

    return {
      id:
        message.uuid ??
        `${conversationId}-${message.created_at ?? ''}-${message.sender}`,
      role: message.sender === 'human' ? 'user' : 'assistant',
      content: text.trim(),
      createdAt: message.created_at ?? new Date().toISOString(),
      attachments: attachments.length > 0 ? attachments : undefined,
    };
  }

  private extractAttachments(
    message: ClaudeChatMessage,
  ): ConversationAttachment[] {
    const files = message.files ?? [];
    return files
      .filter((f) => f.file_uuid || f.file_name)
      .map((f) => ({
        storedName: f.file_uuid ?? f.file_name ?? '',
        displayName: f.file_name || f.file_uuid || '',
      }));
  }

  private extractText(message: ClaudeChatMessage): string {
    const text = this.stripUnsupportedBlocks(message.text ?? '').trim();

    if (message.sender === 'assistant' && message.content?.length) {
      const thinkingParts: string[] = [];
      for (const block of message.content) {
        if (block.type === 'thinking' && block.thinking?.trim()) {
          thinkingParts.push(block.thinking!.trim());
        }
      }
      if (thinkingParts.length > 0) {
        const thinking = thinkingParts.join('\n\n');
        return `\`\`\`thinking\n${thinking}\n\`\`\`\n\n${text}`;
      }
    }

    return text;
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
