import { describe, expect, it } from "vitest";
import { upstreamClientError } from "../src/errors";
import { parseTripInput, todayInNewYork } from "../src/input";
import { buildDemoSearch, demoPlaceSuggestions } from "../src/mock";
import { isDemoMode } from "../src/secrets";
import { GEMINI_MODEL, chooseGoForItPairing, geminiGenerateUrl, geminiRequestBody, kingRoomCandidate, luxuryHotelScore } from "../src/travel";
import type { FlightOffer, HotelOffer, PlannerSecrets } from "../src/types";

const secrets = (overrides: Partial<PlannerSecrets> = {}): PlannerSecrets => ({
  duffelEnv: "test",
  ...overrides,
});

describe("demo mode", () => {
  it("turns on when Duffel, Nuitee, or Gemini is missing", () => {
    expect(isDemoMode(secrets())).toBe(true);
    expect(isDemoMode(secrets({ duffelToken: "x", nuiteeKey: "y" }))).toBe(true);
    expect(isDemoMode(secrets({ duffelToken: "x", nuiteeKey: "y", geminiKey: "z" }))).toBe(false);
  });

  it("builds a clickable Chicago to Amalfi plan inside the budget", () => {
    const parsed = parseTripInput({
      originName: "Chicago",
      destinationName: "Amalfi Coast",
      startDate: "2026-12-01",
      endDate: "2026-12-08",
      budget: 8000,
      travelers: 2,
      pace: "Balanced",
      styles: ["romantic", "food & wine"],
      notes: "One special dinner",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = buildDemoSearch(parsed.input);
    const option = result.aiPlan.options[0];
    expect(result.mode).toBe("demo");
    expect(result.geography.originAirportCode).toBe("ORD");
    expect(result.geography.destinationAirportCode).toBe("NAP");
    expect(result.geography.hotelSearchCities).toEqual(["Positano", "Amalfi", "Ravello"]);
    expect(option.itinerary.length).toBeGreaterThan(2);
    expect(option.flightDetails?.slices).toHaveLength(2);
    expect(option.hotelDetails?.gallery.length).toBeGreaterThan(1);
    expect(option.hotelDetails?.roomName.toLowerCase()).toContain("king");
    expect(option.estimatedTripTotal).toBeLessThanOrEqual(8000);
    expect(option.estimatedTripTotal).toBeGreaterThan(0);
    expect(option.whyItWorks.toLowerCase()).toContain("honeymoon");
    expect(option.whyItWorks).toContain("One special dinner");
  });

  it("rejects past, non-ISO, and out-of-order dates with plain English", () => {
    const past = parseTripInput({
      originName: "New York",
      destinationName: "Paris",
      startDate: "2026-09-01",
      endDate: "2026-09-08",
      budget: 8000,
      travelers: 2,
    }, new Date("2026-10-01T22:00:00Z"));
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.error).toBe("Pick a departure date today or later.");

    const slashes = parseTripInput({
      originName: "New York",
      destinationName: "Paris",
      startDate: "11/15/2026",
      endDate: "11/22/2026",
      budget: 8000,
    }, new Date("2026-10-01T22:00:00Z"));
    expect(slashes.ok).toBe(false);
    if (!slashes.ok) expect(slashes.error).toBe("Use dates like 2026-11-15.");

    const sameDay = parseTripInput({
      originName: "New York",
      destinationName: "Paris",
      startDate: "2026-11-15",
      endDate: "2026-11-15",
      budget: 8000,
    }, new Date("2026-10-01T22:00:00Z"));
    expect(sameDay.ok).toBe(false);
    if (!sameDay.ok) expect(sameDay.error).toBe("Pick a return date after your departure date.");

    const today = todayInNewYork(new Date("2026-10-01T22:00:00Z"));
    const future = parseTripInput({
      originName: "New York",
      destinationName: "Paris",
      startDate: today,
      endDate: "2026-11-15",
      budget: 8000,
      travelers: 2,
    }, new Date("2026-10-01T22:00:00Z"));
    expect(future.ok).toBe(true);
    if (future.ok) expect(future.input.travelers).toBe(2);
  });

  it("maps Duffel and Nuitee 4xx to 400 and 5xx to 502", () => {
    expect(upstreamClientError(422, "Departure date must be in the future").status).toBe(400);
    expect(upstreamClientError(422, "Departure date must be in the future").message).toContain("future");
    expect(upstreamClientError(503, "Nuitee rates (503): unavailable").status).toBe(502);
  });

  it("rejects an empty search the same way the Express planner does", () => {
    expect(parseTripInput({}).ok).toBe(false);
    const missingBudget = parseTripInput({
      originName: "Chicago",
      destinationName: "Paris",
      startDate: "2026-12-01",
      endDate: "2026-12-08",
      budget: 0,
    });
    expect(missingBudget.ok).toBe(false);
  });

  it("suggests preview airports without Duffel", () => {
    expect(demoPlaceSuggestions("c")).toEqual([]);
    expect(demoPlaceSuggestions("chicago")[0]?.iataCode).toBe("ORD");
  });
});

describe("Gemini Flash-Lite", () => {
  it("calls generateContent on gemini-3.5-flash-lite and asks for JSON", () => {
    expect(GEMINI_MODEL).toBe("gemini-3.5-flash-lite");
    expect(GEMINI_MODEL.toLowerCase()).not.toContain("pro");
    expect(geminiGenerateUrl()).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
    );
    expect(geminiRequestBody("resolve this trip").generationConfig.responseMimeType).toBe("application/json");
  });
});

describe("live pairing helpers", () => {
  const flight = { id: "f1", total: 1800 } as FlightOffer;
  const hotel = {
    id: "h1",
    name: "Grand Palace Resort",
    roomName: "King suite",
    description: "Sea view spa",
    starRating: 5,
    nightlyEquivalent: 620,
    total: 4000,
    luxuryScore: 0,
  } as HotelOffer;

  it("prefers a luxury king room and scores five-star stays higher", () => {
    hotel.luxuryScore = luxuryHotelScore(hotel);
    expect(hotel.luxuryScore).toBeGreaterThan(200);
    const choice = kingRoomCandidate({
      roomTypes: [
        { name: "Two Queen Room", rates: [{ name: "Flexible", retailRate: { total: [{ amount: 100, currency: "USD" }] } }] },
        { name: "King Sea View", rates: [{ name: "King bed", retailRate: { total: [{ amount: 400, currency: "USD" }] } }] },
      ],
    });
    expect(choice?.roomType.name).toBe("King Sea View");
    const pairing = chooseGoForItPairing([flight], [{ ...hotel, luxuryScore: hotel.luxuryScore }], 8000);
    expect(pairing?.flightId).toBe("f1");
    expect(pairing?.hotelId).toBe("h1");
    expect(pairing?.label).toBe("GO FOR IT");
  });
});
