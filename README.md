# Talk2Folder

Chat with your Google Drive folders using AI. Paste a folder link, and ask questions about your files with citations.

## Quick Start

```bash
# 1. Clone and setup
cp .env.example .env
# Fill in your credentials in .env

# 2. Start all services
make dev

# 3. Run database migration
make migrate

# 4. Open http://localhost:3009
```

## Google OAuth Setup

Since this app requests Google Drive access, you'll see warning screens during sign-in. **This is expected behavior.**

### Screen 1: "Google hasn't verified this app"
This appears because the app uses OAuth credentials in testing mode. **Click "Continue"** to proceed safely.

### Screen 2: "JobTrackingPro" consent screen
You'll see "JobTrackingPro" as the app name - this is my existing Google Cloud project that I reused for this MVP to avoid the overhead of creating and configuring a new project. The app only requests read-only access to your Google Drive files. **Click "Continue"** to grant access.

Both screens are completely normal for apps in development/testing mode and do not indicate any security issues.

### For Reviewers

If you're reviewing this project:

1. You can use the provided credentials (contact developer for access)
2. OR set up your own Google Cloud credentials:
   - Create a project at [Google Cloud Console](https://console.cloud.google.com/)
   - Enable **Google Drive API** and **Generative Language API**
   - Create **OAuth 2.0 credentials** (Web application)
   - Add redirect URI: `http://localhost:8009/api/auth/callback`
   - Add yourself as a **test user** in OAuth consent screen
   - Copy credentials to `.env`

## Architecture

```
┌─────────────┐     ┌─────────────────────────────────────┐
│   Frontend  │────▶│              Backend                │
│  React/Bun  │     │             FastAPI                 │
└─────────────┘     │                                     │
                    │  ┌─────────────┐  ┌──────────────┐  │
                    │  │ Fast Path   │  │  RAG Path    │  │
                    │  │ Gemini API  │  │  ChromaDB    │  │
                    │  │ (≤50 files) │  │ (fallback)   │  │
                    │  └─────────────┘  └──────────────┘  │
                    └─────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
             ┌──────┴──────┐ ┌──────┴──────┐ ┌──────┴──────┐
             │  PostgreSQL │ │  ChromaDB   │ │ Google Drive│
             │   Users/DB  │ │   Vectors   │ │     API     │
             └─────────────┘ └─────────────┘ └─────────────┘
```

### Why No ADK?

This project uses **direct Gemini API calls** instead of Google's Agent Development Kit (ADK) for:
- **Lower latency**: No extra network hop to an ADK service
- **Simpler deployment**: Fewer containers, less infrastructure
- **Better control**: Direct access to streaming, file uploads, and model parameters

The `HybridAgent` handles both Fast Path (Gemini native) and RAG Path (ChromaDB) with automatic routing based on folder size.

## Services

| Service | Port | Description |
|---------|------|-------------|
| Frontend | 3009 | React + Vite + Bun |
| Backend | 8009 | FastAPI + Hybrid Agent |
| ChromaDB | 8100 | Vector database |
| PostgreSQL | 5667 | User data |

## Tech Stack

- **Frontend**: React 18, Vite, Tailwind CSS, Bun
- **Backend**: FastAPI, SQLAlchemy, Alembic, asyncio
- **AI**: Gemini API (direct integration), Hybrid RAG architecture
- **Vector Store**: ChromaDB
- **Database**: PostgreSQL 17
- **Auth**: Google OAuth 2.0, JWT

## Environment Variables

```env
# Database
DB_PASSWORD=your-db-password

# Google OAuth (from Google Cloud Console)
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxx

# Gemini API (from Google AI Studio)
GOOGLE_API_KEY=xxx

# App
JWT_SECRET=your-jwt-secret
VITE_API_URL=http://localhost:8009
VITE_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
```

## Makefile Commands

```bash
make dev          # Start all services with logs
make start        # Start in background
make stop         # Stop all services
make logs         # View logs
make build        # Rebuild containers
make migrate      # Run database migrations
make db-shell     # PostgreSQL shell
make backend-shell # Backend container shell
```

## How It Works

1. **Sign in** with Google (grants read-only Drive access)
2. **Paste** a Google Drive folder link
3. **Indexing** happens automatically:
   - **Fast Path** (≤50 files, ≤100MB): Files uploaded to Gemini File API for native understanding
   - **RAG Path** (fallback): Uses ChromaDB with chunk/embed/retrieve
4. **Chat** with your files - AI answers with citations
5. **Click citations** to preview files in a side panel (Google Drive embedded viewer)

## File Support

**Documents**
- PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx)
- Text (.txt, .md, .csv, .json)
- Google Docs/Sheets/Slides (exported automatically)

**Media** (Gemini native understanding)
- Images: PNG, JPEG, GIF, WebP, HEIC
- Video: MP4, MOV
- Audio: MP3, WAV

## Technical Decisions

| Decision | Why |
|----------|-----|
| Direct Gemini API vs ADK | Lower latency, simpler deployment, better streaming control |
| Hybrid RAG | Fast path for small folders, fallback for scale |
| asyncio vs Celery | Simpler for MVP; Celery adds Redis/worker complexity |
| ChromaDB vs Pinecone | Self-hosted, no API keys, works offline |
| Bun vs npm | Faster installs, native TypeScript |
