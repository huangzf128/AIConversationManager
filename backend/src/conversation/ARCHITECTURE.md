# ZIP Import Architecture

## Directory Structure

```
conversation/
├── chatgpt/
│   ├── chatgpt.importer.ts      # ZIP import logic (filtering, library_files, DALL·E attachments)
│   ├── chatgpt.parser.ts        # JSON parsing (parse / parseOne / parseReadStream)
│   └── chatgpt.parser.spec.ts
├── claude/
│   ├── claude.importer.ts
│   └── claude.parser.ts
├── deepseek/
│   ├── deepseek.importer.ts
│   └── deepseek.parser.ts       # parseStream (string scanning) + parseReadStream (file stream)
├── gemini/
│   ├── gemini.importer.ts
│   └── gemini.parser.ts
├── utils/
│   ├── streaming-json-splitter.ts   # Streaming JSON array splitting state machine
│   └── zip-utils.ts                 # ZIP extraction, fuzzy matching index
├── conversation.service.ts      # General import flow (extract → parse → persist → attachments)
└── conversation.module.ts
```

## Import Flow

```
User uploads zip
    │
    ▼
conversation.service.importFromZip(platform, zipBuffer)
    │
    ├─ 1. extractZipToTempDir(zipBuffer, filters)
    │     ├─ adm-zip extracts to temp directory
    │     ├─ expandNestedZips()          ← shouldExpandZip filter
    │     └─ collectFiles()              ← shouldParseJson filter
    │     Returns: { tempDir, allFiles[], jsonFiles[] }
    │
    ├─ 2. buildFuzzyFileMap(allFiles)    # Fuzzy matching index for attachments
    │
    ├─ 3. for await (parsed of importer.parseZipEntries(jsonFiles))
    │     │
    │     ├─ upsertConversation()        # Incremental merge & persist
    │     │
    │     └─ Attachment handling (generic)
    │         ├─ findFile()              # Fuzzy-match attachment lookup
    │         ├─ fs.readFileSync()       # Read attachment from disk
    │         └─ attachmentStorage.save()
    │
    ├─ 4. syncDelete (optional)          # Delete conversations not present in zip
    │
    └─ 5. rmSync(tempDir)               # Clean up temp directory
```

## PlatformImporter Interface

```typescript
interface PlatformImporter {
  shouldExpandZip?(entryPath: string): boolean;   // Which nested zips to expand
  shouldParseJson?(entryPath: string): boolean;   // Which json files to parse
  parseZipEntries(jsonFiles: JsonFileEntry[]):     // Parse json → yield conversation
    Iterable<ParsedConversation> | AsyncIterable<ParsedConversation>;
}
```

| Method | Purpose | Default (when not implemented) |
|--------|---------|-------------------------------|
| `shouldExpandZip` | Filter nested zips to avoid expanding irrelevant ones | Expand all zips |
| `shouldParseJson` | Filter json files to avoid parsing irrelevant ones | Parse all json |
| `parseZipEntries` | Yield ParsedConversation one by one | (Must implement) |

## Platform Filters

| Platform | shouldExpandZip | shouldParseJson |
|----------|----------------|-----------------|
| **ChatGPT** | `Conversations__*.zip` | `conversations-*.json` + `library_files.json` |
| **Gemini** | Path contains `gemini` or `bard` | Path contains `gemini` or `bard` |
| **DeepSeek** | Expand all | Only `conversations.json` |
| **Claude** | Expand all | Parse all |

## Streaming JSON Parsing

### Architecture

```
fs.createReadStream(filePath, { highWaterMark: 64KB })
    │  chunk by chunk (64KB)
    ▼
StreamingJsonArraySplitter.feed(chunk)
    │  State machine tracks bracket depth, emits complete JSON item strings
    ▼
JSON.parse(itemJson)
    │  Single conversation object
    ▼
yield conversation
```

### StreamingJsonArraySplitter State Machine

Chunks are fed one at a time; the state machine tracks JSON array bracket depth:

- `depth === 0`: Outside the array (skip `[`, then enter depth 1)
- `depth === 1`: At array top level; mark `itemStart` when `{` is encountered
- `depth > 1`: Inside an item; when `}` brings depth back to 1, yield the complete item
- String escapes (`\"`, `\\`) are handled to avoid brackets inside strings interfering

### Stream Status per Platform

| Platform | JSON Read | Parse Method | Notes |
|----------|-----------|-------------|-------|
| **DeepSeek** | `createReadStream` ✅ | State machine per chunk ✅ | True streaming, single conversation granularity |
| **ChatGPT** | `createReadStream` ✅ | State machine per chunk ✅ | True streaming, single conversation granularity |
| **Gemini** | `readFileSync` | Full parse | Requires grouping by chatId; cannot stream per item |
| **Claude** | `readFileSync` | Full parse | Files are typically small |

### Why can't Gemini stream?

Gemini Takeout JSON is not "one item = one conversation".
Each record is a message fragment that must be grouped by `chatId` before assembling into a conversation.
All records must be seen before grouping is possible, so per-item yielding is not feasible.

## Fuzzy File Matching

In Google Takeout exports, attachment filenames may carry a `(1)` suffix (auto-added on repeated downloads).
`buildFuzzyFileMap` generates two index keys for each file:

- **fuzzyKey**: Strip extension and `(digit)` suffix → `conversations/abc123`
- **fullKey**: Strip only `(digit)` suffix → `conversations/abc123.dat`

Lookup order:
1. Exact path match
2. Match after stripping `(digit)` suffix
3. Any unconsumed candidate match
4. Fallback by basename (`findFileByBasename`)

Matched files are marked as consumed to prevent duplicate matching.

## ZIP Structure Examples

### ChatGPT
```
OpenAI-export/
└── User Online Activity/
    ├── Conversations__xxxxxx.zip    ← shouldExpandZip: ✅
    │   ├── conversations-abc.json   ← shouldParseJson: ✅
    │   ├── library_files.json       ← shouldParseJson: ✅
    │   └── abc/attachment.png
    ├── OtherActivity__xxxxxx.zip    ← shouldExpandZip: ❌
    └── ...
```

### Gemini
```
Takeout/
└── My Activity/
    ├── Gemini Apps/                 ← shouldExpandZip/shouldParseJson: ✅
    │   ├── MyActivity.json
    │   └── attachments/
    ├── Search/                      ← shouldExpandZip/shouldParseJson: ❌
    └── ...
```

### DeepSeek
```
deepseek_data-2026-09-16.zip
├── conversations.json              ← shouldParseJson: ✅
├── user.json                       ← shouldParseJson: ❌
└── ...
```