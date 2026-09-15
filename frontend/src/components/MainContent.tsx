import { useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import './MainContent.css';
import { ChevronIcon, EyeIcon } from './Icons';
import ToggleSwitch from './ToggleSwitch.js';
import type { ConversationDetail } from '../pages/MyPage';
import { attachmentDownloadUrl } from '../common/api.js';

// Platforms whose export stores assistant content as raw HTML (Gemini's
// safeHtmlItem). Everything else (Claude, ChatGPT, DeepSeek) exports
// markdown, which must be converted to HTML before rendering.
const HTML_PLATFORMS = new Set(['gemini']);

marked.setOptions({ gfm: true, breaks: true });

function toAssistantHtml(content: string, platform: string): string {
  const html = HTML_PLATFORMS.has(platform) ? content : marked.parse(content) as string;
  // Content comes from uploaded export files, so treat it as untrusted.
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
  deepseek: (id) => `https://chat.deepseek.com/chat/${id}`,
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function MainContent({ conversation, loading, onToggleMessageHidden }: MainContentProps) {
  // Which message ids are collapsed. Local-only, resets whenever a
  // different conversation is opened — everything starts expanded.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [showHiddenMessages, setShowHiddenMessages] = useState(false);
  // Image preview modal state
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);

  // Helper to check if attachment is an image based on file extension
  const isImageAttachment = (displayName: string): boolean => {
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
    return imageExtensions.some(ext => displayName.toLowerCase().endsWith(ext));
  };



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
  const collapseAll = () => setCollapsedIds(new Set(conversation.messages.map((m) => m.id)));

  const visibleMessages = conversation.messages.filter((m) => showHiddenMessages || !m.hidden);

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
          <button
            type="button"
            onClick={collapseAll}
          >
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
                <button type="button" className="message-meta-toggle" onClick={() => toggleMessage(message.id)}>
                  <ChevronIcon open={!isCollapsed} />
                  <span className="message-role">{message.role}</span>
                  <span className="message-time">{formatTime(message.createdAt)}</span>
                </button>
                <span
                  className="icon-button"
                  role="button"
                  tabIndex={0}
                  title={message.hidden ? 'Unhide message' : 'Hide message'}
                  onClick={() => onToggleMessageHidden(message.id, !message.hidden)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') onToggleMessageHidden(message.id, !message.hidden);
                  }}
                >
                  <EyeIcon hidden={message.hidden} />
                </span>
              </div>
              {!isCollapsed &&
                (message.role === 'assistant' ? (
                  // Gemini's export stores assistant replies as raw HTML;
                  // markdown platforms (Claude etc.) are converted and
                  // everything is sanitized before being injected.
                  <div
                    className="assistant-html"
                    dangerouslySetInnerHTML={{ __html: toAssistantHtml(message.content, conversation.platform) }}
                  />
                ) : (
                  <p className="message-text">{message.content}</p>
                ))}
              {/* Display attachments for this message right below it */}
              {!isCollapsed && message.attachments && message.attachments.length > 0 && (
                <div className="message-attachments">
                  <span className="attachments-label">Attachments:</span>
                  <ul className="attachments-list">
                    {message.attachments.map((a) => (
                      <li key={a.id}>
                        {isImageAttachment(a.displayName) ? (
                          <img 
                            src={attachmentDownloadUrl(a.id)} 
                            alt={a.displayName}
                            className="attachment-image"
                            onClick={() => setPreviewImageUrl(attachmentDownloadUrl(a.id))}
                          />
                        ) : (
                          <a href={attachmentDownloadUrl(a.id)} target="_blank" rel="noopener noreferrer">
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

      {/* Image Preview Modal */}
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