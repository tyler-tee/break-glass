import path from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { protocolSources, protocolVersions } from '../../src/db/schema.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword } from '../../src/features/admin/auth.js';
import { createProtocol, getProtocolBySlug } from '../../src/features/protocols/repo.js';
import {
  ProtocolError,
  generateDraft,
  isAllowedSource,
  parseAllowlist,
} from '../../src/features/protocols/service.js';
import { SOP_HEADINGS } from '../../src/services/llm/draft.js';
import { fixtureProvider } from '../../src/services/llm/fixture.js';
import { LlmValidationError, type LlmProvider } from '../../src/services/llm/provider.js';
import { adminLogin } from '../helpers/adminLogin.js';
import { fakeSiteFetch } from '../helpers/fakeSiteFetch.js';
import { createTestDb } from '../helpers/testDb.js';

const LLM_DIR = path.resolve(import.meta.dirname, '../fixtures/llm');
const WEB_DIR = path.resolve(import.meta.dirname, '../fixtures/web');
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const RC = 'https://redcross.example/choking';
const NHS = 'https://nhs.example/choking';
const NOW = new Date('2026-01-01T00:00:00Z');

let db: Db;
beforeEach(() => {
  db = createTestDb();
});

const deps = (over: Partial<Parameters<typeof generateDraft>[3]> = {}) => ({
  llm: fixtureProvider(LLM_DIR),
  fetch: fakeSiteFetch(WEB_DIR),
  model: 'claude-opus-5-5',
  allowlist: [] as string[],
  now: () => NOW,
  lookup: publicLookup,
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  ...over,
});

const choking = () => createProtocol(db, { slug: 'choking-adult', title: 'Choking (adult)', tags: [] });
const counts = () => ({
  versions: db.select().from(protocolVersions).all().length,
  sources: db.select().from(protocolSources).all().length,
});

describe('generateDraft', () => {
  it('asks the LLM for 16000 max tokens', async () => {
    const inner = fixtureProvider(LLM_DIR);
    const spy = vi.fn(inner.generateJson.bind(inner));
    const llm = { generateJson: spy } as LlmProvider;
    await generateDraft(db, choking().id, [RC, NHS], deps({ llm }));
    expect(spy.mock.calls[0]![0].maxTokens).toBe(16000);
  });

  it('stores sources with hashes and a draft version 1', async () => {
    const p = choking();
    const v = await generateDraft(db, p.id, [RC, NHS], deps());
    expect(v.version).toBe(1);
    expect(v.status).toBe('draft');
    const lines = v.bodyMd.split('\n');
    const idx = SOP_HEADINGS.map((h) => lines.indexOf(h));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    const sources = db.select().from(protocolSources).where(eq(protocolSources.protocolVersionId, v.id)).all();
    expect(sources).toHaveLength(2);
    for (const s of sources) expect(s.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sources.map((s) => s.title).sort()).toEqual(['Choking first aid', 'How to help a choking adult']);
  });

  it('second generateDraft creates version 2', async () => {
    const p = choking();
    await generateDraft(db, p.id, [RC, NHS], deps());
    const v2 = await generateDraft(db, p.id, [RC, NHS], deps());
    expect(v2.version).toBe(2);
  });

  it('rejects source outside allowlist', async () => {
    const p = choking();
    await expect(generateDraft(db, p.id, [RC, NHS], deps({ allowlist: ['redcross.example'] }))).rejects.toMatchObject({
      code: 'source_not_allowed',
      detail: NHS,
    });
    expect(counts()).toEqual({ versions: 0, sources: 0 });
  });

  it('rejects non-http url', async () => {
    const p = choking();
    const err = await generateDraft(db, p.id, ['ftp://redcross.example/x'], deps()).catch((e) => e);
    expect(err).toBeInstanceOf(ProtocolError);
    expect(err.code).toBe('invalid');
    expect(counts()).toEqual({ versions: 0, sources: 0 });
  });

  it('unreachable source stores nothing', async () => {
    const p = choking();
    await expect(
      generateDraft(db, p.id, [RC, NHS], deps({ fetch: fakeSiteFetch(WEB_DIR, { fail: [NHS] }) })),
    ).rejects.toMatchObject({ code: 'source_unreachable' });
    expect(counts()).toEqual({ versions: 0, sources: 0 });
  });

  it('draft body missing headings is rejected', async () => {
    const p = choking();
    const llm: LlmProvider = { generateJson: async (req) => req.schema.parse({ bodyMd: 'hello' }) };
    await expect(generateDraft(db, p.id, [RC], deps({ llm }))).rejects.toBeInstanceOf(LlmValidationError);
    expect(counts()).toEqual({ versions: 0, sources: 0 });
  });
});

