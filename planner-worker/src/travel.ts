import { HttpError } from "./errors";
import {
  arr,
  durationMinutes,
  errorText,
  isRecord,
  nightsBetween,
  penaltyText,
  readResponseJson,
  rec,
  safeNumber,
  str,
} from "./json";
import type {
  AiPlan,
  FlightOffer,
  FlightSegment,
  HotelGalleryImage,
  HotelOffer,
  Pairing,
  PlannerSecrets,
  PlanOption,
  PlaceSuggestion,
  SearchSuccess,
  TripInput,
} from "./types";

interface RawAiPlan {
  summary: string;
  options: unknown[];
}

const DUFFEL_BASE = "https://api.duffel.com";
const NUITEE_BASE = "https://api.liteapi.travel/v3.0";
/** gemini-2.5-flash-lite is rejected for new API keys. Use Gemini 3.5 Flash-Lite. */
export const GEMINI_MODEL = "gemini-3.5-flash-lite";

interface ResolvedTrip extends TripInput {
  originCode: string;
  destinationCode: string;
  destinationCountryCode: string | null;
  resolvedOriginName: string;
  resolvedDestinationName: string;
  resolvedDestinationAirportName: string;
  hotelSearchCities: string[];
  geographyExplanation: string | null;
}

interface DuffelPlace {
  id: string;
  type: string;
  name: string;
  city_name: string;
  iata_country_code: string | null;
  iata_code: string | null;
  airports: unknown[] | null;
}

function duffelHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    "Duffel-Version": "v2",
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function nuiteeHeaders(key: string): HeadersInit {
  return {
    "X-API-Key": key,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function requireDuffel(secrets: PlannerSecrets): string {
  if (!secrets.duffelToken) throw new Error("Duffel access token is not configured.");
  return secrets.duffelToken;
}

function requireNuitee(secrets: PlannerSecrets): string {
  if (!secrets.nuiteeKey) throw new Error("Nuitee API key is not configured.");
  return secrets.nuiteeKey;
}

function asHotelAddress(value: unknown): HotelOffer["address"] {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return null;
  const address = str(value.address);
  const line1 = str(value.line1);
  const city = str(value.city);
  if (!address && !line1 && !city) return null;
  return {
    address: address || undefined,
    line1: line1 || undefined,
    city: city || undefined,
  };
}

function asPlace(value: unknown): DuffelPlace | null {
  if (!isRecord(value)) return null;
  return {
    id: str(value.id),
    type: str(value.type),
    name: str(value.name),
    city_name: str(value.city_name),
    iata_country_code: str(value.iata_country_code) || null,
    iata_code: str(value.iata_code) || null,
    airports: Array.isArray(value.airports) ? value.airports : null,
  };
}

async function duffelPlaceSuggestions(query: string, token: string): Promise<DuffelPlace[]> {
  const url = new URL(`${DUFFEL_BASE}/places/suggestions`);
  url.searchParams.set("query", query);
  const response = await fetch(url, { headers: duffelHeaders(token) });
  const payload = rec(await readResponseJson(response));
  if (!response.ok) {
    throw new Error(errorText(arr(payload.errors)[0]) || `Duffel place search failed with status ${response.status}.`);
  }
  return arr(payload.data).map(asPlace).filter((place): place is DuffelPlace => place !== null);
}

async function verifyAirportCode(code: string, token: string): Promise<DuffelPlace | null> {
  if (!code) return null;
  try {
    const places = await duffelPlaceSuggestions(code, token);
    return places.find((place) => str(place.iata_code).toUpperCase() === code.toUpperCase()) || null;
  } catch {
    return null;
  }
}

export function geminiGenerateUrl(model: string = GEMINI_MODEL): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

export function geminiRequestBody(prompt: string): {
  contents: Array<{ role: "user"; parts: Array<{ text: string }> }>;
  generationConfig: { responseMimeType: "application/json" };
} {
  return {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json" },
  };
}

function geminiOutputText(payload: unknown): string {
  const parts: string[] = [];
  for (const candidate of arr(rec(payload).candidates)) {
    for (const part of arr(rec(rec(candidate).content).parts)) {
      const text = str(rec(part).text);
      if (text) parts.push(text);
    }
  }
  return parts.join("");
}

function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    /* try fenced or embedded JSON */
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]) as unknown;
    } catch {
      /* continue */
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    } catch {
      return null;
    }
  }
  return null;
}

async function geminiText(apiKey: string, prompt: string): Promise<string> {
  const response = await fetch(geminiGenerateUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(geminiRequestBody(prompt)),
  });
  const payload = await readResponseJson(response);
  if (!response.ok) {
    throw new Error(errorText(rec(payload).error) || `Gemini request failed with status ${response.status}.`);
  }
  const text = geminiOutputText(payload);
  if (text) return text;
  const blocked = errorText(rec(payload).promptFeedback);
  throw new Error(blocked || "Gemini returned no text.");
}

