import { nightsBetween } from "./json";
import { chooseGoForItPairing, luxuryHotelScore, normalizeAIPlan } from "./travel";
import type { FlightOffer, HotelOffer, ItineraryDay, PlaceSuggestion, SearchSuccess, TripInput } from "./types";

interface KnownPlace {
  match: RegExp;
  code: string;
  airportName: string;
  city: string;
  country: string;
  hotelCities?: string[];
}

const PLACES: KnownPlace[] = [
  { match: /chicago|o'hare|ohare|\bord\b/i, code: "ORD", airportName: "Chicago O'Hare International", city: "Chicago", country: "US" },
  { match: /new york|nyc|manhattan|\bjfk\b/i, code: "JFK", airportName: "John F. Kennedy International", city: "New York", country: "US" },
  { match: /los angeles|\blax\b/i, code: "LAX", airportName: "Los Angeles International", city: "Los Angeles", country: "US" },
  { match: /miami|\bmia\b/i, code: "MIA", airportName: "Miami International", city: "Miami", country: "US" },
  { match: /tampa|\btpa\b/i, code: "TPA", airportName: "Tampa International", city: "Tampa", country: "US" },
  { match: /san francisco|\bsfo\b/i, code: "SFO", airportName: "San Francisco International", city: "San Francisco", country: "US" },
  { match: /amalfi|positano|ravello|sorrento|naples|napoli|\bnap\b/i, code: "NAP", airportName: "Naples International", city: "Naples", country: "IT", hotelCities: ["Positano", "Amalfi", "Ravello"] },
  { match: /rome|roma|\bfco\b/i, code: "FCO", airportName: "Rome Fiumicino", city: "Rome", country: "IT", hotelCities: ["Rome"] },
  { match: /florence|firenze|\bflr\b/i, code: "FLR", airportName: "Florence Airport", city: "Florence", country: "IT", hotelCities: ["Florence"] },
  { match: /paris|\bcdg\b/i, code: "CDG", airportName: "Paris Charles de Gaulle", city: "Paris", country: "FR", hotelCities: ["Paris"] },
  { match: /london|\blhr\b/i, code: "LHR", airportName: "London Heathrow", city: "London", country: "GB", hotelCities: ["London"] },
  { match: /santorini|mykonos|athens|\bath\b/i, code: "ATH", airportName: "Athens International", city: "Athens", country: "GR", hotelCities: ["Santorini", "Mykonos", "Athens"] },
  { match: /maui|honolulu|hawaii|\bhnl\b/i, code: "HNL", airportName: "Daniel K. Inouye International", city: "Honolulu", country: "US", hotelCities: ["Wailea", "Honolulu"] },
  { match: /bali|denpasar|\bdps\b/i, code: "DPS", airportName: "Ngurah Rai International", city: "Denpasar", country: "ID", hotelCities: ["Ubud", "Seminyak"] },
  { match: /maldives|\bmlé\b|\bmle\b|\bmale\b/i, code: "MLE", airportName: "Velana International", city: "Malé", country: "MV", hotelCities: ["Malé"] },
  { match: /kyoto|osaka|\bkix\b/i, code: "KIX", airportName: "Kansai International", city: "Osaka", country: "JP", hotelCities: ["Kyoto", "Osaka"] },
  { match: /tokyo|\bhnd\b|\bnrt\b/i, code: "HND", airportName: "Tokyo Haneda", city: "Tokyo", country: "JP", hotelCities: ["Tokyo"] },
];

function fallbackCode(name: string): string {
  const letters = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z]/g, "").toUpperCase();
  return (letters + "XXX").slice(0, 3);
}

function resolvePlace(text: string): KnownPlace {
  const found = PLACES.find((place) => place.match.test(text));
  if (found) return found;
  const city = text.trim() || "City";
  return {
    match: /$^/,
    code: fallbackCode(city),
    airportName: `${city} preview gateway`,
    city,
    country: "US",
  };
}

