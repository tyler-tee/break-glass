import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { settings } from '../../src/db/schema.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword } from '../../src/features/admin/auth.js';
import { createSecretsStore } from '../../src/features/admin/secrets.js';
import { createProtocol } from '../../src/features/protocols/repo.js';
import type { LlmProvider } from '../../src/services/llm/provider.js';
import { makeServiceResolver } from '../../src/services/resolver.js';
import { adminLogin } from '../helpers/adminLogin.js';
import { createTestDb } from '../helpers/testDb.js';

const PW = 'correct horse battery';
const KEY = 'sk-ant-api03-saved-but-unused-9876';
const OFF = 'Drafting is turned off by LLM_PROVIDER=none in the server environment';
let HASH: string;
beforeAll(async () => {
  HASH = await hashPassword(PW);
});

async function harness(opts: { env?: Record<string, string>; fetch?: typeof fetch; llm?: LlmProvider } = {}) {
  const db = createTestDb();
  db.update(settings).set({ homeLat: null, homeLng: null, homeLabel: null }).where(eq(settings.id, 1)).run();
  const env = loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: HASH, ...opts.env });
  const secrets = createSecretsStore(db, env);
  const resolve = makeServiceResolver(db, env, secrets, opts.fetch ? { fetch: opts.fetch } : {});
  const app = createApp({ db, env, secrets, resolve, scheduler: { reschedule: vi.fn() }, ...(opts.llm ? { llm: opts.llm } : {}) });
  const cookie = await adminLogin(app, PW);
  const get = (path: string) => app.request(path, { headers: { cookie } });
  const post = (path: string, fields: Record<string, string>) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams(fields).toString(),
    });
  return { db, secrets, get, post };
}

const NONE = { env: { LLM_PROVIDER: 'none' } };
/** The Service keys row of the Done checklist. */
const servicesRow = (html: string) =>
  html.slice(html.indexOf('class="checklist"')).match(/<li>(?:(?!<\/li>)[^])*Service keys \(optional\)[^]*?<\/li>/)![0];

describe('LLM_PROVIDER=none with a saved Anthropic key', () => {
  it('Services shows a status notice beside the Anthropic key; absent without the override', async () => {
    const off = await harness(NONE);
    off.secrets.setAnthropicKey(KEY);
    const html = await (await off.get('/admin/setup/services')).text();
    expect(html).toMatch(new RegExp(`role="status"[^>]*>${OFF}; the key is saved but unused`));
    expect(html).not.toContain(KEY);
    // The notice sits in the Anthropic fieldset, not the Places one.
    const anthropic = html.slice(html.indexOf('<legend>Anthropic key</legend>'));
    expect(anthropic).toContain(OFF);

    const on = await harness();
    on.secrets.setAnthropicKey(KEY);
    expect(await (await on.get('/admin/setup/services')).text()).not.toContain('LLM_PROVIDER');
  });

  it('the key Test still works and says the key is unused', async () => {
    const llm = { generateJson: vi.fn(async () => ({ ok: true })) } as unknown as LlmProvider;
    const { post, secrets } = await harness({ ...NONE, llm });
    secrets.setAnthropicKey(KEY);
    const html = await (await post('/admin/setup/services', { test: 'anthropic' })).text();
    expect(html).toMatch(/role="status"[^>]*>The saved key works\.[^<]*unused/);
    expect(html).toContain(OFF);
    expect(llm.generateJson).toHaveBeenCalledTimes(1);
  });

  it('the protocol step explains the env override instead of asking for a key', async () => {
    const { get, secrets } = await harness(NONE);
    secrets.setAnthropicKey(KEY);
    const html = await (await get('/admin/setup/protocol')).text();
    expect(html).toContain(`${OFF}.`);
    expect(html).not.toContain('Add an Anthropic key in');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>\s*Draft from sources/);
  });

  it('the classic protocol detail page explains the env override instead of asking for a key', async () => {
    const { db, get, secrets } = await harness(NONE);
    secrets.setAnthropicKey(KEY);
    const p = createProtocol(db, { slug: 'burns', title: 'Burns', tags: [] });
    const html = await (await get(`/admin/protocols/${p.id}`)).text();
    expect(html).toContain(`${OFF}.`);
    expect(html).not.toContain('Add an Anthropic key in');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>\s*Generate draft/);
  });

  it('the Done checklist counts the saved key but says drafting is off', async () => {
    const off = await harness(NONE);
    off.secrets.setAnthropicKey(KEY);
    const html = await (await off.get('/admin/setup/done')).text();
    const row = servicesRow(html);
    expect(row).toContain('✓');
    expect(row).toContain(OFF);
    expect(row).not.toContain('not added');

    // No key at all: still "not added", with no mention of the override.
    const none = await harness(NONE);
    const empty = servicesRow(await (await none.get('/admin/setup/done')).text());
    expect(empty).toContain('not added');
  });
});

describe('Services Test for env-provided keys', () => {
  it('shows Test (but no Remove) and probes the effective env key without echoing it', async () => {
    const key = 'AIzaSyENV-provided-key-7777';
    const fetch = vi.fn(async () => new Response(JSON.stringify({ places: [] }), { status: 200 })) as unknown as typeof globalThis.fetch;
    const { get, post } = await harness({ env: { GOOGLE_PLACES_API_KEY: key }, fetch });
    const page = await (await get('/admin/setup/services')).text();
    expect(page).toMatch(/name="test" value="places"/);
    expect(page).not.toMatch(/name="remove" value="places"/);
    expect(page).not.toContain('name="places_key"');
    const html = await (await post('/admin/setup/services', { test: 'places' })).text();
    expect(html).toMatch(/role="status"[^>]*>[^<]*works/);
    expect(html).not.toContain(key);
    expect(html).not.toContain('7777');
    const headers = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['X-Goog-Api-Key']).toBe(key);
  });
});
