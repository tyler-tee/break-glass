import { describe, expect, it, vi } from 'vitest';
import { resetAdmin } from '../../src/cli/reset-admin.js';
import { loadEnv } from '../../src/env.js';
import { installState } from '../../src/features/admin/install.js';
import { createSecretsStore } from '../../src/features/admin/secrets.js';
import { createTestDb } from '../helpers/testDb.js';

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('resetAdmin', () => {
  it('clears a DB hash -> unclaimed, rotates the session secret', () => {
    const db = createTestDb();
    const env = loadEnv({});
    const secrets = createSecretsStore(db, env);
    secrets.setAdminHash('scrypt:aa:bb');
    const before = secrets.getSessionSecret();
    const l = log();
    expect(resetAdmin(db, env, l)).toBe('reset');
    expect(installState({ db, secrets })).toBe('unclaimed');
    expect(secrets.getSessionSecret()).not.toBe(before);
    const out = l.info.mock.calls.flat().join('\n');
    expect(out).toContain('/setup');
    expect(out).toContain('docker compose logs app');
    expect(out).not.toContain('scrypt');
  });

  it('refuses an env hash', () => {
    const db = createTestDb();
    const env = loadEnv({ ADMIN_PASSWORD_HASH: 'scrypt:aa:bb' });
    const secrets = createSecretsStore(db, env);
    const l = log();
    expect(resetAdmin(db, env, l)).toBe('env-managed');
    expect(secrets.getAdminHash()).toBe('scrypt:aa:bb');
    expect(l.info.mock.calls.flat().join('\n')).toContain('ADMIN_PASSWORD_HASH');
  });
});
