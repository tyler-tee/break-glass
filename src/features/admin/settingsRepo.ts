import cron from 'node-cron';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { locations, settings } from '../../db/schema.js';
import { haversineMi } from '../../domain/ranking.js';

export type Settings = typeof settings.$inferSelect;

export type SettingsPatch = Partial<
  Pick<
    Settings,
    | 'homeLabel'
    | 'homeLat'
    | 'homeLng'
    | 'defaultRadiusMi'
    | 'homeTz'
    | 'locationRefreshCron'
    | 'protocolRefreshCron'
    | 'householdName'
    | 'emergencyNumber'
  >
>;

export class SettingsValidationError extends Error {
  constructor(
    public field: string,
    message: string,
  ) {
    super(message);
    this.name = 'SettingsValidationError';
  }
}

export function getSettings(db: Db): Settings {
  const row = db.select().from(settings).where(eq(settings.id, 1)).get();
  if (!row) throw new Error('settings row missing');
  return row;
}

export const HOUSEHOLD_NAME_MAX = 60;
export const EMERGENCY_NUMBER_MAX = 20;
export const RADIUS_MAX_MI = 500;

export function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Plain-words checks shared by the setup wizard (which shows every field's error at once) and updateSettings.
/** For a trimmed, non-empty household name. */
export function householdNameError(name: string): string | undefined {
  if (name.length > HOUSEHOLD_NAME_MAX) return `Keep the name to ${HOUSEHOLD_NAME_MAX} characters or fewer.`;
  return undefined;
}

/** For a trimmed emergency number. */
export function emergencyNumberError(number: string): string | undefined {
  if (number === '') return 'Enter the number to call in an emergency (911 in the US).';
  if (!/\d/.test(number)) return 'The emergency number needs at least one digit, like 911.';
  if (!/^[0-9+\-() ]+$/.test(number)) return 'Use only digits, spaces, and + - ( ).';
  if (number.length > EMERGENCY_NUMBER_MAX) return `Keep the number to ${EMERGENCY_NUMBER_MAX} characters or fewer.`;
  return undefined;
}

export function radiusError(miles: number): string | undefined {
  if (!(Number.isFinite(miles) && miles > 0 && miles <= RADIUS_MAX_MI)) {
    return `Search radius must be a number of miles above 0 and up to ${RADIUS_MAX_MI}, like 15.`;
  }
  return undefined;
}

export function updateSettings(db: Db, input: SettingsPatch): Settings {
  // Household name and emergency number are stored trimmed; a blank household name means "no name".
  const patch: SettingsPatch = { ...input };
  if (typeof patch.householdName === 'string') patch.householdName = patch.householdName.trim() || null;
  if (typeof patch.emergencyNumber === 'string') patch.emergencyNumber = patch.emergencyNumber.trim();
  const next = { ...getSettings(db), ...patch };

  if (next.homeLat !== null && !(next.homeLat >= -90 && next.homeLat <= 90)) {
    throw new SettingsValidationError('home_lat', 'home_lat must be between -90 and 90');
  }
  if (next.homeLng !== null && !(next.homeLng >= -180 && next.homeLng <= 180)) {
    throw new SettingsValidationError('home_lng', 'home_lng must be between -180 and 180');
  }
  if ((next.homeLat === null) !== (next.homeLng === null)) {
    throw new SettingsValidationError('home_lat', 'home_lat and home_lng must both be set or both be empty');
  }
  const radius = next.defaultRadiusMi === null ? undefined : radiusError(next.defaultRadiusMi);
  if (radius) throw new SettingsValidationError('default_radius_mi', radius);
  const household = next.householdName === null ? undefined : householdNameError(next.householdName);
  if (household) throw new SettingsValidationError('household_name', household);
  const emergency = emergencyNumberError(next.emergencyNumber);
  if (emergency) throw new SettingsValidationError('emergency_number', emergency);
  if (!validTimeZone(next.homeTz)) {
    throw new SettingsValidationError('home_tz', `home_tz "${next.homeTz}" is not a valid time zone`);
  }
  if (next.locationRefreshCron !== null && !cron.validate(next.locationRefreshCron)) {
    throw new SettingsValidationError('location_refresh_cron', 'location_refresh_cron is not a valid cron expression');
  }
  if (next.protocolRefreshCron !== null && !cron.validate(next.protocolRefreshCron)) {
    throw new SettingsValidationError('protocol_refresh_cron', 'protocol_refresh_cron is not a valid cron expression');
  }

  const current = getSettings(db);
  const homeChanged = next.homeLat !== current.homeLat || next.homeLng !== current.homeLng;
  db.transaction((tx) => {
    tx.update(settings).set(patch).where(eq(settings.id, 1)).run();
    if (!homeChanged) return;
    // Stored distances are relative to home, so they must follow it.
    const home = next.homeLat !== null && next.homeLng !== null ? { lat: next.homeLat, lng: next.homeLng } : null;
    if (home === null) {
      tx.update(locations).set({ distanceMi: null }).run();
      return;
    }
    for (const l of tx.select({ id: locations.id, lat: locations.lat, lng: locations.lng }).from(locations).all()) {
      if (l.lat === null || l.lng === null) continue;
      tx.update(locations)
        .set({ distanceMi: haversineMi(home, { lat: l.lat, lng: l.lng }) })
        .where(eq(locations.id, l.id))
        .run();
    }
  });
  return getSettings(db);
}
