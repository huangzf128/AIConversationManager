# Parser: ChatGPT

## Export Source

Settings → Data Controls → Export Data. Produces an `OpenAI-export.zip`
containing a nested zip structure.

## Zip Structure

```
OpenAI-export.zip
└── User Online Activity/
    └── Conversations__{hash}-chatgpt-0001.zip   ← inner zip
        ├── conversations-001.json
        ├── conversations-002.json
        ├── ...
        ├── conversation_asset_file_names.json
        ├── library_files.json
        ├── file_00000000xxxx.dat               ← attachment files
        └── ...
```

The outer zip contains one or more inner zips under `User Online Activity/`.
Each inner zip holds conversation JSON files, attachment `.dat` files, and
metadata files. The parser recursively flattens nested zips so inner files
are accessed via virtual paths like
`User Online Activity/Conversations__xxx.zip/conversations-001.json`.

## JSON Format

Each `conversations-xxx.json` is a **flat array** of conversation objects.
Messages are stored as a **tree** (not a flat list) to support edit /
regenerate branches:

```jsonc
[
  {
    "id": "6a7874a8-d5b8-83e8-9975-9e74995f828d",
    "title": "My Conversation",
    "create_time": 1786279737.515,
    "update_time": 1786279800.123,
    "current_node": "node-leaf-id",
    "mapping": {
      "node-id-1": {
        "id": "node-id-1",
        "message": {
          "id": "msg-001",
          "author": { "role": "user" },
          "content": {
            "content_type": "text",
            "parts": ["Hello!"]
          },
          "create_time": 1786279737.515,
          "end_turn": null,
          "metadata": { "attachments": [] }
        },
        "parent": null,
        "children": ["node-id-2"]
      },
      "node-id-2": {
        "id": "node-id-2",
        "message": {
          "id": "msg-002",
          "author": { "role": "assistant" },
          "content": {
            "content_type": "text",
            "parts": ["Hi there!"]
          },
          "create_time": 1786279740.0,
          "end_turn": true,
          "metadata": {}
        },
        "parent": "node-id-1",
        "children": []
      }
    }
  }
]
```

## Key Fields

| Field | Description |
|-------|-------------|
| `id` | Conversation identifier (UUID) |
| `title` | Conversation title |
| `create_time` / `update_time` | Unix epoch (seconds, fractional) |
| `current_node` | The leaf node of the currently selected branch |
| `mapping` | Map of node-id → node object forming the message tree |
| `mapping[id].message.author.role` | `"user"`, `"assistant"`, or `"system"` |
| `mapping[id].message.content.parts` | Array of strings and/or objects (images) |
| `mapping[id].message.end_turn` | `true` marks the last fragment of a logical assistant reply |
| `mapping[id].parent` | Parent node id (null for root) |
| `mapping[id].children` | Child node ids (multiple = branching point) |

## Message Tree Traversal

ChatGPT stores messages as a tree to support edit and regenerate. The
parser reconstructs the currently selected branch by:

1. Starting from `current_node`, walk up via `parent` to the root
2. Reverse to get root → leaf path
3. Walk the path, converting each node to a `ConversationMessage`

### Branch Selection

When a user edits a message, the original and edited messages share the
same parent but have different node ids. The tree walk follows
`current_node`'s path, so only the selected branch is imported.

### Assistant Reply Merging

A single logical assistant reply may span multiple consecutive nodes
(e.g. text → tool call → text). The parser merges these fragments into
one message, buffering until `end_turn === true` (or the
`finish_details.stop_tokens` sentinel `200002` is seen).

## Content Types

### text

```json
{ "content_type": "text", "parts": ["Hello!"] }
```

Plain string parts are joined with `\n`.

### multimodal_text

```json
{
  "content_type": "multimodal_text",
  "parts": [
    "Here is the image:",
    {
      "content_type": "image_asset_pointer",
      "asset_pointer": "sediment://file_00000000abc123",
      "height": 512, "width": 512
    }
  ]
}
```

