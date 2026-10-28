import type { Db } from '../../db/client.js';
import { haversineMi } from '../../domain/ranking.js';
import { hashTracked, trackedFromLocation } from '../../domain/snapshot.js';
import type { LocationStatus } from '../../domain/types.js';
import { getSettings } from '../admin/settingsRepo.js';
import { getCategory } from '../categories/repo.js';
import {
  type Location,
  getLocation,
  insertLocation,
  insertSnapshot,
  latestSnapshot,
  resolveOpenChanges,
  updateLocationRow,
} from './repo.js';

export type LocationErrorCode = 'invalid' | 'not_found' | 'invalid_transition';

/** The form field a validation error belongs to, so callers need not parse the message. */
export type LocationField = 'name' | 'category_id' | 'lat' | 'lng';

export class LocationError extends Error {
  constructor(
    public code: LocationErrorCode,
    message: string,
    public field?: LocationField,
  ) {
    super(message);
    this.name = 'LocationError';
  }
}

export type ManualLocationInput = {
  categoryId: number;
  name: string;
  address?: string | null;
  phone?: string | null;
  website?: string | null;
  lat?: number | null;
  lng?: number | null;
  afterHoursNotes?: string | null;
  walkIns?: boolean | null;
  insuranceNotes?: string | null;
  adminNotes?: string | null;
};

// Single source of truth for allowed status moves.
const TRANSITIONS: Record<LocationStatus, LocationStatus[]> = {
  candidate: ['approved', 'rejected'],
  approved: ['rejected'],
  warn: ['approved', 'rejected'],
  rejected: [],
};

export const canTransition = (from: LocationStatus, to: LocationStatus): boolean => TRANSITIONS[from].includes(to);

function requireTransition(loc: Location, to: LocationStatus): void {
  if (!canTransition(loc.status, to)) {
    throw new LocationError('invalid_transition', `Cannot move a ${loc.status} location to ${to}`);
  }
}

const blankToNull = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

function validated(db: Db, input: ManualLocationInput) {
  const name = input.name.trim();
  if (name === '') throw new LocationError('invalid', 'Name is required', 'name');
  if (!getCategory(db, input.categoryId)) throw new LocationError('invalid', 'Category does not exist', 'category_id');
  const lat = input.lat ?? null;
  const lng = input.lng ?? null;
  if ((lat === null) !== (lng === null)) throw new LocationError('invalid', 'Latitude and longitude must both be set or both be empty', 'lat');
  if (lat !== null && !(lat >= -90 && lat <= 90)) throw new LocationError('invalid', 'Latitude must be between -90 and 90', 'lat');
  if (lng !== null && !(lng >= -180 && lng <= 180)) throw new LocationError('invalid', 'Longitude must be between -180 and 180', 'lng');

  const { homeLat, homeLng } = getSettings(db);
  const distanceMi =
    lat !== null && lng !== null && homeLat !== null && homeLng !== null
      ? haversineMi({ lat: homeLat, lng: homeLng }, { lat, lng })
      : null;

  return {
    categoryId: input.categoryId,
    name,
    address: blankToNull(input.address),
    phone: blankToNull(input.phone),
    website: blankToNull(input.website),
    lat,
    lng,
    distanceMi,
    afterHoursNotes: blankToNull(input.afterHoursNotes),
    walkIns: input.walkIns ?? null,
    insuranceNotes: blankToNull(input.insuranceNotes),
    adminNotes: blankToNull(input.adminNotes),
  };
}

export function createManualLocation(db: Db, input: ManualLocationInput, now: Date): Location {
  return insertLocation(db, {
    ...validated(db, input),
    status: 'candidate',
    placeId: null,
    hours: null,
    businessStatus: 'OPERATIONAL',
    createdAt: now,
    updatedAt: now,
  });
}

export function updateLocation(db: Db, id: number, patch: Partial<ManualLocationInput>, now: Date): Location {
  const current = getLocation(db, id);
  if (!current) throw new LocationError('not_found', 'Location not found');
  const values = validated(db, {
    categoryId: current.categoryId,
    name: current.name,
    address: current.address,
    phone: current.phone,
    website: current.website,
    lat: current.lat,
    lng: current.lng,
    afterHoursNotes: current.afterHoursNotes,
    walkIns: current.walkIns,
    insuranceNotes: current.insuranceNotes,
    adminNotes: current.adminNotes,
    ...patch,
  });
  return updateLocationRow(db, id, { ...values, updatedAt: now });
}

export function approveLocation(db: Db, id: number, now: Date): Location {
  const current = getLocation(db, id);
  if (!current) throw new LocationError('not_found', 'Location not found');
  requireTransition(current, 'approved');
  return db.transaction((tx) => {
    // Re-approving a warned row adopts the latest fetched details as the new baseline.
    const adopted = current.status === 'warn' ? (latestSnapshot(tx, id)?.payload ?? {}) : {};
    const updated = updateLocationRow(tx, id, {
      ...adopted,
      status: 'approved',
      lastVerifiedAt: now,
      updatedAt: now,
      consecutiveFetchFailures: 0,
    });
    resolveOpenChanges(tx, id, now);
    const payload = trackedFromLocation(updated);
    insertSnapshot(tx, { locationId: id, fetchedAt: now, payload, hash: hashTracked(payload) });
    return updated;
  });
}

export function reapproveLocation(db: Db, id: number, now: Date): Location {
  const current = getLocation(db, id);
  if (!current) throw new LocationError('not_found', 'Location not found');
  if (current.status !== 'warn') {
    throw new LocationError('invalid_transition', `Cannot re-approve a ${current.status} location`);
  }
  return approveLocation(db, id, now);
}

export function rejectLocation(db: Db, id: number, now: Date): Location {
  const current = getLocation(db, id);
  if (!current) throw new LocationError('not_found', 'Location not found');
  requireTransition(current, 'rejected');
  return updateLocationRow(db, id, { status: 'rejected', updatedAt: now });
}
