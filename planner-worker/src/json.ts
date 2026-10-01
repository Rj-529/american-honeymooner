export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function rec(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function errorText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(errorText).filter(Boolean).join("; ");
  if (isRecord(value)) {
    const preferred = value.message || value.detail || value.title || value.description || value.error;
    if (preferred && preferred !== value) return errorText(preferred);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function safeNumber(value: unknown, fallback = 0): number {
  const number = typeof value === "number" ? value : Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function nightsBetween(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const nights = Math.round((end.getTime() - start.getTime()) / 86400000);
  return Number.isFinite(nights) && nights > 0 ? nights : 1;
}

export function durationMinutes(isoDuration: unknown): number {
  if (!isoDuration) return Number.MAX_SAFE_INTEGER;
  const match = String(isoDuration).match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  return match ? Number(match[1] || 0) * 60 + Number(match[2] || 0) : Number.MAX_SAFE_INTEGER;
}

export function penaltyText(condition: unknown, fallbackCurrency = "USD"): string {
  if (!isRecord(condition)) return "Not provided";
  if (condition.allowed === false) return "Not allowed";
  if (condition.allowed !== true) return "Not provided";
  const amount = Number(condition.penalty_amount || 0);
  const currency = str(condition.penalty_currency, fallbackCurrency) || fallbackCurrency;
  return amount > 0 ? `Allowed with ${amount} ${currency} penalty` : "Allowed";
}

const MAX_UPSTREAM_BYTES = 2_000_000;

export async function readBoundedText(response: Response): Promise<string> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader && Number(lengthHeader) > MAX_UPSTREAM_BYTES) {
    throw new Error(`Upstream response exceeded ${MAX_UPSTREAM_BYTES} bytes.`);
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_UPSTREAM_BYTES) {
      await reader.cancel();
      throw new Error(`Upstream response exceeded ${MAX_UPSTREAM_BYTES} bytes.`);
    }
    chunks.push(value);
  }
  if (!chunks.length) return "";
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function readResponseJson(response: Response, invalid: "empty" | "raw" = "empty"): Promise<unknown> {
  const text = await readBoundedText(response);
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return invalid === "raw" ? { raw: text.slice(0, 500) } : {};
  }
}