async function resolveTripGeography(input: TripInput, secrets: PlannerSecrets): Promise<ResolvedTrip> {
  const originText = input.originName.trim();
  const destinationText = input.destinationName.trim();
  if (!originText || !destinationText) throw new Error("Enter where you are leaving from and where you want to go.");
  if (!secrets.geminiKey) throw new Error("Gemini is required to interpret natural-language destinations.");
  const token = requireDuffel(secrets);
  const prompt = `Resolve a leisure trip into practical flight gateways and hotel-search geography. The traveler types human places, not airport codes.\n\nOrigin: ${originText}\nDestination: ${destinationText}\n\nReturn JSON only with: originAirportCode, originAirportName, destinationAirportCode, destinationAirportName, destinationCountryCode (ISO-2), hotelSearchCities (array of 1-3 actual cities/towns appropriate for lodging in the requested destination), destinationDisplayName, explanation.\n\nRules: choose practical major commercial airports. For a region/island/coast, choose the airport a leisure traveler would realistically fly into, but keep the requested region as destinationDisplayName. Example: Chicago to Amalfi Coast should normally resolve to Chicago's practical commercial gateway and Naples NAP, while hotelSearchCities should be Amalfi-area towns such as Amalfi, Positano, or Ravello. Do not invent airport codes.`;
  const text = await geminiText(secrets.geminiKey, prompt);
  const resolved = rec(parseModelJson(text));
  if (!Object.keys(resolved).length) {
    throw new Error("Could not interpret the trip locations. Try slightly more specific place names.");
  }
  const originCode = str(resolved.originAirportCode).toUpperCase();
  const destinationCode = str(resolved.destinationAirportCode).toUpperCase();
  const [verifiedOrigin, verifiedDestination] = await Promise.all([
    verifyAirportCode(originCode, token),
    verifyAirportCode(destinationCode, token),
  ]);
  if (!verifiedOrigin) {
    throw new Error(`I interpreted “${originText}” as ${originCode || "an airport"}, but Duffel could not verify it.`);
  }
  if (!verifiedDestination) {
    throw new Error(`I interpreted “${destinationText}” as ${destinationCode || "an airport"}, but Duffel could not verify it.`);
  }
  const hotelSearchCities = arr(resolved.hotelSearchCities).map((city) => str(city)).filter(Boolean).slice(0, 3);
  return {
    ...input,
    originCode,
    destinationCode,
    destinationCountryCode: str(resolved.destinationCountryCode) || verifiedDestination.iata_country_code,
    resolvedOriginName: str(resolved.originAirportName) || verifiedOrigin.city_name || verifiedOrigin.name || originText,
    resolvedDestinationName: str(resolved.destinationDisplayName) || destinationText,
    resolvedDestinationAirportName: str(resolved.destinationAirportName) || verifiedDestination.name || destinationCode,
    hotelSearchCities: hotelSearchCities.length ? hotelSearchCities : [destinationText],
    geographyExplanation: str(resolved.explanation) || null,
  };
}

function summarizeBaggage(baggages: unknown): string[] {
  if (!Array.isArray(baggages) || !baggages.length) return [];
  return baggages.map((bag) => {
    const item = rec(bag);
    const type = str(item.type, "baggage").replaceAll("_", " ");
    const qty = Number(item.quantity || 1);
    const weight = item.weight ? ` · ${item.weight}${item.weight_unit ? ` ${str(item.weight_unit)}` : ""}` : "";
    return `${qty} ${type}${qty === 1 ? "" : "s"}${weight}`;
  });
}

function summarizeSegment(segment: unknown): FlightSegment {
  const row = rec(segment);
  const marketing = rec(row.marketing_carrier);
  const operating = rec(row.operating_carrier);
  const carrier = str(marketing.name) ? marketing : operating;
  const carrierCode = str(marketing.iata_code) || str(operating.iata_code);
  const marketingNumber = str(row.marketing_carrier_flight_number);
  const operatingNumber = str(row.operating_carrier_flight_number);
  const flightNumber = marketingNumber
    ? `${carrierCode}${marketingNumber}`
    : operatingNumber
      ? `${str(operating.iata_code) || carrierCode}${operatingNumber}`
      : "";
  const passenger = rec(arr(row.passengers)[0]);
  const cabin = rec(passenger.cabin);
  const amenities = rec(cabin.amenities);
  const wifi = rec(amenities.wifi);
  const power = rec(amenities.power);
  const seat = rec(amenities.seat);
  const origin = rec(row.origin);
  const destination = rec(row.destination);
  const wifiAvailable = wifi.available === true || wifi.available === "true";
  return {
    id: str(row.id) || null,
    airline: str(carrier.name) || carrierCode || "Airline",
    airlineCode: carrierCode,
    airlineLogo: str(carrier.logo_symbol_url) || str(marketing.logo_symbol_url) || str(operating.logo_symbol_url) || null,
    flightNumber,
    operatingAirline: str(operating.name) || str(operating.iata_code) || null,
    operatingFlightNumber: operatingNumber ? `${str(operating.iata_code) || carrierCode}${operatingNumber}` : null,
    originCode: str(origin.iata_code),
    originName: str(origin.name),
    originTerminal: str(row.origin_terminal) || null,
    destinationCode: str(destination.iata_code),
    destinationName: str(destination.name),
    destinationTerminal: str(row.destination_terminal) || null,
    departingAt: str(row.departing_at) || null,
    arrivingAt: str(row.arriving_at) || null,
    duration: str(row.duration) || null,
    aircraft: str(rec(row.aircraft).name) || null,
    distanceMiles: row.distance ? Math.round(Number(row.distance)) : null,
    cabinClass: str(passenger.cabin_class) || null,
    cabinName: str(passenger.cabin_class_marketing_name) || str(cabin.marketing_name) || str(cabin.name) || null,
    fareBasisCode: str(passenger.fare_basis_code) || null,
    baggage: summarizeBaggage(passenger.baggages),
    wifi: wifiAvailable ? str(wifi.cost, "available") || "available" : null,
    power: power.available === true || power.available === "true",
    seatPitch: str(seat.pitch) || null,
  };
}

