import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { assetUrl } from '../src/web/assets.js';
import { createTestDb } from './helpers/testDb.js';

const env = loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: 'x' });
const app = () => createApp({ db: createTestDb(), env });

describe('static assets', () => {
  it('serves styles.css with long-lived immutable cache header', async () => {
    const res = await app().request(assetUrl('styles.css'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toContain('max-age=31536000');
    expect(cc).toContain('immutable');
    expect(await res.text()).toContain('--primary');
  });

  it('unhashed or stale-hash requests get a short cache, not immutable', async () => {
    for (const url of ['/assets/styles.css', '/assets/styles.css?v=deadbeef']) {
      const res = await app().request(url);
      expect(res.status).toBe(200);
      const cc = res.headers.get('cache-control') ?? '';
      expect(cc).toContain('max-age=3600');
      expect(cc).not.toContain('immutable');
    }
  });

  it('serves the woff2 font', async () => {
    const res = await app().request('/assets/atkinson-hyperlegible-next.woff2');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('font/woff2');
  });

  it('serves the admin.js placeholder and svg/manifest files', async () => {
    const a = app();
    expect((await a.request('/assets/admin.js')).headers.get('content-type')).toContain('text/javascript');
    expect((await a.request('/assets/favicon.svg')).headers.get('content-type')).toContain('image/svg+xml');
    expect((await a.request('/assets/icon.svg')).status).toBe(200);
    expect((await a.request('/assets/manifest.webmanifest')).headers.get('content-type')).toContain('application/manifest+json');
  });

  it('unknown and traversal paths 404', async () => {
    const a = app();
    expect((await a.request('/assets/nope.css')).status).toBe(404);
    expect((await a.request('/assets/..%2f..%2fpackage.json')).status).toBe(404);
  });

  it('assetUrl appends an 8-hex content hash', () => {
    expect(assetUrl('styles.css')).toMatch(/^\/assets\/styles\.css\?v=[0-9a-f]{8}$/);
  });
});
