# Parser: Gemini

## Export Source

Google Takeout → "Gemini Apps" activity. The export is a `.zip` containing
a JSON file (typically under `My Activity/Gemini Apps/`) plus attachment
files in the same or nested directories.

## JSON Format

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

## Key Fields

| Field | Description |
|-------|-------------|
| `title` | User prompt, prefixed with a locale-specific label (e.g. `送信したメッセージ: `). The parser strips everything before the first colon. When the user sends only an image with no text, the title is just the label with an empty prompt (e.g. `送信したメッセージ: `). |
| `time` | ISO 8601 timestamp of this activity |
| `details[].url` | Contains the chat URL `https://gemini.google.com/app/{chatId}`. The chatId is extracted via regex `/\/app\/([0-9a-fA-F]+)/`. |
| `safeHtmlItem[].html` | Assistant reply as raw HTML. Rendered as-is in the UI (sanitized by DOMPurify on the frontend). |
| `subtitles[].name` | Original filename of an attachment (with a leading bullet). Maps to `subtitles[].url` which is the stored filename in the zip. |
| `attachedFiles[]` | Filenames of attachments as stored in the zip (relative to the JSON's directory). |
| `imageFile` | The primary image filename when the user sent an image. Always also appears in `attachedFiles`. |

## Multi-ChatId Records

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

## Parsing Steps

1. **Parse** the JSON array
2. **Extract chatIds** from each record's `details[].url`
3. **Group** records by chatId into buckets of `{ record, detailIndex }[]`
4. **Sort** each bucket by `time` ascending (Takeout is newest-first)
5. **Convert** each record to 1–2 messages (user prompt + assistant reply)
6. **Assemble** each bucket into a `Conversation` object

## Message ID Scheme

```
{chatId}-{time}-user
{chatId}-{time}-assistant
```

## Attachments

- `attachedFiles` lists filenames as stored in the zip
- `subtitles` maps each stored filename back to the original display name
- The parser produces `{ storedName, displayName }` pairs
- `ConversationService` locates the file in the zip via fuzzy matching,
  saves it to `storage/files/{platform}/{sha256}{ext}`, and creates an
  `Attachment` DB row keyed by `(messageId, contentHash)`

## Noise Filtering

Records without an extractable chatId (e.g. "previous feedback cleared")
are dropped during the grouping step. This is locale-independent — it
doesn't rely on matching noise entry title text.

## Image-Only Messages

When a user sends only an image with no accompanying text, the Takeout
record has an empty prompt after the locale-specific label:

```jsonc
{
  "title": "送信したメッセージ: ",   // empty prompt
  "subtitles": [
    { "name": "添付ファイル 1 件" },
    { "name": "-  screenshot.png", "url": "screenshot-abc123.png" }
  ],
  "imageFile": "screenshot-abc123.png",
  "attachedFiles": ["screenshot-abc123.png"],
  "safeHtmlItem": [{ "html": "<p>Reply to the image...</p>" }]
}
```

The parser handles this by creating a user message even when `title`
contains no text, as long as the record has attachments. The message
content is set to `[画像]` as a placeholder, and the attachments are
preserved normally.

## Streaming Import

When importing a Gemini zip, the backend uses `importFromZipGemini` instead
of the generic `importFromZip`. This avoids `JSON.parse` on the entire
Takeout file and instead processes records one by one:

### Flow

1. `GeminiParser.parseRecordStream(filePath)` uses `splitJsonArrayFile`
   to stream the JSON array, yielding one `TakeoutRecord` at a time
2. Each record is parsed, `chatId` extracted, and messages converted
3. `GeminiImporter.parseZipEntriesStreamed` iterates all JSON files in
   the zip, yielding `{ result: StreamedRecordResult, zipDir }` per record
4. `importFromZipGemini` processes each record within a `$transaction`:

   - **First encounter of chatId**: query DB for existing conversation
     - Exists → set `dbExists: true`, `dbUpdatedAt` = DB value
     - Not exists → set `dbExists: false`, `title` from this record
   - **Watermark skip**: if `dbExists && recordTime <= dbUpdatedAt`, skip
   - **Title tracking** (new conversations only): if a later record has
     an earlier `time`, its title replaces the current one (title should
     come from the first user message)
   - **Message upsert**: `tx.message.upsert` per message
   - **Attachment collection**: messages with attachments are added to
     `pendingAttachments` for post-transaction processing
5. After all records: batch `tx.conversation.upsert` for each chatId
6. After transaction commits: process `pendingAttachments` (file I/O
   outside the transaction)

### Watermark Logic

| Condition | Action |
|-----------|--------|
| `!dbExists` | Insert all messages; `updatedAt = max(recordTime)` |
| `dbExists && recordTime > dbUpdatedAt` | Insert message; update `updatedAt` |
| `dbExists && recordTime <= dbUpdatedAt` | Skip (already in DB) |

### Title Selection

For new conversations, the title is derived from the record with the
**earliest** `time` (the first user message). As records arrive in
Takeout order (newest-first), the title is updated whenever a record
with an earlier timestamp is encountered.

For existing conversations, the DB title is preserved (not overwritten).