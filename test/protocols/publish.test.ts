import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { protocolVersions, protocols } from '../../src/db/schema.js';
import type { ProtocolStatus } from '../../src/domain/types.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword } from '../../src/features/admin/auth.js';
import { createProtocol, getVersion, insertSources, insertVersion, listVersions } from '../../src/features/protocols/repo.js';
import {
  ProtocolError,
  publishVersion,
  rejectVersion,
  submitForReview,
  updateDraftBody,
} from '../../src/features/protocols/service.js';
import { SOP_HEADINGS } from '../../src/services/llm/draft.js';
import { renderMarkdown } from '../../src/web/format.js';
import { adminLogin } from '../helpers/adminLogin.js';
import { createTestDb } from '../helpers/testDb.js';

const NOW = new Date('2026-02-01T00:00:00Z');
const LATER = new Date('2026-03-01T00:00:00Z');
const RC = 'https://redcross.example/choking';
const NHS = 'https://nhs.example/choking';
const BODY = SOP_HEADINGS.map((h) => `${h}\ntext`).join('\n\n');

let db: Db;
beforeEach(() => {
  db = createTestDb();
});

const proto = (slug = 'choking-adult') => createProtocol(db, { slug, title: 'Choking (adult)', tags: [] });
const ver = (protocolId: number, version: number, status: ProtocolStatus = 'draft', bodyMd = BODY) =>
  insertVersion(db, { protocolId, version, status, bodyMd, createdAt: NOW });
const statuses = (protocolId: number) => listVersions(db, protocolId).map((v) => [v.version, v.status]);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof ProtocolError ? e.code : e;
  }
  return null;
};

describe('publishVersion', () => {
  it('publish v1 then v2 -> v1 superseded, v2 published', () => {
    const p = proto();
    const v1 = ver(p.id, 1);
    const v2 = ver(p.id, 2);
    publishVersion(db, v1.id, NOW);
    const out = publishVersion(db, v2.id, LATER, 'looks good');
    expect(out.status).toBe('published');
    expect(out.reviewNotes).toBe('looks good');
    expect(statuses(p.id)).toEqual([
      [2, 'published'],
      [1, 'superseded'],
    ]);
    expect(getVersion(db, v1.id)!.reviewedAt).toEqual(NOW);
    expect(getVersion(db, v2.id)!.reviewedAt).toEqual(LATER);
    const published = db.select().from(protocolVersions).where(eq(protocolVersions.status, 'published')).all();
    expect(published).toHaveLength(1);
  });

  it('publish clears needs_rereview', () => {
    const p = proto();
    db.update(protocols).set({ needsRereview: true, rereviewReason: 'x' }).where(eq(protocols.id, p.id)).run();
    const v = ver(p.id, 1, 'in_review');
    publishVersion(db, v.id, NOW);
    const row = db.select().from(protocols).where(eq(protocols.id, p.id)).get()!;
    expect(row.needsRereview).toBe(false);
    expect(row.rereviewReason).toBeNull();
  });

  it('publishing a rejected version throws invalid_transition', () => {
    const v = ver(proto().id, 1, 'rejected');
    expect(code(() => publishVersion(db, v.id, NOW))).toBe('invalid_transition');
  });

  it('publishing a superseded version throws invalid_transition', () => {
    const v = ver(proto().id, 1, 'superseded');
    expect(code(() => publishVersion(db, v.id, NOW))).toBe('invalid_transition');
  });

  it('publishing a missing version throws not_found', () => {
    expect(code(() => publishVersion(db, 999, NOW))).toBe('not_found');
  });
});

describe('review workflow', () => {
  it('submitForReview moves draft to in_review with submittedAt', () => {
    const v = ver(proto().id, 1);
    const out = submitForReview(db, v.id, NOW);
    expect(out.status).toBe('in_review');
    expect(out.submittedAt).toEqual(NOW);
    expect(code(() => submitForReview(db, v.id, NOW))).toBe('invalid_transition');
  });

  it('updateDraftBody re-validates headings', () => {
    const v = ver(proto().id, 1);
    const bad = BODY.replace('## Do not', '## Nope');
    expect(code(() => updateDraftBody(db, v.id, bad, NOW))).toBe('invalid');
    expect(getVersion(db, v.id)!.bodyMd).toBe(BODY);
    const good = `${BODY}\nmore`;
    expect(updateDraftBody(db, v.id, good, NOW).bodyMd).toBe(good);
  });

  it('updateDraftBody on a published version throws invalid_transition', () => {
    const v = ver(proto().id, 1, 'published');
    expect(code(() => updateDraftBody(db, v.id, BODY, NOW))).toBe('invalid_transition');
  });

  it('rejectVersion stores notes', () => {
    const v = ver(proto().id, 1, 'in_review');
    const out = rejectVersion(db, v.id, LATER, 'too vague');
    expect(out.status).toBe('rejected');
    expect(out.reviewNotes).toBe('too vague');
    expect(out.reviewedAt).toEqual(LATER);
  });
});

