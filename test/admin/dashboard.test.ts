import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword } from '../../src/features/admin/auth.js';
import { eq } from 'drizzle-orm';
import { categories, locations, protocols, settings } from '../../src/db/schema.js';
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

  const tile = (html: string, key: string): string => {
    const start = html.indexOf(`data-stat="${key}"`);
    expect(start, `tile ${key} present`).toBeGreaterThan(-1);
    return html.slice(html.lastIndexOf('<a ', start), html.indexOf('</a>', start) + 4);
  };

  const seedCounts = () => {
    const cat = db.insert(categories).values({ name: 'Dentist', slug: 'dentist', searchTerms: ['dentist'] }).returning().get();
    const loc = (name: string, status: 'approved' | 'candidate' | 'warn') =>
      db.insert(locations).values({ categoryId: cat.id, name, status, createdAt: now, updatedAt: now }).run();
    for (const n of ['A1', 'A2', 'A3', 'A4']) loc(n, 'approved');
    loc('C1', 'candidate');
    loc('W1', 'warn');
    loc('W2', 'warn');
    loc('W3', 'warn');
    const mk = (slug: string, needsRereview: boolean, published: boolean) => {
      const p = db.insert(protocols).values({ slug, title: slug, tags: [], needsRereview }).returning().get();
      if (published) insertVersion(db, { protocolId: p.id, version: 1, status: 'published', bodyMd: 'x', createdAt: now, reviewedAt: now });
    };
    mk('p1', true, true);
    mk('p2', true, true);
    mk('p3', true, false);
    mk('p4', true, false);
    mk('p5', true, false);
  };

  it('overview shows linked counts', async () => {
    seedCounts();
    const html = await dashboard();
    const expectTile = (key: string, href: string, n: string, label: string) => {
      const t = tile(html, key);
      expect(t).toContain(`href="${href}"`);
      expect(t).toContain(`<span class="stat-num">${n}</span>`);
      expect(t).toContain(`<span class="stat-label">${label}</span>`);
    };
    expectTile('approved', '/admin/locations', '4', 'approved places');
    expectTile('candidates', '/admin/candidates', '1', 'candidate awaiting review');
    expectTile('warnings', '/admin/warn', '3', 'warnings');
    expectTile('published', '/admin/protocols', '2', 'published protocols');
    expectTile('rereview', '/admin/protocols', '5', 'protocols needing re-review');
  });

  it('incomplete install shows Continue setup', async () => {
    const html = await dashboard();
    expect(html).toMatch(/<a [^>]*href="\/admin\/setup"[^>]*>\s*Continue setup\s*<\/a>/);
    expect(html).not.toContain('Run setup again');
  });

  it('ready install shows Run setup again and no Continue setup', async () => {
    db.update(settings).set({ setupCompletedAt: now }).where(eq(settings.id, 1)).run();
    const html = await dashboard();
    expect(html).toContain('<a href="/admin/setup">Run setup again</a>');
    expect(html).not.toContain('Continue setup');
  });
});
