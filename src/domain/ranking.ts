import type { LatLng } from './types.js';

const EARTH_RADIUS_MI = 3958.8;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

export function haversineMi(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(h));
}

export function rankByDistanceThenRating<T extends { distanceMi: number; rating: number | null }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => {
    if (a.distanceMi !== b.distanceMi) return a.distanceMi - b.distanceMi;
    if (a.rating === b.rating) return 0;
    if (a.rating === null) return 1;
    if (b.rating === null) return -1;
    return b.rating - a.rating;
  });
}
