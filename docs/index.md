# AI Conversation Manager

A web app that imports, stores, and browses conversation history exported from Gemini, ChatGPT, Claude, and DeepSeek. Upload a Takeout zip or JSON, and the app parses, persists, and displays your AI conversations with search, filter, and bookmark support.

---

## Documentation

### Import & Parsing

- [Upload](features/upload.md) — Upload flow, zip handling, attachment storage
- [Parser: Gemini](features/parser-gemini.md) — Gemini Takeout JSON format, multi-chatId records, noise filtering
- [Parser: Claude](features/parser-claude.md) — Claude export JSON format, unsupported blocks
- [Parser: ChatGPT](features/parser-chatgpt.md) — ChatGPT export (not yet implemented)
- [Parser: DeepSeek](features/parser-deepseek.md) — DeepSeek export (not yet implemented)
- [DB Sync](features/db-sync.md) — Append-only import strategy, upsert logic, sync-delete batching