describe('renderMarkdown', () => {
  it('strips script tags and keeps headings', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n## Steps');
    expect(html).not.toContain('<script');
    expect(html).toContain('<h2');
  });
});

describe('review routes', () => {
  const makeApp = async () =>
    createApp({
      db,
      env: loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: await hashPassword('correct horse') }),
      now: () => NOW,
    });
  const post = (cookie: string, body: Record<string, string>) => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(body).toString(),
  });
  const seed = (status: ProtocolStatus = 'draft') => {
    const p = proto();
    const v = ver(p.id, 1, status);
    insertSources(db, [
      { protocolVersionId: v.id, url: RC, title: 'Choking first aid', fetchedAt: NOW, contentHash: 'a'.repeat(64) },
      { protocolVersionId: v.id, url: NHS, title: 'NHS', fetchedAt: NOW, contentHash: 'b'.repeat(64) },
    ]);
    return { p, v, base: `/admin/protocols/${p.id}/versions/${v.id}` };
  };

  it('review page shows rendered draft and sources side by side', async () => {
    const app = await makeApp();
    const cookie = await adminLogin(app, 'correct horse');
    const { base } = seed();
    const res = await app.request(base, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Steps</h2>');
    expect(html).toContain(RC);
    expect(html).toContain(NHS);
    expect(html).toContain('aaaaaaaaaaaa');
    expect(html).toContain('<textarea');
    expect(html).toContain('name="body_md"');
  });

  it('publish route publishes and redirects', async () => {
    const app = await makeApp();
    const cookie = await adminLogin(app, 'correct horse');
    const { v, base } = seed();
    const res = await app.request(`${base}/publish`, post(cookie, { notes: 'ok' }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(base);
    expect(getVersion(db, v.id)!.status).toBe('published');
  });

  it('publish route on a rejected version is 409', async () => {
    const app = await makeApp();
    const cookie = await adminLogin(app, 'correct horse');
    const { base } = seed('rejected');
    expect((await app.request(`${base}/publish`, post(cookie, {}))).status).toBe(409);
  });

  it('reject route requires notes', async () => {
    const app = await makeApp();
    const cookie = await adminLogin(app, 'correct horse');
    const { v, base } = seed();
    expect((await app.request(`${base}/reject`, post(cookie, { notes: ' ' }))).status).toBe(400);
    expect(getVersion(db, v.id)!.status).toBe('draft');
    const ok = await app.request(`${base}/reject`, post(cookie, { notes: 'no' }));
    expect(ok.status).toBe(302);
    expect(getVersion(db, v.id)!.status).toBe('rejected');
  });

  it('submit route moves draft to in_review', async () => {
    const app = await makeApp();
    const cookie = await adminLogin(app, 'correct horse');
    const { v, base } = seed();
    expect((await app.request(`${base}/submit`, post(cookie, {}))).status).toBe(302);
    expect(getVersion(db, v.id)!.status).toBe('in_review');
  });

  it('edit route saves a valid body and rejects an invalid one', async () => {
    const app = await makeApp();
    const cookie = await adminLogin(app, 'correct horse');
    const { v, base } = seed();
    const good = `${BODY}\nextra line`;
    const res = await app.request(`${base}/body`, post(cookie, { body_md: good }));
    expect(res.status).toBe(302);
    expect(getVersion(db, v.id)!.bodyMd).toBe(good);
    const bad = await app.request(`${base}/body`, post(cookie, { body_md: 'nothing' }));
    expect(bad.status).toBe(400);
    expect(getVersion(db, v.id)!.bodyMd).toBe(good);
  });

  it('version of another protocol is 404', async () => {
    const app = await makeApp();
    const cookie = await adminLogin(app, 'correct horse');
    const { v } = seed();
    const other = proto('other');
    const res = await app.request(`/admin/protocols/${other.id}/versions/${v.id}`, { headers: { cookie } });
    expect(res.status).toBe(404);
    const pub = await app.request(`/admin/protocols/${other.id}/versions/${v.id}/publish`, post(cookie, {}));
    expect(pub.status).toBe(404);
    expect(getVersion(db, v.id)!.status).toBe('draft');
  });
});