export function summarizeDuffelOffer(offer: unknown): FlightOffer {
  const row = rec(offer);
  const slices = arr(row.slices);
  const allSegments = slices.flatMap((slice) => arr(rec(slice).segments));
  const carrier = Object.keys(rec(row.owner)).length
    ? rec(row.owner)
    : rec(rec(allSegments[0]).marketing_carrier).name
      ? rec(rec(allSegments[0]).marketing_carrier)
      : rec(rec(allSegments[0]).operating_carrier);
  const maxStops = slices.reduce<number>((max, slice) => Math.max(max, Math.max(0, arr(rec(slice).segments).length - 1)), 0);
  const currency = str(row.total_currency, "USD") || "USD";
  const conditions = rec(row.conditions);
  return {
    id: str(row.id),
    airline: str(carrier.name) || str(carrier.iata_code) || "Airline",
    airlineCode: str(carrier.iata_code) || null,
    airlineLogo: str(carrier.logo_symbol_url) || null,
    stops: maxStops,
    duration: slices.map((slice) => str(rec(slice).duration)).filter(Boolean).join(" / "),
    total: Number(row.total_amount || 0),
    currency,
    baseAmount: Number(row.base_amount || 0),
    taxAmount: Number(row.tax_amount || 0),
    expiresAt: str(row.expires_at) || null,
    passengerCount: Array.isArray(row.passengers) ? row.passengers.length : null,
    totalEmissionsKg: safeNumber(row.total_emissions_kg, 0) || null,
    changePolicy: penaltyText(conditions.change_before_departure, currency),
    refundPolicy: penaltyText(conditions.refund_before_departure, currency),
    availableBagServices: arr(row.available_services)
      .filter((service) => rec(service).type === "baggage")
      .map((service) => ({
        amount: Number(rec(service).total_amount || 0),
        currency: str(rec(service).total_currency, currency) || currency,
        maximumQuantity: rec(service).maximum_quantity == null ? null : Number(rec(service).maximum_quantity),
      })),
    totalDurationMinutes: slices.reduce<number>((sum, slice) => sum + durationMinutes(rec(slice).duration), 0),
    slices: slices.map((slice, index) => {
      const item = rec(slice);
      const segments = arr(item.segments);
      return {
        direction: index === 0 ? "Outbound" : index === 1 ? "Return" : `Leg ${index + 1}`,
        duration: str(item.duration) || null,
        stops: Math.max(0, segments.length - 1),
        changePolicy: penaltyText(rec(item.conditions).change_before_departure, currency),
        segments: segments.map(summarizeSegment),
      };
    }),
  };
}

function maxReasonableFlightTotal(input: TripInput): number {
  const travelers = Math.max(1, Number(input.travelers || 2));
  const cabin = String(input.travelClass || "economy").toLowerCase();
  const perTraveler = cabin === "first" ? 30000 : cabin === "business" ? 18000 : cabin === "premium_economy" ? 9000 : 7500;
  return travelers * perTraveler;
}

async function refreshDuffelOffer(offerId: string, token: string): Promise<unknown | null> {
  const url = new URL(`${DUFFEL_BASE}/air/offers/${offerId}`);
  url.searchParams.set("return_available_services", "true");
  const response = await fetch(url, { headers: duffelHeaders(token) });
  const payload = rec(await readResponseJson(response));
  if (!response.ok) {
    throw new Error(errorText(arr(payload.errors)[0]) || `Duffel offer refresh failed with status ${response.status}.`);
  }
  return payload.data ?? null;
}