describe('draft safety', () => {
  const stub = (bodyMd: string): LlmProvider => ({ generateJson: async (req) => req.schema.parse({ bodyMd }) });
  const good = SOP_HEADINGS.map((h) => `${h}
text`).join('\n\n');

  it('draft with an extra ## Sources heading is rejected', async () => {
    const p = choking();
    await expect(generateDraft(db, p.id, [RC], deps({ llm: stub(`${good}

## Sources
- x`) }))).rejects.toThrow(
      /unexpected level-2 headings/,
    );
    expect(counts()).toEqual({ versions: 0, sources: 0 });
  });

  it('draft with headings out of order is rejected', async () => {
    const p = choking();
    const swapped = [SOP_HEADINGS[1], SOP_HEADINGS[0], SOP_HEADINGS[2], SOP_HEADINGS[3]].map((h) => `${h}
t`).join('\n');
    await expect(generateDraft(db, p.id, [RC], deps({ llm: stub(swapped) }))).rejects.toBeInstanceOf(LlmValidationError);
    expect(counts()).toEqual({ versions: 0, sources: 0 });
  });

  it('redirect to a non-allowlisted host is rejected', async () => {
    const p = choking();
    const redirecting = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === RC) return new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } });
      if (url.startsWith('https://evil.example/')) {
        return new Response('<title>Evil</title><p>x</p>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return fakeSiteFetch(WEB_DIR)(url);
    }) as typeof fetch;
    await expect(
      generateDraft(db, p.id, [RC], deps({ allowlist: ['redcross.example'], fetch: redirecting })),
    ).rejects.toMatchObject({ code: 'source_unreachable' });
    expect(counts()).toEqual({ versions: 0, sources: 0 });
  });

  it('allowlist rejects lookalike hosts', async () => {
    const p = choking();
    for (const url of ['https://evil-redcross.example/x', 'https://redcross.example.evil/x']) {
      await expect(generateDraft(db, p.id, [url], deps({ allowlist: ['redcross.example'] }))).rejects.toMatchObject({
        code: 'source_not_allowed',
      });
    }
  });
});

describe('allowlist', () => {
  it('parseAllowlist and isAllowedSource', () => {
    expect(parseAllowlist(' Redcross.example, nhs.example\n  ,')).toEqual(['redcross.example', 'nhs.example']);
    expect(parseAllowlist('')).toEqual([]);
    expect(isAllowedSource(new URL('https://www.redcross.example/x'), ['redcross.example'])).toBe(true);
    expect(isAllowedSource(new URL('https://redcross.example/x'), ['redcross.example'])).toBe(true);
    expect(isAllowedSource(new URL('https://evilredcross.example/x'), ['redcross.example'])).toBe(false);
    expect(isAllowedSource(new URL('https://nhs.example/x'), ['redcross.example'])).toBe(false);
    expect(isAllowedSource(new URL('https://anything.example/x'), [])).toBe(true);
  });
});

describe('protocol admin routes', () => {
  const makeApp = async (llm?: LlmProvider) =>
    createApp({
      db,
      env: loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: await hashPassword('correct horse') }),
      now: () => NOW,
      ...(llm ? { llm } : {}),
      siteFetch: fakeSiteFetch(WEB_DIR),
      lookup: publicLookup,
    });
  const form = (cookie: string, body: Record<string, string>) => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(body).toString(),
  });

  it('protocol admin pages require login', async () => {
    const app = await makeApp();
    expect((await app.request('/admin/protocols')).status).toBe(302);
    expect((await app.request('/admin/protocols/new')).status).toBe(302);
    expect((await app.request('/admin/protocols/1')).status).toBe(302);
  });

  it('create protocol and generate draft via routes', async () => {
    const app = await makeApp(fixtureProvider(LLM_DIR));
    const cookie = await adminLogin(app, 'correct horse');
    const created = await app.request(
      '/admin/protocols/new',
      form(cookie, { title: 'Choking (adult)', tags: 'first-aid, choking' }),
    );
    expect(created.status).toBe(302);
    const p = getProtocolBySlug(db, 'choking-adult')!;
    expect(p.tags).toEqual(['first-aid', 'choking']);
    const dup = await app.request('/admin/protocols/new', form(cookie, { title: 'Choking (adult)', tags: '' }));
    expect(dup.status).toBe(400);
    const res = await app.request(`/admin/protocols/${p.id}/draft`, form(cookie, { source_urls: `${RC}\n${NHS}\n` }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/admin/protocols/${p.id}`);
    const html = await (await app.request(`/admin/protocols/${p.id}`, { headers: { cookie } })).text();
    expect(html).toContain('v1');
    expect(html).toContain('draft');
    expect(html).toContain(RC);
    expect(html).toContain(NHS);
    const list = await (await app.request('/admin/protocols', { headers: { cookie } })).text();
    expect(list).toContain('choking-adult');
  });

  it('draft route maps ProtocolError to 400', async () => {
    const app = await makeApp(fixtureProvider(LLM_DIR));
    const cookie = await adminLogin(app, 'correct horse');
    const p = choking();
    const res = await app.request(`/admin/protocols/${p.id}/draft`, form(cookie, { source_urls: 'ftp://x.example/a' }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Source is not a valid http(s) URL');
  });

  it('draft route without llm is 503', async () => {
    const app = await makeApp();
    const cookie = await adminLogin(app, 'correct horse');
    const p = choking();
    const res = await app.request(`/admin/protocols/${p.id}/draft`, form(cookie, { source_urls: RC }));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('Add an Anthropic key in');
  });

  it('draft route maps provider errors to 502', async () => {
    const llm: LlmProvider = {
      generateJson: async () => {
        throw new Error('connection reset');
      },
    };
    const app = await makeApp(llm);
    const cookie = await adminLogin(app, 'correct horse');
    const p = choking();
    const res = await app.request(`/admin/protocols/${p.id}/draft`, form(cookie, { source_urls: RC }));
    expect(res.status).toBe(502);
    const html = await res.text();
    expect(html).toContain('Draft rejected');
    expect(html).toContain('LLM provider error: connection reset');
    expect(counts()).toEqual({ versions: 0, sources: 0 });
  });

  it('draft route maps LlmValidationError to 502', async () => {
    const llm: LlmProvider = {
      generateJson: async () => {
        throw new LlmValidationError('junk', null);
      },
    };
    const app = await makeApp(llm);
    const cookie = await adminLogin(app, 'correct horse');
    const p = choking();
    const res = await app.request(`/admin/protocols/${p.id}/draft`, form(cookie, { source_urls: RC }));
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('Draft rejected');
    expect(counts()).toEqual({ versions: 0, sources: 0 });
  });
});