function previewPhoto(label: string, background: string): string {
  const safe = label.replace(/[<&>]/g, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="${background}"/><text x="600" y="380" text-anchor="middle" fill="#f7f2e8" font-family="Georgia, serif" font-size="54">${safe}</text><text x="600" y="450" text-anchor="middle" fill="#f7f2e8" font-family="Georgia, serif" font-size="22">Preview photograph</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function addDays(isoDate: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function splitBudget(budget: number): { flightTotal: number; hotelTotal: number } {
  const flightTotal = Math.max(1, Math.round(budget * 0.34));
  const hotelTotal = Math.max(1, Math.round(budget * 0.46));
  if (flightTotal + hotelTotal <= budget) return { flightTotal, hotelTotal };
  const flight = Math.max(1, Math.floor(budget * 0.4));
  return { flightTotal: flight, hotelTotal: Math.max(0, Math.round((budget - flight) * 0.7)) };
}

function buildItinerary(input: TripInput, destination: string, hotelName: string, nights: number): ItineraryDay[] {
  const totalDays = Math.min(Math.max(nights + 1, 2), 7);
  const packed = /pack/i.test(input.pace);
  const relaxed = /relax/i.test(input.pace);
  const afternoon = packed
    ? `A fuller afternoon around ${destination}: one neighborhood on foot, then a viewpoint you would otherwise skip.`
    : relaxed
      ? `Nothing scheduled. Stay at ${hotelName}, swim, and leave the afternoon open.`
      : `A slow loop through ${destination} with one reservation and a long break back at the hotel.`;
  const days: ItineraryDay[] = [];
  for (let day = 1; day <= totalDays; day += 1) {
    if (day === 1) {
      days.push({
        day,
        title: "Arrive and check in",
        morning: `Fly the sample itinerary and transfer to ${hotelName}.`,
        afternoon: `Settle into the king room and tell the front desk this is your honeymoon.`,
        evening: `A first dinner close to the hotel. Keep it easy after the flight.`,
      });
    } else if (day === totalDays) {
      days.push({
        day,
        title: "One last morning, then home",
        morning: `Breakfast and a last walk before checkout.`,
        afternoon: `Transfer back to the airport for the sample return flight.`,
        evening: `Travel home. The rest of the budget stays with the trip, not with extra hotels.`,
      });
    } else {
      days.push({
        day,
        title: day % 2 === 0 ? `A day in ${destination}` : "Stay put",
        morning: relaxed ? "Late breakfast on the property." : `Coffee, then one planned outing in ${destination}.`,
        afternoon,
        evening: input.styles.includes("food & wine")
          ? "The reserved dinner. Order the wine."
          : "Dinner somewhere you can sit for a long time.",
      });
    }
  }
  return days;
}

export function demoPlaceSuggestions(query: string): PlaceSuggestion[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length < 2) return [];
  return PLACES.filter((place) => {
    const haystack = `${place.city} ${place.code} ${place.airportName} ${(place.hotelCities || []).join(" ")}`.toLowerCase();
    return haystack.includes(trimmed) || place.match.test(query);
  }).slice(0, 8).map((place) => ({
    id: `demo-${place.code.toLowerCase()}`,
    type: "airport",
    name: place.airportName,
    cityName: place.city,
    countryCode: place.country,
    iataCode: place.code,
    airportCount: 1,
  }));
}

export function buildDemoSearch(input: TripInput): SearchSuccess {
  const origin = resolvePlace(input.originName);
  const destination = resolvePlace(input.destinationName);
  const nights = nightsBetween(input.startDate, input.endDate);
  const { flightTotal, hotelTotal } = splitBudget(input.budget);
  const taxAmount = Math.round(flightTotal * 0.14);
  const international = origin.country !== destination.country;
  const outboundArrive = international ? addDays(input.startDate, 1) : input.startDate;
  const hotelCity = destination.hotelCities?.[0] || destination.city;
  const hotelName = `Palazzo Preview, ${hotelCity}`;
  const gallery = [
    { url: previewPhoto("Terrace", "#0c1b2a"), caption: "Terrace" },
    { url: previewPhoto("Coast", "#6e2b3a"), caption: "Coast" },
    { url: previewPhoto("King suite", "#8a7340"), caption: "King suite" },
    { url: previewPhoto("Evening", "#1f3b32"), caption: "Evening" },
  ];
  const segment = (
    from: KnownPlace,
    to: KnownPlace,
    date: string,
    arriveDate: string,
    departTime: string,
    arriveTime: string,
    number: string,
  ): FlightOffer["slices"][number]["segments"][number] => ({
    id: `demo-seg-${number}`,
    airline: "Preview Air",
    airlineCode: "PA",
    airlineLogo: null,
    flightNumber: number,
    operatingAirline: null,
    operatingFlightNumber: null,
    originCode: from.code,
    originName: from.airportName,
    originTerminal: "1",
    destinationCode: to.code,
    destinationName: to.airportName,
    destinationTerminal: "1",
    departingAt: `${date}T${departTime}:00`,
    arrivingAt: `${arriveDate}T${arriveTime}:00`,
    duration: international ? "PT9H20M" : "PT3H10M",
    aircraft: "Airbus A321",
    distanceMiles: international ? 4800 : 860,
    cabinClass: "economy",
    cabinName: "Economy",
    fareBasisCode: null,
    baggage: ["1 carry on", "1 checked bag"],
    wifi: "paid",
    power: true,
    seatPitch: "32",
  });

  const flight: FlightOffer = {
    id: "demo-flight",
    airline: "Preview Air",
    airlineCode: "PA",
    airlineLogo: null,
    stops: 0,
    duration: international ? "PT9H20M / PT10H05M" : "PT3H10M / PT3H25M",
    total: flightTotal,
    currency: "USD",
    baseAmount: flightTotal - taxAmount,
    taxAmount,
    expiresAt: null,
    passengerCount: input.travelers,
    totalEmissionsKg: international ? 920 : 280,
    changePolicy: "Sample policy — not a live fare",
    refundPolicy: "Sample policy — not a live fare",
    availableBagServices: [],
    totalDurationMinutes: international ? 1165 : 395,
    slices: [
      {
        direction: "Outbound",
        duration: international ? "PT9H20M" : "PT3H10M",
        stops: 0,
        changePolicy: "Sample policy — not a live fare",
        segments: [segment(origin, destination, input.startDate, outboundArrive, "09:40", "11:20", "PA418")],
      },
      {
        direction: "Return",
        duration: international ? "PT10H05M" : "PT3H25M",
        stops: 0,
        changePolicy: "Sample policy — not a live fare",
        segments: [segment(destination, origin, input.endDate, international ? addDays(input.endDate, 1) : input.endDate, "15:10", "19:40", "PA219")],
      },
    ],
  };

  const hotel: HotelOffer = {
    id: "demo-hotel",
    offerId: "demo-offer",
    name: hotelName,
    total: hotelTotal,
    nightlyEquivalent: Math.round((hotelTotal / nights) * 100) / 100,
    nights,
    priceBasis: "full_stay",
    currency: "USD",
    roomName: "King sea-view suite",
    bedPreference: "King bed — preview sample",
    boardName: "Breakfast included",
    refundable: true,
    rating: 4.8,
    starRating: 5,
    reviewCount: 128,
    address: `Preview address, ${hotelCity}`,
    photo: gallery[0].url,
    gallery,
    pricingType: "demo_preview",
    searchCity: hotelCity,
    luxuryScore: 0,
    luxuryTier: "5-star luxury",
    description: `Sample 5-star stay in ${input.destinationName}. This is not a live Nuitee rate.`,
    facilities: ["Spa", "Infinity pool", "Concierge", "Sea view", "Terrace"],
    location: null,
  };
  hotel.luxuryScore = luxuryHotelScore(hotel);

  const pairing = chooseGoForItPairing([flight], [hotel], input.budget);
  const geography = {
    requestedOrigin: input.originName,
    requestedDestination: input.destinationName,
    originAirportCode: origin.code,
    destinationAirportCode: destination.code,
    destinationAirportName: destination.airportName,
    destinationDisplayName: input.destinationName,
    hotelSearchCities: destination.hotelCities || [destination.city],
    explanation: "Preview geography. Airport codes are illustrative until Duffel and Gemini are configured.",
  };
  const styleLine = input.styles.length ? input.styles.join(", ") : "romantic";
  const noteLine = input.notes.trim() ? ` Your note: ${input.notes.trim()}` : "";
  const rawPlan = {
    summary: `Sample honeymoon from ${input.originName} to ${input.destinationName}.`,
    options: [
      {
        label: "GO FOR IT",
        title: `${input.destinationName} honeymoon`,
        whyItWorks: `This preview keeps the trip inside your $${Math.round(input.budget).toLocaleString("en-US")} budget with one flight and one hotel, paced ${input.pace.toLowerCase()} and styled ${styleLine}. Tell ${hotelName} when you book that it is your honeymoon — hotels sometimes offer a nicer room, a welcome amenity, champagne, an upgrade, or late checkout when they can, and none of that is promised. Reserve one dinner before you fly, and book the airport transfer ahead of arrival.${noteLine}`,
        itinerary: buildItinerary(input, input.destinationName, hotelName, nights),
      },
    ],
  };
  const travelData = {
    mode: "demo" as const,
    flightPricing: "Preview sample — Duffel is not configured",
    hotelPricing: "Preview sample — not a live Nuitee rate",
    searchedAt: new Date().toISOString(),
    geography,
    pairing,
    selectedFlight: flight,
    selectedHotel: hotel,
  };
  return {
    ...travelData,
    flights: [flight],
    hotels: [hotel],
    aiPlan: normalizeAIPlan(rawPlan, travelData, input),
    aiModel: null,
  };
}
