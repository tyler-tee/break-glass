import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword } from '../../src/features/admin/auth.js';
import {
  SettingsValidationError,
  getSettings,
  updateSettings,
  validTimeZone,
} from '../../src/features/admin/settingsRepo.js';
import { adminLogin } from '../helpers/adminLogin.js';
import { createTestDb } from '../helpers/testDb.js';

let db: Db;
beforeEach(() => {
  db = createTestDb();
});

const fieldOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SettingsValidationError) return e.field;
    throw e;
  }
  return undefined;
};

describe('updateSettings shared validation', () => {
  it('trims the household name and caps it at 60 characters', () => {
    expect(updateSettings(db, { householdName: '  The Smiths  ' }).householdName).toBe('The Smiths');
    expect(updateSettings(db, { householdName: `  ${'x'.repeat(60)}  ` }).householdName).toBe('x'.repeat(60));
    expect(fieldOf(() => updateSettings(db, { householdName: 'x'.repeat(61) }))).toBe('household_name');
    expect(getSettings(db).householdName).toBe('x'.repeat(60));
    // Blank means "no name" (the family site falls back to its default title).
    expect(updateSettings(db, { householdName: '   ' }).householdName).toBeNull();
  });

  it('checks the emergency number: a digit, only digits/spaces/+-(), at most 20', () => {
    expect(updateSettings(db, { emergencyNumber: ' +1 (801) 555-0100 ' }).emergencyNumber).toBe('+1 (801) 555-0100');
    for (const bad of ['', 'call mom', '911!', '+-()', '1'.repeat(21)]) {
      expect(fieldOf(() => updateSettings(db, { emergencyNumber: bad }))).toBe('emergency_number');
    }
    expect(getSettings(db).emergencyNumber).toBe('+1 (801) 555-0100');
  });

  it('caps the search radius at 500 miles', () => {
    expect(updateSettings(db, { defaultRadiusMi: 500 }).defaultRadiusMi).toBe(500);
    expect(fieldOf(() => updateSettings(db, { defaultRadiusMi: 500.5 }))).toBe('default_radius_mi');
    expect(fieldOf(() => updateSettings(db, { defaultRadiusMi: 0 }))).toBe('default_radius_mi');
  });

  it('exports validTimeZone', () => {
    expect(validTimeZone('America/Denver')).toBe(true);
    expect(validTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('Settings page household fields', () => {
  let app: ReturnType<typeof createApp>;
  let cookie: string;
  const reschedule = vi.fn();
  beforeEach(async () => {
    app = createApp({
      db,
      env: loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: await hashPassword('correct horse') }),
      scheduler: { reschedule },
    });
    cookie = await adminLogin(app, 'correct horse');
  });
  const post = (fields: Record<string, string>) =>
    app.request('/admin/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams(fields).toString(),
    });
  const base = {
    home_label: 'Home',
    home_lat: '40.7608',
    home_lng: '-111.891',
    default_radius_mi: '15',
    home_tz: 'America/Denver',
    location_refresh_cron: '0 3 * * 0',
    protocol_refresh_cron: '0 4 1 * *',
  };

  it('shows labelled Household name and Emergency number fields in their own fieldset', async () => {
    updateSettings(db, { householdName: 'The Smiths', emergencyNumber: '112' });
    const html = await (await app.request('/admin/settings', { headers: { cookie } })).text();
    const fs = html.match(/<fieldset><legend>Household<\/legend>[\s\S]*?<\/fieldset>/)![0];
    expect(fs).toMatch(/<label for="household_name">Household name<\/label>/);
    expect(fs).toMatch(/<input id="household_name" name="household_name" value="The Smiths"/);
    expect(fs).toMatch(/<label for="emergency_number">Emergency number<\/label>/);
    expect(fs).toMatch(/<input id="emergency_number" name="emergency_number" type="tel" value="112"/);
  });

  it('saves the household name and emergency number', async () => {
    const res = await post({ ...base, household_name: '  The Joneses ', emergency_number: '999' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/settings?saved=1');
    expect(getSettings(db)).toMatchObject({ householdName: 'The Joneses', emergencyNumber: '999' });
  });

  it('shows the error beside the field with role=alert and saves nothing', async () => {
    let res = await post({ ...base, household_name: 'x'.repeat(61), emergency_number: '911' });
    expect(res.status).toBe(400);
    let html = await res.text();
    expect(html).toMatch(/id="household_name-error" role="alert">[^<]*60 characters/);
    expect(html).toMatch(/aria-describedby="household_name-hint household_name-error"/);
    expect(getSettings(db).householdName).toBeNull();

    res = await post({ ...base, household_name: 'Ok', emergency_number: 'call mom' });
    expect(res.status).toBe(400);
    html = await res.text();
    expect(html).toMatch(/id="emergency_number-error" role="alert">[^<]*digit/);
    expect(html).toContain('value="call mom"'); // kept for correction
    expect(getSettings(db).emergencyNumber).toBe('911');
    expect(reschedule).not.toHaveBeenCalled();
  });

  it('rejects a radius over 500 miles', async () => {
    const res = await post({ ...base, default_radius_mi: '600' });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/role="alert"[^>]*>[^<]*500/);
    expect(getSettings(db).defaultRadiusMi).toBe(15);
  });
});
