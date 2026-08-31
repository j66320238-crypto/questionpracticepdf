# Mock Exam Pro 🎯

PDF question paper → timed CBT-style exam, instant-feedback practice, auto question
detection, answer-key matching, and an AI answer finder (Gemini / Groq / OpenAI,
multiple keys with auto-rotation). 100% open source, works offline, no database.

## Run locally
    node server.js          # http://localhost:8090
(or just open index.html in a browser — it also works from file://)

## Deploy on Render
1. Push this folder to a GitHub repo.
2. Render → New → **Blueprint** → point to this repo (render.yaml included).
   Or: New → **Web Service** → connect repo → build `npm install` is not needed,
   start command: `npm start`.
3. In the service settings add environment variables (optional, for AI answers):
   - `GEMINI_API_KEYS`  — one or more keys, comma separated
   - `GROQ_API_KEYS`    — one or more keys, comma separated
   - `OPENAI_API_KEYS`  — one or more keys, comma separated
   Keys are served to the app via `/api/ai-config` and rotate automatically on rate limits.
   You can also paste keys in the UI (Setup → AI Answer Finder) on any host.

## Free AI keys
- Gemini: https://aistudio.google.com → Get API key (free tier)
- Groq:   https://console.groq.com → API Keys (free tier)

⚠️ AI answers are estimates — verify important ones yourself.
