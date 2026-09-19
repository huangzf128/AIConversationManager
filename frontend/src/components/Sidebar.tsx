import { useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import './Sidebar.css';
import { EyeIcon, UploadIcon, StarIcon } from './Icons';
import ToggleSwitch from './ToggleSwitch.js';
import type { ConversationListItem } from '../pages/MyPage';

interface SidebarProps {
  conversations: ConversationListItem[];
  platforms: string[];
  activePlatforms: Set<string>;
  onTogglePlatform: (platform: string) => void;
  dateFrom: string;
  dateTo: string;
  onDateFromChange: (value: string) => void;
  onDateToChange: (value: string) => void;
  chatIdSearch: string;
  onChatIdSearchChange: (value: string) => void;
  showHidden: boolean;
  onToggleShowHidden: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggleHidden: (id: string, hidden: boolean) => void;
  onToggleStarred: (id: string, starred: boolean) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function Sidebar({
  conversations,
  platforms,
  activePlatforms,
  onTogglePlatform,
  dateFrom,
  dateTo,
  onDateFromChange,
  onDateToChange,
  chatIdSearch,
  onChatIdSearchChange,
  showHidden,
  onToggleShowHidden,
  selectedId,
  onSelect,
  onToggleHidden,
  onToggleStarred,
  hasMore,
  loadingMore,
  onLoadMore,
}: SidebarProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el || !hasMore || loadingMore) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
      onLoadMore();
    }
  }, [hasMore, loadingMore, onLoadMore]);
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-brand">Archive</div>
        <Link
          to="/upload"
          className="sidebar-import-link"
          title="Import or update conversation export files"
        >
          <UploadIcon />
          <span>Import</span>
        </Link>
      </div>

      <div className="sidebar-filters">
        <div className="filter-chips">
          {platforms.map((platform) => (
            <button
              key={platform}
              type="button"
              className={`chip chip-${platform} ${activePlatforms.has(platform) ? 'chip-active' : ''}`}
              onClick={() => onTogglePlatform(platform)}
            >
              <span className="chip-dot" />
              {platform}
            </button>
          ))}
        </div>

        <div className="filter-dates">
          <label>
            From
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => onDateFromChange(e.target.value)}
            />
          </label>
          <label>
            To
            <input type="date" value={dateTo} onChange={(e) => onDateToChange(e.target.value)} />
          </label>
        </div>

        <div className="filter-chatid">
          <label>
            Search by Chat ID
            <div className="filter-chatid-input-wrap">
              <input
                type="text"
                value={chatIdSearch}
                onChange={(e) => onChatIdSearchChange(e.target.value)}
                placeholder="Enter chat ID to search..."
              />
              {chatIdSearch && (
                <button
                  type="button"
                  className="filter-chatid-clear"
                  onClick={() => onChatIdSearchChange('')}
                >
                  ×
                </button>
              )}
            </div>
          </label>
        </div>

        <div className="toggle-switch-wrapper">
          <ToggleSwitch
            checked={showHidden}
            onChange={onToggleShowHidden}
            label="Show hidden conversations"
          />
        </div>
      </div>

      <div className="conversation-list" ref={listRef} onScroll={handleScroll}>
        {conversations.length === 0 && (
          <p className="empty-state">No conversations match these filters.</p>
        )}
        {conversations.map((conversation) => (
          <div
            key={conversation.id}
            role="button"
            tabIndex={0}
            className={[
              'conversation-row',
              selectedId === conversation.id ? 'conversation-row-active' : '',
              conversation.hidden ? 'conversation-row-hidden' : '',
            ].join(' ')}
            onClick={() => onSelect(conversation.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onSelect(conversation.id);
            }}
          >
            <span className={`row-dot row-dot-${conversation.platform}`} />
            <span className="row-body">
              <span className="row-title">{conversation.title}</span>
              <span className="row-meta">
                {conversation.platform} · {conversation._count.messages} messages ·{' '}
                {formatDate(conversation.updatedAt)}
              </span>
            </span>
            <span
              className={`icon-button row-star-button ${conversation.starred ? 'row-star-button-active' : ''}`}
              role="button"
              tabIndex={0}
              title={conversation.starred ? 'Unstar conversation' : 'Star conversation'}
              onClick={(e) => {
                e.stopPropagation();
                onToggleStarred(conversation.id, !conversation.starred);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  onToggleStarred(conversation.id, !conversation.starred);
                }
              }}
            >
              <StarIcon starred={conversation.starred} />
            </span>
            <span
              className="icon-button row-hide-button"
              role="button"
              tabIndex={0}
              title={conversation.hidden ? 'Unhide conversation' : 'Hide conversation'}
              onClick={(e) => {
                e.stopPropagation();
                onToggleHidden(conversation.id, !conversation.hidden);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  onToggleHidden(conversation.id, !conversation.hidden);
                }
              }}
            >
              <EyeIcon hidden={conversation.hidden} />
            </span>
          </div>
        ))}
        {loadingMore && <div className="loading-more">Loading…</div>}
      </div>
    </aside>
  );
}

export default Sidebar;
