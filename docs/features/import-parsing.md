# Import & Parsing

This document describes how uploaded export files are parsed and persisted
for each supported AI platform.

## Upload Flow

The frontend sends a `POST /conversations/upload` request with:

- `file` — the export file (`.json` or `.zip`)
- `platform` — one of `gemini`, `chatgpt`, `claude`, `deepseek`
- `syncDelete` — if `"true"`, conversations in DB but absent from the
  export are deleted (starred conversations are always kept)

The backend dispatches to either `importFromFile` (`.json`) or
`importFromZip` (`.zip`), then runs the platform-specific parser and
persists the results.

## Zip Handling

When a `.zip` is uploaded:

1. Every `.json` entry inside the zip is tried against the platform's
   parser. Entries that don't match the expected shape yield zero
   conversations and are silently skipped. This avoids relying on
   localized folder names inside the export.
2. The directory of each JSON entry is recorded so that attachment
   filenames (which are relative to that directory) can be resolved.
3. A fuzzy-entry map is built from all non-directory zip entries to
   handle filename variations: different extensions, `(N)` duplicate
   suffixes added by the OS, and dots in filenames that confuse
   `path.extname`. Attachment lookup uses tiered matching (exact →
   fuzzy-prefix → stripped-suffix).

## DB Sync Strategy

Gemini conversations are **append-only**: messages cannot be edited or
deleted, only added. The import logic exploits this:

| Condition | Action |
|-----------|--------|
| `json.updatedAt <= db.updatedAt` | Skip entirely — nothing new |
| `!existing` in DB | `create` conversation + nested `messages.create` |
| `json.updatedAt > db.updatedAt` | Update `title`/`updatedAt` on conversation; only `createMany` messages whose `createdAt > db.updatedAt` |

User-controlled fields (`starred`, `hidden` on conversations; `hidden` on
messages) are **never overwritten** by import, so manual choices survive
re-imports.

### Sync Delete

When `syncDelete` is enabled:

1. Fetch only `id` from DB for the platform where `starred = false`
   (lightweight query, no SQLite parameter limit issues)
2. Filter in JS: `toDeleteIds = dbIds - importedIds`
3. Batch-fetch full records (with attachments) in chunks of 900 to stay
   under SQLite's 999 `SQLITE_MAX_VARIABLE_NUMBER` limit
4. Delete attachment files from disk, then delete the conversation
   (cascade removes messages + attachment DB rows)

---

## Platform: Gemini

### Export Source

Google Takeout → "Gemini Apps" activity. The export is a `.zip` containing
a JSON file (typically under `My Activity/Gemini Apps/`) plus attachment
files in the same or nested directories.

### JSON Format

The JSON is a **flat array** of activity records — each record represents
a single user prompt **or** a single assistant reply, not a complete
conversation:

```jsonc
[
  {
    "header": "Gemini アプリ",
    "title": "送信したメッセージ: What is recursion?",
    "time": "2024-01-15T10:00:00.000Z",
    "products": ["Gemini アプリ"],
    "details": [{
      "name": "https://gemini.google.com/app/9d0b8ac907c407f0",
      "url": "https://gemini.google.com/app/9d0b8ac907c407f0"
    }],
    "activityControls": ["Gemini アプリ アクティビティ"],
    "safeHtmlItem": [{
      "html": "<p>Recursion is...</p>"
    }],
    "subtitles": [{ "name": "-  diagram.png", "url": "diagram-abc123.png" }],
    "attachedFiles": ["diagram-abc123.png"]
  },
  // ... more records
]
```

### Key Fields

