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

## Key Fields

| Field | Description |
|-------|-------------|
| `uuid` | Conversation and message identifier. Used as DB primary key. |
| `name` | Conversation title |
| `chat_messages[].sender` | `"human"` or `"assistant"` |
| `chat_messages[].text` | Message content in markdown |

## Unsupported Blocks

Claude's export may include fenced placeholder blocks for thinking, tool
use, memory reads, etc.:

    ```This block is not supported on your current device yet.```

The parser strips these (both fenced and bare forms) before storing.

## Parsing Steps

1. Parse the JSON array
2. For each conversation: sort `chat_messages` by `created_at`, map
   `sender: "human"` → `role: "user"`, strip unsupported blocks
3. Skip conversations without a `uuid` (cannot match across re-imports)