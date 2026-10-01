import { isRecord, str } from "./json";
import type { TripInput } from "./types";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Departure "today" is the calendar date in America/New_York. */
export function todayInNewYork(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return `${year}-${month}-${day}`;
}

function validIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

export function parseTripInput(
  body: unknown,
  now: Date = new Date(),
): { ok: true; input: TripInput } | { ok: false; error: string } {
  const record = isRecord(body) ? body : {};
  const originName = str(record.originName).trim();
  const destinationName = str(record.destinationName).trim();
  const startDate = str(record.startDate).trim();
  const endDate = str(record.endDate).trim();
  if (!startDate || !endDate || !originName || !destinationName) {
    return { ok: false, error: "Enter an origin, destination, departure date, and return date." };
  }
  if (!validIsoDate(startDate) || !validIsoDate(endDate)) {
    return { ok: false, error: "Use dates like 2026-11-15." };
  }
  if (startDate < todayInNewYork(now)) {
    return { ok: false, error: "Pick a departure date today or later." };
  }
  if (endDate <= startDate) {
    return { ok: false, error: "Pick a return date after your departure date." };
  }
  const budget = typeof record.budget === "number" ? record.budget : Number(record.budget);
  if (!Number.isFinite(budget) || budget <= 0) {
    return { ok: false, error: "Enter a valid total trip budget." };
  }
  const travelersRaw = Number(record.travelers ?? 2);
  const travelers = Number.isFinite(travelersRaw) && travelersRaw > 0 ? travelersRaw : 2;
  const styles = Array.isArray(record.styles) ? record.styles.filter((item): item is string => typeof item === "string") : [];
  return {
    ok: true,
    input: {
      originName,
      destinationName,
      startDate,
      endDate,
      budget,
      travelers,
      pace: str(record.pace, "Balanced") || "Balanced",
      styles,
      notes: str(record.notes),
      travelClass: str(record.travelClass, "economy") || "economy",
    },
  };
}
