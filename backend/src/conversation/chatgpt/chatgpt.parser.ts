import { Injectable } from '@nestjs/common';
import { ConversationParser } from '../../common/interfaces/parser.interface.js';
import {
  Conversation,
  ConversationMessage,
  ConversationAttachment,
} from '../../common/interfaces/conversation.interface.js';
import { splitJsonArrayFile } from '../utils/streaming-json-splitter.js';

interface ChatGptAuthor {
  role?: string;
}

interface ChatGptImageAssetPointer {
  asset_pointer?: string;
  content_type?: string;
  height?: number;
  width?: number;
  size_bytes?: number;
}

interface ChatGptAttachment {
  id?: string;
  name?: string;
  mime_type?: string;
  size?: number;
}

interface ChatGptContent {
  content_type?: string;
  parts?: (string | ChatGptImageAssetPointer | null)[];
}

interface ChatGptFinishDetails {
  type?: string;
  stop_tokens?: number[];
}

interface ChatGptMessage {
  id?: string;
  author?: ChatGptAuthor;
  content?: ChatGptContent | null;
  create_time?: number | null;
  update_time?: number | null;
  end_turn?: boolean | null;
  finish_details?: ChatGptFinishDetails | null;
  metadata?: {
    attachments?: ChatGptAttachment[];
    model_slug?: string;
  } | null;
}

interface ChatGptMappingNode {
  id?: string;
  message?: ChatGptMessage | null;
  parent?: string | null;
  children?: string[];
}

interface ChatGptConversation {
  id?: string;
  conversation_id?: string;
  title?: string;
  create_time?: number | null;
  update_time?: number | null;
  current_node?: string | null;
  mapping?: Record<string, ChatGptMappingNode>;
}

const STOP_TOKEN_NORMAL_END = 200002;
const STOP_TOKEN_TOOL_CALL = 200007;

@Injectable()
export class ChatgptParser implements ConversationParser {
  parse(rawFileContent: string): Conversation[] {
    let rawConversations: ChatGptConversation[];
    try {
      rawConversations = JSON.parse(rawFileContent) as ChatGptConversation[];
    } catch {
      console.log('ChatgptParser: failed to parse conversations JSON');
      return [];
    }

    if (!Array.isArray(rawConversations)) return [];

    const conversations: Conversation[] = [];
    for (const raw of rawConversations) {
      try {
        const conversation = this.toConversation(raw);
        if (conversation) conversations.push(conversation);
      } catch (err) {
        console.log(
          `ChatgptParser: skipping conversation ${raw?.id ?? '<no-id>'}: ${
            (err as Error).message
          }`,
        );
      }
    }
    return conversations;
  }

  async *parseReadStream(filePath: string): AsyncGenerator<Conversation> {
    for await (const itemJson of splitJsonArrayFile(filePath)) {
      const conversation = this.parseOne(itemJson);
      if (conversation) yield conversation;
    }
  }

  parseOne(itemJson: string): Conversation | null {
    let raw: ChatGptConversation;
    try {
      raw = JSON.parse(itemJson) as ChatGptConversation;
    } catch {
      return null;
    }
    try {
      return this.toConversation(raw);
    } catch {
      return null;
    }
  }

  parseOneUnordered(itemJson: string): Conversation | null {
    let raw: ChatGptConversation;
    try {
      raw = JSON.parse(itemJson) as ChatGptConversation;
    } catch {
      return null;
    }
    try {
      return this.toConversation(raw, true);
    } catch {
      return null;
    }
  }

  buildMessageParentLookup(itemJson: string): Map<string, string> {
    let raw: ChatGptConversation;
    try {
      raw = JSON.parse(itemJson) as ChatGptConversation;
    } catch {
      return new Map();
    }
    const mapping = raw.mapping;
    if (!mapping) return new Map();

    const lookup = new Map<string, string>();
    for (const node of Object.values(mapping)) {
      const msgId = node.message?.id;
      const parentId = node.parent;
      if (!msgId || !parentId) continue;
      const parentNode = mapping[parentId];
      const parentMsgId = parentNode?.message?.id;
      if (parentMsgId) {
        lookup.set(msgId, parentMsgId);
      }
    }
    return lookup;
  }

