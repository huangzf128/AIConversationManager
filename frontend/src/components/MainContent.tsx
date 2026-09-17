import { useMemo, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import './MainContent.css';
import { ChevronIcon, EyeIcon, PaperclipIcon } from './Icons';
import ToggleSwitch from './ToggleSwitch.js';
import type { ConversationDetail, MessageItem } from '../pages/MyPage';
import { attachmentDownloadUrl } from '../common/api.js';

const HTML_PLATFORMS = new Set(['gemini']);

marked.setOptions({ gfm: true, breaks: true });

function toAssistantHtml(content: string, platform: string): string {
  const html = HTML_PLATFORMS.has(platform) ? content : (marked.parse(content) as string);
  return DOMPurify.sanitize(html);
}

interface MainContentProps {
  conversation: ConversationDetail | null;
  loading: boolean;
  onToggleMessageHidden: (messageId: string, hidden: boolean) => void;
}

const PLATFORM_URLS: Record<string, (id: string) => string> = {
  gemini: (id) => `https://gemini.google.com/app/${id}`,
  chatgpt: (id) => `https://chatgpt.com/c/${id}`,
  claude: (id) => `https://claude.ai/chat/${id}`,
  deepseek: (id) => `https://chat.deepseek.com/a/chat/s/${id}`,
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function buildChildrenMap(messages: MessageItem[]): Map<string | null, MessageItem[]> {
  const map = new Map<string | null, MessageItem[]>();
  for (const m of messages) {
    const key = m.parentMessageId ?? null;
    const list = map.get(key) ?? [];
    list.push(m);
    map.set(key, list);
  }
  return map;
}

function flattenBranch(
  childrenMap: Map<string | null, MessageItem[]>,
  activeBranch: Map<string | null, number>,
  parentId: string | null,
): MessageItem[] {
  const siblings = childrenMap.get(parentId);
  if (!siblings || siblings.length === 0) return [];

  const idx = activeBranch.get(parentId) ?? 0;
  const chosen = siblings[Math.min(idx, siblings.length - 1)];
  const rest: MessageItem[] = [chosen];

  const childSiblings = childrenMap.get(chosen.id);
  if (childSiblings && childSiblings.length > 0) {
    rest.push(...flattenBranch(childrenMap, activeBranch, chosen.id));
  }

  return rest;
}

function MainContent({ conversation, loading, onToggleMessageHidden }: MainContentProps) {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [showHiddenMessages, setShowHiddenMessages] = useState(false);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [activeBranch, setActiveBranch] = useState<Map<string | null, number>>(new Map());

  const isImageAttachment = (displayName: string): boolean => {
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
    return imageExtensions.some((ext) => displayName.toLowerCase().endsWith(ext));
  };

  const visibleMessages = useMemo(() => {
    if (!conversation) return [];
    const all = conversation.messages.filter((m) => showHiddenMessages || !m.hidden);
    const childrenMap = buildChildrenMap(all);

    const hasBranches = Array.from(childrenMap.values()).some((s) => s.length > 1);
    if (!hasBranches) return all;

    return flattenBranch(childrenMap, activeBranch, null);
  }, [conversation, showHiddenMessages, activeBranch]);

  const branchInfo = useMemo(() => {
    if (!conversation) return new Map<string | null, { total: number; current: number }>();
    const all = conversation.messages.filter((m) => showHiddenMessages || !m.hidden);
    const childrenMap = buildChildrenMap(all);
    const info = new Map<string | null, { total: number; current: number }>();
    for (const [parentId, siblings] of childrenMap) {
      if (siblings.length > 1) {
        const idx = activeBranch.get(parentId) ?? 0;
        info.set(parentId, {
          total: siblings.length,
          current: Math.min(idx, siblings.length - 1) + 1,
        });
      }
    }
    return info;
  }, [conversation, showHiddenMessages, activeBranch]);

  if (loading) {
    return (
      <main className="main-content main-content-empty">
        <p>Loading…</p>
      </main>
    );
  }

  if (!conversation) {
    return (
      <main className="main-content main-content-empty">
        <p>Select a conversation from the left to read it.</p>
      </main>
    );
  }

  const toggleMessage = (id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const expandAll = () => setCollapsedIds(new Set());
  const collapseAll = () => setCollapsedIds(new Set(visibleMessages.map((m) => m.id)));

  const switchBranch = (parentId: string | null, direction: -1 | 1) => {
    setActiveBranch((prev) => {
      const all = conversation.messages.filter((m) => showHiddenMessages || !m.hidden);
      const childrenMap = buildChildrenMap(all);
      const siblings = childrenMap.get(parentId);
      if (!siblings || siblings.length <= 1) return prev;

      const current = prev.get(parentId) ?? 0;
      const next = (current + direction + siblings.length) % siblings.length;
      const nextMap = new Map(prev);
      nextMap.set(parentId, next);
      return nextMap;
    });
  };

  return (
    <main className="main-content" key={conversation.id}>
      <header className="thread-header">
        <div className="thread-header-top">
          <a
            className={`platform-tag platform-tag-${conversation.platform}`}
            href={PLATFORM_URLS[conversation.platform]?.(conversation.id)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {conversation.platform}
          </a>
          <h1>{conversation.title}</h1>
        </div>
        <div className="thread-header-actions">
          {conversation.hidden && <span className="hidden-badge">hidden</span>}
          <button type="button" onClick={expandAll}>
            Expand all
          </button>
          <button type="button" onClick={collapseAll}>
            Collapse all
          </button>
          <ToggleSwitch
            checked={showHiddenMessages}
            onChange={() => setShowHiddenMessages((prev) => !prev)}
            label="Show hidden messages"
          />
        </div>
      </header>

      <div className="thread">
        {visibleMessages.map((message) => {
          const isCollapsed = collapsedIds.has(message.id);
          const branch = branchInfo.get(message.parentMessageId ?? null);
          return (
            <div
              key={message.id}
              className={[
                'thread-message',
                `role-${message.role}`,
                message.hidden ? 'message-hidden' : '',
              ].join(' ')}
            >
              <div className="message-meta">
                <button
                  type="button"
                  className="message-meta-toggle"
                  onClick={() => toggleMessage(message.id)}
                >
                  <ChevronIcon open={!isCollapsed} />
                  <span className="message-role">{message.role}</span>
                  <span className="message-time">{formatTime(message.createdAt)}</span>
                  {message.attachments && message.attachments.length > 0 && (
                    <span className="message-attachment-icon">
                      <PaperclipIcon />
                    </span>
                  )}
                </button>
                {branch && (
                  <span className="branch-switcher">
                    <button
                      type="button"
                      className="branch-btn"
                      onClick={() => switchBranch(message.parentMessageId ?? null, -1)}
                      title="Previous branch"
                    >
                      ◀
                    </button>
                    <span className="branch-label">
                      {branch.current}/{branch.total}
                    </span>
                    <button
                      type="button"
                      className="branch-btn"
                      onClick={() => switchBranch(message.parentMessageId ?? null, 1)}
                      title="Next branch"
                    >
                      ▶
                    </button>
                  </span>
                )}
                <span
                  className="icon-button"
                  role="button"
                  tabIndex={0}
                  title={message.hidden ? 'Unhide message' : 'Hide message'}
                  onClick={() => onToggleMessageHidden(message.id, !message.hidden)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ')
                      onToggleMessageHidden(message.id, !message.hidden);
                  }}
                >
                  <EyeIcon hidden={message.hidden} />
                </span>
              </div>
              {!isCollapsed &&
                (message.role === 'assistant' ? (
                  <div
                    className="assistant-html"
                    dangerouslySetInnerHTML={{
                      __html: toAssistantHtml(message.content, conversation.platform),
                    }}
                  />
                ) : (
                  <p className="message-text">{message.content}</p>
                ))}
              {!isCollapsed && message.attachments && message.attachments.length > 0 && (
                <div className="message-attachments">
                  <span className="attachments-label">Attachments:</span>
                  <ul className="attachments-list">
                    {message.attachments.map((a) => (
                      <li key={a.id}>
                        {conversation.platform === 'deepseek' ? (
                          <span className="attachment-name-only">{a.displayName}</span>
                        ) : isImageAttachment(a.displayName) ? (
                          <img
                            src={attachmentDownloadUrl(a.id)}
                            alt={a.displayName}
                            className="attachment-image"
                            onClick={() => setPreviewImageUrl(attachmentDownloadUrl(a.id))}
                          />
                        ) : (
                          <a
                            href={attachmentDownloadUrl(a.id)}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {a.displayName}
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {previewImageUrl && (
        <div className="image-modal" onClick={() => setPreviewImageUrl(null)}>
          <button className="modal-close" onClick={() => setPreviewImageUrl(null)}>
            ×
          </button>
          <img src={previewImageUrl} alt="Full size preview" className="modal-image" />
        </div>
      )}
    </main>
  );
}

export default MainContent;
