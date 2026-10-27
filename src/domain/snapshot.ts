import { createHash } from 'node:crypto';
import type { Location } from '../features/locations/repo.js';
import type { TrackedFields } from './types.js';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, stable(obj[k])]),
    );
  }
  return value;
}

export function hashTracked(t: TrackedFields): string {
  return createHash('sha256').update(JSON.stringify(stable(t))).digest('hex');
}

export function trackedFromLocation(loc: Location): TrackedFields {
  return {
    name: loc.name ?? null,
    address: loc.address ?? null,
    phone: loc.phone ?? null,
    website: loc.website ?? null,
    hours: loc.hours ?? null,
    businessStatus: loc.businessStatus ?? null,
    rating: loc.rating ?? null,
    ratingCount: loc.ratingCount ?? null,
    afterHoursNotes: loc.afterHoursNotes ?? null,
    walkIns: loc.walkIns ?? null,
    insuranceNotes: loc.insuranceNotes ?? null,
  };
}