Image pointers reference attachment files. The `asset_pointer` prefix
(`sediment://` or `file-service://`) is stripped to get the `fileId`.
The actual file in the zip is named `{fileId}.dat`.

### thoughts / reasoning_recap

These content types appear in reasoning models (o1, o3, etc.). They may
contain `null` parts or non-string objects. The parser filters out `null`
parts and skips non-recognized object types silently.

## Attachments

### From content.parts (image_asset_pointer)

Images embedded inline in multimodal_text are extracted from
`content.parts`:

```
asset_pointer: "sediment://file_00000000abc123"
  → storedName: "file_00000000abc123.dat"
  → displayName: from metadata.attachments[id].name ?? fileId
```

### From metadata.attachments (non-image files)

Non-image attachments (txt, log, sql, md, css, 7z, etc.) appear in
`metadata.attachments` but have no `image_asset_pointer` in `parts`:

```json
{
  "metadata": {
    "attachments": [{
      "id": "file_00000000def456",
      "name": "report.txt",
      "mime_type": "text/plain"
    }]
  }
}
```

The parser adds these after processing `image_asset_pointer` entries,
deduplicating by `storedName`.

### Empty-text messages with attachments

When AI calls a tool (e.g. DALL-E) and the reply has no text
(`parts: [""]`) but does have attachments, the message is preserved
rather than filtered out. This ensures tool-call results are not lost.

## DALL-E Image Supplementation

ChatGPT's export may **omit** DALL-E-generated images from the
conversation JSON. This happens when:

- The user edits a message after the image was generated, causing the
  AI's reply (including the image) to fall off the `current_node` path
- The AI's reply message is completely absent from the `mapping`

These "orphan" DALL-E images are recovered from `library_files.json`:

```jsonc
[
  {
    "file_id": "file_00000000cfb88207acd32e46d5e32aef",
    "file_name": "generated-image.png",
    "image_gen_generation_id": "s_9a99d456...",  // marks as DALL-E
    "origination_thread_id": "6a7874a8-...",     // → conversation id
    "origination_message_id": "79503492-...",    // → message id (may be absent)
    "file_upload_time": "2026-08-09T12:49:58Z"   // → insertion position
  }
]
```

The supplementation logic (`supplementDalleAttachments` in
`ConversationService`):

1. Parse `library_files.json`, collect entries with
   `image_gen_generation_id` and `origination_thread_id`
2. For each conversation, find DALL-E files whose
   `origination_thread_id` matches the conversation id
3. Skip files already present as attachments (dedup)
4. For each missing file:
   - If `origination_message_id` matches an existing message → attach
     the file there (and set content to `[图片]` if empty)
   - Otherwise → **insert a new assistant message** with content
     `[图片]` at the correct position:
     1. Look up `origination_message_id` in the raw mapping to find its
        parent message (the user message that triggered DALL-E), then
        insert after that parent message
     2. Fall back to time-based insertion using `file_upload_time` if
        the parent message cannot be resolved from the mapping
5. Insertions are applied in reverse index order to preserve positions

Note: chronological ordering (`ensureChronologicalOrder`) is applied
**after** DALL-E supplementation so that the insertion logic can use
original timestamps for accurate positioning.

## Message ID Scheme

```
{conversationId}-{message.id}
```

ChatGPT message ids are only unique within a conversation. Prefixing with
the conversation id ensures global uniqueness across the DB.

For supplemented DALL-E messages (no original message id):

```
{conversationId}-dalle-{fileId}
```

## Incremental Import

Conversations are upserted based on `id`. The `updatedAt` watermark is
derived from the last message's `createdAt`. On re-import, conversations
whose `updatedAt` has not changed are skipped entirely (no messages
deleted or re-created).

When a conversation **has** changed, all its existing messages and
attachments are deleted and re-created from scratch. This avoids complex
diff logic and ensures consistency.

## Noise Filtering

- Messages without an `id` are skipped (with a log warning)
- Messages with unrecognized `author.role` values are skipped
- Empty-text messages without attachments are skipped
- Conversations with zero messages after filtering are skipped