async function searchDuffelFlights(input: ResolvedTrip, token: string): Promise<FlightOffer[]> {
  const body = {
    data: {
      slices: [
        { origin: input.originCode, destination: input.destinationCode, departure_date: input.startDate },
        { origin: input.destinationCode, destination: input.originCode, departure_date: input.endDate },
      ],
      passengers: Array.from({ length: Number(input.travelers || 2) }, () => ({ type: "adult" })),
      cabin_class: String(input.travelClass || "economy").toLowerCase(),
    },
  };
  const requestResponse = await fetch(`${DUFFEL_BASE}/air/offer_requests?return_offers=false&supplier_timeout=15000`, {
    method: "POST",
    headers: duffelHeaders(token),
    body: JSON.stringify(body),
  });
  const requestPayload = rec(await readResponseJson(requestResponse));
  if (!requestResponse.ok) {
    throw new Error(errorText(arr(requestPayload.errors)[0]) || `Duffel request failed with status ${requestResponse.status}.`);
  }
  const requestId = str(rec(requestPayload.data).id);
  if (!requestId) throw new Error("Duffel did not return an offer request ID.");

  const offersUrl = new URL(`${DUFFEL_BASE}/air/offers`);
  offersUrl.searchParams.set("offer_request_id", requestId);
  offersUrl.searchParams.set("sort", "total_amount");
  offersUrl.searchParams.set("limit", "20");
  const offersResponse = await fetch(offersUrl, { headers: duffelHeaders(token) });
  const offersPayload = rec(await readResponseJson(offersResponse));
  if (!offersResponse.ok) {
    throw new Error(errorText(arr(offersPayload.errors)[0]) || `Duffel offers list failed with status ${offersResponse.status}.`);
  }
  const maxTotal = maxReasonableFlightTotal(input);
  return arr(offersPayload.data)
    .map(summarizeDuffelOffer)
    .filter((offer) => Number.isFinite(offer.total) && offer.total > 0 && offer.total <= maxTotal)
    .sort((a, b) => a.total - b.total)
    .slice(0, 12);
}

function hotelIdsFromPayload(payload: unknown): string[] {
  const record = rec(payload);
  if (Array.isArray(record.hotelIds)) return record.hotelIds.map((id) => str(id)).filter(Boolean);
  if (typeof record.HotelIds === "string") return record.HotelIds.split(",").map((id) => id.trim()).filter(Boolean);
  if (Array.isArray(record.HotelIds)) return record.HotelIds.map((id) => str(id)).filter(Boolean);
  const rows = Array.isArray(record.data) ? record.data : Array.isArray(payload) ? payload : [];
  return rows.map((hotel) => str(rec(hotel).id) || str(rec(hotel).hotelId)).filter(Boolean);
}

async function findNuiteeHotelIds(input: ResolvedTrip, key: string): Promise<{ ids: string[]; city: string }> {
  const countryCode = input.destinationCountryCode;
  if (!countryCode) throw new Error(`Nuitee: could not determine the country for ${input.destinationName}.`);
  const cities = [...new Set([...(input.hotelSearchCities || []), input.destinationName].filter(Boolean))];
  for (const city of cities) {
    const url = new URL(`${NUITEE_BASE}/data/hotels`);
    url.searchParams.set("countryCode", countryCode);
    url.searchParams.set("cityName", city);
    url.searchParams.set("limit", "50");
    const response = await fetch(url, { headers: nuiteeHeaders(key) });
    const payload = await readResponseJson(response, "raw");
    if (!response.ok) continue;
    const ids = hotelIdsFromPayload(payload).slice(0, 50);
    if (ids.length) return { ids, city };
  }
  return { ids: [], city: cities[0] || input.destinationName };
}

function rateTotal(rate: unknown): { amount: number; currency: string } {
  const totals = rec(rec(rate).retailRate).total;
  const first = Array.isArray(totals) ? rec(totals[0]) : rec(totals);
  return { amount: Number(first.amount ?? first.value ?? 0), currency: str(first.currency, "USD") || "USD" };
}

function roomTypeTotal(roomType: unknown, rate: unknown): { amount: number; currency: string } {
  const offer = rec(rec(roomType).offerRetailRate);
  if (Number(offer.amount) > 0) return { amount: Number(offer.amount), currency: str(offer.currency, "USD") || "USD" };
  return rateTotal(rate);
}

export function kingRoomCandidate(item: unknown): { roomType: Record<string, unknown>; rate: Record<string, unknown> | null } | null {
  const candidates: Array<{ roomType: Record<string, unknown>; rate: Record<string, unknown> | null }> = [];
  for (const roomTypeValue of arr(rec(item).roomTypes)) {
    const roomType = rec(roomTypeValue);
    const rates = arr(roomType.rates);
    const rateRows = rates.length ? rates : [null];
    for (const rateValue of rateRows) {
      const rate = rateValue == null ? null : rec(rateValue);
      const text = JSON.stringify({
        roomName: roomType.name,
        roomDescription: roomType.description,
        roomInfo: roomType.roomInfo,
        beds: roomType.beds,
        bedType: roomType.bedType,
        rateName: rate?.name,
        rateDescription: rate?.description,
        rateBeds: rate?.beds,
        rateBedType: rate?.bedType,
      }).toLowerCase();
      const hasKing = /(^|[^a-z])(?:1\s*)?(?:california\s+|super\s+)?king(?:\s+size)?(?:\s+bed)?([^a-z]|$)/i.test(text);
      const hasTwoBedSetup = /(2\s*(?:queen|double|twin)|two\s*(?:queen|double|twin)|2\s*beds|two\s*beds)/i.test(text);
      if (hasKing && !hasTwoBedSetup) candidates.push({ roomType, rate });
    }
  }
  if (!candidates.length) return null;
  return candidates.reduce((best, candidate) => {
    const a = roomTypeTotal(best.roomType, best.rate).amount || Number.MAX_SAFE_INTEGER;
    const b = roomTypeTotal(candidate.roomType, candidate.rate).amount || Number.MAX_SAFE_INTEGER;
    return b < a ? candidate : best;
  }, candidates[0]);
}

