import { normalizeHours } from '../../domain/hours.js';
import type { LatLng, TrackedFields } from '../../domain/types.js';
import { BudgetExhausted, CallBudget } from './budget.js';
import type {
  PlaceDetails,
  PlaceSummary,
  RawDetailsResponse,
  RawPlace,
  RawSearchResponse,
} from './types.js';

const BASE_URL = 'https://places.googleapis.com/v1';
const METERS_PER_MILE = 1609.344;
const MAX_RADIUS_METERS = 50000;

const SEARCH_MASK =
  'places.id,places.displayName,places.formattedAddress,places.location,places.businessStatus';
const DETAILS_MASK =
  'id,displayName,formattedAddress,nationalPhoneNumber,websiteUri,location,rating,userRatingCount,businessStatus,regularOpeningHours';

export { BudgetExhausted, CallBudget };

export class PlacesError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`Places API error ${status}: ${body}`);
    this.name = 'PlacesError';
  }
}

const REQUEST_TIMEOUT_MS = 15_000;

export type PlacesDeps = { fetch: typeof fetch; apiKey: string; budget: CallBudget };

async function request<T>(url: string, init: RequestInit, deps: PlacesDeps): Promise<T> {
  deps.budget.take();
  let res: Response;
  try {
    res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    // Timeouts (AbortError/TimeoutError) and network failures (TypeError) surface as one error type.
    if (e instanceof Error && (e instanceof TypeError || e.name === 'AbortError' || e.name === 'TimeoutError')) {
      throw new PlacesError(0, e.message);
    }
    throw e;
  }
  if (!res.ok) throw new PlacesError(res.status, await res.text());
  return (await res.json()) as T;
}

const summarize = (p: RawPlace): PlaceSummary => ({
  placeId: p.id,
  name: p.displayName.text,
  address: p.formattedAddress ?? null,
  lat: p.location.latitude,
  lng: p.location.longitude,
  rating: p.rating ?? null,
  ratingCount: p.userRatingCount ?? null,
  businessStatus: p.businessStatus ?? null,
});

export async function textSearch(
  query: string,
  bias: { center: LatLng; radiusMi: number } | undefined,
  deps: PlacesDeps,
): Promise<PlaceSummary[]> {
  const body = {
    textQuery: query,
    pageSize: 10,
    ...(bias && {
      locationBias: {
        circle: {
          center: { latitude: bias.center.lat, longitude: bias.center.lng },
          radius: Math.min(Math.round(bias.radiusMi * METERS_PER_MILE), MAX_RADIUS_METERS),
        },
      },
    }),
  };
  const data = await request<RawSearchResponse>(
    `${BASE_URL}/places:searchText`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': deps.apiKey,
        'X-Goog-FieldMask': SEARCH_MASK,
      },
      body: JSON.stringify(body),
    },
    deps,
  );
  // The search mask omits rating fields (they bill at the Enterprise SKU); ratings come from details.
  return (data.places ?? []).map((p) => ({ ...summarize(p), rating: null, ratingCount: null }));
}

export async function placeDetails(placeId: string, deps: PlacesDeps): Promise<PlaceDetails> {
  const data = await request<RawDetailsResponse>(
    `${BASE_URL}/places/${encodeURIComponent(placeId)}`,
    {
      method: 'GET',
      headers: { 'X-Goog-Api-Key': deps.apiKey, 'X-Goog-FieldMask': DETAILS_MASK },
    },
    deps,
  );
  const oh = data.regularOpeningHours;
  return {
    ...summarize(data),
    phone: data.nationalPhoneNumber ?? null,
    website: data.websiteUri ?? null,
    hours: normalizeHours(oh?.periods, oh?.weekdayDescriptions),
  };
}

export async function geocode(address: string, deps: PlacesDeps): Promise<LatLng | null> {
  const [first] = await textSearch(address, undefined, deps);
  return first ? { lat: first.lat, lng: first.lng } : null;
}

export function detailsToTracked(d: PlaceDetails): TrackedFields {
  return {
    name: d.name,
    address: d.address,
    phone: d.phone,
    website: d.website,
    hours: d.hours,
    businessStatus: d.businessStatus,
    rating: d.rating,
    ratingCount: d.ratingCount,
    afterHoursNotes: null,
    walkIns: null,
    insuranceNotes: null,
  };
}