  ensureChronologicalOrder(messages: ConversationMessage[]): void {
    if (messages.length === 0) return;

    const base = new Date(messages[0].createdAt).getTime();
    for (let i = 0; i < messages.length; i++) {
      messages[i].createdAt = new Date(base + i).toISOString();
    }
  }

  private toConversation(
    raw: ChatGptConversation,
    skipOrdering = false,
  ): Conversation | null {
    const id = raw.id ?? raw.conversation_id;
    if (!id) return null;

    const messages = this.walkTree(raw, id);
    if (messages.length === 0) return null;

    if (!skipOrdering) {
      this.ensureChronologicalOrder(messages);
    }

    const createdAt =
      this.toIsoString(raw.create_time) ?? messages[0].createdAt;
    const updatedAt = messages[messages.length - 1].createdAt;

    return {
      id,
      platform: 'chatgpt',
      title: raw.title?.trim() || this.deriveTitle(messages),
      createdAt,
      updatedAt,
      messages,
    };
  }

  private walkTree(
    raw: ChatGptConversation,
    conversationId: string,
  ): ConversationMessage[] {
    const mapping = raw.mapping;
    if (!mapping) return [];

    const root = this.findRoot(mapping);
    if (!root) return [];

    const allNodeIds = this.bfsAllNodes(mapping, root);

    const nodeLastMessageId = new Map<string, string>();
    const nodePendingAssistant = new Map<string, ConversationMessage>();
    const messages: ConversationMessage[] = [];

    for (const nodeId of allNodeIds) {
      const node = mapping[nodeId];
      if (!node) continue;

      const parentNodeId = node.parent ?? undefined;

      if (!node.message) {
        const parentLastId = parentNodeId
          ? nodeLastMessageId.get(parentNodeId)
          : undefined;
        if (parentLastId) nodeLastMessageId.set(nodeId, parentLastId);
        continue;
      }

      const role = this.mapRole(node.message.author?.role);

      if (role === 'assistant') {
        const pendingParent = parentNodeId
          ? nodePendingAssistant.get(parentNodeId)
          : null;
        const parentLastId = parentNodeId
          ? nodeLastMessageId.get(parentNodeId)
          : undefined;

        const msg = this.toMessage(conversationId, node.message);
        if (!msg) {
          if (parentLastId) nodeLastMessageId.set(nodeId, parentLastId);
          continue;
        }

        if (pendingParent) {
          const merged = [pendingParent.content, msg.content]
            .filter((s) => s && s.trim())
            .join('\n\n');
          pendingParent.content = merged;
          if (msg.attachments?.length) {
            pendingParent.attachments = [
              ...(pendingParent.attachments ?? []),
              ...msg.attachments,
            ];
          }
          pendingParent.id = msg.id;
          if (parentNodeId) nodePendingAssistant.delete(parentNodeId);
        }

        if (this.isAssistantReplyEnd(node.message)) {
          const finalMsg = pendingParent ?? msg;
          if (!pendingParent) {
            finalMsg.parentMessageId = parentLastId;
          }
          messages.push(finalMsg);
          nodeLastMessageId.set(nodeId, finalMsg.id);
        } else {
          const bufferMsg = pendingParent ?? msg;
          if (!pendingParent) {
            bufferMsg.parentMessageId = parentLastId;
          }
          nodePendingAssistant.set(nodeId, bufferMsg);
        }
        continue;
      }

      if (parentNodeId && nodePendingAssistant.has(parentNodeId)) {
        const pending = nodePendingAssistant.get(parentNodeId)!;
        messages.push(pending);
        nodeLastMessageId.set(parentNodeId, pending.id);
        nodePendingAssistant.delete(parentNodeId);
      }

      const parentLastId = parentNodeId
        ? nodeLastMessageId.get(parentNodeId)
        : undefined;

      const msg = this.toMessage(conversationId, node.message);
      if (msg) {
        msg.parentMessageId = parentLastId;
        messages.push(msg);
        nodeLastMessageId.set(nodeId, msg.id);
      } else {
        if (parentLastId) nodeLastMessageId.set(nodeId, parentLastId);
      }
    }

    for (const [, pending] of nodePendingAssistant) {
      messages.push(pending);
    }

    return messages;
  }

