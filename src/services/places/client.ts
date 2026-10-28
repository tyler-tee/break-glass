import { normalizeHours } from '../../domain/hours.js';
import type { LatLng, TrackedFields } from '../../domain/types.js';
import { BudgetExhausted, CallBudget } from './budget.js';
import type {
  PlaceCandidate,
  PlaceDetails,
  PlaceSummary,
  RawDetailsResponse,
  RawPlace,
  RawRichPlace,
  RawRichSearchResponse,
  RawSearchResponse,
} from './types.js';

export const PLACES_BASE_URL = 'https://places.googleapis.com/v1';
const BASE_URL = PLACES_BASE_URL;
const METERS_PER_MILE = 1609.344;
const MAX_RADIUS_METERS = 50000;

const SEARCH_MASK =
  'places.id,places.displayName,places.formattedAddress,places.location,places.businessStatus';
const DETAILS_MASK =
  'id,displayName,formattedAddress,nationalPhoneNumber,websiteUri,location,rating,userRatingCount,businessStatus,regularOpeningHours';
// Everything ranking needs in one Text Search. Reviews bill at Enterprise + Atmosphere; that is intended.
// Google names the review age field relativePublishTimeDescription.
export const RICH_SEARCH_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.shortFormattedAddress',
  'places.location',
  'places.businessStatus',
  'places.primaryType',
  'places.primaryTypeDisplayName',
  'places.googleMapsUri',
  'places.rating',
  'places.userRatingCount',
  'places.regularOpeningHours',
  'places.currentOpeningHours.openNow',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.reviews.text',
  'places.reviews.rating',
  'places.reviews.relativePublishTimeDescription',
].join(',');

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

/** One budgeted Places request; exported for the key probe, which needs its own minimal field mask. */
export async function placesRequest<T>(url: string, init: RequestInit, deps: PlacesDeps): Promise<T> {
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
  lat: p.location?.latitude ?? null,
  lng: p.location?.longitude ?? null,
  rating: p.rating ?? null,
  ratingCount: p.userRatingCount ?? null,
  businessStatus: p.businessStatus ?? null,
});

export type SearchBias = { center: LatLng; radiusMi: number };

const biasCircle = (bias: SearchBias) => ({
  circle: {
    center: { latitude: bias.center.lat, longitude: bias.center.lng },
    radius: Math.min(Math.round(bias.radiusMi * METERS_PER_MILE), MAX_RADIUS_METERS),
  },
});

export async function textSearch(
  query: string,
  bias: SearchBias | undefined,
  deps: PlacesDeps,
): Promise<PlaceSummary[]> {
  const body = {
    textQuery: query,
    pageSize: 10,
    ...(bias && { locationBias: biasCircle(bias) }),
  };
  const data = await placesRequest<RawSearchResponse>(
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

const toCandidate = (p: RawRichPlace): PlaceCandidate => {
  const oh = p.regularOpeningHours;
  return {
    placeId: p.id,
    name: p.displayName.text,
    address: p.formattedAddress ?? null,
    shortAddress: p.shortFormattedAddress ?? null,
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
    businessStatus: p.businessStatus ?? null,
    rating: p.rating ?? null,
    ratingCount: p.userRatingCount ?? null,
    phone: p.nationalPhoneNumber ?? null,
    website: p.websiteUri ?? null,
    primaryType: p.primaryType ?? null,
    primaryTypeDisplay: p.primaryTypeDisplayName?.text ?? null,
    mapsUri: p.googleMapsUri ?? null,
    hours: normalizeHours(oh?.periods, oh?.weekdayDescriptions),
    openNow: p.currentOpeningHours?.openNow ?? null,
    reviews: (p.reviews ?? []).map((r) => ({
      text: r.text?.text ?? null,
      rating: r.rating ?? null,
      relativePublishTime: r.relativePublishTimeDescription ?? null,
    })),
  };
};

/** One Text Search per term with the full ranking field mask; replaces search-then-details for discovery. */
export async function richSearch(term: string, bias: SearchBias, deps: PlacesDeps): Promise<PlaceCandidate[]> {
  const body = { textQuery: term, pageSize: 20, rankPreference: 'RELEVANCE', locationBias: biasCircle(bias) };
  const data = await placesRequest<RawRichSearchResponse>(
    `${BASE_URL}/places:searchText`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': deps.apiKey,
        'X-Goog-FieldMask': RICH_SEARCH_MASK,
      },
      body: JSON.stringify(body),
    },
    deps,
  );
  return (data.places ?? []).map(toCandidate);
}

export async function placeDetails(placeId: string, deps: PlacesDeps): Promise<PlaceDetails> {
  const data = await placesRequest<RawDetailsResponse>(
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
  return first && first.lat !== null && first.lng !== null ? { lat: first.lat, lng: first.lng } : null;
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

/** The tracked (snapshotted) fields of a search result; reviews are never stored. */
export function candidateToTracked(c: PlaceCandidate): TrackedFields {
  return {
    name: c.name,
    address: c.address,
    phone: c.phone,
    website: c.website,
    hours: c.hours,
    businessStatus: c.businessStatus,
    rating: c.rating,
    ratingCount: c.ratingCount,
    afterHoursNotes: null,
    walkIns: null,
    insuranceNotes: null,
  };
}
