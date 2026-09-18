# ZIP Import Architecture

## Directory Structure

```
conversation/
├── chatgpt/
│   ├── chatgpt.importer.ts      # ZIP 导入逻辑（过滤、library_files、DALL·E 附件）
│   ├── chatgpt.parser.ts        # JSON 解析（parse / parseOne / parseReadStream）
│   └── chatgpt.parser.spec.ts
├── claude/
│   ├── claude.importer.ts
│   └── claude.parser.ts
├── deepseek/
│   ├── deepseek.importer.ts
│   └── deepseek.parser.ts       # parseStream（字符串扫描）+ parseReadStream（文件流）
├── gemini/
│   ├── gemini.importer.ts
│   └── gemini.parser.ts
├── streaming-json-splitter.ts   # 共享：流式 JSON 数组分割状态机
├── zip-utils.ts                 # ZIP 解压、模糊匹配索引
├── conversation.service.ts      # 通用导入流程（解压 → 解析 → 入库 → 附件）
└── conversation.module.ts
```

## Import Flow

```
用户上传 zip
    │
    ▼
conversation.service.importFromZip(platform, zipBuffer)
    │
    ├─ 1. extractZipToTempDir(zipBuffer, filters)
    │     ├─ adm-zip 解压到临时目录
    │     ├─ expandNestedZips()          ← shouldExpandZip 过滤
    │     └─ collectFiles()              ← shouldParseJson 过滤
    │     返回: { tempDir, allFiles[], jsonFiles[] }
    │
    ├─ 2. buildFuzzyFileMap(allFiles)    # 附件模糊匹配索引
    │
    ├─ 3. for await (parsed of importer.parseZipEntries(jsonFiles))
    │     │
    │     ├─ upsertConversation()        # 增量合并入库
    │     │
    │     └─ 附件处理（通用）
    │         ├─ findFile()              # 模糊匹配查找附件
    │         ├─ fs.readFileSync()       # 从磁盘读取附件
    │         └─ attachmentStorage.save()
    │
    ├─ 4. syncDelete（可选）             # 删除 zip 中不存在的 conversation
    │
    └─ 5. rmSync(tempDir)               # 清理临时目录
```

## PlatformImporter Interface

```typescript
interface PlatformImporter {
  shouldExpandZip?(entryPath: string): boolean;   // 哪些嵌套 zip 需要展开
  shouldParseJson?(entryPath: string): boolean;   // 哪些 json 需要解析
  parseZipEntries(jsonFiles: JsonFileEntry[]):     // 解析 json → yield conversation
    Iterable<ParsedConversation> | AsyncIterable<ParsedConversation>;
}
```

| 方法 | 作用 | 默认行为（未实现时） |
|------|------|---------------------|
| `shouldExpandZip` | 过滤嵌套 zip，避免展开无关 zip | 展开所有 zip |
| `shouldParseJson` | 过滤 json 文件，避免解析无关 json | 解析所有 json |
| `parseZipEntries` | 逐个 yield ParsedConversation | （必须实现） |

## Platform Filters

| Platform | shouldExpandZip | shouldParseJson |
|----------|----------------|-----------------|
| **ChatGPT** | `Conversations__*.zip` | `conversations-*.json` + `library_files.json` |
| **Gemini** | 路径含 `gemini` 或 `bard` | 路径含 `gemini` 或 `bard` |
| **DeepSeek** | 全部展开 | 仅 `conversations.json` |
| **Claude** | 全部展开 | 全部解析 |

## Streaming JSON Parsing

### 架构

```
fs.createReadStream(filePath, { highWaterMark: 64KB })
    │  逐 chunk（64KB）
    ▼
StreamingJsonArraySplitter.feed(chunk)
    │  状态机跟踪括号深度，产出完整 JSON item 字符串
    ▼
JSON.parse(itemJson)
    │  单个 conversation 对象
    ▼
yield conversation
```

### StreamingJsonArraySplitter 状态机

逐 chunk 喂入，跟踪 JSON 数组的括号深度：

- `depth === 0`：数组外部（跳过 `[` 后进入 depth 1）
- `depth === 1`：数组顶层，遇到 `{` 标记 itemStart
- `depth > 1`：item 内部，遇到 `}` 且回到 depth 1 时 yield 完整 item
- 同时处理字符串转义（`\"`、`\\`），避免字符串内的括号干扰

### 各平台 Stream 状态

| Platform | JSON 读取 | 解析方式 | 说明 |
|----------|-----------|---------|------|
| **DeepSeek** | `createReadStream` ✅ | 状态机逐 chunk ✅ | 真正 stream，单 conversation 粒度 |
| **ChatGPT** | `createReadStream` ✅ | 状态机逐 chunk ✅ | 真正 stream，单 conversation 粒度 |
| **Gemini** | `readFileSync` | 全量解析 | 需要按 chatId 分组，无法逐个 stream |
| **Claude** | `readFileSync` | 全量解析 | 文件通常不大 |

### 为什么 Gemini 不能 stream？

Gemini Takeout 的 JSON 不是"一个 item = 一个 conversation"。
每条 record 是一条消息片段，需要按 `chatId` 分组后才能组装成 conversation。
所以必须看到所有 record 才能分组，无法逐个 yield。

## Fuzzy File Matching

Google Takeout 导出的 zip 中，附件文件名可能带 `(1)` 后缀（重复下载时自动添加）。
`buildFuzzyFileMap` 为每个文件生成两个索引 key：

- **fuzzyKey**：去掉扩展名和 `(数字)` 后缀 → `conversations/abc123`
- **fullKey**：只去掉 `(数字)` 后缀 → `conversations/abc123.dat`

查找顺序：
1. 精确路径匹配
2. 去掉 `(数字)` 后缀匹配
3. 任意未消费候选匹配
4. 按 basename 再找一轮（`findFileByBasename`）

匹配到的文件标记为 consumed，防止重复匹配。

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
└── マイ アクティビティ/
    ├── Gemini アプリ/               ← shouldExpandZip/shouldParseJson: ✅
    │   ├── マイアクティビティ.json
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