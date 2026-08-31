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
4. **Mixed mode** (default): paste keys from multiple APIs together — the app auto-routes
   each key by prefix (`AIza…`/`AQ.…` → Gemini, `gsk_…` → Groq, `sk-…` → OpenAI),
   uses each API's default model, and round-robins across all keys of all APIs.

## PDF view toggle
Setup has a "Show PDF with questions" toggle (default ON) and the exam header has a
📄 PDF button. Turn it OFF for text-only mode: the paper panel hides and the detected
question + A–D options take the full width (larger text). The PDF is still loaded in the
background (auto-detect, resume, key matching keep working). The preference is remembered.

## Community key donation
The app has a "🎁 Donate Key" box (Setup → AI Answer Finder). A visitor can donate a
free-tier key, which is stored on the server (`donated-keys.json`) and merged into the
shared pool served by `/api/ai-config`, so it rotates for every user. The server validates
the key prefix (Gemini `AIza…`/`AQ.…`, Groq `gsk_…`, OpenAI `sk-…`), de-duplicates, caps
the pool at 100 keys and rate-limits donations per IP. `POST /api/donate` takes
`{"key": "…", "name": "optional"}`; `GET /api/donate` returns pool counts.

## Free AI keys
- Gemini: https://aistudio.google.com → Get API key (free tier)
- Groq:   https://console.groq.com → API Keys (free tier)

⚠️ AI answers are estimates — verify important ones yourself.
