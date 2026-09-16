# Parser: DeepSeek

## Export Source

Settings → Download Data. Produces a `conversations.json` file (plain JSON,
not a zip).

## JSON Format

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
        "id": "root",
        "parent": null,
        "children": ["1"],
        "message": null
      },
      "1": {
        "id": "1",
        "parent": "root",
        "children": ["2"],
        "message": {
          "model": "deepseek-reasoner",
          "inserted_at": "2025-01-29T15:55:28.533000+08:00",
          "fragments": [
            { "type": "REQUEST", "content": "三国里，翼州是现在的什么地方" }
          ]
        }
      },
      "2": {
        "id": "2",
        "parent": "1",
        "children": ["4"],
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

## Key Fields

| Field | Description |
|-------|-------------|
| `id` | Conversation identifier (UUID) |
| `title` | Conversation title |
| `inserted_at` / `updated_at` | ISO 8601 timestamp with timezone offset |
| `mapping` | Map of node-id → node object forming the message tree |
| `mapping[id].message.model` | Model name (e.g. `deepseek-reasoner`, `deepseek-chat`) |
| `mapping[id].message.fragments[]` | Array of typed content fragments (see below) |
| `mapping[id].parent` | Parent node id (null for root) |
| `mapping[id].children` | Child node ids (multiple = branching point) |

## Fragment Types

Each node's `message.fragments` is an array of typed fragments. A single
node can carry multiple fragments (e.g. REQUEST + FILE on the user node,
or THINK + RESPONSE on the assistant node).

### REQUEST — User Prompt

```json
{ "type": "REQUEST", "content": "What is recursion?" }
```

Becomes a `user` message.

### RESPONSE — Assistant Reply

```json
{ "type": "RESPONSE", "content": "Recursion is..." }
```

Becomes the main body of an `assistant` message.

### THINK — Reasoning Chain (DeepSeek-R1)

```json
{ "type": "THINK", "content": "Let me think about this..." }
```

DeepSeek-R1 models produce a reasoning chain before the final answer.
The parser wraps THINK content in a `-thinking` code block and prepends
it to the RESPONSE content:

```markdown
-thinking
Let me think about this...

Recursion is...
```

The frontend can optionally render the `-thinking` block differently
(e.g. collapsible).

### SEARCH / TOOL_SEARCH — Web Search Results

```json
{
  "type": "SEARCH",
  "results": [
    { "url": "https://example.com/page1", "title": "Page 1" },
    { "url": "https://example.com/page2", "title": "Page 2" }
  ]
}
```

Search results are formatted as a numbered reference list and appended
to the assistant message content:

```
[1] Page 1 (https://example.com/page1)
[2] Page 2 (https://example.com/page2)
```

`TOOL_SEARCH` has the same shape and is handled identically.

### FILE — Uploaded Files

```json
{
  "type": "FILE",
  "files": [
    { "file_id": "a94b5ef1-...", "file_name": "report.sql", "file_size": 52860 }
  ]
}
```

**Important:** DeepSeek's export only contains file metadata (`file_id`,
`file_name`, `file_size`). The actual file content is **not included** in
the export — it remains on DeepSeek's servers and cannot be retrieved.

The parser creates attachment records with:
- `storedName` = `file_id` (UUID)
- `displayName` = `file_name`

On the frontend, DeepSeek attachments are rendered as **plain text**
(non-clickable) to avoid 404 errors when clicking a download link for
a file that doesn't exist. The attachment name is still visible so users
can see what files were uploaded in the original conversation.

### TOOL_OPEN — Tool Open

```json
{ "type": "TOOL_OPEN" }
```

Carries no useful content. Silently skipped by the parser.

## Message Tree Traversal

DeepSeek uses the same tree structure as ChatGPT to support message
editing and regeneration. The parser reconstructs the main conversation
path by:

1. Finding the root node (`parent == null`)
2. Walking down through `children[0]` at each node (the first child
   represents the main path; siblings are alternate edits)
3. Converting each node's fragments into `ConversationMessage`(s)

### Node-to-Message Splitting

A single node may carry both REQUEST and RESPONSE fragments. The parser
splits these into separate messages:

- REQUEST fragments → one `user` message
- THINK + RESPONSE + SEARCH fragments → one `assistant` message

If a node has only REQUEST (no RESPONSE), only a user message is
produced. If it has only RESPONSE (no REQUEST), only an assistant
message is produced.

### Timestamp Ordering

DeepSeek's export often gives the REQUEST and RESPONSE nodes nearly
identical `inserted_at` values, with the RESPONSE timestamp a few
milliseconds **earlier** than the REQUEST timestamp. Since the UI sorts
messages by `createdAt`, this would place the assistant reply before the
user prompt.

The parser fixes this with `ensureChronologicalOrder()`: after building
the message list in tree-traversal order (which is correct), it walks
the list and ensures each message's `createdAt` is not earlier than the
preceding message's. This preserves the correct display order without
altering the original timestamps more than necessary.

## Message ID Scheme

```
{conversationId}-{nodeId}-user
{conversationId}-{nodeId}-assistant
```

A single node may produce both a user and an assistant message, so the
role suffix ensures uniqueness.

## Attachments

Since DeepSeek's export does not include actual file content, the import
flow in `ConversationService` handles DeepSeek attachments specially:

- **Other platforms**: Look up the file in the zip, save to disk, create
  a DB row with `storagePath` and `contentHash`
- **DeepSeek**: Skip zip lookup entirely. Create a DB row with
  `storagePath: ""`, `size: 0`, and `contentHash: file_id`. The
  attachment exists only as a metadata record (display name) — no file
  on disk.

On the frontend, DeepSeek attachments are rendered as non-clickable
text (`<span>`) styled with muted color, instead of the usual
downloadable `<a>` link. This prevents 404 errors and avoids confusing
users into thinking it's a bug.

## Noise Filtering

- Conversations without an `id` are skipped
- Nodes without `message` or without `fragments` are skipped
- Conversations with zero messages after filtering are skipped
- TOOL_OPEN fragments are silently ignored