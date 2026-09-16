# DB Sync

## Append-Only Model

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

## Sync Delete

When `syncDelete` is enabled:

1. Fetch only `id` from DB for the platform where `starred = false`
   (lightweight query, no SQLite parameter limit issues)
2. Filter in JS: `toDeleteIds = dbIds - importedIds`
3. Batch-fetch full records (with attachments) in chunks of 900 to stay
   under SQLite's 999 `SQLITE_MAX_VARIABLE_NUMBER` limit
4. Delete attachment files from disk, then delete the conversation
   (cascade removes messages + attachment DB rows)

Starred conversations are **never deleted**, regardless of `syncDelete`.