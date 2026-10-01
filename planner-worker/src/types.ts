export interface TripInput {
  originName: string;
  destinationName: string;
  startDate: string;
  endDate: string;
  budget: number;
  travelers: number;
  pace: string;
  styles: string[];
  notes: string;
  travelClass: string;
}

export interface FlightSegment {
  id: string | null;
  airline: string;
  airlineCode: string;
  airlineLogo: string | null;
  flightNumber: string;
  operatingAirline: string | null;
  operatingFlightNumber: string | null;
  originCode: string;
  originName: string;
  originTerminal: string | null;
  destinationCode: string;
  destinationName: string;
  destinationTerminal: string | null;
  departingAt: string | null;
  arrivingAt: string | null;
  duration: string | null;
  aircraft: string | null;
  distanceMiles: number | null;
  cabinClass: string | null;
  cabinName: string | null;
  fareBasisCode: string | null;
  baggage: string[];
  wifi: string | null;
  power: boolean;
  seatPitch: string | null;
}

export interface FlightSlice {
  direction: string;
  duration: string | null;
  stops: number;
  changePolicy: string;
  segments: FlightSegment[];
}

export interface BagService {
  amount: number;
  currency: string;
  maximumQuantity: number | null;
}

export interface FlightOffer {
  id: string;
  airline: string;
  airlineCode: string | null;
  airlineLogo: string | null;
  stops: number;
  duration: string;
  total: number;
  currency: string;
  baseAmount: number;
  taxAmount: number;
  expiresAt: string | null;
  passengerCount: number | null;
  totalEmissionsKg: number | null;
  changePolicy: string;
  refundPolicy: string;
  availableBagServices: BagService[];
  totalDurationMinutes: number;
  slices: FlightSlice[];
}

export interface HotelGalleryImage {
  url: string;
  caption: string;
  score?: number;
}

export interface HotelOffer {
  id: string;
  offerId: string | null;
  name: string;
  total: number;
  nightlyEquivalent: number;
  nights: number;
  priceBasis: string;
  currency: string;
  roomName: string;
  bedPreference: string;
  boardName: string | null;
  refundable: boolean;
  rating: number | null;
  starRating: number | null;
  reviewCount?: number | null;
  address: string | HotelAddress | null;
  photo: string | null;
  gallery: HotelGalleryImage[];
  pricingType: string;
  searchCity: string | null;
  luxuryScore: number;
  luxuryTier: string;
  description?: string | null;
  facilities?: unknown[];
  location?: unknown;
}

export interface HotelAddress {
  address?: string;
  line1?: string;
  city?: string;
}

export interface Pairing {
  flightId: string;
  hotelId: string;
  travelSubtotal: number;
  luxuryScore: number;
  label: "GO FOR IT";
  targetTotal: number;
}

export interface Geography {
  requestedOrigin: string;
  requestedDestination: string;
  originAirportCode: string;
  destinationAirportCode: string;
  destinationAirportName: string;
  destinationDisplayName: string;
  hotelSearchCities: string[];
  explanation: string | null;
}

export interface ItineraryDay {
  day: number;
  title: string;
  morning: string;
  afternoon: string;
  evening: string;
}

export interface PlanOption {
  label: "GO FOR IT";
  title: string;
  flightId: string | null;
  hotelId: string | null;
  whyItWorks: string;
  itinerary: ItineraryDay[];
  flightTotal: number;
  hotelTotal: number;
  travelSubtotal: number;
  estimatedOnTripSpend: number;
  estimatedTripTotal: number;
  budgetTarget: number | null;
  currency: string;
  flightDetails: FlightOffer | null;
  hotelDetails: HotelOffer | null;
}

export interface AiPlan {
  summary: string;
  options: PlanOption[];
}

export interface SearchSuccess {
  mode: "demo" | "duffel_test" | "live";
  flightPricing: string;
  hotelPricing: string;
  searchedAt: string;
  geography: Geography;
  pairing: Pairing | null;
  selectedFlight: FlightOffer;
  selectedHotel: HotelOffer;
  flights: FlightOffer[];
  hotels: HotelOffer[];
  aiPlan: AiPlan;
  aiModel: string | null;
}

export interface PlannerSecrets {
  duffelToken?: string;
  duffelEnv: string;
  nuiteeKey?: string;
  openAIKey?: string;
  googleMapsKey?: string;
}

export interface PlaceSuggestion {
  id: string;
  type: string;
  name: string;
  cityName: string;
  countryCode: string | null;
  iataCode: string | null;
  airportCount: number | null;
}
