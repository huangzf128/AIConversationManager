# Upload

## Upload Flow

The frontend sends a `POST /conversations/upload` request with:

- `file` — the export file (`.json` or `.zip`)
- `platform` — one of `gemini`, `chatgpt`, `claude`, `deepseek`
- `syncDelete` — if `"true"`, conversations in DB but absent from the
  export are deleted (starred conversations are always kept)

The backend dispatches to either `importFromFile` (`.json`) or
`importFromZip` (`.zip`), then runs the platform-specific parser and
persists the results.

## Zip Handling

When a `.zip` is uploaded:

1. Every `.json` entry inside the zip is tried against the platform's
   parser. Entries that don't match the expected shape yield zero
   conversations and are silently skipped. This avoids relying on
   localized folder names inside the export.
2. The directory of each JSON entry is recorded so that attachment
   filenames (which are relative to that directory) can be resolved.
3. A fuzzy-entry map is built from all non-directory zip entries to
   handle filename variations: different extensions, `(N)` duplicate
   suffixes added by the OS, and dots in filenames that confuse
   `path.extname`. Attachment lookup uses tiered matching (exact →
   fuzzy-prefix → stripped-suffix).

## Attachment Storage

Attachments are saved to disk under `storage/files/{platform}/`, named by
their SHA-256 content hash plus original extension. This deduplicates
identical files across re-imports. The DB stores only the filename; the
backend resolves the full path using the platform subdirectory.

On sync-delete, attachment files are removed from disk before the DB
record is deleted.