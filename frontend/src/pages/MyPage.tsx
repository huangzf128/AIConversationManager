import { useEffect, useMemo, useState } from 'react';
import Sidebar from '../components/Sidebar';
import MainContent from '../components/MainContent';
import './MyPage.css';

export interface ConversationListItem {
  id: string;
  platform: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  hidden: boolean;
  _count: { messages: number };
}

export interface AttachmentItem {
  id: string;
  displayName: string;
}

export interface MessageItem {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  hidden: boolean;
  attachments: AttachmentItem[];
}

export interface ConversationDetail {
  id: string;
  platform: string;
  title: string;
  hidden: boolean;
  messages: MessageItem[];
}

const API_BASE = 'http://localhost:3000';

function MyPage() {
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Fetched conversation details, keyed by id, so re-selecting a
  // previously-opened conversation doesn't need to hit the network again.
  const [detailsCache, setDetailsCache] = useState<Record<string, ConversationDetail>>({});

  // Platform filter: an empty set means "show every platform".
  const [platformFilter, setPlatformFilter] = useState<Set<string>>(new Set());
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [chatIdSearch, setChatIdSearch] = useState('');
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/conversations`)
      .then((res) => res.json())
      .then(setConversations)
      .catch(() => setConversations([]));
  }, []);

  // Only fetches when the selected conversation isn't already cached; never
  // needs to synchronously clear state for the "nothing selected" case,
  // since `selected` below is derived rather than stored separately.
  useEffect(() => {
    if (!selectedId || detailsCache[selectedId]) return;
    fetch(`${API_BASE}/conversations/${selectedId}`)
      .then((res) => res.json())
      .then((detail: ConversationDetail) => {
        setDetailsCache((prev) => ({ ...prev, [selectedId]: detail }));
      });
  }, [selectedId, detailsCache]);

  const selected = selectedId ? (detailsCache[selectedId] ?? null) : null;
  const selectedLoading = Boolean(selectedId) && !selected;

  const platforms = useMemo(
    () => Array.from(new Set(conversations.map((c) => c.platform))).sort(),
    [conversations],
  );

  const visibleConversations = useMemo(() => {
    return conversations.filter((c) => {
      if (!showHidden && c.hidden) return false;
      if (platformFilter.size > 0 && !platformFilter.has(c.platform)) return false;
      if (dateFrom && c.updatedAt < dateFrom) return false;
      if (dateTo && c.updatedAt > `${dateTo}T23:59:59.999Z`) return false;
      if (chatIdSearch && !c.id.toLowerCase().includes(chatIdSearch.toLowerCase())) return false;
      return true;
    });
  }, [conversations, platformFilter, dateFrom, dateTo, chatIdSearch, showHidden]);

  const togglePlatform = (platform: string) => {
    setPlatformFilter((prev) => {
      const next = new Set(prev);
      if (next.has(platform)) {
        next.delete(platform);
      } else {
        next.add(platform);
      }
      return next;
    });
  };

  const handleToggleHidden = (id: string, hidden: boolean) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, hidden } : c)));
    setDetailsCache((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], hidden } } : prev));

    fetch(`${API_BASE}/conversations/${id}/hidden`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden }),
    }).catch(() => {
      // Revert on failure.
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, hidden: !hidden } : c)));
      setDetailsCache((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], hidden: !hidden } } : prev));
    });
  };

  const handleToggleMessageHidden = (messageId: string, hidden: boolean) => {
    if (!selectedId) return;

    setDetailsCache((prev) => {
      const current = prev[selectedId];
      if (!current) return prev;
      return {
        ...prev,
        [selectedId]: {
          ...current,
          messages: current.messages.map((m) => (m.id === messageId ? { ...m, hidden } : m)),
        },
      };
    });

    fetch(`${API_BASE}/conversations/${selectedId}/messages/${messageId}/hidden`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden }),
    }).catch(() => {
      // Revert on failure.
      setDetailsCache((prev) => {
        const current = prev[selectedId];
        if (!current) return prev;
        return {
          ...prev,
          [selectedId]: {
            ...current,
            messages: current.messages.map((m) => (m.id === messageId ? { ...m, hidden: !hidden } : m)),
          },
        };
      });
    });
  };

  return (
    <div className="my-page">
      <Sidebar
        conversations={visibleConversations}
        platforms={platforms}
        activePlatforms={platformFilter}
        onTogglePlatform={togglePlatform}
        dateFrom={dateFrom}
        dateTo={dateTo}
        onDateFromChange={setDateFrom}
        onDateToChange={setDateTo}
        chatIdSearch={chatIdSearch}
        onChatIdSearchChange={setChatIdSearch}
        showHidden={showHidden}
        onToggleShowHidden={() => setShowHidden((prev) => !prev)}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onToggleHidden={handleToggleHidden}
      />
      <MainContent
        key={selectedId}
        conversation={selected}
        loading={selectedLoading}
        onToggleMessageHidden={handleToggleMessageHidden}
      />
    </div>
  );
}

export default MyPage;