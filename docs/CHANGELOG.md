# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

* Claude parser now supports branching: walks the `parent_message_uuid`
  tree via BFS to build `parentMessageId` chains, enabling branch
  switchers in the UI. Falls back to linear sort for older exports
  without `parent_message_uuid`.
* Claude parser now extracts thinking content from `content[]` blocks
  (`type: "thinking"`) and wraps it in `thinking` code fences, matching
  the DeepSeek parser format.

### Fixed

* Claude import now creates Attachment DB records for files referenced in
  `chat_messages[].files`. Previously attachments were silently skipped
  because the zip lookup failed (Claude exports don't include file
  content). Now `skipAttachmentFiles: true` is set, matching DeepSeek's
  approach, so placeholder attachment records are created with
  `size: 0`.
* Claude parser no longer injects `[Attached: ...]` placeholder text into
  `message.content` when a message has attachments but no text. The
  attachment info is stored solely in the Attachment table.
* Claude parser now preserves file-only messages (user sends a file with
  no text). Previously these were silently dropped because `text` was
  empty. Now the parser generates a placeholder content like
  `[Attached: filename.txt]` and includes the attachment records.

### Changed

* Gemini zip import now uses streaming: Takeout JSON records are parsed
  one by one via `splitJsonArrayFile`, messages are upserted individually,
  and conversations are batch-upserted at the end — all within a
  `$transaction`. This avoids `JSON.parse` on the entire file and
  significantly reduces peak heap usage for large Takeout exports.
* Gemini streaming import uses watermark-based skip: for existing
  conversations, only records with `time > dbUpdatedAt` are processed.
* Gemini streaming import selects conversation title from the record with
  the earliest timestamp (first user message), not the last.
* DeepSeek import now uses stream parsing: the JSON array is scanned for
  element boundaries and each conversation is parsed and persisted
  individually, keeping only one chat object in memory at a time. This
  significantly reduces peak heap usage for large exports (20+ MB).
* `syncDeleteMissing` now accepts `Set<string>` instead of `Conversation[]`,
  avoiding temporary placeholder objects.
* BFS traversal in DeepSeek parser uses a head pointer instead of
  `Array.shift()` for O(1) dequeue.

## [1.0.0] - 2026-09-16

### Added

* Backend (NestJS + Prisma + SQLite) for storing and serving conversation data.
* Frontend (React + Vite) with three pages: Login, Upload, and My Page (conversation viewer).
* Parsers for four AI platforms:
  * **ChatGPT** — OpenAI export `.zip` (JSON conversations + attachments).
  * **Gemini** — Google Takeout `.zip` or `.json` (My Activity with HTML replies + attachments).
  * **Claude** — `conversations.json` export (JSON conversations).
  * **DeepSeek** — exported conversations `.json` (JSON conversations).
* Upload page with platform selector, file picker, and import progress feedback.
* Conversation list sidebar with:
  * Platform filter toggles (ChatGPT / Gemini / Claude / DeepSeek).
  * Date range filter.
  * Chat ID search.
  * Show/hide toggle for hidden conversations.
  * Star (favorite) and hide actions per conversation.
* Main content area displaying full conversation messages with inline attachments.
* Attachment download support (images and files stored alongside the export).
* SQLite database schema with `Conversation`, `Message`, and `Attachment` models.
* Deduplication of attachments via content hash (`@@unique [messageId, contentHash]`).
* Gemini parser: image-only messages (user sends an image with no text) are preserved with a `[画像]` placeholder instead of being silently dropped.
* Gemini parser: `imageFile` field recognized in Takeout records alongside `attachedFiles`.