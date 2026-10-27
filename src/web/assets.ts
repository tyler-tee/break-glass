import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';

// Works from src/web (tsx) and dist/web (build): two levels up is the repo root.
const publicDir = fileURLToPath(new URL('../../public', import.meta.url));

// Explicit allowlist: request name -> file under public/ and content type. No directory serving.
const ALLOWED: Record<string, { file: string; type: string }> = {
  'styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  'admin.js': { file: 'admin.js', type: 'text/javascript; charset=utf-8' },
  'favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' },
  'icon.svg': { file: 'icon.svg', type: 'image/svg+xml' },
  'manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json' },
  'atkinson-hyperlegible-next.woff2': { file: 'fonts/atkinson-hyperlegible-next.woff2', type: 'font/woff2' },
};

type Loaded = { body: Buffer; type: string; hash: string };
const loaded = new Map<string, Loaded>();
for (const [name, { file, type }] of Object.entries(ALLOWED)) {
  const body = readFileSync(`${publicDir}/${file}`);
  loaded.set(name, { body, type, hash: createHash('sha256').update(body).digest('hex').slice(0, 8) });
}

export function assetUrl(name: string): string {
  const a = loaded.get(name);
  if (!a) throw new Error(`unknown asset: ${name}`);
  return `/assets/${name}?v=${a.hash}`;
}

export function registerAssets(app: Hono): void {
  app.get('/assets/:file', (c) => {
    const name = c.req.param('file');
    const a = Object.hasOwn(ALLOWED, name) ? loaded.get(name) : undefined;
    if (!a) return c.notFound();
    // Only a request pinned to the current content hash may be cached forever.
    const pinned = c.req.query('v') === a.hash;
    return c.body(new Uint8Array(a.body), 200, {
      'Content-Type': a.type,
      'Cache-Control': pinned ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    });
  });
}
