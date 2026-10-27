import { expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { createTestDb } from './helpers/testDb.js';

const env = loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: 'x' });

it('GET /health returns 200 {ok:true}', async () => {
  const app = createApp({ db: createTestDb(), env });
  const res = await app.request('/health');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

it('GET /health returns 503 {ok:false} when the database throws', async () => {
  const db = createTestDb();
  db.$client.close();
  const app = createApp({ db, env });
  const res = await app.request('/health');
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ ok: false });
});
