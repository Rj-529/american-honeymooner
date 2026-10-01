import express from 'express';
import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const PORT = Number(process.env.PORT || 3000);
const DUFFEL_BASE = 'https://api.duffel.com';
const NUITEE_BASE = 'https://api.liteapi.travel/v3.0';
const OPENAI_MODEL = 'gpt-5.6-luna';

function duffelHeaders() {
  const token = process.env.DUFFEL_ACCESS_TOKEN;
  if (!token) throw new Error('Duffel access token is not configured in Render.');
  return { Authorization: `Bearer ${token}`, 'Duffel-Version': 'v2', Accept: 'application/json' };
}
function nuiteeHeaders(includeJson = false) {
  const key = process.env.NUITEE_API_KEY;
  if (!key) throw new Error('Nuitee API key is not configured in Render.');
  const headers = { 'X-API-Key': key, Accept: 'application/json' };
  if (includeJson) headers['Content-Type'] = 'application/json';
  return headers;
}
function errorText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(errorText).filter(Boolean).join('; ');
  if (typeof value === 'object') {
    const preferred = value.message || value.detail || value.title || value.description || value.error;
    if (preferred && preferred !== value) return errorText(preferred);
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}
function safeNumber(value, fallback = 0) {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}
function nightsBetween(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`), end = new Date(`${endDate}T00:00:00Z`);
  const nights = Math.round((end - start) / 86400000);
  return Number.isFinite(nights) && nights > 0 ? nights : 1;
}
function durationMinutes(isoDuration) {
  if (!isoDuration) return Number.MAX_SAFE_INTEGER;
  const match = String(isoDuration).match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  return match ? Number(match[1] || 0) * 60 + Number(match[2] || 0) : Number.MAX_SAFE_INTEGER;
}
function penaltyText(condition, fallbackCurrency = 'USD') {
  if (!condition) return 'Not provided';
  if (condition.allowed === false) return 'Not allowed';
  if (condition.allowed !== true) return 'Not provided';
  const amount = Number(condition.penalty_amount || 0);
  return amount > 0 ? `Allowed with ${amount} ${condition.penalty_currency || fallbackCurrency} penalty` : 'Allowed';
}

async function duffelPlaceSuggestions(query) {
  const url = new URL(`${DUFFEL_BASE}/places/suggestions`);
  url.searchParams.set('query', query);
  const response = await fetch(url, { headers: duffelHeaders() });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorText(payload?.errors?.[0]) || `Duffel place search failed with status ${response.status}.`);
  return payload?.data || [];
}
async function verifyAirportCode(code) {
  if (!code) return null;
  try {
    const places = await duffelPlaceSuggestions(code);
    return places.find((p) => String(p.iata_code || '').toUpperCase() === String(code).toUpperCase()) || null;
  } catch { return null; }
}
async function resolveTripGeography(input) {
  const originText = String(input.originName || input.originCode || '').trim();
  const destinationText = String(input.destinationName || input.destinationCode || '').trim();
  if (!originText || !destinationText) throw new Error('Enter where you are leaving from and where you want to go.');

  if (!process.env.OPENAI_API_KEY) throw new Error('OpenAI is required to interpret natural-language destinations.');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const prompt = `Resolve a leisure trip into practical flight gateways and hotel-search geography. The traveler types human places, not airport codes.\n\nOrigin: ${originText}\nDestination: ${destinationText}\n\nReturn JSON only with: originAirportCode, originAirportName, destinationAirportCode, destinationAirportName, destinationCountryCode (ISO-2), hotelSearchCities (array of 1-3 actual cities/towns appropriate for lodging in the requested destination), destinationDisplayName, explanation.\n\nRules: choose practical major commercial airports. For a region/island/coast, choose the airport a leisure traveler would realistically fly into, but keep the requested region as destinationDisplayName. Example: Chicago to Amalfi Coast should normally resolve to Chicago's practical commercial gateway and Naples NAP, while hotelSearchCities should be Amalfi-area towns such as Amalfi, Positano, or Ravello. Do not invent airport codes.`;
  const response = await client.responses.create({ model: OPENAI_MODEL, reasoning: { effort: 'low' }, input: prompt, store: false });
  let resolved;
  try { resolved = JSON.parse(response.output_text || '{}'); } catch { throw new Error('Could not interpret the trip locations. Try slightly more specific place names.'); }

  const originCode = String(resolved.originAirportCode || '').toUpperCase();
  const destinationCode = String(resolved.destinationAirportCode || '').toUpperCase();
  const [verifiedOrigin, verifiedDestination] = await Promise.all([verifyAirportCode(originCode), verifyAirportCode(destinationCode)]);
  if (!verifiedOrigin) throw new Error(`I interpreted “${originText}” as ${originCode || 'an airport'}, but Duffel could not verify it.`);
  if (!verifiedDestination) throw new Error(`I interpreted “${destinationText}” as ${destinationCode || 'an airport'}, but Duffel could not verify it.`);

  const hotelSearchCities = Array.isArray(resolved.hotelSearchCities) ? resolved.hotelSearchCities.filter(Boolean).slice(0, 3) : [];
  return {
    ...input,
    originCode,
    destinationCode,
    destinationCountryCode: resolved.destinationCountryCode || verifiedDestination.iata_country_code || null,
    resolvedOriginName: resolved.originAirportName || verifiedOrigin.city_name || verifiedOrigin.name || originText,
    resolvedDestinationName: resolved.destinationDisplayName || destinationText,
    resolvedDestinationAirportName: resolved.destinationAirportName || verifiedDestination.name || destinationCode,
    hotelSearchCities: hotelSearchCities.length ? hotelSearchCities : [destinationText],
    geographyExplanation: resolved.explanation || null
  };
}

