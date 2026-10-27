import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type FixtureMode = 'record' | 'replay';

export class FixtureMissing extends Error {
  constructor(
    public key: string,
    public url: string,
  ) {
    super(`No recorded fixture ${key} for ${url}`);
    this.name = 'FixtureMissing';
  }
}

export function fixtureKey(method: string, url: string, body: string | null): string {
  return createHash('sha1')
    .update(`${method.toUpperCase()} ${url}\n${body ?? ''}`)
    .digest('hex');
}

interface Fixture {
  method: string;
  url: string;
  status: number;
  headers: { 'content-type': string | null };
  body: string;
}

function toResponse(f: Fixture): Response {
  const contentType = f.headers['content-type'];
  return new Response(f.body, {
    status: f.status,
    headers: contentType === null ? undefined : { 'content-type': contentType },
  });
}

export function resolveMode(raw: string | undefined): FixtureMode {
  if (raw === undefined || raw === '') return 'replay';
  if (raw === 'record' || raw === 'replay') return raw;
  throw new Error(`FIXTURE_MODE must be "record" or "replay", got "${raw}"`);
}

export function recordingFetch(
  dir: string,
  mode: FixtureMode = resolveMode(process.env.FIXTURE_MODE),
  real: typeof fetch = globalThis.fetch,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const url = input instanceof Request ? input.url : String(input);
    const body = typeof init?.body === 'string' ? init.body : null;
    const key = fixtureKey(method, url, body);
    const file = path.join(dir, `${key}.json`);

    if (mode === 'record') {
      const res = await real(input, init);
      const fixture: Fixture = {
        method,
        url,
        status: res.status,
        headers: { 'content-type': res.headers.get('content-type') },
        body: await res.text(),
      };
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(fixture, null, 2));
      return toResponse(fixture);
    }

    if (!fs.existsSync(file)) throw new FixtureMissing(key, url);
    return toResponse(JSON.parse(fs.readFileSync(file, 'utf8')) as Fixture);
  }) as typeof fetch;
}