| Field | Description |
|-------|-------------|
| `title` | User prompt, prefixed with a locale-specific label (e.g. `送信したメッセージ: `). The parser strips everything before the first colon. |
| `time` | ISO 8601 timestamp of this activity |
| `details[].url` | Contains the chat URL `https://gemini.google.com/app/{chatId}`. The chatId is extracted via regex `/\/app\/([0-9a-fA-F]+)/`. |
| `safeHtmlItem[].html` | Assistant reply as raw HTML. Rendered as-is in the UI (sanitized by DOMPurify on the frontend). |
| `subtitles[].name` | Original filename of an attachment (with a leading bullet). Maps to `subtitles[].url` which is the stored filename in the zip. |
| `attachedFiles[]` | Filenames of attachments as stored in the zip (relative to the JSON's directory). |

### Multi-ChatId Records

Google may aggregate near-simultaneous edits across multiple chats into a
single activity record. In this case:

- `details` contains **multiple** chat URLs (one per chat)
- `safeHtmlItem` contains **multiple** HTML replies (one per chat)
- `title` contains only **one** user prompt (the shared edit text)

The parser handles this by:

1. `extractChatIds` returns **all** chatIds from `details`
2. Each `(record, detailIndex)` pair is grouped into its respective chat
3. `toMessages` uses `safeHtmlItem[detailIndex]` to pick the correct
   reply for each chat

### Parsing Steps

1. **Parse** the JSON array
2. **Extract chatIds** from each record's `details[].url`
3. **Group** records by chatId into buckets of `{ record, detailIndex }[]`
4. **Sort** each bucket by `time` ascending (Takeout is newest-first)
5. **Convert** each record to 1–2 messages (user prompt + assistant reply)
6. **Assemble** each bucket into a `Conversation` object

### Message ID Scheme

```
{chatId}-{time}-user
{chatId}-{time}-assistant
```

### Attachments

- `attachedFiles` lists filenames as stored in the zip
- `subtitles` maps each stored filename back to the original display name
- The parser produces `{ storedName, displayName }` pairs
- `ConversationService` locates the file in the zip via fuzzy matching,
  saves it to `storage/files/{platform}/{sha256}{ext}`, and creates an
  `Attachment` DB row keyed by `(messageId, contentHash)`

### Noise Filtering

Records without an extractable chatId (e.g. "previous feedback cleared")
are dropped during the grouping step. This is locale-independent — it
doesn't rely on matching noise entry title text.

---

## Platform: Claude

### Export Source

Account Settings → Privacy → Export data. Produces a `conversations.json`
file.

### JSON Format

An **array of conversation objects**, each containing its messages inline:

```jsonc
[
  {
    "uuid": "abc-123-def",
    "name": "My Conversation",
    "created_at": "2024-01-15T10:00:00.000Z",
    "updated_at": "2024-01-15T10:05:00.000Z",
    "chat_messages": [
      {
        "uuid": "msg-001",
        "sender": "human",
        "created_at": "2024-01-15T10:00:00.000Z",
        "text": "What is recursion?"
      },
      {
        "uuid": "msg-002",
        "sender": "assistant",
        "created_at": "2024-01-15T10:00:05.000Z",
        "text": "Recursion is..."
      }
    ]
  }
]
```

### Key Fields

| Field | Description |
|-------|-------------|
| `uuid` | Conversation and message identifier. Used as DB primary key. |
| `name` | Conversation title |
| `chat_messages[].sender` | `"human"` or `"assistant"` |
| `chat_messages[].text` | Message content in markdown |

### Unsupported Blocks

Claude's export may include fenced placeholder blocks for thinking, tool
use, memory reads, etc.:

    ```This block is not supported on your current device yet.```

The parser strips these (both fenced and bare forms) before storing.

### Parsing Steps

1. Parse the JSON array
2. For each conversation: sort `chat_messages` by `created_at`, map
   `sender: "human"` → `role: "user"`, strip unsupported blocks
3. Skip conversations without a `uuid` (cannot match across re-imports)

---

## Platform: ChatGPT

**Not yet implemented.** The parser exists but returns an empty array.
Expected export format: `conversations.json` from ChatGPT settings.

---

## Platform: DeepSeek

### Export Source

Settings → Download Data. Produces a `conversations.json` file (plain JSON,
not a zip).

### JSON Format

A **flat array** of conversation objects. Messages are stored as a **tree**
(same structure as ChatGPT) to support edit / regenerate branches:

```jsonc
[
  {
    "id": "9594303f-3319-4ec0-8767-c9e2725ac07b",
    "title": "三国",
    "inserted_at": "2025-01-29T15:55:28.250000+08:00",
    "updated_at": "2025-01-29T15:55:28.250000+08:00",
    "mapping": {
      "root": {
        "id": "root", "parent": null, "children": ["1"], "message": null
      },
      "1": {
        "id": "1", "parent": "root", "children": ["2"],
        "message": {
          "model": "deepseek-reasoner",
          "inserted_at": "2025-01-29T15:55:28.533000+08:00",
          "fragments": [
            { "type": "REQUEST", "content": "三国里，翼州是现在的什么地方" }
          ]
        }
      },
      "2": {
        "id": "2", "parent": "1", "children": [],
        "message": {
          "model": "deepseek-reasoner",
          "inserted_at": "2025-01-29T15:55:28.533000+08:00",
          "fragments": [
            { "type": "THINK", "content": "好的，用户问的是..." },
            { "type": "RESPONSE", "content": "三国时期的冀州..." }
          ]
        }
      }
    }
  }
]
```

### Key Fields

| Field | Description |
|-------|-------------|
| `id` | Conversation identifier (UUID) |
| `title` | Conversation title |
| `inserted_at` / `updated_at` | ISO 8601 timestamp with timezone offset |
| `mapping` | Map of node-id → node object forming the message tree |
| `mapping[id].message.fragments[]` | Array of typed content fragments |

### Fragment Types

| Type | Description |
|------|-------------|
| `REQUEST` | User prompt → `user` message |
| `RESPONSE` | Assistant reply → `assistant` message body |
| `THINK` | DeepSeek-R1 reasoning chain → wrapped in `-thinking` code block, prepended to RESPONSE |
| `SEARCH` / `TOOL_SEARCH` | Web search results → formatted as numbered reference list, appended to assistant message |
| `FILE` | Uploaded file metadata (no actual file content in export) → attachment record |
| `TOOL_OPEN` | No useful content → silently skipped |

### Message Tree Traversal

Same tree structure as ChatGPT. The parser walks from root through
`children[0]` to reconstruct the main conversation path. A single node
may carry both REQUEST and RESPONSE fragments, which are split into
separate user and assistant messages.

### Timestamp Ordering

DeepSeek's export often gives RESPONSE nodes timestamps a few milliseconds
**earlier** than their REQUEST siblings. The parser corrects this with
`ensureChronologicalOrder()` so the UI displays messages in the correct
order.

### Attachments

DeepSeek's export only contains file metadata (`file_id`, `file_name`,
`file_size`) — actual file content is **not included**. The import flow
skips zip lookup and creates DB attachment records with `storagePath: ""`
and `size: 0`. On the frontend, DeepSeek attachments render as
non-clickable text to avoid 404 errors.

### Message ID Scheme

```
{conversationId}-{nodeId}-user
{conversationId}-{nodeId}-assistant
```

---

## Attachment Storage

Attachments are saved to disk under `storage/files/{platform}/`, named by
their SHA-256 content hash plus original extension. This deduplicates
identical files across re-imports. The DB stores only the filename; the
backend resolves the full path using the platform subdirectory.

On sync-delete, attachment files are removed from disk before the DB
record is deleted.