import { expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { ensureSettingsRow, runMigrations } from '../../src/db/migrate.js';
import { getSettings } from '../../src/features/admin/settingsRepo.js';

it('creates the settings row with defaults on a fresh database and is idempotent', () => {
  const db = openDb(':memory:');
  runMigrations(db);
  expect(() => getSettings(db)).toThrow(/settings row missing/);
  ensureSettingsRow(db);
  ensureSettingsRow(db);
  const s = getSettings(db);
  expect(s.homeTz).toBe('America/Denver');
  expect(s.locationRefreshCron).toBe('0 3 * * 0');
  expect(s.homeLat).toBeNull();
});
