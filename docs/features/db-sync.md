# DB Sync

## Append-Only Model

All platforms use an **append-only** model: existing messages are never
deleted or recreated, only new ones are appended. This mirrors Gemini's
append-only nature but now applies universally — user-controlled state
(such as `hidden`) on existing messages survives re-imports untouched.

The import logic uses `conversation.updatedAt` as a watermark:

| Condition | Action |
|-----------|--------|
| `json.updatedAt <= db.updatedAt` | Skip entirely — nothing new |
| `!existing` in DB | `create` conversation + nested `messages.create` |
| `json.updatedAt > db.updatedAt` | Update `title`/`updatedAt` on conversation; only `create` messages whose `createdAt > db.updatedAt` |

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