export function luxuryHotelScore(hotel: Pick<HotelOffer, "starRating" | "name" | "roomName" | "description" | "nightlyEquivalent"> | HotelOffer): number {
  let score = 0;
  const stars = safeNumber(hotel.starRating, 0);
  if (stars >= 5) score += 180;
  else if (stars >= 4.5) score += 140;
  else if (stars >= 4) score += 100;
  else if (stars > 0) score -= 300;

  const text = `${hotel.name || ""} ${hotel.roomName || ""} ${hotel.description || ""}`.toLowerCase();
  const boosts: Array<[RegExp, number]> = [
    [/luxury|luxurious|five star|5-star|five-star/, 80],
    [/resort|palace|grand hotel|collection|boutique/, 45],
    [/suite|premium|deluxe|executive|sea view|ocean view|panoramic|balcony|terrace/, 30],
    [/spa|private beach|infinity pool|rooftop|concierge|villa/, 25],
  ];
  const penalties: Array<[RegExp, number]> = [
    [/hostel|motel|budget|economy inn|guesthouse|guest house|dorm|shared bathroom/, -250],
    [/airport hotel|business hotel|express hotel/, -35],
  ];
  for (const [pattern, points] of boosts) if (pattern.test(text)) score += points;
  for (const [pattern, points] of penalties) if (pattern.test(text)) score += points;
  const nightly = safeNumber(hotel.nightlyEquivalent, 0);
  if (nightly >= 500) score += 20;
  else if (nightly >= 300) score += 10;
  return score;
}

function luxuryTier(starRating: number | null, fallback?: string): string {
  const stars = safeNumber(starRating, 0);
  if (stars >= 5) return "5-star luxury";
  if (stars >= 4) return "4-star+ luxury";
  return fallback || "luxury candidate";
}

async function searchNuiteeHotels(input: ResolvedTrip, key: string): Promise<HotelOffer[]> {
  const found = await findNuiteeHotelIds(input, key);
  if (!found.ids.length) return [];
  const body = {
    hotelIds: found.ids,
    occupancies: [{ adults: Number(input.travelers || 2) }],
    currency: "USD",
    guestNationality: "US",
    checkin: input.startDate,
    checkout: input.endDate,
    timeout: 10,
    roomMapping: true,
    maxRatesPerHotel: 5,
    includeHotelData: true,
  };
  const response = await fetch(`${NUITEE_BASE}/hotels/rates`, {
    method: "POST",
    headers: nuiteeHeaders(key),
    body: JSON.stringify(body),
  });
  if (response.status === 204) return [];
  const payload = rec(await readResponseJson(response, "raw"));
  if (!response.ok) {
    throw new Error(`Nuitee rates (${response.status}): ${errorText(payload.errors || payload.error || payload.message || payload)}`);
  }
  const hotelDataRows = Array.isArray(payload.hotels) ? payload.hotels : Array.isArray(payload.hotelData) ? payload.hotelData : [];
  const hotelData = new Map(hotelDataRows.map((hotel) => {
    const row = rec(hotel);
    return [str(row.id) || str(row.hotelId), row] as const;
  }));
  const nights = nightsBetween(input.startDate, input.endDate);
  const candidates = arr(payload.data).map((itemValue) => {
    const item = rec(itemValue);
    const choice = kingRoomCandidate(item);
    if (!choice) return null;
    const price = roomTypeTotal(choice.roomType, choice.rate);
    const hotel = hotelData.get(str(item.hotelId)) || rec(item.hotel);
    const total = price.amount;
    const starRating = safeNumber(hotel.starRating ?? hotel.rating, 0) || null;
    const offer: HotelOffer = {
      id: str(item.hotelId),
      offerId: str(choice.roomType.offerId) || str(choice.rate?.offerId) || null,
      name: str(hotel.name) || str(item.hotelName) || `Hotel ${str(item.hotelId)}`,
      total,
      nightlyEquivalent: total > 0 ? Math.round((total / nights) * 100) / 100 : 0,
      nights,
      priceBasis: "full_stay",
      currency: price.currency,
      roomName: str(choice.rate?.name) || str(choice.roomType.name) || "King room",
      bedPreference: "King bed confirmed from rate data",
      boardName: str(choice.rate?.boardName) || null,
      refundable: str(rec(choice.rate?.cancellationPolicies).refundableTag) === "RFN",
      rating: typeof hotel.rating === "number" ? hotel.rating : typeof hotel.starRating === "number" ? hotel.starRating : null,
      starRating,
      address: asHotelAddress(hotel.address),
      photo: str(hotel.main_photo) || str(hotel.mainPhoto) || str(hotel.main_photo_url) || null,
      gallery: [],
      pricingType: "nuitee_sandbox",
      searchCity: found.city,
      luxuryScore: 0,
      luxuryTier: luxuryTier(starRating),
    };
    return offer;
  }).filter((hotel): hotel is HotelOffer => Boolean(hotel && Number.isFinite(hotel.total) && hotel.total > 0 && (!hotel.starRating || hotel.starRating >= 4)));

  const knownLuxury = candidates.filter((hotel) => safeNumber(hotel.starRating, 0) >= 4);
  const pool = knownLuxury.length ? knownLuxury : candidates;
  return pool
    .map((hotel) => ({ ...hotel, luxuryScore: luxuryHotelScore(hotel), luxuryTier: luxuryTier(hotel.starRating, hotel.luxuryTier) }))
    .sort((a, b) => b.luxuryScore - a.luxuryScore || b.nightlyEquivalent - a.nightlyEquivalent)
    .slice(0, 12);
}

