# American Honeymooner Planner

Express app under this monorepo at `planner/`.

## What it does

- Natural-language origin/destination planning
- Flights via Duffel
- Hotels via Nuitee (LiteAPI)
- One “GO FOR IT” AI itinerary via OpenAI
- Optional Google Maps neighborhood restaurants

## Run locally

```bash
cd planner
cp .env.example .env
# fill secrets
npm install
npm run dev
```

Open `http://localhost:3000`.

## Deploy

Host this Node app (e.g. Render) with env vars. Do not put secrets in the static marketing site.

Marketing site remains at repo root (`index.html`) on Cloudflare Pages.
