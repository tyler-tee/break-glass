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

function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function updateSettings(db: Db, patch: SettingsPatch): Settings {
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
  if (next.defaultRadiusMi !== null && !(next.defaultRadiusMi > 0)) {
    throw new SettingsValidationError('default_radius_mi', 'default_radius_mi must be greater than 0');
  }
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