function honeymoonImageScore(image: unknown): number {
  if (typeof image === "string") return 0;
  const row = rec(image);
  const text = `${str(row.caption)} ${str(row.category)} ${str(row.type)} ${str(row.description)}`.toLowerCase();
  let score = 0;
  const boosts: Array<[RegExp, number]> = [
    [/ocean|sea view|water view|lake view|beach|coast|cliff|panoram|scenic|sunset|view/, 60],
    [/exterior|facade|façade|property|hotel exterior|resort/, 50],
    [/pool|infinity pool|swimming/, 45],
    [/terrace|rooftop|balcony|patio|garden|courtyard/, 40],
    [/suite|bedroom|guest room|king room|room/, 30],
    [/lobby|lounge|bar|spa/, 15],
  ];
  const penalties: Array<[RegExp, number]> = [
    [/bathroom|toilet|wc|shower|bathtub|sink/, -80],
    [/hallway|corridor|stair|elevator|lift/, -70],
    [/meeting|conference|banquet|ballroom|business center/, -70],
    [/logo|sign|entrance sign|parking|garage/, -65],
    [/breakfast|buffet|food|dish|restaurant table|menu/, -45],
    [/gym|fitness|laundry|desk|workstation/, -35],
  ];
  for (const [pattern, points] of boosts) if (pattern.test(text)) score += points;
  for (const [pattern, points] of penalties) if (pattern.test(text)) score += points;
  if (row.defaultImage) score += 12;
  const order = safeNumber(row.order, 9999);
  if (order < 10) score += Math.max(0, 10 - order);
  return score;
}

function imageGallery(details: unknown): HotelGalleryImage[] {
  const rows = arr(rec(details).hotelImages);
  rows.sort((a, b) => honeymoonImageScore(b) - honeymoonImageScore(a) || Number(Boolean(rec(b).defaultImage)) - Number(Boolean(rec(a).defaultImage)) || safeNumber(rec(a).order, 9999) - safeNumber(rec(b).order, 9999));
  const seen = new Set<string>();
  const gallery: HotelGalleryImage[] = [];
  let roomIncluded = false;
  for (const image of rows) {
    const url = typeof image === "string" ? image : str(rec(image).url);
    if (!url || seen.has(url)) continue;
    const caption = typeof image === "string" ? "" : str(rec(image).caption);
    const text = `${caption} ${typeof image === "string" ? "" : str(rec(image).category)} ${typeof image === "string" ? "" : str(rec(image).type)}`.toLowerCase();
    const score = honeymoonImageScore(image);
    const clearlyBad = /bathroom|toilet|wc|hallway|corridor|meeting|conference|banquet|logo|parking|garage/.test(text);
    if (clearlyBad && gallery.length < 4) continue;
    if (score < -20 && gallery.length < 5) continue;
    const isRoom = /suite|bedroom|guest room|king room|room/.test(text) && !/bathroom/.test(text);
    seen.add(url);
    gallery.push({ url, caption, score });
    if (isRoom) roomIncluded = true;
    if (gallery.length >= 6) break;
  }
  if (!roomIncluded) {
    const roomImage = rows.find((image) => {
      const text = `${typeof image === "string" ? "" : str(rec(image).caption)} ${typeof image === "string" ? "" : str(rec(image).category)}`.toLowerCase();
      const url = typeof image === "string" ? image : str(rec(image).url);
      return url && !seen.has(url) && /suite|bedroom|guest room|king room|room/.test(text) && !/bathroom|meeting|conference/.test(text);
    });
    if (roomImage) {
      const room = {
        url: typeof roomImage === "string" ? roomImage : str(rec(roomImage).url),
        caption: typeof roomImage === "string" ? "" : str(rec(roomImage).caption),
        score: honeymoonImageScore(roomImage),
      };
      if (gallery.length >= 6) gallery[gallery.length - 1] = room;
      else gallery.push(room);
    }
  }
  return gallery.slice(0, 6);
}

async function enrichNuiteeHotel(hotel: HotelOffer, key: string): Promise<HotelOffer> {
  if (!hotel.id) return hotel;
  const url = new URL(`${NUITEE_BASE}/data/hotel`);
  url.searchParams.set("hotelId", hotel.id);
  url.searchParams.set("timeout", "5");
  const response = await fetch(url, { headers: nuiteeHeaders(key) });
  const payload = rec(await readResponseJson(response));
  if (!response.ok || !isRecord(payload.data)) return hotel;
  const details = payload.data;
  const gallery = imageGallery(details);
  const starRating = typeof details.starRating === "number" ? details.starRating : hotel.starRating;
  const enriched: HotelOffer = {
    ...hotel,
    name: str(details.name) || hotel.name,
    address: asHotelAddress(details.address) || hotel.address,
    rating: typeof details.rating === "number" ? details.rating : typeof details.starRating === "number" ? details.starRating : hotel.rating,
    starRating,
    reviewCount: typeof details.reviewCount === "number" ? details.reviewCount : null,
    description: str(details.hotelDescription) || null,
    facilities: Array.isArray(details.hotelFacilities) ? details.hotelFacilities.slice(0, 12) : [],
    location: details.location ?? null,
    gallery,
    photo: gallery[0]?.url || str(details.main_photo) || hotel.photo,
  };
  return { ...enriched, luxuryScore: luxuryHotelScore(enriched), luxuryTier: luxuryTier(enriched.starRating, enriched.luxuryTier) };
}

