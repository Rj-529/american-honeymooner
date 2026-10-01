import type { PlannerSecrets } from "./types";

function stringSecret(env: Env, name: string): string | undefined {
  const value: unknown = Reflect.get(env, name);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readSecrets(env: Env): PlannerSecrets {
  return {
    duffelToken: stringSecret(env, "DUFFEL_ACCESS_TOKEN"),
    duffelEnv: (stringSecret(env, "DUFFEL_ENV") || "test").toLowerCase(),
    nuiteeKey: stringSecret(env, "NUITEE_API_KEY"),
    geminiKey: stringSecret(env, "GEMINI_API_KEY"),
    googleMapsKey: stringSecret(env, "GOOGLE_MAPS_API_KEY"),
  };
}

/** Live search needs Duffel, Nuitee, and Gemini. Anything missing stays in demo mode. */
export function isDemoMode(secrets: PlannerSecrets): boolean {
  return !secrets.duffelToken || !secrets.nuiteeKey || !secrets.geminiKey;
}

export function plannerMode(secrets: PlannerSecrets): "demo" | "duffel_test" | "live" {
  if (isDemoMode(secrets)) return "demo";
  return secrets.duffelEnv === "live" ? "live" : "duffel_test";
}
