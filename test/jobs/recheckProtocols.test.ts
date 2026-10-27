import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword } from '../../src/features/admin/auth.js';
import {
  createProtocol,
  getProtocol,
  insertSources,
  insertVersion,
  listSources,
} from '../../src/features/protocols/repo.js';
import { hashSourceText, publishVersion } from '../../src/features/protocols/service.js';
import { recheckProtocols } from '../../src/jobs/recheckProtocols.js';
import { SOP_HEADINGS } from '../../src/services/llm/draft.js';
import { fetchPage } from '../../src/services/llm/web.js';
import { adminLogin } from '../helpers/adminLogin.js';
import { fakeSiteFetch } from '../helpers/fakeSiteFetch.js';
import { createTestDb } from '../helpers/testDb.js';

const WEB_DIR = path.resolve(import.meta.dirname, '../fixtures/web');
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const RC = 'https://redcross.example/choking';
const NHS = 'https://nhs.example/choking';
const NOW = new Date('2026-02-01T00:00:00Z');
const STALE = 'f'.repeat(64);
const BODY = SOP_HEADINGS.map((h) => `${h}\ntext`).join('\n\n');

let db: Db;
beforeEach(() => {
  db = createTestDb();
});

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const run = (over: { fail?: string[] } = {}) =>
  recheckProtocols(db, {
    fetch: fakeSiteFetch(WEB_DIR, over.fail ? { fail: over.fail } : {}),
    now: () => NOW,
    log: log(),
    lookup: publicLookup,
  });

async function goodHash(url: string): Promise<string> {
  const page = await fetchPage(url, { fetch: fakeSiteFetch(WEB_DIR), lookup: publicLookup });
  return hashSourceText(page!.text);
}

async function seed(opts: { staleNhs?: boolean; slug?: string; title?: string } = {}) {
  const p = createProtocol(db, { slug: opts.slug ?? 'choking-adult', title: opts.title ?? 'Choking (adult)', tags: [] });
  const v = insertVersion(db, { protocolId: p.id, version: 1, status: 'published', bodyMd: BODY, createdAt: NOW, reviewedAt: NOW });
  insertSources(db, [
    { protocolVersionId: v.id, url: RC, title: null, fetchedAt: NOW, contentHash: await goodHash(RC) },
    { protocolVersionId: v.id, url: NHS, title: null, fetchedAt: NOW, contentHash: opts.staleNhs ? STALE : await goodHash(NHS) },
  ]);
  return { p, v };
}

describe('recheckProtocols', () => {
  it('changed source fixture flags protocol with the changed URL in reason', async () => {
    const { p } = await seed({ staleNhs: true });
    const report = await run();
    const after = getProtocol(db, p.id)!;
    expect(after.needsRereview).toBe(true);
    expect(after.rereviewReason).toContain('nhs.example/choking');
    expect(after.rereviewReason).not.toContain('redcross.example');
    expect(report).toEqual({ checked: 1, flagged: 1, unchanged: 0, failed: 0 });
  });

  it('unchanged fixtures leave needs_rereview false', async () => {
    const { p } = await seed();
    const report = await run();
    expect(getProtocol(db, p.id)!.needsRereview).toBe(false);
    expect(report).toEqual({ checked: 1, flagged: 0, unchanged: 1, failed: 0 });
  });

  it('fetch failure does not flag', async () => {
    const { p } = await seed({ staleNhs: true });
    const report = await run({ fail: [NHS] });
    expect(getProtocol(db, p.id)!.needsRereview).toBe(false);
    expect(report.flagged).toBe(0);
    expect(report.failed).toBe(1);
  });

  it('stored hashes are never overwritten', async () => {
    const { p, v } = await seed({ staleNhs: true });
    const before = listSources(db, v.id).map((s) => s.contentHash);
    await run();
    expect(getProtocol(db, p.id)!.needsRereview).toBe(true);
    expect(listSources(db, v.id).map((s) => s.contentHash)).toEqual(before);
    expect(before[1]).toBe(STALE);
  });

  it('draft-only protocols are not checked', async () => {
    await seed();
    const d = createProtocol(db, { slug: 'drafty', title: 'Drafty', tags: [] });
    const dv = insertVersion(db, { protocolId: d.id, version: 1, status: 'draft', bodyMd: BODY, createdAt: NOW });
    insertSources(db, [{ protocolVersionId: dv.id, url: RC, title: null, fetchedAt: NOW, contentHash: STALE }]);
    const report = await run();
    expect(report.checked).toBe(1);
    expect(getProtocol(db, d.id)!.needsRereview).toBe(false);
  });
});

describe('re-review flag visibility', () => {
  const makeApp = async () =>
    createApp({
      db,
      env: loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: await hashPassword('correct horse') }),
      now: () => NOW,
      siteFetch: fakeSiteFetch(WEB_DIR),
      lookup: publicLookup,
    });

  it('published version stays visible on /emergency with badge', async () => {
    const { p } = await seed({ staleNhs: true });
    await run();
    const app = await makeApp();
    const res = await app.request(`/emergency/${p.slug}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('⚠');
    expect(html).toContain(getProtocol(db, p.id)!.rereviewReason!);
    const api = (await (await app.request('/api/protocols')).json()) as { protocols: { needsRereview: boolean }[] };
    expect(api.protocols[0]!.needsRereview).toBe(true);
  });

  it('publishing a new version clears the flag', async () => {
    const { p } = await seed({ staleNhs: true });
    await run();
    expect(getProtocol(db, p.id)!.needsRereview).toBe(true);
    const v2 = insertVersion(db, { protocolId: p.id, version: 2, status: 'draft', bodyMd: BODY, createdAt: NOW });
    publishVersion(db, v2.id, NOW);
    const after = getProtocol(db, p.id)!;
    expect(after.needsRereview).toBe(false);
    expect(after.rereviewReason).toBeNull();
  });

  it('protocol list shows flagged protocols first with the reason and a new-draft link', async () => {
    await seed({ slug: 'a-fine', title: 'A fine protocol' });
    // Same URLs, stale hash: only this one is flagged, though it sorts after by title.
    const { p } = await seed({ staleNhs: true, slug: 'z-stale', title: 'Z stale protocol' });
    await run();
    const app = await makeApp();
    const cookie = await adminLogin(app, 'correct horse');
    const res = await app.request('/admin/protocols', { headers: { cookie } });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html.indexOf('Z stale protocol')).toBeGreaterThan(-1);
    expect(html.indexOf('Z stale protocol')).toBeLessThan(html.indexOf('A fine protocol'));
    expect(html).toContain('Source changed: ' + NHS);
    expect(html).toContain(`href="/admin/protocols/${p.id}#draft"`);
    expect(html).toContain('Start new draft from these sources');
  });
});