export function chooseGoForItPairing(flights: FlightOffer[], hotels: HotelOffer[], budget: number): Pairing | null {
  const combos: Array<Omit<Pairing, "label" | "targetTotal">> = [];
  for (const flight of flights) {
    for (const hotel of hotels) {
      const subtotal = safeNumber(flight.total) + safeNumber(hotel.total);
      if (subtotal > 0) {
        combos.push({
          flightId: flight.id,
          hotelId: hotel.id,
          travelSubtotal: subtotal,
          luxuryScore: safeNumber(hotel.luxuryScore, 0),
        });
      }
    }
  }
  if (!combos.length) return null;
  combos.sort((a, b) => b.luxuryScore - a.luxuryScore || a.travelSubtotal - b.travelSubtotal);
  if (!budget || budget <= 0) {
    const pair = combos[0];
    return { ...pair, label: "GO FOR IT", targetTotal: Math.round(pair.travelSubtotal * 1.3) };
  }
  const affordable = combos.filter((combo) => combo.travelSubtotal <= budget);
  const pool = affordable.length ? affordable : combos;
  const travelTarget = budget * 0.78;
  const pair = pool.reduce((best, combo) => {
    const bestValue = Math.abs(best.travelSubtotal - travelTarget) - best.luxuryScore * 8;
    const comboValue = Math.abs(combo.travelSubtotal - travelTarget) - combo.luxuryScore * 8;
    return comboValue < bestValue ? combo : best;
  }, pool[0]);
  return { ...pair, label: "GO FOR IT", targetTotal: Math.max(pair.travelSubtotal, budget * 0.98) };
}

async function buildAIPlan(input: TripInput, travelData: Pick<SearchSuccess, "geography" | "flightPricing" | "hotelPricing" | "pairing" | "selectedFlight" | "selectedHotel">, apiKey: string): Promise<RawAiPlan | null> {
  const leanData = {
    geography: travelData.geography,
    flightPricing: travelData.flightPricing,
    hotelPricing: travelData.hotelPricing,
    pairing: travelData.pairing,
    flight: travelData.selectedFlight,
    hotel: travelData.selectedHotel,
  };
  const prompt = `You are the planning engine for American Honeymooner. Build ONE honeymoon plan only, labeled GO FOR IT. The user has already been matched to one flight and one hotel. Respect the requested destination even when the flight lands at a gateway airport. Nuitee hotel totals are full-stay totals. The selected hotel room has been filtered for a single king-bed setup suitable for a honeymoon. The hotel selection is intentionally luxury-first: favor polished 4-5 star, resort, boutique, palace, villa, suite, spa, view, terrace, pool and high-end honeymoon properties; never frame a basic, budget, hostel, motel, dorm, shared-bathroom or business-style property as acceptable luxury. Do not suggest switching to two queens or twin beds. Do not invent flight or hotel prices. Use the available trip budget for excellent dining, activities, local transportation and romantic experiences rather than leaving large amounts unused. In whyItWorks, include 2-3 concise, practical honeymoon tips. One should normally remind the couple to tell the hotel when booking that it is their honeymoon because hotels may offer a nicer room, welcome amenity, champagne, upgrade, or late checkout when available; never promise an upgrade or free amenity. Other tips can cover restaurant reservations, airport transfers, room requests, special-occasion notes, or booking timing. Return JSON only with summary and options, where options contains exactly one object with label,title,flightId,hotelId,whyItWorks,itinerary[{day,title,morning,afternoon,evening}]. No markdown.\n\nTraveler input:\n${JSON.stringify(input, null, 2)}\n\nTravel data:\n${JSON.stringify(leanData, null, 2)}`;
  const text = await geminiText(apiKey, prompt);
  const parsed = parseModelJson(text);
  if (isRecord(parsed)) return { summary: str(parsed.summary), options: arr(parsed.options) };
  return { summary: text || "", options: [] };
}

