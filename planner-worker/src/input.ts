import { isRecord, str } from "./json";
import type { TripInput } from "./types";

export function parseTripInput(
  body: unknown,
): { ok: true; input: TripInput } | { ok: false; error: string } {
  const record = isRecord(body) ? body : {};
  const originName = str(record.originName).trim();
  const destinationName = str(record.destinationName).trim();
  const startDate = str(record.startDate).trim();
  const endDate = str(record.endDate).trim();
  if (!startDate || !endDate || !originName || !destinationName) {
    return { ok: false, error: "Enter an origin, destination, departure date, and return date." };
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
