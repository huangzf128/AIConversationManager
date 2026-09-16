# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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