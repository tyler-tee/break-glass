import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword } from '../../src/features/admin/auth.js';
import { createProtocol, getVersion, insertVersion } from '../../src/features/protocols/repo.js';
import { SOP_HEADINGS } from '../../src/services/llm/draft.js';
import { adminLogin } from '../helpers/adminLogin.js';
import { createTestDb } from '../helpers/testDb.js';

const form = (body: string, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body,
});

describe('request body limits', () => {
  it('an oversized POST /setup is a 413, not a 500', async () => {
    const app = createApp({ db: createTestDb(), env: loadEnv({}) }); // unclaimed
    const res = await app.request('/setup', form(`code=${'A'.repeat(20 * 1024)}`));
    expect(res.status).toBe(413);
  });

  it('an oversized POST /admin/login is a 413, not a 500', async () => {
    const app = createApp({
      db: createTestDb(),
      env: loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: await hashPassword('correct horse') }),
    });
    const res = await app.request('/admin/login', form(`password=${'x'.repeat(20 * 1024)}`));
    expect(res.status).toBe(413);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('an oversized POST without a content-length header is still a 413', async () => {
    const app = createApp({ db: createTestDb(), env: loadEnv({}) });
    const big = new TextEncoder().encode(`code=${'A'.repeat(20 * 1024)}`);
    const body = new ReadableStream({
      start(c) {
        c.enqueue(big);
        c.close();
      },
    });
    const res = await app.request('/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
  });

  it('a large but legitimate protocol body save still works, and a huge one is a 413', async () => {
    const db = createTestDb();
    const app = createApp({
      db,
      env: loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: await hashPassword('correct horse') }),
    });
    const cookie = await adminLogin(app, 'correct horse');
    const p = createProtocol(db, { slug: 'burns', title: 'Burns', tags: [] });
    const v = insertVersion(db, {
      protocolId: p.id,
      version: 1,
      status: 'draft',
      bodyMd: SOP_HEADINGS.map((h) => `${h}\ntext`).join('\n\n'),
      createdAt: new Date(),
    });
    const base = `/admin/protocols/${p.id}/versions/${v.id}`;
    // About 60 KB of real text: well above the login/setup limit, well below the general one.
    const long = SOP_HEADINGS.map((h) => `${h}\n${'Keep the person calm and still. '.repeat(470)}`).join('\n\n');
    expect(long.length).toBeGreaterThan(55 * 1024);
    const ok = await app.request(`${base}/body`, form(new URLSearchParams({ body_md: long }).toString(), { cookie }));
    expect(ok.status).toBe(302);
    expect(getVersion(db, v.id)!.bodyMd).toBe(long);

    const huge = await app.request(`${base}/body`, form(`body_md=${'x'.repeat(300 * 1024)}`, { cookie }));
    expect(huge.status).toBe(413);
    expect(getVersion(db, v.id)!.bodyMd).toBe(long);
  });
});
