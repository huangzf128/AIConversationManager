import { Injectable } from '@nestjs/common';
import { ConversationParser } from '../../../common/interfaces/parser.interface.js';
import {
  Conversation,
  ConversationMessage,
  ConversationAttachment,
} from '../../../common/interfaces/conversation.interface.js';

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
    let rawConversations: DeepseekConversation[];
    try {
      rawConversations = JSON.parse(rawFileContent) as DeepseekConversation[];
    } catch {
      console.log('DeepseekParser: failed to parse conversations JSON');
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
          `DeepseekParser: skipping conversation ${raw?.id ?? '<no-id>'}: ${
            (err as Error).message
          }`,
        );
      }
    }
    return conversations;
  }

  private toConversation(raw: DeepseekConversation): Conversation | null {
    if (!raw.id) return null;

    const messages = this.walkTree(raw);
    if (messages.length === 0) return null;

    const createdAt =
      this.normalizeTimestamp(raw.inserted_at) ?? messages[0].createdAt;
    const updatedAt =
      this.normalizeTimestamp(raw.updated_at) ??
      messages[messages.length - 1].createdAt;

    return {
      id: raw.id,
      platform: 'deepseek',
      title: raw.title?.trim() || this.deriveTitle(messages),
      createdAt,
      updatedAt,
      messages,
    };
  }

  /**
   * DeepSeek stores messages as a tree (same structure as ChatGPT).
   * Walk from the leaf back up through `parent` to reconstruct the path
   * of the currently selected branch, then convert each node into
   * ConversationMessage(s).
   *
   * A single node can carry multiple fragments (REQUEST, THINK, RESPONSE,
   * SEARCH, FILE, TOOL_*). We split REQUEST into a user message and
   * THINK+RESPONSE into an assistant message. SEARCH and TOOL fragments
   * are appended to the preceding assistant message when present.
   */
  private walkTree(raw: DeepseekConversation): ConversationMessage[] {
    const mapping = raw.mapping;
    if (!mapping) return [];

    const path = this.resolvePath(mapping);

    const messages: ConversationMessage[] = [];
    let pendingAssistant: ConversationMessage | null = null;

    const flushAssistant = () => {
      if (pendingAssistant) {
        messages.push(pendingAssistant);
        pendingAssistant = null;
      }
    };

    for (const nodeId of path) {
      const node = mapping[nodeId];
      if (!node?.message?.fragments?.length) continue;

      const { userMsg, assistantMsg } = this.extractMessages(
        raw.id!,
        nodeId,
        node.message,
      );

      if (userMsg) {
        flushAssistant();
        messages.push(userMsg);
      }

      if (assistantMsg) {
        if (pendingAssistant) {
          const merged = [pendingAssistant.content, assistantMsg.content]
            .filter((s) => s && s.trim())
            .join('\n\n');
          pendingAssistant.content = merged;
          if (assistantMsg.attachments?.length) {
            pendingAssistant.attachments = [
              ...(pendingAssistant.attachments ?? []),
              ...assistantMsg.attachments,
            ];
          }
          pendingAssistant.id = assistantMsg.id;
        } else {
          pendingAssistant = assistantMsg;
        }
      }
    }

    flushAssistant();
    this.ensureChronologicalOrder(messages);
    return messages;
  }

  /**
   * DeepSeek exports often give the REQUEST and RESPONSE nodes nearly
   * identical `inserted_at` values, with the RESPONSE timestamp a few
   * milliseconds *earlier* than the REQUEST timestamp. Since the UI
   * sorts messages by `createdAt`, this would place the assistant reply
   * before the user prompt. We walk the tree in the correct structural
   * order, so we simply enforce that each message's createdAt is not
   * earlier than the preceding message's.
   */
  private ensureChronologicalOrder(messages: ConversationMessage[]): void {
    for (let i = 1; i < messages.length; i++) {
      if (messages[i].createdAt < messages[i - 1].createdAt) {
        messages[i].createdAt = messages[i - 1].createdAt;
      }
    }
  }

  /**
   * Split a node's fragments into at most one user message and one
   * assistant message. THINK content is prepended to RESPONSE content
   * (wrapped in a <think> block so the UI can optionally render it).
   * SEARCH results are formatted as a reference list and appended to
   * the assistant content. FILE fragments become attachments on the
   * user message.
   */
  private extractMessages(
    conversationId: string,
    nodeId: string,
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
        id: `${conversationId}-${nodeId}-user`,
        role: 'user',
        content: userContent,
        createdAt: time,
        attachments: userAttachments.length > 0 ? userAttachments : undefined,
      };
    }

    let assistantMsg: ConversationMessage | null = null;
    const assistantParts: string[] = [];
    if (thinkContent.trim()) {
      assistantParts.push(`<think>\n${thinkContent}\n</think>`);
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
        id: `${conversationId}-${nodeId}-assistant`,
        role: 'assistant',
        content: assistantText,
        createdAt: time,
      };
    }

    return { userMsg, assistantMsg };
  }

  /**
   * Resolve the path from root to the deepest leaf by following the tree
   * structure. DeepSeek exports don't have a `current_node` field, so we
   * walk from the root down through children (taking the first child at
   * each branch, which represents the main conversation path).
   */
  private resolvePath(mapping: Record<string, DeepseekMappingNode>): string[] {
    const root = this.findRoot(mapping);
    if (!root) return [];

    const path: string[] = [];
    const visited = new Set<string>();
    let nodeId: string | null | undefined = root;

    while (nodeId && mapping[nodeId] && !visited.has(nodeId)) {
      visited.add(nodeId);
      path.push(nodeId);
      const children: string[] = mapping[nodeId].children ?? [];
      nodeId = children.length > 0 ? children[0] : null;
    }

    return path;
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
