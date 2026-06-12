# ResilienceAI

Disaster-response platform. The frontend (`Frontend.html`) is a single-page app; the
backend (`server.js`) serves it and powers the **AI damage assessment** feature.

## How damage assessment works

1. You upload photos of the damage in the **Damage Reporting** screen.
2. The browser sends those photos to the backend (`POST /api/damage-assessment`).
3. The backend calls **Claude Opus 4.8 with vision**, which inspects the actual
   images and returns a structured assessment (total loss, line-item breakdown,
   severity, affected area, confidence, and a summary).
4. The result renders in the analysis + report screens.

Your API key stays on the server — it is never exposed to the browser.

## Setup (2 steps)

```bash
# 1. Add your Anthropic API key
cp .env.example .env
#    then edit .env and paste your key (from https://console.anthropic.com/settings/keys)

# 2. Run it
npm start
```

Open **http://localhost:3000** and log in (any email + 6-char password).

> No build step, no dependencies — just Node 18+ (`node server.js` also works).

## Without an API key

The app still runs and is fully clickable. If `ANTHROPIC_API_KEY` isn't set (or the
API is unreachable), the damage assessment falls back to built-in demo data, so the
demo never breaks.

## Endpoints

| Method | Path                      | Purpose                                  |
| ------ | ------------------------- | ---------------------------------------- |
| GET    | `/`                       | Serves `Frontend.html`                   |
| GET    | `/api/health`             | `{ ok, ai, model }` — is AI configured?  |
| POST   | `/api/damage-assessment`  | `{ location, category, images[] }` → assessment JSON |
