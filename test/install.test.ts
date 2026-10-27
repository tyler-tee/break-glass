import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { settings } from '../src/db/schema.js';
import { loadEnv } from '../src/env.js';
import { installState } from '../src/features/admin/install.js';
import { createSecretsStore } from '../src/features/admin/secrets.js';
import { createTestDb } from './helpers/testDb.js';

it('moves from unclaimed to incomplete to ready', () => {
  const db = createTestDb();
  const secrets = createSecretsStore(db, loadEnv({}));
  expect(installState({ db, secrets })).toBe('unclaimed');
  secrets.setAdminHash('scrypt:00:00');
  expect(installState({ db, secrets })).toBe('incomplete');
  db.update(settings).set({ setupCompletedAt: new Date() }).where(eq(settings.id, 1)).run();
  expect(installState({ db, secrets })).toBe('ready');
});

it('an env-provided hash counts as claimed', () => {
  const db = createTestDb();
  const secrets = createSecretsStore(db, loadEnv({ ADMIN_PASSWORD_HASH: 'scrypt:00:00' }));
  expect(installState({ db, secrets })).toBe('incomplete');
});

it('new settings columns have sensible defaults', () => {
  const s = createTestDb().select().from(settings).where(eq(settings.id, 1)).get()!;
  expect(s.householdName).toBeNull();
  expect(s.emergencyNumber).toBe('911');
  expect(s.setupCompletedAt).toBeNull();
});
