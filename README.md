# Cascade

**One piece of content. Every platform. Instantly.**

Cascade is an AI-powered longform content repurposing tool. Paste a transcript, blog post, or YouTube URL — select your platforms — and Cascade generates a full suite of platform-native content assets in real time.

---

## What it generates

| Platform | Format |
|---|---|
| Instagram Caption | Hook + body + hashtags |
| Instagram Reel Script | [HOOK] / [BODY] / [CTA] |
| TikTok Script | Pattern-interrupt structure |
| YouTube Shorts Script | Problem → payoff → CTA |
| Twitter/X Thread | 8–12 numbered tweets |
| LinkedIn Post | Single-hook, personal voice |
| LinkedIn Article | Full 800–1200 word piece |
| Newsletter Section | 300–500 word conversational piece |
| Podcast Show Notes | Summary + timestamps + quotes |
| Blog Post Summary | SEO-aware intro section |
| Email Subject Lines | 5 variants, mixed styles |
| Quote Cards | 5 visual-ready pullquotes |

---

## Setup

### 1. Clone / navigate to the project

```bash
cd cascade
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Copy the `.env` file and fill in your API keys:

```
ANTHROPIC_API_KEY=your_anthropic_api_key_here
YOUTUBE_API_KEY=your_youtube_data_api_key_here
PORT=3001
```

**Getting your Anthropic API key:**
1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Navigate to API Keys → Create Key
3. Copy the key into `ANTHROPIC_API_KEY`

**Getting your YouTube Data API key:**
1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project → Enable "YouTube Data API v3"
3. Credentials → Create API Key
4. Copy the key into `YOUTUBE_API_KEY`

> Note: The `YOUTUBE_API_KEY` is reserved for future use. Current YouTube transcript fetching uses the `youtube-transcript` package, which does not require an API key but requires the video to have captions enabled.

---

## Running the app

### Terminal 1 — Start the backend server

```bash
npm run dev
# Server runs on http://localhost:3001
```

### Terminal 2 — Start the frontend

```bash
npm run client
# Frontend served on http://localhost:3000
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Architecture

```
cascade/
├── client/
│   └── index.html          # Single-file React app (Babel + Tailwind CDN)
├── server/
│   ├── index.js             # Express entry point
│   ├── routes/
│   │   └── repurpose.js     # Route definitions
│   ├── controllers/
│   │   └── repurposeController.js  # Pipeline orchestration
│   └── services/
│       ├── claudeService.js    # Claude API + platform prompts
│       ├── transcriptService.js # YouTube transcript extraction
│       └── sseService.js       # SSE connection helpers
├── .env
├── package.json
└── README.md
```

### How the pipeline works

1. **Extract** — Validate input, begin processing
2. **Transcript** *(YouTube only)* — Fetch captions via `youtube-transcript`
3. **Analyse** — Single Claude call to extract: topic, key ideas, tone, audience, hooks
4. **Map** — Match platforms to their prompt templates
5. **Generate** — Sequential Claude calls per platform; each emits an SSE `result` event as it completes
6. **Polish** — Brief pause; final verification pass
7. **Done** — SSE `complete: true` triggers output render

Progress is streamed in real time via Server-Sent Events (SSE) — no fake timers.

---

## Known limitations

- **YouTube videos without captions** — If auto-generated or manual captions are disabled on a video, the transcript fetch will fail. Paste the content manually instead.
- **Content length** — Content over ~50,000 tokens (~200,000 characters) is trimmed. Consider splitting very long transcripts into multiple runs.
- **Sequential generation** — Platforms are generated one at a time for accurate progress tracking. Generating all 12 platforms on a long piece of content takes approximately 2–4 minutes.
- **Rate limits** — The app retries once on Claude API rate-limit errors (429) with a 5-second delay. If you hit persistent limits, reduce the number of platforms selected.
- **YouTube private videos** — Private or unlisted videos cannot be accessed. Use paste mode for those.

---

## Tech stack

- **Backend:** Node.js, Express, `@anthropic-ai/sdk`, `youtube-transcript`, SSE
- **Frontend:** React 18 (UMD), Tailwind CSS (CDN), Babel Standalone
- **AI model:** `claude-opus-4-6`
