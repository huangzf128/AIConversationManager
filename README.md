# AIConversationManager

A locally-run AI chat history management application that centralizes your conversations from various AI platforms into a single, searchable database. Hide irrelevant content, organize your knowledge, and keep all your AI interactions in one place.

## Features

- **Multi-platform Support**: Import conversations from Gemini, Claude (more coming: ChatGPT, DeepSeek)
- **Incremental Sync**: Re-import updated exports without losing your hidden statuses
- **Content Management**: Hide entire conversations or individual messages to focus on what matters
- **Message Collapsing**: Expand/collapse messages for better navigation in long conversations
- **Filtering**: Filter conversations by platform and date range
- **Local-first**: All data stored locally in SQLite, no cloud required
- **Markdown Support**: Render rich text content from your AI conversations

## Tech Stack

### Frontend
- React + TypeScript + Vite
- marked (Markdown parsing)
- DOMPurify (XSS protection)

### Backend
- NestJS
- Prisma ORM v7
- SQLite database

## Project Structure

```
AIConversationManager/
├── frontend/          # React frontend
├── backend/           # NestJS backend
├── docs/              # Documentation
│   ├── features.md    # English feature spec
│   ├── features.zh.md # 中文功能规格
│   └── features.ja.md # 日本語機能仕様書
└── README.md
```

## Getting Started

### Prerequisites
- Node.js 18+
- npm or yarn

### Installation

1. **Install backend dependencies**
```bash
cd backend
npm install
```

2. **Setup database**
```bash
npx prisma migrate dev
```

3. **Start backend server**
```bash
npm run start:dev
```

4. **Install frontend dependencies and start**
```bash
cd ../frontend
npm install
npm run dev
```

## Usage

1. **Export conversations** from your AI platforms (use their native export features)
2. **Upload the ZIP file** through the application's upload page
3. **Browse and manage** your conversations in the main interface
4. **Hide irrelevant content** to keep your knowledge base clean

## Current Status

- ✅ Gemini and Claude parsers fully implemented
- ✅ Full CRUD API for conversations and messages
- ✅ Frontend with filtering, hiding, and collapsing features
- ✅ Incremental import with preserved user settings
- 🚧 UI styling improvements in progress
- 🚧 ChatGPT and DeepSeek parsers coming soon

## License

MIT