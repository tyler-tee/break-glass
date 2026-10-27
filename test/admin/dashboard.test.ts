import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword } from '../../src/features/admin/auth.js';
import { categories, locations, protocols } from '../../src/db/schema.js';
import { insertVersion } from '../../src/features/protocols/repo.js';
import { dbLedger } from '../../src/services/places/budget.js';
import { adminLogin } from '../helpers/adminLogin.js';
import { createTestDb } from '../helpers/testDb.js';

const now = new Date('2026-10-27T16:00:00Z');
let db: Db;

const dashboard = async (extra: Record<string, string> = {}): Promise<string> => {
  const env = loadEnv({
    SESSION_SECRET: 's'.repeat(32),
    ADMIN_PASSWORD_HASH: await hashPassword('correct horse'),
    ...extra,
  });
  const app = createApp({ db, env, now: () => now });
  const cookie = await adminLogin(app, 'correct horse');
  return (await app.request('/admin', { headers: { cookie } })).text();
};

beforeEach(() => {
  db = createTestDb();
});

describe('admin dashboard', () => {
  it('dashboard shows Places calls this month', async () => {
    dbLedger(db).add('2026-10', 12, now);
    const html = await dashboard({ PLACES_MONTHLY_CAP: '800' });
    expect(html).toContain('Places calls this month: 12 / 800');
    expect(html).not.toContain('nearing');
  });

  it('warns at 80 percent', async () => {
    dbLedger(db).add('2026-10', 80, now);
    const html = await dashboard({ PLACES_MONTHLY_CAP: '100' });
    expect(html).toContain('Places calls this month: 80 / 100');
    expect(html).toContain('nearing the monthly cap');
  });

  it('overview shows linked counts', async () => {
    const cat = db.insert(categories).values({ name: 'Dentist', slug: 'dentist', searchTerms: ['dentist'] } as never).returning().get();
    db.insert(locations)
      .values({ categoryId: cat.id, name: 'Smile Co', status: 'approved', createdAt: now, updatedAt: now })
      .run();
    const p = db.insert(protocols).values({ slug: 'cpr', title: 'CPR', tags: [] }).returning().get();
    insertVersion(db, { protocolId: p.id, version: 1, status: 'published', bodyMd: 'x', createdAt: now, reviewedAt: now });
    const html = await dashboard();
    const section = html.slice(html.indexOf('class="overview'));
    expect(section).toMatch(/<a href="\/admin\/locations"[^>]*>[\s\S]*?>1<[\s\S]*?approved place/);
    expect(section).toMatch(/<a href="\/admin\/protocols"[^>]*>[\s\S]*?>1<[\s\S]*?published protocol/);
  });
});
