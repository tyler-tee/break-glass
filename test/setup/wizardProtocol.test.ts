import path from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { settings } from '../../src/db/schema.js';
import { loadEnv } from '../../src/env.js';
import { createSecretsStore } from '../../src/features/admin/secrets.js';
import { hashPassword } from '../../src/features/admin/auth.js';
import { installState } from '../../src/features/admin/install.js';
import { listProtocols, listVersions } from '../../src/features/protocols/repo.js';
import { publishVersion, updateDraftBody } from '../../src/features/protocols/service.js';
import { SOP_HEADINGS } from '../../src/services/llm/draft.js';
import { fixtureProvider } from '../../src/services/llm/fixture.js';
import { adminLogin } from '../helpers/adminLogin.js';
import { fakeSiteFetch } from '../helpers/fakeSiteFetch.js';
import { createTestDb } from '../helpers/testDb.js';

const PW = 'correct horse battery';
const now = new Date('2026-10-27T16:00:00Z');
const RC = ['https://redcross.example/choking', 'https://nhs.example/choking'].join('\n');
let HASH: string;
beforeAll(async () => {
  HASH = await hashPassword(PW);
});

async function harness(opts: { llm?: boolean; llmOverride?: { generateJson: () => Promise<never> } } = {}) {
  const db = createTestDb();
  const env = loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: HASH });
  const secrets = createSecretsStore(db, env);
  const app = createApp({
    db,
    env,
    secrets,
    now: () => now,
    scheduler: { reschedule: vi.fn() },
    ...(opts.llm
      ? {
          llm: (opts.llmOverride as never) ?? fixtureProvider(path.resolve(import.meta.dirname, '../fixtures/llm')),
          siteFetch: fakeSiteFetch(path.resolve(import.meta.dirname, '../fixtures/web')),
          lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
        }
      : {}),
  });
  const cookie = await adminLogin(app, PW);
  const get = (p: string) => app.request(p, { headers: { cookie } });
  const post = (p: string, fields: Record<string, string> = {}) =>
    app.request(p, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams(fields).toString(),
    });
  return { db, env, secrets, app, cookie, get, post };
}

