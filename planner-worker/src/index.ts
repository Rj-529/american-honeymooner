/// <reference path="../worker-configuration.d.ts" />
import { Hono } from "hono";
import { HttpError } from "./errors";
import { parseTripInput } from "./input";
import { buildDemoSearch, demoPlaceSuggestions } from "./mock";
import { isDemoMode, plannerMode, readSecrets } from "./secrets";
import { OPENAI_MODEL, runLiveSearch, searchPlaces } from "./travel";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => {
  const secrets = readSecrets(c.env);
  return c.json({
    ok: true,
    runtime: "cloudflare-workers",
    mode: plannerMode(secrets),
    demo: isDemoMode(secrets),
    duffelConfigured: Boolean(secrets.duffelToken),
    nuiteeConfigured: Boolean(secrets.nuiteeKey),
    googleMapsConfigured: Boolean(secrets.googleMapsKey),
    openAIConfigured: Boolean(secrets.openAIKey),
    openAIModel: OPENAI_MODEL,
  });
});

app.get("/api/maps-config", (c) => {
  const secrets = readSecrets(c.env);
  if (!secrets.googleMapsKey) return c.json({ error: "Google Maps is not configured." }, 404);
  return c.json({ apiKey: secrets.googleMapsKey });
});

app.get("/api/places", async (c) => {
  const query = c.req.query("query") || "";
  const secrets = readSecrets(c.env);
  if (query.trim().length < 2) return c.json({ data: [] });
  try {
    const data = secrets.duffelToken ? await searchPlaces(query, secrets) : demoPlaceSuggestions(query);
    return c.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Location search failed.";
    console.error(JSON.stringify({ event: "places_error", message }));
    return c.json({ error: message }, 500);
  }
});

app.post("/api/search", async (c) => {
  const raw = await c.req.text();
  if (raw.length > 1_000_000) return c.json({ error: "Request body is too large." }, 413);
  let body: unknown = {};
  if (raw.trim()) {
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      return c.json({ error: "Request body must be JSON." }, 400);
    }
  }
  const parsed = parseTripInput(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const secrets = readSecrets(c.env);
  try {
    const result = isDemoMode(secrets) ? buildDemoSearch(parsed.input) : await runLiveSearch(parsed.input, secrets);
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Search failed.";
    if (error instanceof HttpError) {
      if (error.status === 404) return c.json({ error: message }, 404);
      return c.json({ error: message }, 400);
    }
    console.error(JSON.stringify({ event: "search_error", message }));
    return c.json({ error: message || "Search failed." }, 500);
  }
});

app.all("*", async (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((error, c) => {
  const message = error.message || "Request failed.";
  console.error(JSON.stringify({ event: "worker_error", message, path: c.req.path }));
  return c.json({ error: message }, 500);
});

export default app;