function summarizeBaggage(baggages) {
  if (!Array.isArray(baggages) || !baggages.length) return [];
  return baggages.map((bag) => {
    const type = String(bag.type || 'baggage').replaceAll('_', ' ');
    const qty = Number(bag.quantity || 1);
    const weight = bag.weight ? ` · ${bag.weight}${bag.weight_unit ? ` ${bag.weight_unit}` : ''}` : '';
    return `${qty} ${type}${qty === 1 ? '' : 's'}${weight}`;
  });
}
function summarizeSegment(segment) {
  const marketing = segment?.marketing_carrier || {}, operating = segment?.operating_carrier || {};
  const carrier = marketing.name ? marketing : operating;
  const carrierCode = marketing.iata_code || operating.iata_code || '';
  const marketingNumber = segment?.marketing_carrier_flight_number || '', operatingNumber = segment?.operating_carrier_flight_number || '';
  const flightNumber = marketingNumber ? `${carrierCode}${marketingNumber}` : operatingNumber ? `${operating.iata_code || carrierCode}${operatingNumber}` : '';
  const passenger = segment?.passengers?.[0] || {};
  const cabin = passenger?.cabin || {};
  const amenities = cabin?.amenities || {};
  return {
    id: segment?.id || null,
    airline: carrier.name || carrierCode || 'Airline',
    airlineCode: carrierCode,
    airlineLogo: carrier.logo_symbol_url || marketing.logo_symbol_url || operating.logo_symbol_url || null,
    flightNumber,
    operatingAirline: operating.name || operating.iata_code || null,
    operatingFlightNumber: operatingNumber ? `${operating.iata_code || carrierCode}${operatingNumber}` : null,
    originCode: segment?.origin?.iata_code || '', originName: segment?.origin?.name || '', originTerminal: segment?.origin_terminal || null,
    destinationCode: segment?.destination?.iata_code || '', destinationName: segment?.destination?.name || '', destinationTerminal: segment?.destination_terminal || null,
    departingAt: segment?.departing_at || null, arrivingAt: segment?.arriving_at || null, duration: segment?.duration || null,
    aircraft: segment?.aircraft?.name || null,
    distanceMiles: segment?.distance ? Math.round(Number(segment.distance)) : null,
    cabinClass: passenger?.cabin_class || null,
    cabinName: passenger?.cabin_class_marketing_name || cabin?.marketing_name || cabin?.name || null,
    fareBasisCode: passenger?.fare_basis_code || null,
    baggage: summarizeBaggage(passenger?.baggages),
    wifi: amenities?.wifi?.available === true || amenities?.wifi?.available === 'true' ? (amenities?.wifi?.cost || 'available') : null,
    power: amenities?.power?.available === true || amenities?.power?.available === 'true',
    seatPitch: amenities?.seat?.pitch || null
  };
}
function summarizeDuffelOffer(offer) {
  const slices = offer.slices || [], allSegments = slices.flatMap((slice) => slice.segments || []);
  const carrier = offer?.owner || allSegments[0]?.marketing_carrier || allSegments[0]?.operating_carrier || {};
  const maxStops = slices.reduce((max, slice) => Math.max(max, Math.max(0, (slice.segments || []).length - 1)), 0);
  const currency = offer.total_currency || 'USD';
  return {
    id: offer.id,
    airline: carrier.name || carrier.iata_code || 'Airline',
    airlineCode: carrier.iata_code || null,
    airlineLogo: carrier.logo_symbol_url || null,
    stops: maxStops,
    duration: slices.map((slice) => slice.duration || '').filter(Boolean).join(' / '),
    total: Number(offer.total_amount || 0), currency,
    baseAmount: Number(offer.base_amount || 0), taxAmount: Number(offer.tax_amount || 0),
    expiresAt: offer.expires_at || null,
    passengerCount: Array.isArray(offer.passengers) ? offer.passengers.length : null,
    totalEmissionsKg: safeNumber(offer.total_emissions_kg, 0) || null,
    changePolicy: penaltyText(offer?.conditions?.change_before_departure, currency),
    refundPolicy: penaltyText(offer?.conditions?.refund_before_departure, currency),
    availableBagServices: (offer.available_services || []).filter((s) => s.type === 'baggage').map((s) => ({ amount: Number(s.total_amount || 0), currency: s.total_currency || currency, maximumQuantity: s.maximum_quantity || null })),
    totalDurationMinutes: slices.reduce((sum, slice) => sum + durationMinutes(slice.duration), 0),
    slices: slices.map((slice, index) => ({
      direction: index === 0 ? 'Outbound' : index === 1 ? 'Return' : `Leg ${index + 1}`,
      duration: slice.duration || null,
      stops: Math.max(0, (slice.segments || []).length - 1),
      changePolicy: penaltyText(slice?.conditions?.change_before_departure, currency),
      segments: (slice.segments || []).map(summarizeSegment)
    }))
  };
}
function maxReasonableFlightTotal(input) {
  const travelers = Math.max(1, Number(input.travelers || 2));
  const cabin = String(input.travelClass || 'economy').toLowerCase();
  const perTraveler = cabin === 'first' ? 30000 : cabin === 'business' ? 18000 : cabin === 'premium_economy' ? 9000 : 7500;
  return travelers * perTraveler;
}
async function refreshDuffelOffer(offerId) {
  const url = new URL(`${DUFFEL_BASE}/air/offers/${offerId}`);
  url.searchParams.set('return_available_services', 'true');
  const response = await fetch(url, { headers: duffelHeaders() });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorText(payload?.errors?.[0]) || `Duffel offer refresh failed with status ${response.status}.`);
  return payload?.data || null;
}
async function searchDuffelFlights(input) {
  const body = { data: { slices: [{ origin: input.originCode, destination: input.destinationCode, departure_date: input.startDate }, { origin: input.destinationCode, destination: input.originCode, departure_date: input.endDate }], passengers: Array.from({ length: Number(input.travelers || 2) }, () => ({ type: 'adult' })), cabin_class: String(input.travelClass || 'economy').toLowerCase() } };
  const requestResponse = await fetch(`${DUFFEL_BASE}/air/offer_requests?return_offers=false&supplier_timeout=15000`, { method: 'POST', headers: { ...duffelHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const requestPayload = await requestResponse.json().catch(() => ({}));
  if (!requestResponse.ok) throw new Error(errorText(requestPayload?.errors?.[0]) || `Duffel request failed with status ${requestResponse.status}.`);
  const requestId = requestPayload?.data?.id;
  if (!requestId) throw new Error('Duffel did not return an offer request ID.');

  const offersUrl = new URL(`${DUFFEL_BASE}/air/offers`);
  offersUrl.searchParams.set('offer_request_id', requestId);
  offersUrl.searchParams.set('sort', 'total_amount');
  offersUrl.searchParams.set('limit', '20');
  const offersResponse = await fetch(offersUrl, { headers: duffelHeaders() });
  const offersPayload = await offersResponse.json().catch(() => ({}));
  if (!offersResponse.ok) throw new Error(errorText(offersPayload?.errors?.[0]) || `Duffel offers list failed with status ${offersResponse.status}.`);

  const maxTotal = maxReasonableFlightTotal(input);
  return (Array.isArray(offersPayload?.data) ? offersPayload.data : [])
    .map(summarizeDuffelOffer)
    .filter((offer) => Number.isFinite(offer.total) && offer.total > 0 && offer.total <= maxTotal)
    .sort((a, b) => a.total - b.total)
    .slice(0, 12);
}

function hotelIdsFromPayload(payload) {
  if (Array.isArray(payload?.hotelIds)) return payload.hotelIds;
  if (typeof payload?.HotelIds === 'string') return payload.HotelIds.split(',').map((x) => x.trim()).filter(Boolean);
  if (Array.isArray(payload?.HotelIds)) return payload.HotelIds;
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return rows.map((h) => h.id || h.hotelId).filter(Boolean);
}
async function findNuiteeHotelIds(input) {
  const countryCode = input.destinationCountryCode;
  if (!countryCode) throw new Error(`Nuitee: could not determine the country for ${input.destinationName}.`);
  const cities = [...new Set([...(input.hotelSearchCities || []), input.destinationName].filter(Boolean))];
  for (const city of cities) {
    const url = new URL(`${NUITEE_BASE}/data/hotels`);
    url.searchParams.set('countryCode', countryCode);
    url.searchParams.set('cityName', city);
    url.searchParams.set('limit', '50');
    const response = await fetch(url, { headers: nuiteeHeaders() });
    const raw = await response.text(); let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw }; }
    if (!response.ok) continue;
    const ids = hotelIdsFromPayload(payload).slice(0, 50);
    if (ids.length) return { ids, city };
  }
  return { ids: [], city: cities[0] || input.destinationName };
}
function rateTotal(rate) {
  const totals = rate?.retailRate?.total, first = Array.isArray(totals) ? totals[0] : totals;
  return { amount: Number(first?.amount ?? first?.value ?? 0), currency: first?.currency || 'USD' };
}
function roomTypeTotal(roomType, rate) {
  const offer = roomType?.offerRetailRate;
  if (offer && Number(offer.amount) > 0) return { amount: Number(offer.amount), currency: offer.currency || 'USD' };
  return rateTotal(rate);
}
function kingRoomCandidate(item) {
  const candidates = [];
  for (const roomType of item?.roomTypes || []) {
    const rates = Array.isArray(roomType?.rates) && roomType.rates.length ? roomType.rates : [null];
    for (const rate of rates) {
      const text = JSON.stringify({
        roomName: roomType?.name,
        roomDescription: roomType?.description,
        roomInfo: roomType?.roomInfo,
        beds: roomType?.beds,
        bedType: roomType?.bedType,
        rateName: rate?.name,
        rateDescription: rate?.description,
        rateBeds: rate?.beds,
        rateBedType: rate?.bedType
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
function luxuryHotelScore(hotel) {
  let score = 0;
  const stars = safeNumber(hotel?.starRating, 0);
  if (stars >= 5) score += 180;
  else if (stars >= 4.5) score += 140;
  else if (stars >= 4) score += 100;
  else if (stars > 0) score -= 300;

  const text = `${hotel?.name || ''} ${hotel?.roomName || ''} ${hotel?.description || ''}`.toLowerCase();
  const boosts = [
    [/luxury|luxurious|five star|5-star|five-star/, 80],
    [/resort|palace|grand hotel|collection|boutique/, 45],
    [/suite|premium|deluxe|executive|sea view|ocean view|panoramic|balcony|terrace/, 30],
    [/spa|private beach|infinity pool|rooftop|concierge|villa/, 25]
  ];
  const penalties = [
    [/hostel|motel|budget|economy inn|guesthouse|guest house|dorm|shared bathroom/, -250],
    [/airport hotel|business hotel|express hotel/, -35]
  ];
  for (const [pattern, points] of boosts) if (pattern.test(text)) score += points;
  for (const [pattern, points] of penalties) if (pattern.test(text)) score += points;

  const nightly = safeNumber(hotel?.nightlyEquivalent, 0);
  if (nightly >= 500) score += 20;
  else if (nightly >= 300) score += 10;
  return score;
}
async function searchNuiteeHotels(input) {
  if (!process.env.NUITEE_API_KEY) return [];
  const found = await findNuiteeHotelIds(input);
  if (!found.ids.length) return [];
  const body = { hotelIds: found.ids, occupancies: [{ adults: Number(input.travelers || 2) }], currency: 'USD', guestNationality: 'US', checkin: input.startDate, checkout: input.endDate, timeout: 10, roomMapping: true, maxRatesPerHotel: 5, includeHotelData: true };
  const response = await fetch(`${NUITEE_BASE}/hotels/rates`, { method: 'POST', headers: nuiteeHeaders(true), body: JSON.stringify(body) });
  if (response.status === 204) return [];
  const raw = await response.text(); let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw }; }
  if (!response.ok) throw new Error(`Nuitee rates (${response.status}): ${errorText(payload?.errors || payload?.error || payload?.message || payload)}`);
  const hotelDataRows = Array.isArray(payload?.hotels) ? payload.hotels : Array.isArray(payload?.hotelData) ? payload.hotelData : [];
  const hotelData = new Map(hotelDataRows.map((hotel) => [hotel.id || hotel.hotelId, hotel]));
  const nights = nightsBetween(input.startDate, input.endDate);
  const candidates = (payload?.data || []).map((item) => {
    const choice = kingRoomCandidate(item);
    if (!choice) return null;
    const roomType = choice.roomType, rate = choice.rate, price = roomTypeTotal(roomType, rate), hotel = hotelData.get(item.hotelId) || item.hotel || {};
    const total = price.amount;
    const starRating = safeNumber(hotel.starRating ?? hotel.rating, 0) || null;
    return { id: item.hotelId, offerId: roomType?.offerId || rate?.offerId || null, name: hotel.name || item.hotelName || `Hotel ${item.hotelId}`, total, nightlyEquivalent: total > 0 ? Math.round((total / nights) * 100) / 100 : 0, nights, priceBasis: 'full_stay', currency: price.currency, roomName: rate?.name || roomType?.name || 'King room', bedPreference: 'King bed confirmed from rate data', boardName: rate?.boardName || null, refundable: rate?.cancellationPolicies?.refundableTag === 'RFN', rating: hotel.rating ?? hotel.starRating ?? null, starRating, address: hotel.address || null, photo: hotel.main_photo || hotel.mainPhoto || hotel.main_photo_url || null, gallery: [], pricingType: 'nuitee_sandbox', searchCity: found.city };
  }).filter((hotel) => hotel && Number.isFinite(hotel.total) && hotel.total > 0 && (!hotel.starRating || hotel.starRating >= 4));

  const knownLuxury = candidates.filter((hotel) => safeNumber(hotel.starRating, 0) >= 4);
  const pool = knownLuxury.length ? knownLuxury : candidates;
  return pool
    .map((hotel) => ({ ...hotel, luxuryScore: luxuryHotelScore(hotel), luxuryTier: safeNumber(hotel.starRating, 0) >= 5 ? '5-star luxury' : safeNumber(hotel.starRating, 0) >= 4 ? '4-star+ luxury' : 'luxury candidate' }))
    .sort((a, b) => b.luxuryScore - a.luxuryScore || b.nightlyEquivalent - a.nightlyEquivalent)
    .slice(0, 12);
}
function honeymoonImageScore(image) {
  if (typeof image === 'string') return 0;
  const text = `${image?.caption || ''} ${image?.category || ''} ${image?.type || ''} ${image?.description || ''}`.toLowerCase();
  let score = 0;
  const boosts = [
    [/ocean|sea view|water view|lake view|beach|coast|cliff|panoram|scenic|sunset|view/, 60],
    [/exterior|facade|façade|property|hotel exterior|resort/, 50],
    [/pool|infinity pool|swimming/, 45],
    [/terrace|rooftop|balcony|patio|garden|courtyard/, 40],
    [/suite|bedroom|guest room|king room|room/, 30],
    [/lobby|lounge|bar|spa/, 15]
  ];
  const penalties = [
    [/bathroom|toilet|wc|shower|bathtub|sink/, -80],
    [/hallway|corridor|stair|elevator|lift/, -70],
    [/meeting|conference|banquet|ballroom|business center/, -70],
    [/logo|sign|entrance sign|parking|garage/, -65],
    [/breakfast|buffet|food|dish|restaurant table|menu/, -45],
    [/gym|fitness|laundry|desk|workstation/, -35]
  ];
  for (const [pattern, points] of boosts) if (pattern.test(text)) score += points;
  for (const [pattern, points] of penalties) if (pattern.test(text)) score += points;
  if (image?.defaultImage) score += 12;
  const order = safeNumber(image?.order, 9999);
  if (order < 10) score += Math.max(0, 10 - order);
  return score;
}
function imageGallery(details) {
  const rows = Array.isArray(details?.hotelImages) ? [...details.hotelImages] : [];
  rows.sort((a, b) => honeymoonImageScore(b) - honeymoonImageScore(a) || Number(Boolean(b?.defaultImage)) - Number(Boolean(a?.defaultImage)) || safeNumber(a?.order, 9999) - safeNumber(b?.order, 9999));
  const seen = new Set();
  const gallery = [];
  let roomIncluded = false;
  for (const image of rows) {
    const url = typeof image === 'string' ? image : image?.url;
    if (!url || seen.has(url)) continue;
    const caption = typeof image === 'string' ? '' : image?.caption || '';
    const text = `${caption} ${typeof image === 'string' ? '' : image?.category || ''} ${typeof image === 'string' ? '' : image?.type || ''}`.toLowerCase();
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
      const text = `${typeof image === 'string' ? '' : image?.caption || ''} ${typeof image === 'string' ? '' : image?.category || ''}`.toLowerCase();
      const url = typeof image === 'string' ? image : image?.url;
      return url && !seen.has(url) && /suite|bedroom|guest room|king room|room/.test(text) && !/bathroom|meeting|conference/.test(text);
    });
    if (roomImage) {
      const room = { url: typeof roomImage === 'string' ? roomImage : roomImage.url, caption: typeof roomImage === 'string' ? '' : roomImage.caption || '', score: honeymoonImageScore(roomImage) };
      if (gallery.length >= 6) gallery[gallery.length - 1] = room; else gallery.push(room);
    }
  }
  return gallery.slice(0, 6);
}
async function enrichNuiteeHotel(hotel) {
  if (!hotel?.id) return hotel;
  const url = new URL(`${NUITEE_BASE}/data/hotel`);
  url.searchParams.set('hotelId', hotel.id);
  url.searchParams.set('timeout', '5');
  const response = await fetch(url, { headers: nuiteeHeaders() });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.data) return hotel;
  const d = payload.data;
  const gallery = imageGallery(d);
  const enriched = {
    ...hotel,
    name: d.name || hotel.name,
    address: d.address || hotel.address,
    rating: d.rating ?? d.starRating ?? hotel.rating,
    starRating: d.starRating ?? hotel.starRating ?? null,
    reviewCount: d.reviewCount ?? null,
    description: d.hotelDescription || null,
    facilities: Array.isArray(d.hotelFacilities) ? d.hotelFacilities.slice(0, 12) : [],
    location: d.location || null,
    gallery,
    photo: gallery[0]?.url || d.main_photo || hotel.photo
  };
  return { ...enriched, luxuryScore: luxuryHotelScore(enriched), luxuryTier: safeNumber(enriched.starRating, 0) >= 5 ? '5-star luxury' : safeNumber(enriched.starRating, 0) >= 4 ? '4-star+ luxury' : enriched.luxuryTier || 'luxury candidate' };
}

function chooseGoForItPairing(flights, hotels, budget) {
  const combos = [];
  for (const flight of flights) for (const hotel of hotels) {
    const subtotal = safeNumber(flight.total) + safeNumber(hotel.total);
    if (subtotal > 0) combos.push({ flightId: flight.id, hotelId: hotel.id, travelSubtotal: subtotal, luxuryScore: safeNumber(hotel.luxuryScore, 0) });
  }
  if (!combos.length) return null;
  combos.sort((a, b) => b.luxuryScore - a.luxuryScore || a.travelSubtotal - b.travelSubtotal);
  if (!budget || budget <= 0) {
    const pair = combos[0];
    return { ...pair, label: 'GO FOR IT', targetTotal: Math.round(pair.travelSubtotal * 1.3) };
  }
  const affordable = combos.filter((c) => c.travelSubtotal <= budget);
  const pool = affordable.length ? affordable : combos;
  const travelTarget = budget * 0.78;
  const pair = pool.reduce((best, combo) => {
    const bestValue = Math.abs(best.travelSubtotal - travelTarget) - best.luxuryScore * 8;
    const comboValue = Math.abs(combo.travelSubtotal - travelTarget) - combo.luxuryScore * 8;
    return comboValue < bestValue ? combo : best;
  }, pool[0]);
  return { ...pair, label: 'GO FOR IT', targetTotal: Math.max(pair.travelSubtotal, budget * 0.98) };
}

async function buildAIPlan(input, travelData) {
  if (!process.env.OPENAI_API_KEY) return null;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const leanData = { geography: travelData.geography, flightPricing: travelData.flightPricing, hotelPricing: travelData.hotelPricing, pairing: travelData.pairing, flight: travelData.selectedFlight, hotel: travelData.selectedHotel };
  const prompt = `You are the planning engine for American Honeymooner. Build ONE honeymoon plan only, labeled GO FOR IT. The user has already been matched to one flight and one hotel. Respect the requested destination even when the flight lands at a gateway airport. Nuitee hotel totals are full-stay totals. The selected hotel room has been filtered for a single king-bed setup suitable for a honeymoon. The hotel selection is intentionally luxury-first: favor polished 4-5 star, resort, boutique, palace, villa, suite, spa, view, terrace, pool and high-end honeymoon properties; never frame a basic, budget, hostel, motel, dorm, shared-bathroom or business-style property as acceptable luxury. Do not suggest switching to two queens or twin beds. Do not invent flight or hotel prices. Use the available trip budget for excellent dining, activities, local transportation and romantic experiences rather than leaving large amounts unused. In whyItWorks, include 2-3 concise, practical honeymoon tips. One should normally remind the couple to tell the hotel when booking that it is their honeymoon because hotels may offer a nicer room, welcome amenity, champagne, upgrade, or late checkout when available; never promise an upgrade or free amenity. Other tips can cover restaurant reservations, airport transfers, room requests, special-occasion notes, or booking timing. Return JSON only with summary and options, where options contains exactly one object with label,title,flightId,hotelId,whyItWorks,itinerary[{day,title,morning,afternoon,evening}]. No markdown.\n\nTraveler input:\n${JSON.stringify(input, null, 2)}\n\nTravel data:\n${JSON.stringify(leanData, null, 2)}`;
  const response = await client.responses.create({ model: OPENAI_MODEL, reasoning: { effort: 'low' }, input: prompt, store: false });
  try { return JSON.parse(response.output_text || ''); } catch { return { summary: response.output_text || '', options: [] }; }
}
function normalizeAIPlan(aiPlan, travelData, input) {
  const option = aiPlan?.options?.[0] || {};
  const pairing = travelData.pairing;
  const flight = travelData.selectedFlight;
  const hotel = travelData.selectedHotel;
  const flightTotal = safeNumber(flight?.total), hotelTotal = safeNumber(hotel?.total);
  const travelSubtotal = Math.round((flightTotal + hotelTotal) * 100) / 100;
  const budget = safeNumber(input.budget, 0);
  let targetTotal = pairing?.targetTotal || travelSubtotal + Math.round(Math.max(600, travelSubtotal * 0.3));
  if (budget > 0) targetTotal = Math.min(Math.max(travelSubtotal, targetTotal), Math.max(travelSubtotal, budget));
  const estimatedOnTripSpend = Math.max(0, Math.round((targetTotal - travelSubtotal) * 100) / 100);
  const normalized = {
    ...option,
    label: 'GO FOR IT',
    flightId: flight?.id || null,
    hotelId: hotel?.id || null,
    flightTotal,
    hotelTotal,
    travelSubtotal,
    estimatedOnTripSpend,
    estimatedTripTotal: Math.round((travelSubtotal + estimatedOnTripSpend) * 100) / 100,
    budgetTarget: budget || null,
    currency: flight?.currency || hotel?.currency || 'USD',
    flightDetails: flight || null,
    hotelDetails: hotel || null
  };
  return { ...(aiPlan || {}), options: [normalized] };
}

app.get('/api/maps-config', (req, res) => {
  if (!process.env.GOOGLE_MAPS_API_KEY) return res.status(404).json({ error: 'Google Maps is not configured.' });
  res.json({ apiKey: process.env.GOOGLE_MAPS_API_KEY });
});
app.get('/api/places', async (req, res) => {
  const query = String(req.query.query || '').trim();
  if (query.length < 2) return res.json({ data: [] });
  try {
    const places = await duffelPlaceSuggestions(query);
    res.json({ data: places.slice(0, 8).map((place) => ({ id: place.id, type: place.type, name: place.name, cityName: place.city_name || place.name, countryCode: place.iata_country_code, iataCode: place.iata_code, airportCount: Array.isArray(place.airports) ? place.airports.length : null })) });
  } catch (error) { res.status(500).json({ error: error.message || 'Location search failed.' }); }
});
app.post('/api/search', async (req, res) => {
  const rawInput = req.body || {};
  if (!rawInput.startDate || !rawInput.endDate || !rawInput.originName || !rawInput.destinationName) return res.status(400).json({ error: 'Enter an origin, destination, departure date, and return date.' });
  const budget = Number(rawInput.budget);
  if (!Number.isFinite(budget) || budget <= 0) return res.status(400).json({ error: 'Enter a valid total trip budget.' });
  rawInput.budget = budget;
  try {
    const input = await resolveTripGeography(rawInput);
    const [flights, hotels] = await Promise.all([searchDuffelFlights(input), searchNuiteeHotels(input)]);
    if (!flights.length) return res.status(404).json({ error: `No usable flights found from ${input.originCode} to ${input.destinationCode}.` });
    if (!hotels.length) return res.status(404).json({ error: `No 4-star+ honeymoon-quality Nuitee sandbox hotels with a confirmed king-bed room were found around ${input.resolvedDestinationName || input.destinationName}. Try nearby dates or a nearby honeymoon town.` });

    const pairing = chooseGoForItPairing(flights, hotels, safeNumber(input.budget, 0));
    let selectedFlight = flights.find((f) => f.id === pairing?.flightId) || flights[0];
    let selectedHotel = hotels.find((h) => h.id === pairing?.hotelId) || hotels[0];

    const [freshOffer, richHotel] = await Promise.all([
      selectedFlight?.id ? refreshDuffelOffer(selectedFlight.id).catch(() => null) : null,
      enrichNuiteeHotel(selectedHotel).catch(() => selectedHotel)
    ]);
    if (freshOffer) selectedFlight = summarizeDuffelOffer(freshOffer);
    selectedHotel = richHotel || selectedHotel;

    if (safeNumber(selectedHotel?.starRating, 0) > 0 && safeNumber(selectedHotel.starRating, 0) < 4) {
      return res.status(404).json({ error: 'The selected hotel did not meet the 4-star honeymoon-quality requirement after verification. Try nearby dates or another honeymoon destination.' });
    }

    const isTest = String(process.env.DUFFEL_ENV || 'test').toLowerCase() !== 'live';
    const geography = { requestedOrigin: rawInput.originName, requestedDestination: rawInput.destinationName, originAirportCode: input.originCode, destinationAirportCode: input.destinationCode, destinationAirportName: input.resolvedDestinationAirportName, destinationDisplayName: input.resolvedDestinationName || rawInput.destinationName, hotelSearchCities: input.hotelSearchCities, explanation: input.geographyExplanation };
    const travelData = { mode: isTest ? 'duffel_test' : 'live', flightPricing: isTest ? 'Duffel test-mode offer' : 'Validated live Duffel offer', hotelPricing: 'Nuitee sandbox full-stay luxury king-room hotel rate', searchedAt: new Date().toISOString(), geography, pairing, selectedFlight, selectedHotel };
    const rawAIPlan = await buildAIPlan(input, travelData);
    const aiPlan = normalizeAIPlan(rawAIPlan, travelData, input);
    res.json({ ...travelData, flights: [selectedFlight], hotels: [selectedHotel], aiPlan, aiModel: aiPlan ? OPENAI_MODEL : null });
  } catch (error) {
    console.error(`Search error: ${error.message}`);
    res.status(500).json({ error: error.message || 'Search failed.' });
  }
});
app.get('/health', (req, res) => res.json({ ok: true, duffelConfigured: Boolean(process.env.DUFFEL_ACCESS_TOKEN), nuiteeConfigured: Boolean(process.env.NUITEE_API_KEY), googleMapsConfigured: Boolean(process.env.GOOGLE_MAPS_API_KEY), openAIConfigured: Boolean(process.env.OPENAI_API_KEY), openAIModel: OPENAI_MODEL }));
app.listen(PORT, () => console.log(`American Honeymooner Planner running at http://localhost:${PORT}`));