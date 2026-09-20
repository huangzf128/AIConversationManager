import { Injectable } from '@nestjs/common';
import { ConversationParser } from '../../common/interfaces/parser.interface.js';
import {
  Conversation,
  ConversationMessage,
  ConversationAttachment,
} from '../../common/interfaces/conversation.interface.js';
import { splitJsonArrayFile } from '../utils/streaming-json-splitter.js';

interface DeepseekFragmentBase {
  type: string;
}

interface DeepseekRequestFragment extends DeepseekFragmentBase {
  type: 'REQUEST';
  content: string;
}

interface DeepseekResponseFragment extends DeepseekFragmentBase {
  type: 'RESPONSE';
  content: string;
}

interface DeepseekThinkFragment extends DeepseekFragmentBase {
  type: 'THINK';
  content: string;
}

interface DeepseekSearchFragment extends DeepseekFragmentBase {
  type: 'SEARCH';
  results?: { url?: string; title?: string }[];
}

interface DeepseekFileFragment extends DeepseekFragmentBase {
  type: 'FILE';
  files?: { file_id?: string; file_name?: string; file_size?: number }[];
}

interface DeepseekToolSearchFragment extends DeepseekFragmentBase {
  type: 'TOOL_SEARCH';
  results?: { url?: string; title?: string }[];
}

interface DeepseekToolOpenFragment extends DeepseekFragmentBase {
  type: 'TOOL_OPEN';
}

type DeepseekFragment =
  | DeepseekRequestFragment
  | DeepseekResponseFragment
  | DeepseekThinkFragment
  | DeepseekSearchFragment
  | DeepseekFileFragment
  | DeepseekToolSearchFragment
  | DeepseekToolOpenFragment;

interface DeepseekMessage {
  model?: string;
  inserted_at?: string;
  fragments?: DeepseekFragment[];
}

interface DeepseekMappingNode {
  id?: string;
  parent?: string | null;
  children?: string[];
  message?: DeepseekMessage | null;
}

interface DeepseekConversation {
  id?: string;
  title?: string;
  inserted_at?: string;
  updated_at?: string;
  mapping?: Record<string, DeepseekMappingNode>;
}

@Injectable()
export class DeepseekParser implements ConversationParser {
  parse(rawFileContent: string): Conversation[] {
    const conversations: Conversation[] = [];
    for (const conversation of this.parseStream(rawFileContent)) {
      conversations.push(conversation);
    }
    return conversations;
  }

  *parseStream(rawFileContent: string): Generator<Conversation> {
    const trimmed = rawFileContent.trim();
    if (!trimmed.startsWith('[')) {
      console.log('DeepseekParser: expected JSON array');
      return;
    }

    const items = splitJsonArrayItems(trimmed);
    for (const itemJson of items) {
      let raw: DeepseekConversation;
      try {
        raw = JSON.parse(itemJson) as DeepseekConversation;
      } catch (err) {
        console.log(
          `DeepseekParser: skipping malformed item: ${(err as Error).message}`,
        );
        continue;
      }
      try {
        const conversation = this.toConversation(raw);
        if (conversation) yield conversation;
      } catch (err) {
        console.log(
          `DeepseekParser: skipping conversation ${raw?.id ?? '<no-id>'}: ${
            (err as Error).message
          }`,
        );
      }
    }
  }

  async *parseReadStream(filePath: string): AsyncGenerator<Conversation> {
    for await (const itemJson of splitJsonArrayFile(filePath)) {
      let raw: DeepseekConversation;
      try {
        raw = JSON.parse(itemJson) as DeepseekConversation;
      } catch (err) {
        console.log(
          `DeepseekParser: skipping malformed item: ${(err as Error).message}`,
        );
        continue;
      }
      try {
        const conversation = this.toConversation(raw);
        if (conversation) yield conversation;
      } catch (err) {
        console.log(
          `DeepseekParser: skipping conversation ${raw?.id ?? '<no-id>'}: ${
            (err as Error).message
          }`,
        );
      }
    }
  }

  private toConversation(raw: DeepseekConversation): Conversation | null {
    if (!raw.id) return null;

    const messages = this.walkTree(raw);
    if (messages.length === 0) return null;

    const createdAt =
      this.normalizeTimestamp(raw.inserted_at) ?? messages[0].createdAt;
    const updatedAt = messages[messages.length - 1].createdAt;

    return {
      id: raw.id,
      platform: 'deepseek',
      title: raw.title?.trim() || this.deriveTitle(messages),
      createdAt,
      updatedAt,
      messages,
    };
  }

