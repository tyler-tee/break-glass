import fs from 'node:fs';
import path from 'node:path';
import { fixtureKey } from './recordingFetch.js';

// Writes a fixture in the exact shape recordingFetch replays. Used where no live key exists to record from.
export function authorFixture(
  dir: string,
  req: { method: string; url: string; body?: string | null },
  res: { status: number; json: unknown },
): string {
  const method = req.method.toUpperCase();
  const key = fixtureKey(method, req.url, req.body ?? null);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${key}.json`);
  const fixture = {
    method,
    url: req.url,
    status: res.status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(res.json),
  };
  fs.writeFileSync(file, JSON.stringify(fixture, null, 2));
  return file;
}
