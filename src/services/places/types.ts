import type { PlacesPeriod } from '../../domain/hours.js';
import type { BusinessStatus, WeeklyHours } from '../../domain/types.js';

export type PlaceSummary = {
  placeId: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  rating: number | null;
  ratingCount: number | null;
  businessStatus: BusinessStatus | null;
};

export type PlaceDetails = PlaceSummary & {
  phone: string | null;
  website: string | null;
  hours: WeeklyHours | null;
};

export type PlaceReview = { text: string | null; rating: number | null; relativePublishTime: string | null };

/** One Text Search result with everything ranking needs, so no Details call per place. */
export type PlaceCandidate = {
  placeId: string;
  name: string;
  address: string | null;
  shortAddress: string | null;
  lat: number | null;
  lng: number | null;
  businessStatus: BusinessStatus | null;
  rating: number | null;
  ratingCount: number | null;
  phone: string | null;
  website: string | null;
  primaryType: string | null;
  primaryTypeDisplay: string | null;
  mapsUri: string | null;
  hours: WeeklyHours | null;
  openNow: boolean | null;
  reviews: PlaceReview[]; // prompt-only, never persisted
};

export type RawPlace = {
  id: string;
  displayName: { text: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  rating?: number;
  userRatingCount?: number;
  businessStatus?: BusinessStatus;
};

export type RawSearchResponse = { places?: RawPlace[] };

export type RawDetailsResponse = RawPlace & {
  nationalPhoneNumber?: string;
  websiteUri?: string;
  regularOpeningHours?: { periods?: PlacesPeriod[]; weekdayDescriptions?: string[] };
};

export type RawReview = {
  text?: { text?: string; languageCode?: string };
  rating?: number;
  relativePublishTimeDescription?: string;
};

export type RawRichPlace = RawDetailsResponse & {
  shortFormattedAddress?: string;
  primaryType?: string;
  primaryTypeDisplayName?: { text: string };
  googleMapsUri?: string;
  currentOpeningHours?: { openNow?: boolean };
  reviews?: RawReview[];
};

export type RawRichSearchResponse = { places?: RawRichPlace[] };
