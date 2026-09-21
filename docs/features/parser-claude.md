# Parser: Claude

## Export Source

Account Settings → Privacy → Export data. Produces a `conversations.json`
file.

## JSON Format

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
        "text": "What is recursion?",
        "parent_message_uuid": "00000000-0000-4000-8000-000000000000"
      },
      {
        "uuid": "msg-002",
        "sender": "assistant",
        "created_at": "2024-01-15T10:00:05.000Z",
        "text": "Recursion is...",
        "parent_message_uuid": "msg-001",
        "content": [
          { "type": "thinking", "thinking": "Let me reason about..." },
          { "type": "text", "text": "Recursion is..." }
        ]
      }
    ]
  }
]
```

## Key Fields

| Field | Description |
|-------|-------------|
| `uuid` | Conversation and message identifier. Used as DB primary key. |
| `name` | Conversation title |
| `chat_messages[].sender` | `"human"` or `"assistant"` |
| `chat_messages[].text` | Message content in markdown |
| `chat_messages[].parent_message_uuid` | Parent message UUID; root messages use the sentinel `00000000-0000-4000-8000-000000000000`. Enables branching (edit/regenerate). |
| `chat_messages[].content[]` | Array of typed content blocks (e.g. `thinking`, `text`, `tool_use`, `tool_result`) |
| `chat_messages[].files[]` | Attached file metadata (`file_uuid`, `file_name`) |

## Message Tree & Branching

Claude's export uses `parent_message_uuid` to form a **tree** — the same
model as DeepSeek's `mapping` / ChatGPT's tree structure. When a user
edits a message or regenerates a response, multiple sibling messages share
the same `parent_message_uuid`, creating a branch.

The parser walks this tree via BFS from the root sentinel, building a
`parentMessageId` chain for each output message. The frontend uses this
chain to render branch switchers (◀ 1/3 ▶) when siblings exist.

If `parent_message_uuid` is absent from all messages (older exports), the
parser falls back to a simple linear sort by `created_at`.

## Thinking Content

Assistant messages may include a `content` array with blocks of
`type: "thinking"`. The parser extracts these, joins them, and wraps
the result in a `thinking` code fence — the same format used by the
DeepSeek parser:

```
```thinking
Let me reason about...
```

Recursion is...
```

This thinking content is prepended to the main `text` field.

## Attachments

Claude's export includes file metadata (`file_uuid`, `file_name`) in the
`files` array on each message, but **does not include actual file
content**. The import flow skips zip lookup (`skipAttachmentFiles: true`)
and creates DB attachment records with `size: 0`. On the frontend, Claude
attachments render as non-clickable text to avoid 404 errors.

Messages that have files but no text (e.g. a user uploads a file without
comment) are preserved — the parser generates a placeholder content like
`[Attached: filename.txt]` so the message is not silently dropped.

## Unsupported Blocks

Claude's export may include fenced placeholder blocks for thinking, tool
use, memory reads, etc.:

    ```This block is not supported on your current device yet.```

The parser strips these (both fenced and bare forms) before storing.

## Deleted Conversations

When a conversation is deleted in Claude, the export may still contain a
**shell entry** — an object with only `uuid` and no `name`, `chat_messages`,
or timestamps. These are remnants of deleted conversations and carry no
useful content.

The parser skips these by checking `name`:
- If `name` is empty or missing → conversation is skipped (returns `null`)

This filter is applied **before** the message tree walk, so deleted
conversations are discarded early without any processing overhead.

## Empty Messages

Claude's message tree may contain **empty nodes** — messages where both
`text` is `""` and `content` is `[]`, with no attachments. These are
internal tree structure placeholders (e.g. abandoned regenerations).

The parser skips these in `toMessage()`:
- If `text` is blank **and** there are no attachments → message is
  skipped (returns `null`)

## Parsing Steps

1. Parse the JSON array
2. For each conversation:
   - Skip if `uuid` is missing (cannot match across re-imports)
   - Skip if `name` is empty or missing (deleted conversation shell)
   - If `parent_message_uuid` is present: walk the message tree via BFS
     from the root sentinel, building `parentMessageId` chains for
     branching support
   - Otherwise: fall back to sorting `chat_messages` by `created_at`
   - Map `sender: "human"` → `role: "user"`
   - Extract thinking content from `content[]` blocks
   - Parse `files[]` as attachments; preserve file-only messages
   - Strip unsupported blocks
   - Skip messages with no text and no attachments (empty tree nodes)