describe('protocol step', () => {
  it('write-it-yourself path reaches review', async () => {
    const { db, post, get } = await harness();
    const res = await post('/admin/setup/protocol/start', { title: 'Choking (adult)', tags: 'a, b', path: 'manual' });
    expect(res.status).toBe(302);
    const p = listProtocols(db)[0]!;
    expect(p.tags).toEqual(['a', 'b']);
    const v = listVersions(db, p.id)[0]!;
    expect(v.status).toBe('draft');
    const loc = res.headers.get('location')!;
    expect(loc).toBe(`/admin/protocols/${p.id}/versions/${v.id}?from=setup`);
    expect(await (await get(loc)).text()).toContain('href="/admin/setup/protocol"');
  });

  it('without a key the draft-from-sources controls are disabled and explained', async () => {
    const { get } = await harness();
    const html = await (await get('/admin/setup/protocol')).text();
    expect(html).toMatch(/<button[^>]*disabled[^>]*>\s*Draft from sources/);
    expect(html).toContain('Add an Anthropic key in');
    expect(html).toContain('data-busy');
  });

  it('with a key the sources path drafts directly and lands on review with the setup link', async () => {
    const { db, post } = await harness({ llm: true });
    const res = await post('/admin/setup/protocol/start', { title: 'Choking (adult)', source_urls: RC, path: 'sources' });
    expect(res.status).toBe(302);
    const p = listProtocols(db)[0]!;
    const v = listVersions(db, p.id)[0]!;
    expect(res.headers.get('location')).toBe(`/admin/protocols/${p.id}/versions/${v.id}?from=setup`);
  });

  it('a failed draft re-renders the wizard with a plain error, retry and manual options, and retry reuses the protocol', async () => {
    const llm = { generateJson: async () => { throw new Error('upstream said: sk-secret-123 rate limited'); } };
    const { db, post } = await harness({ llm: true, llmOverride: llm });
    const res = await post('/admin/setup/protocol/start', { title: 'Choking (adult)', source_urls: RC, path: 'sources' });
    expect(res.status).toBe(502);
    const html = await res.text();
    expect(html).toContain('Draft rejected');
    expect(html).not.toContain('sk-secret-123');
    expect(html).toContain('id="source_urls"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Try again');
    expect(html).toContain('Write it yourself');
    expect(html).toContain('In progress');
    expect(html).toContain('redcross.example/choking');
    expect(listProtocols(db)).toHaveLength(1);
    const p = listProtocols(db)[0]!;
    expect(html).toContain(`/admin/setup/protocol/${p.id}/draft`);
    expect(html).toContain(`/admin/protocols/${p.id}/manual-draft`);
    const retry = await post(`/admin/setup/protocol/${p.id}/draft`, { source_urls: RC });
    expect(retry.status).toBe(502);
    expect(listProtocols(db)).toHaveLength(1);
  });

  it('forged sources path without a key is a 503 in the wizard and creates nothing', async () => {
    const { db, post } = await harness();
    const res = await post('/admin/setup/protocol/start', { title: 'Choking (adult)', source_urls: RC, path: 'sources' });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('Add an Anthropic key in');
    expect(listProtocols(db)).toHaveLength(0);
  });

  it('disabled Draft from sources points at its explanation', async () => {
    const { get } = await harness();
    const html = await (await get('/admin/setup/protocol')).text();
    expect(html).toMatch(/<button[^>]*aria-describedby="no-llm-note"[^>]*disabled|<button[^>]*disabled[^>]*aria-describedby="no-llm-note"/);
    expect(html).toContain('id="no-llm-note"');
  });

  it('rejects a blank or duplicate title with a field error', async () => {
    const { post } = await harness();
    const blank = await post('/admin/setup/protocol/start', { title: '  ', path: 'manual' });
    expect(blank.status).toBe(400);
    expect(await blank.text()).toContain('role="alert"');
    await post('/admin/setup/protocol/start', { title: 'Burns', path: 'manual' });
    const dup = await post('/admin/setup/protocol/start', { title: 'burns', path: 'manual' });
    expect(dup.status).toBe(400);
    expect(await dup.text()).toContain('already have a protocol');
  });

  it('shows an already published protocol as done and lets you continue', async () => {
    const { db, post, get } = await harness();
    await post('/admin/setup/protocol/start', { title: 'Burns', path: 'manual' });
    const p = listProtocols(db)[0]!;
    const v = listVersions(db, p.id)[0]!;
    // The untouched template can no longer be published, so fill it in first.
    updateDraftBody(db, v.id, SOP_HEADINGS.map((h) => `${h}\ntext`).join('\n\n'), now);
    publishVersion(db, v.id, now);
    const html = await (await get('/admin/setup/protocol')).text();
    expect(html).toContain('is published');
    expect(html).toContain(`href="/admin/protocols/${p.id}"`);
    expect(html).not.toContain('id="protocol-start"');
    const next = await post('/admin/setup/protocol', { go: 'next' });
    expect(next.headers.get('location')).toBe('/admin/setup/done');
  });
});

describe('done step', () => {
  it('lists open steps, the family link and the phone tip', async () => {
    const { get } = await harness();
    const html = await (await get('/admin/setup/done')).text();
    expect(html).toContain('Still open:');
    expect(html).toContain('href="/admin/setup/protocol"');
    expect(html).toContain('href="/"');
    expect(html).toContain('Add to Home Screen');
  });

  it('done sets setup_completed_at', async () => {
    const { db, secrets, post, get } = await harness();
    expect(installState({ db, secrets })).toBe('incomplete');
    const res = await post('/admin/setup/done', { go: 'next' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin');
    expect(db.select().from(settings).where(eq(settings.id, 1)).get()!.setupCompletedAt).toEqual(now);
    expect(installState({ db, secrets })).toBe('ready');
    const overview = await (await get('/admin')).text();
    expect(overview).toContain('Run setup again');
    expect(overview).not.toMatch(/<a [^>]*href="\/admin\/setup"[^>]*>\s*Setup\s*<\/a>/);
  });

  it('Finish later does not complete setup', async () => {
    const { db, post } = await harness();
    const res = await post('/admin/setup/done', { go: 'later' });
    expect(res.headers.get('location')).toBe('/admin');
    expect(db.select().from(settings).where(eq(settings.id, 1)).get()!.setupCompletedAt).toBeNull();
  });
});