  private walkTree(raw: DeepseekConversation): ConversationMessage[] {
    const mapping = raw.mapping;
    if (!mapping) return [];

    const root = this.findRoot(mapping);
    if (!root) return [];

    const allNodeIds = this.bfsAllNodes(mapping, root);

    const nodeLastMessageId = new Map<string, string>();
    const messages: ConversationMessage[] = [];

    for (const nodeId of allNodeIds) {
      const node = mapping[nodeId];
      if (!node) continue;

      const parentNodeId = node.parent ?? 'root';
      const parentLastId =
        parentNodeId !== 'root'
          ? nodeLastMessageId.get(parentNodeId)
          : undefined;

      if (!node.message?.fragments?.length) {
        if (parentLastId) nodeLastMessageId.set(nodeId, parentLastId);
        continue;
      }

      const { userMsg, assistantMsg } = this.extractMessages(
        raw.id!,
        nodeId,
        parentNodeId,
        node.message,
      );

      if (userMsg) {
        userMsg.parentMessageId = parentLastId;
        messages.push(userMsg);
        nodeLastMessageId.set(nodeId, userMsg.id);
      }

      if (assistantMsg) {
        assistantMsg.parentMessageId = userMsg?.id ?? parentLastId;
        messages.push(assistantMsg);
        nodeLastMessageId.set(nodeId, assistantMsg.id);
      }
    }

    this.ensureChronologicalOrder(messages);
    return messages;
  }

  private bfsAllNodes(
    mapping: Record<string, DeepseekMappingNode>,
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

  private ensureChronologicalOrder(messages: ConversationMessage[]): void {
    if (messages.length === 0) return;

    const base = new Date(messages[0].createdAt).getTime();
    for (let i = 0; i < messages.length; i++) {
      messages[i].createdAt = new Date(base + i).toISOString();
    }
  }

  private extractMessages(
    conversationId: string,
    nodeId: string,
    parentNodeId: string,
    message: DeepseekMessage,
  ): {
    userMsg: ConversationMessage | null;
    assistantMsg: ConversationMessage | null;
  } {
    const time =
      this.normalizeTimestamp(message.inserted_at) ?? new Date().toISOString();

    let userContent = '';
    const userAttachments: ConversationAttachment[] = [];
    let thinkContent = '';
    let responseContent = '';
    const searchParts: string[] = [];

    for (const fragment of message.fragments ?? []) {
      switch (fragment.type) {
        case 'REQUEST':
          userContent = fragment.content ?? '';
          break;
        case 'THINK':
          thinkContent = fragment.content ?? '';
          break;
        case 'RESPONSE':
          responseContent = fragment.content ?? '';
          break;
        case 'SEARCH':
        case 'TOOL_SEARCH': {
          const results =
            fragment.type === 'SEARCH'
              ? (fragment as DeepseekSearchFragment).results
              : (fragment as DeepseekToolSearchFragment).results;
          if (results?.length) {
            const lines = results
              .filter((r) => r.title || r.url)
              .map(
                (r, i) =>
                  `[${i + 1}] ${r.title ?? r.url}${r.url ? ` (${r.url})` : ''}`,
              );
            if (lines.length) searchParts.push(lines.join('\n'));
          }
          break;
        }
        case 'FILE': {
          const files = (fragment as DeepseekFileFragment).files ?? [];
          for (const f of files) {
            const storedName = f.file_id ?? '';
            const displayName = f.file_name ?? storedName;
            if (storedName) userAttachments.push({ storedName, displayName });
          }
          break;
        }
        case 'TOOL_OPEN':
          break;
      }
    }

    let userMsg: ConversationMessage | null = null;
    if (userContent.trim() || userAttachments.length > 0) {
      userMsg = {
        id: `${conversationId}-${nodeId}-${parentNodeId}-user`,
        role: 'user',
        content: userContent,
        createdAt: time,
        attachments: userAttachments.length > 0 ? userAttachments : undefined,
      };
    }

    let assistantMsg: ConversationMessage | null = null;
    const assistantParts: string[] = [];
    if (thinkContent.trim()) {
      assistantParts.push(`\`\`\`thinking\n${thinkContent}\n\`\`\``);
    }
    if (responseContent.trim()) {
      assistantParts.push(responseContent);
    }
    if (searchParts.length) {
      assistantParts.push(searchParts.join('\n\n'));
    }

    const assistantText = assistantParts.join('\n\n');
    if (assistantText.trim()) {
      assistantMsg = {
        id: `${conversationId}-${nodeId}-${parentNodeId}-assistant`,
        role: 'assistant',
        content: assistantText,
        createdAt: time,
      };
    }

    return { userMsg, assistantMsg };
  }

  private findRoot(
    mapping: Record<string, DeepseekMappingNode>,
  ): string | null {
    for (const [id, node] of Object.entries(mapping)) {
      if (node.parent == null) return id;
    }
    return null;
  }

  private normalizeTimestamp(ts?: string): string | null {
    if (!ts) return null;
    try {
      const date = new Date(ts);
      if (!Number.isFinite(date.getTime())) return null;
      return date.toISOString();
    } catch {
      return null;
    }
  }

  private deriveTitle(messages: ConversationMessage[]): string {
    const firstUserMessage = messages.find((m) => m.role === 'user');
    return firstUserMessage
      ? firstUserMessage.content.slice(0, 60)
      : 'DeepSeek conversation';
  }
}

function* splitJsonArrayItems(json: string): Generator<string> {
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;

  for (let i = 0; i < json.length; i++) {
    const ch = json[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{' || ch === '[') {
      if (depth === 1 && start < 0) start = i;
      depth++;
      continue;
    }

    if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 1 && start >= 0) {
        yield json.substring(start, i + 1);
        start = -1;
      }
      continue;
    }
  }
}
