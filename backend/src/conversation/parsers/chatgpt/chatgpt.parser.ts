// backend/src/conversation/parsers/chatgpt/chatgpt.parser.ts
import { Injectable } from '@nestjs/common';
import { ConversationParser } from '../../../common/interfaces/parser.interface.js';
import {
  Conversation,
  ConversationMessage,
  ConversationAttachment,
} from '../../../common/interfaces/conversation.interface.js';

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
  // In real exports, parts is either string[] or (string | object | null)[].
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
  // A logical assistant reply may be split into multiple consecutive nodes
  // (e.g. when a tool call happens in between). end_turn === true marks the
  // last fragment of a reply.
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

// stop_tokens sentinel values used by ChatGPT exports.
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
        // A single malformed conversation must not fail the whole export.
        console.log(
          `ChatgptParser: skipping conversation ${raw?.id ?? '<no-id>'}: ${
            (err as Error).message
          }`,
        );
      }
    }
    return conversations;
  }

  private toConversation(raw: ChatGptConversation): Conversation | null {
    const id = raw.id ?? raw.conversation_id;
    if (!id) return null;

    const messages = this.walkTree(raw, id);
    if (messages.length === 0) return null;

    const createdAt =
      this.toIsoString(raw.create_time) ?? messages[0].createdAt;
    // Use the last message's time as the watermark, matching the Gemini
    // parser. This keeps incremental import semantics identical across
    // platforms: messages newer than this get appended on re-import.
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

  /**
   * ChatGPT stores messages as a tree (to support edit / regenerate branches).
   * Walk from current_node back up through `parent` to reconstruct the path
   * of the currently selected branch.
   *
   * A single logical assistant reply may be stored as several consecutive
   * assistant nodes (e.g. text → tool call → text). We merge those fragments
   * into one message. The reply ends when `end_turn === true` (or, for older
   * exports, when finish_details.stop_tokens contains the normal-end sentinel).
   */
  private walkTree(
    raw: ChatGptConversation,
    conversationId: string,
  ): ConversationMessage[] {
    const mapping = raw.mapping;
    if (!mapping) return [];

    const path = this.resolvePath(mapping, raw.current_node);

    const messages: ConversationMessage[] = [];
    // Buffer holding the fragments of the current logical assistant reply.
    let assistantBuffer: ConversationMessage | null = null;

    const flushAssistant = () => {
      if (assistantBuffer) {
        messages.push(assistantBuffer);
        assistantBuffer = null;
      }
    };

    for (const nodeId of path) {
      const node = mapping[nodeId];
      if (!node?.message) continue;

      const role = this.mapRole(node.message.author?.role);

      if (role === 'assistant') {
        const msg = this.toMessage(conversationId, node.message);

        if (msg) {
          if (assistantBuffer) {
            // Merge this fragment into the buffered reply.
            const merged = [assistantBuffer.content, msg.content]
              .filter((s) => s && s.trim())
              .join('\n\n');
            assistantBuffer.content = merged;
            if (msg.attachments?.length) {
              assistantBuffer.attachments = [
                ...(assistantBuffer.attachments ?? []),
                ...msg.attachments,
              ];
            }
            // Re-point the id to the last fragment so the merged message
            // has a stable identity across re-imports (the last fragment is
            // the one with end_turn === true).
            assistantBuffer.id = msg.id;
          } else {
            assistantBuffer = msg;
          }
        }

        // Whether or not this fragment produced text, we must inspect
        // end_turn to know when the logical reply is over.
        if (this.isAssistantReplyEnd(node.message)) {
          flushAssistant();
        }
        continue;
      }

      // Any non-assistant node (user / system) terminates a pending reply.
      flushAssistant();
      const msg = this.toMessage(conversationId, node.message);
      if (msg) messages.push(msg);
    }

    // Trailing assistant reply without an explicit end_turn (malformed data):
    // still emit it rather than dropping it.
    flushAssistant();

    return messages;
  }

  /**
   * Decide whether the given assistant message is the last fragment of a
   * logical reply.
   *
   * Priority:
   *   1. `end_turn` field if present (newer exports).
   *   2. `finish_details.stop_tokens` sentinels (older exports).
   *   3. Default to true so we don't accidentally swallow subsequent replies.
   */
  private isAssistantReplyEnd(message: ChatGptMessage): boolean {
    if (message.end_turn != null) {
      return message.end_turn === true;
    }
    const tokens = message.finish_details?.stop_tokens ?? [];
    if (tokens.includes(STOP_TOKEN_NORMAL_END)) return true;
    if (tokens.includes(STOP_TOKEN_TOOL_CALL)) return false;
    return true;
  }

  /**
   * Returns the node-id path from root down to current_node.
   * 1. If current_node exists and can be traced back to the root via parent,
   *    use that path (most accurate; preserves the selected branch).
   * 2. Otherwise walk down from the root following the last child.
   * 3. Otherwise fall back to sorting all message-bearing nodes by create_time.
   */
  private resolvePath(
    mapping: Record<string, ChatGptMappingNode>,
    currentNode: string | null | undefined,
  ): string[] {
    if (currentNode && mapping[currentNode]) {
      const path: string[] = [];
      const visited = new Set<string>();
      let nodeId: string | null | undefined = currentNode;
      while (nodeId && mapping[nodeId] && !visited.has(nodeId)) {
        visited.add(nodeId);
        path.unshift(nodeId);
        nodeId = mapping[nodeId].parent;
      }
      // Only accept the path if it actually reaches a real root (parent == null).
      if (path.length > 0 && mapping[path[0]]?.parent == null) {
        return path;
      }
    }

    // Fallback: walk down from the root following the last child.
    const root = this.findRoot(mapping);
    if (root) {
      const path: string[] = [];
      const visited = new Set<string>();
      let nodeId: string | null | undefined = root;
      while (nodeId && mapping[nodeId] && !visited.has(nodeId)) {
        visited.add(nodeId);
        path.push(nodeId);
        const children: string[] = mapping[nodeId].children ?? [];
        nodeId = children.length > 0 ? children[children.length - 1] : null;
      }
      if (path.length > 0) return path;
    }

    // Last resort: every message-bearing node, ordered by create_time.
    return Object.values(mapping)
      .filter((n) => n.message && this.toIsoString(n.message.create_time))
      .sort(
        (a, b) =>
          new Date(this.toIsoString(a.message!.create_time)!).getTime() -
          new Date(this.toIsoString(b.message!.create_time)!).getTime(),
      )
      .map((n) => n.id!)
      .filter(Boolean);
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
    // Messages without an id cannot be matched across re-imports: their id
    // would have to be synthesized and could drift between imports, which
    // would break attachment foreign keys. Log and skip them.
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

    // Fall back to epoch 0 so the value is stable across imports; createdAt is
    // used for display and for the incremental watermark, so it must not
    // change between runs.
    const time =
      this.toIsoString(message.create_time) ?? new Date(0).toISOString();

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

  /**
   * Extract text and attachments from a message's content.
   * - "text": parts are plain strings.
   * - "multimodal_text": parts mix strings and image_asset_pointer objects.
   * - parts may contain null (e.g. thinking entries) and must be filtered.
   */
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
        // asset_pointer looks like "sediment://file_abc123" or
        // "file-service://file_abc123".
        const fileId = part.asset_pointer.replace(
          /^(sediment|file-service):\/\//,
          '',
        );
        const meta = attachmentMeta.get(fileId);
        const displayName = meta?.name ?? fileId;
        // The actual file inside the zip is named file_xxxxx.dat and lives in
        // the same folder as conversations-xxx.json.
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
