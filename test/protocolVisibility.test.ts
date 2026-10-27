import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { protocolSources, protocolVersions, protocols } from '../src/db/schema.js';
import type { ProtocolStatus } from '../src/domain/types.js';
import { loadEnv } from '../src/env.js';
import { createProtocol, insertSources, insertVersion } from '../src/features/protocols/repo.js';
import { SOP_HEADINGS } from '../src/services/llm/draft.js';
import { createTestDb } from './helpers/testDb.js';

const NOW = new Date('2026-02-01T00:00:00Z');
const RC = 'https://redcross.example/choking';
const NHS = 'https://nhs.example/choking';
const body = (text: string) => SOP_HEADINGS.map((h) => `${h}\n${text}`).join('\n\n');

let db: Db;
let app: ReturnType<typeof createApp>;

const ver = (protocolId: number, version: number, status: ProtocolStatus, bodyMd: string) =>
  insertVersion(db, { protocolId, version, status, bodyMd, createdAt: NOW, reviewedAt: status === 'published' ? NOW : null });

beforeEach(() => {
  db = createTestDb();
  app = createApp({
    db,
    env: loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: 'x' }),
    now: () => NOW,
  });
});

function seedPublished(bodyMd = body('v2 body text')) {
  const p = createProtocol(db, { slug: 'choking-adult', title: 'Choking (adult)', tags: ['first-aid', 'airway'] });
  ver(p.id, 1, 'superseded', body('v1 old text'));
  const v2 = ver(p.id, 2, 'published', bodyMd);
  insertSources(db, [
    { protocolVersionId: v2.id, url: RC, title: 'Choking first aid', fetchedAt: NOW, contentHash: 'a'.repeat(64) },
    { protocolVersionId: v2.id, url: NHS, title: null, fetchedAt: NOW, contentHash: 'b'.repeat(64) },
  ]);
  return p;
}

function seedUnpublished() {
  const slugs: Record<string, string> = {};
  for (const status of ['draft', 'in_review', 'rejected'] as const) {
    const p = createProtocol(db, { slug: `hidden-${status}`, title: `Hidden ${status} protocol`, tags: [] });
    ver(p.id, 1, status, body('secret'));
    slugs[status] = p.slug;
  }
  return slugs;
}

describe('protocol visibility', () => {
  it('drafts, in_review and rejected never appear on /emergency or /api/protocols', async () => {
    seedPublished();
    const slugs = seedUnpublished();
    const html = await (await app.request('/emergency')).text();
    const json = await (await app.request('/api/protocols')).text();
    expect(html).toContain('Choking (adult)');
    expect(html).toContain('/emergency/choking-adult');
    expect(json).toContain('choking-adult');
    for (const [status, slug] of Object.entries(slugs)) {
      for (const text of [html, json]) {
        expect(text).not.toContain(`Hidden ${status} protocol`);
        expect(text).not.toContain(slug);
      }
      expect((await app.request(`/emergency/${slug}`)).status).toBe(404);
      expect((await app.request(`/api/protocols/${slug}`)).status).toBe(404);
    }
  });

  it('published renders with Sources section', async () => {
    seedPublished();
    const res = await app.request('/emergency/choking-adult');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('Steps</h2>');
    expect(html).toContain('Sources</h2>');
    expect(html).toContain(`href="${RC}"`);
    expect(html).toContain(`href="${NHS}"`);
    expect(html).toContain('Published v2 - reviewed 2026-02-01');
  });

  it('superseded slug shows the new published body', async () => {
    seedPublished();
    const html = await (await app.request('/emergency/choking-adult')).text();
    expect(html).toContain('v2 body text');
    expect(html).not.toContain('v1 old text');
  });

  it('script tags stripped from body', async () => {
    seedPublished(
      `${body('x')}\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<iframe src="https://evil.example"></iframe>\n\n[x](javascript:alert(1))`,
    );
    const html = await (await app.request('/emergency/choking-adult')).text();
    for (const bad of ['<script', 'onerror', '<iframe', 'javascript:']) expect(html).not.toContain(bad);
    expect(html).toContain('<h2');
  });

  it('needs_rereview shows the badge on list and page', async () => {
    const p = seedPublished();
    const reason = 'Source changed: https://redcross.example/choking';
    db.update(protocols).set({ needsRereview: true, rereviewReason: reason }).where(eq(protocols.id, p.id)).run();
    const list = await (await app.request('/emergency')).text();
    const page = await (await app.request('/emergency/choking-adult')).text();
    expect(list).toContain('⚠');
    expect(page).toContain('⚠');
    expect(page).toContain(reason);
  });

  it('api protocol detail has body and sources', async () => {
    seedPublished();
    const list = (await (await app.request('/api/protocols')).json()) as { protocols: Record<string, unknown>[] };
    expect(list.protocols).toHaveLength(1);
    expect(list.protocols[0]).toMatchObject({
      slug: 'choking-adult',
      title: 'Choking (adult)',
      tags: ['first-aid', 'airway'],
      needsRereview: false,
      rereviewReason: null,
      version: { number: 2, publishedAt: NOW.toISOString() },
    });
    const res = await app.request('/api/protocols/choking-adult');
    const json = (await res.json()) as { protocol: { bodyMd: string; sources: Record<string, unknown>[] } };
    expect(res.status).toBe(200);
    expect(json.protocol.bodyMd).toContain('v2 body text');
    expect(json.protocol.sources).toEqual([
      { url: RC, title: 'Choking first aid', fetchedAt: NOW.toISOString() },
      { url: NHS, title: null, fetchedAt: NOW.toISOString() },
    ]);
    const missing = await app.request('/api/protocols/nope');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not found' });
  });

  it('javascript: source URL is not rendered as a link', async () => {
    const p = seedPublished();
    const v = db.select().from(protocolVersions).where(eq(protocolVersions.protocolId, p.id)).all().find((x) => x.status === 'published')!;
    db.insert(protocolSources).values({ protocolVersionId: v.id, url: 'javascript:alert(1)', title: null, fetchedAt: NOW, contentHash: 'c'.repeat(64) }).run();
    const html = await (await app.request('/emergency/choking-adult')).text();
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('javascript:alert(1)');
  });

  it('home page emergency link resolves', async () => {
    expect((await app.request('/emergency')).status).toBe(200);
  });
});
