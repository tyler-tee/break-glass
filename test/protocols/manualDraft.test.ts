import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword } from '../../src/features/admin/auth.js';
import { createProtocol, getVersion, listVersions } from '../../src/features/protocols/repo.js';
import { MANUAL_TEMPLATE, ProtocolError, createManualDraft, publishVersion } from '../../src/features/protocols/service.js';
import { assertSopHeadings } from '../../src/services/llm/draft.js';
import { adminLogin } from '../helpers/adminLogin.js';
import { createTestDb } from '../helpers/testDb.js';

const NOW = new Date('2026-10-27T16:00:00Z');
const PW = 'correct horse';

let db: Db;
beforeEach(() => {
  db = createTestDb();
});

const proto = (slug = 'burns') => createProtocol(db, { slug, title: 'Burns', tags: [] });

async function harness() {
  const env = loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: await hashPassword(PW) });
  const app = createApp({ db, env, now: () => NOW }); // no LLM configured
  const cookie = await adminLogin(app, PW);
  const get = (p: string) => app.request(p, { headers: { cookie } });
  const post = (p: string, fields: Record<string, string> = {}) =>
    app.request(p, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams(fields).toString(),
    });
  return { get, post };
}

describe('createManualDraft', () => {
  it('uses the exact template and passes assertSopHeadings', () => {
    const v = createManualDraft(db, proto().id, NOW);
    expect(() => assertSopHeadings(v.bodyMd)).not.toThrow();
    expect(v.bodyMd).toBe(MANUAL_TEMPLATE);
    expect(v.bodyMd).toBe(
      '## Title and scope\nWhat this covers and who it is for.\n\n## Steps\n1. First step.\n\n## Escalation criteria\nCall 911 or go to the ER if ...\n\n## Do not\n- Common mistake to avoid.\n',
    );
    expect([v.version, v.status]).toEqual([1, 'draft']);
  });

  it('numbers after existing versions', () => {
    const p = proto();
    const v1 = createManualDraft(db, p.id, NOW);
    publishVersion(db, v1.id, NOW);
    expect(createManualDraft(db, p.id, NOW).version).toBe(2);
  });

  it('returns the existing open version instead of creating a second draft', () => {
    const p = proto();
    const a = createManualDraft(db, p.id, NOW);
    const b = createManualDraft(db, p.id, NOW);
    expect(b.id).toBe(a.id);
    expect(listVersions(db, p.id)).toHaveLength(1);
  });

  it('rejects an unknown protocol', () => {
    expect(() => createManualDraft(db, 999, NOW)).toThrow(ProtocolError);
  });
});

describe('manual draft routes (no LLM configured)', () => {
  it('creates a valid draft that publishes', async () => {
    const p = proto();
    const { post } = await harness();
    const res = await post(`/admin/protocols/${p.id}/manual-draft`);
    expect(res.status).toBe(302);
    const v = listVersions(db, p.id)[0]!;
    expect(res.headers.get('location')).toBe(`/admin/protocols/${p.id}/versions/${v.id}`);
    const base = `/admin/protocols/${p.id}/versions/${v.id}`;
    expect((await post(`${base}/submit`)).status).toBe(302);
    expect((await post(`${base}/publish`, { notes: 'ok' })).status).toBe(302);
    expect(getVersion(db, v.id)!.status).toBe('published');
  });

  it('a second click lands on the same open draft', async () => {
    const p = proto();
    const { post } = await harness();
    const first = await post(`/admin/protocols/${p.id}/manual-draft`);
    const second = await post(`/admin/protocols/${p.id}/manual-draft`);
    expect(second.headers.get('location')).toBe(first.headers.get('location'));
    expect(listVersions(db, p.id)).toHaveLength(1);
  });

  it('404s for an unknown protocol', async () => {
    const { post } = await harness();
    expect((await post('/admin/protocols/999/manual-draft')).status).toBe(404);
  });

  it('editing to break headings is a 400 with an alert', async () => {
    const p = proto();
    const v = createManualDraft(db, p.id, NOW);
    const { post } = await harness();
    const broken = MANUAL_TEMPLATE.replace('## Do not', '## Nope');
    const res = await post(`/admin/protocols/${p.id}/versions/${v.id}/body`, { body_md: broken });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain('missing required SOP headings');
    expect(getVersion(db, v.id)!.bodyMd).toBe(MANUAL_TEMPLATE);
  });

  it('detail page offers Write it yourself and disables Generate draft with the explanation', async () => {
    const p = proto();
    const { get } = await harness();
    const html = await (await get(`/admin/protocols/${p.id}`)).text();
    expect(html).toContain(`action="/admin/protocols/${p.id}/manual-draft"`);
    expect(html).toContain('id="draft"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>\s*Generate draft/);
    expect(html).toContain('Add an Anthropic key in');
    expect(html).toContain('href="/admin/setup/services"');
    expect(html).not.toContain('LLM_PROVIDER');
  });

  it('shows Back to setup only for from=setup', async () => {
    const p = proto();
    const v = createManualDraft(db, p.id, NOW);
    const { get } = await harness();
    const url = `/admin/protocols/${p.id}/versions/${v.id}`;
    expect(await (await get(`${url}?from=setup`)).text()).toContain('href="/admin/setup/protocol"');
    expect(await (await get(`${url}?from=evil`)).text()).not.toContain('Back to setup');
    expect(await (await get(url)).text()).not.toContain('Back to setup');
  });
});
