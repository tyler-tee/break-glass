import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixtureMissing, fixtureKey, recordingFetch } from './recordingFetch.js';

const URL_A = 'https://example.test/api/places?q=pharmacy';

const fakeReal: typeof fetch = async () =>
  new Response('{"ok":true}', {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });

describe('recordingFetch', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-fixtures-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('replay hit returns stored status, header and body', async () => {
    await recordingFetch(dir, 'record', fakeReal)(URL_A);

    const res = await recordingFetch(dir, 'replay', () => {
      throw new Error('network must not be used in replay');
    })(URL_A);

    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe('{"ok":true}');
  });

  it('replay miss throws FixtureMissing with the url', async () => {
    const replay = recordingFetch(dir, 'replay', fakeReal);
    const call = replay(URL_A);

    await expect(call).rejects.toThrow(FixtureMissing);
    await expect(call).rejects.toThrow(URL_A);
  });

  it('record mode writes the file and returns the same body', async () => {
    const res = await recordingFetch(dir, 'record', fakeReal)(URL_A, {
      method: 'POST',
      body: 'a',
    });

    expect(res.status).toBe(201);
    expect(await res.text()).toBe('{"ok":true}');

    const key = fixtureKey('POST', URL_A, 'a');
    const file = path.join(dir, `${key}.json`);
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      method: 'POST',
      url: URL_A,
      status: 201,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    });
    expect(fixtureKey('POST', URL_A, 'b')).not.toBe(key);
  });

  it('POST body participates in the key', async () => {
    const rec = recordingFetch(dir, 'record', fakeReal);
    await rec(URL_A, { method: 'POST', body: 'one' });
    await rec(URL_A, { method: 'POST', body: 'two' });

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(2);
  });
});