export function normalizeAIPlan(aiPlan: RawAiPlan | null, travelData: Pick<SearchSuccess, "pairing" | "selectedFlight" | "selectedHotel">, input: TripInput): AiPlan {
  const option = rec(aiPlan?.options?.[0]);
  const pairing = travelData.pairing;
  const flight = travelData.selectedFlight;
  const hotel = travelData.selectedHotel;
  const flightTotal = safeNumber(flight?.total);
  const hotelTotal = safeNumber(hotel?.total);
  const travelSubtotal = Math.round((flightTotal + hotelTotal) * 100) / 100;
  const budget = safeNumber(input.budget, 0);
  let targetTotal = pairing?.targetTotal || travelSubtotal + Math.round(Math.max(600, travelSubtotal * 0.3));
  if (budget > 0) targetTotal = Math.min(Math.max(travelSubtotal, targetTotal), Math.max(travelSubtotal, budget));
  const estimatedOnTripSpend = Math.max(0, Math.round((targetTotal - travelSubtotal) * 100) / 100);
  const itinerary = arr(option.itinerary).map((day, index) => {
    const row = rec(day);
    return {
      day: Number(row.day) || index + 1,
      title: str(row.title),
      morning: str(row.morning),
      afternoon: str(row.afternoon),
      evening: str(row.evening),
    };
  });
  const normalized: PlanOption = {
    label: "GO FOR IT",
    title: str(option.title),
    whyItWorks: str(option.whyItWorks),
    itinerary,
    flightId: flight?.id || null,
    hotelId: hotel?.id || null,
    flightTotal,
    hotelTotal,
    travelSubtotal,
    estimatedOnTripSpend,
    estimatedTripTotal: Math.round((travelSubtotal + estimatedOnTripSpend) * 100) / 100,
    budgetTarget: budget || null,
    currency: flight?.currency || hotel?.currency || "USD",
    flightDetails: flight || null,
    hotelDetails: hotel || null,
  };
  return { summary: aiPlan?.summary || "", options: [normalized] };
}

export async function searchPlaces(query: string, secrets: PlannerSecrets): Promise<PlaceSuggestion[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  const token = requireDuffel(secrets);
  const places = await duffelPlaceSuggestions(trimmed, token);
  return places.slice(0, 8).map((place) => ({
    id: place.id,
    type: place.type,
    name: place.name,
    cityName: place.city_name || place.name,
    countryCode: place.iata_country_code,
    iataCode: place.iata_code,
    airportCount: Array.isArray(place.airports) ? place.airports.length : null,
  }));
}

export async function runLiveSearch(input: TripInput, secrets: PlannerSecrets): Promise<SearchSuccess> {
  const token = requireDuffel(secrets);
  const nuiteeKey = requireNuitee(secrets);
  const resolved = await resolveTripGeography(input, secrets);
  const [flights, hotels] = await Promise.all([
    searchDuffelFlights(resolved, token),
    searchNuiteeHotels(resolved, nuiteeKey),
  ]);
  if (!flights.length) {
    throw new HttpError(`No usable flights found from ${resolved.originCode} to ${resolved.destinationCode}.`, 404);
  }
  if (!hotels.length) {
    throw new HttpError(
      `No 4-star+ honeymoon-quality Nuitee sandbox hotels with a confirmed king-bed room were found around ${resolved.resolvedDestinationName || resolved.destinationName}. Try nearby dates or a nearby honeymoon town.`,
      404,
    );
  }

  const pairing = chooseGoForItPairing(flights, hotels, safeNumber(input.budget, 0));
  let selectedFlight = flights.find((flight) => flight.id === pairing?.flightId) || flights[0];
  let selectedHotel = hotels.find((hotel) => hotel.id === pairing?.hotelId) || hotels[0];

  const [freshOffer, richHotel] = await Promise.all([
    selectedFlight?.id
      ? refreshDuffelOffer(selectedFlight.id, token).catch(() => null)
      : Promise.resolve(null),
    enrichNuiteeHotel(selectedHotel, nuiteeKey).catch(() => selectedHotel),
  ]);
  if (freshOffer) selectedFlight = summarizeDuffelOffer(freshOffer);
  selectedHotel = richHotel || selectedHotel;

  if (safeNumber(selectedHotel.starRating, 0) > 0 && safeNumber(selectedHotel.starRating, 0) < 4) {
    throw new HttpError(
      "The selected hotel did not meet the 4-star honeymoon-quality requirement after verification. Try nearby dates or another honeymoon destination.",
      404,
    );
  }

  const isTest = secrets.duffelEnv !== "live";
  const geography = {
    requestedOrigin: input.originName,
    requestedDestination: input.destinationName,
    originAirportCode: resolved.originCode,
    destinationAirportCode: resolved.destinationCode,
    destinationAirportName: resolved.resolvedDestinationAirportName,
    destinationDisplayName: resolved.resolvedDestinationName || input.destinationName,
    hotelSearchCities: resolved.hotelSearchCities,
    explanation: resolved.geographyExplanation,
  };
  const travelData = {
    mode: isTest ? "duffel_test" as const : "live" as const,
    flightPricing: isTest ? "Duffel test-mode offer" : "Validated live Duffel offer",
    hotelPricing: "Nuitee sandbox full-stay luxury king-room hotel rate",
    searchedAt: new Date().toISOString(),
    geography,
    pairing,
    selectedFlight,
    selectedHotel,
  };
  const rawAIPlan = secrets.geminiKey ? await buildAIPlan(input, travelData, secrets.geminiKey) : null;
  const aiPlan = normalizeAIPlan(rawAIPlan, travelData, input);
  return {
    ...travelData,
    flights: [selectedFlight],
    hotels: [selectedHotel],
    aiPlan,
    aiModel: GEMINI_MODEL,
  };
}
