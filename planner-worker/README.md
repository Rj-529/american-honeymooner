# American Honeymooner Planner (Cloudflare Workers preview)

Parallel port of `planner/` for a **preview deploy only**.

The Express app in `planner/` stays the Render source of truth. The marketing site at the repo root still links to Render. This Worker does not attach a custom domain and does not change DNS.

## What it serves

- The planner UI from `public/index.html` (same screen as `planner/public/index.html`, with same-origin Worker routes)
- `POST /api/search` — Duffel flights, Nuitee/LiteAPI hotels, one Gemini Flash-Lite “GO FOR IT” itinerary
- `GET /api/places` — Duffel place suggestions
- `GET /api/maps-config` — Google Maps browser key, when configured
- `GET /health`

Secrets are read from the Worker `env` and are never committed:

- `DUFFEL_ACCESS_TOKEN`
- `DUFFEL_ENV` (`test` by default, `live` for live Duffel)
- `NUITEE_API_KEY`
- `GEMINI_API_KEY` (Google AI Studio; model `gemini-3.5-flash-lite`)
- `GOOGLE_MAPS_API_KEY`

If Duffel, Nuitee, or Gemini is missing, `/api/search` stays in **demo mode** and returns a sample flight, hotel, and day-by-day plan so the preview is clickable. Demo copy is labeled as a preview, not a live fare.

The Express app in `planner/` still uses OpenAI on Render. This Worker does not.

## Local

```bash
cd planner-worker
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Open the URL Wrangler prints (usually `http://localhost:8787`).

## Preview deploy

From this directory, with Wrangler logged in (`wrangler login` or `CLOUDFLARE_API_TOKEN`):

```bash
npx wrangler deploy
```

That publishes `american-honeymooner-planner` to `*.workers.dev` only. Do not add a custom domain here.

To turn on live inventory later, set the secrets on the Worker. Do not put them in git:

```bash
npx wrangler secret put DUFFEL_ACCESS_TOKEN
npx wrangler secret put NUITEE_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GOOGLE_MAPS_API_KEY
```
