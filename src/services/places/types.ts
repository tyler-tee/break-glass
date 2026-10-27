import type { PlacesPeriod } from '../../domain/hours.js';
import type { BusinessStatus, WeeklyHours } from '../../domain/types.js';

export type PlaceSummary = {
  placeId: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  rating: number | null;
  ratingCount: number | null;
  businessStatus: BusinessStatus | null;
};

export type PlaceDetails = PlaceSummary & {
  phone: string | null;
  website: string | null;
  hours: WeeklyHours | null;
};

export type RawPlace = {
  id: string;
  displayName: { text: string };
  formattedAddress?: string;
  location: { latitude: number; longitude: number };
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
