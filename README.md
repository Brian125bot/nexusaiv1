# NexusAI v1

AI-native orchestration dashboard for managing architectural goals, reviewing lock traffic, and tracking Jules coding sessions.

## Features
- **Goal Management:** Track architectural goals and review artifacts (PRs).
- **Session Tracking:** Monitor active Jules coding sessions in real-time.
- **Traffic Map:** Visualize file lock traffic to prevent merge conflicts.
- **AI Orchestrator:** Intelligent dispatching of coding tasks with lock awareness.

## Stack
- **Framework:** Next.js (App Router)
- **Database:** Neon (PostgreSQL)
- **Auth:** Descope
- **Rate Limiting:** Upstash Redis (@vercel/kv)
- **AI:** Google Gemini (Gemini 3.0 Flash)
- **Coding Agent:** Jules API

## Getting Started

### 1. Prerequisites
- Node.js 18+
- Neon Database
- Descope Account
- Upstash Redis
- Jules API Key
- GitHub Personal Access Token

### 2. Environment Setup
Create a `.env.local` file with the following:
```env
# Auth (Descope)
DESCOPE_PROJECT_ID=your_id
NEXT_PUBLIC_DESCOPE_PROJECT_ID=your_id
ALLOWED_USER_ID=your_id

# Database (Neon)
DATABASE_URL=your_db_url

# Rate Limiting (Upstash)
KV_REST_API_URL=your_url
KV_REST_API_TOKEN=your_token

# Integrations
GITHUB_WEBHOOK_SECRET=your_secret
GITHUB_TOKEN=your_token
JULES_API_KEY=your_key
JULES_API_BASE_URL=https://jules.google.com/api/v1
```

### 3. Installation
```bash
npm install
```

### 4. Running the App
```bash
npm run dev
```

## Deployment
This project is optimized for Vercel. Ensure all environment variables are set in the Vercel dashboard.
To push schema changes to your database:
```bash
npm run db:push
```
