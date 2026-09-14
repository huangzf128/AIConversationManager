# AIConversationManager — Feature Specification

## Project Goal

A locally-run AI chat history management application. Export conversations scattered across various AI platforms, store them centrally in a database, and browse/manage these records through a purpose-built interface—specifically allowing unimportant sections of long conversations to be hidden, leaving only truly valuable content visible.

## Data Sources

- Avoid real-time scraping via browser extensions; instead, have users use each AI platform's **native export functionality** to download officially exported ZIP files
- Users submit this ZIP on the software's upload page, where the program parses it and writes it to the database
- Support repeated uploads: each time a new ZIP/JSON is uploaded, the program incrementally syncs conversations
    - Use upsert operations to avoid creating duplicate records
    - User-manually set `hidden` status is preserved during re-imports and never overwritten
    - Only conversation titles and message contents are updated, maintaining the user's management state

## Supported Platforms

- ChatGPT
- Gemini
- Claude
- DeepSeek

Each platform has a different export format, handled by independent parsers that convert everything into the program's internal universal Conversation/Message data structure before storage.

## Core Features

1. **Import**: Upload ZIP → select corresponding parser for the platform → write to database (incremental)
2. **Browse**: Sidebar displays conversation list, main area on the right shows full content of selected conversation
3. **Manage**: Users can freely hide sections of conversations (e.g., useless small talk), hidden status is persistently saved and maintained on next open

## Interface Structure

- Login Page (no real account system in current phase; clicking directly redirects to homepage)
- MyPage (Homepage): Left conversation list + right content display area; top of sidebar has an entry to the "upload page"
- Upload Page: Select and submit ZIP file

## Technical Architecture

- **Frontend**: React + TypeScript + Vite + marked (Markdown parsing) + DOMPurify (XSS protection)
- **Backend**: NestJS + Prisma ORM v7
- **Database**: SQLite (local file-based database, no separate database server installation required)
- **Database Models**:
  - `Conversation` table: Stores basic conversation information, includes `hidden` field to mark if hidden
  - `Message` table: Stores message content, also includes `hidden` field to support message-level hiding
- **Backend Module Structure**:
  - `conversation` module —— Contains 4 platform-specific parsers (chatgpt / gemini / claude / deepseek), unified interface enables multi-platform parsing extension
  - `prisma` module —— Encapsulates database services
  - `user` module —— Development postponed, no account system currently
- **Key Frontend Features**:
  - Conversation detail caching mechanism avoids repeated requests
  - Optimistic UI updates enhance interaction experience (automatically rolls back on operation failure)
  - Comprehensive filtering: Platform filtering, date range filtering, hidden content filtering

## Out of Scope (Not implemented in current phase)

- User account registration / login authentication
- Cloud deployment, multi-user support
- Direct technical integration with the AIChatFolders browser extension

## Future Possibilities (Concept only, not in current plans)

- If personal use proves effective and more people want to use it, consider deploying to AWS with an account registration system to support multi-users
- If a web version + account system is implemented, the AIChatFolders extension could also reuse the same backend account system

## Current Progress

- [x] Frontend/backend project skeleton completed (NestJS + React/Vite)
- [x] Page routing working: Login Page → MyPage (dummy data) → Upload Page
- [x] Prisma + SQLite environment setup complete, `Conversation`/`Message` tables created
- [x] Database field update: Added `hidden` field to support hiding functionality
- [x] ZIP/JSON parsing and data storage (supports incremental sync)
    - [x] Gemini conversation history parsing and storage
    - [x] Claude conversation history parsing and storage
    - [ ] ChatGPT conversation history parsing and storage (skeleton only, not implemented)
    - [ ] DeepSeek conversation history parsing and storage (skeleton only, not implemented)
- [x] Backend API fully implemented
    - [x] Get all conversation list (`GET /conversations`)
    - [x] Get single conversation details (`GET /conversations/:id`)
    - [x] Update conversation hidden status (`PATCH /conversations/:id/hidden`)
    - [x] Update message hidden status (`PATCH /conversations/:id/messages/:messageId/hidden`)
    - [x] File upload and parse import (`POST /conversations/upload`)
- [x] Frontend features fully implemented
    - [x] Conversation list sidebar, supports platform filtering, date range filtering
    - [x] Right content area rendering, supports Markdown parsing and HTML sanitization
    - [x] Conversation-level hide/show functionality
    - [x] Message-level hide/show functionality
    - [x] Message collapse/expand functionality (expand all / collapse all)
    - [x] Persistent storage of hidden conversations/messages
- [x] Hide/management functionality (both frontend and backend completed)
- [ ] UI style beautification
- [ ] Frontend error handling improvement (network request failure retries, etc.)
- [ ] Import progress indication and error handling optimization