  private bfsAllNodes(
    mapping: Record<string, ChatGptMappingNode>,
    root: string,
  ): string[] {
    const order: string[] = [];
    const visited = new Set<string>();
    const queue: string[] = [root];
    let head = 0;

    while (head < queue.length) {
      const nodeId = queue[head++];
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      order.push(nodeId);

      for (const childId of mapping[nodeId]?.children ?? []) {
        if (!visited.has(childId)) queue.push(childId);
      }
    }

    return order;
  }

  private isAssistantReplyEnd(message: ChatGptMessage): boolean {
    if (message.end_turn != null) {
      return message.end_turn === true;
    }
    const tokens = message.finish_details?.stop_tokens ?? [];
    if (tokens.includes(STOP_TOKEN_NORMAL_END)) return true;
    if (tokens.includes(STOP_TOKEN_TOOL_CALL)) return false;
    return true;
  }

  private findRoot(mapping: Record<string, ChatGptMappingNode>): string | null {
    for (const [id, node] of Object.entries(mapping)) {
      if (node.parent == null) return id;
    }
    return null;
  }

  private toMessage(
    conversationId: string,
    message: ChatGptMessage,
  ): ConversationMessage | null {
    if (!message.id) {
      console.log(
        `ChatgptParser: skipping message without id [conversation: ${conversationId}, role: ${
          message.author?.role ?? 'unknown'
        }, create_time: ${message.create_time ?? 'null'}]`,
      );
      return null;
    }

    const role = this.mapRole(message.author?.role);
    if (!role) return null;

    const { text, attachments } = this.extractContent(message);
    if (!text.trim() && attachments.length === 0) return null;

    const time =
      this.toIsoString(message.update_time) ??
      this.toIsoString(message.create_time) ??
      new Date(0).toISOString();

    return {
      id: `${conversationId}-${message.id}`,
      role,
      content: text,
      createdAt: time,
      attachments: attachments.length > 0 ? attachments : undefined,
    };
  }

  private mapRole(raw?: string): 'user' | 'assistant' | 'system' | null {
    if (raw === 'user') return 'user';
    if (raw === 'assistant') return 'assistant';
    if (raw === 'system') return 'system';
    return null;
  }

  private extractContent(message: ChatGptMessage): {
    text: string;
    attachments: ConversationAttachment[];
  } {
    const content = message.content;
    if (!content?.parts || !Array.isArray(content.parts)) {
      return { text: '', attachments: [] };
    }

    const attachmentMeta = new Map<string, ChatGptAttachment>();
    for (const att of message.metadata?.attachments ?? []) {
      if (att.id) attachmentMeta.set(att.id, att);
    }

    const textParts: string[] = [];
    const attachments: ConversationAttachment[] = [];

    for (const part of content.parts) {
      if (part == null) continue;

      if (typeof part === 'string') {
        textParts.push(part);
        continue;
      }

      if (
        typeof part === 'object' &&
        part.content_type === 'image_asset_pointer' &&
        part.asset_pointer
      ) {
        const fileId = part.asset_pointer.replace(
          /^(sediment|file-service):\/\//,
          '',
        );
        const meta = attachmentMeta.get(fileId);
        const displayName = meta?.name ?? fileId;
        const storedName = `${fileId}.dat`;
        attachments.push({ storedName, displayName });
      }
    }

    const addedIds = new Set(attachments.map((a) => a.storedName));
    for (const att of message.metadata?.attachments ?? []) {
      if (!att.id) continue;
      const storedName = `${att.id}.dat`;
      if (addedIds.has(storedName)) continue;
      addedIds.add(storedName);
      attachments.push({
        storedName,
        displayName: att.name ?? att.id,
      });
    }

    return { text: textParts.join('\n'), attachments };
  }

  private toIsoString(epoch?: number | null): string | null {
    if (epoch == null || !Number.isFinite(epoch)) return null;
    return new Date(epoch * 1000).toISOString();
  }

  private deriveTitle(messages: ConversationMessage[]): string {
    const firstUserMessage = messages.find((m) => m.role === 'user');
    return firstUserMessage
      ? firstUserMessage.content.slice(0, 60)
      : 'ChatGPT conversation';
  }
}
