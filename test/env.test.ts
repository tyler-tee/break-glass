import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { loadDotEnvFiles, loadEnv, parseDotEnv } from '../src/env.js';

it('rejects missing SESSION_SECRET', () =>
  expect(() => loadEnv({ ADMIN_PASSWORD_HASH: 'x' })).toThrow(/SESSION_SECRET/));

it('applies defaults', () => {
  const e = loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: 'x' });
  expect(e.PORT).toBe(3000);
  expect(e.PLACES_CALL_CAP).toBe(200);
  expect(e.LLM_EXTRACT_MODEL).toBe('claude-haiku-5-5');
  expect(e.LLM_DRAFT_MODEL).toBe('claude-opus-5-5');
});

it('parseDotEnv handles comments, blanks, export prefix, quotes and CRLF', () => {
  const text = '# c\r\n\r\nexport A=1\r\nB="two words"\r\nC=\'x\'\r\nD=raw # inline\r\n';
  expect(parseDotEnv(text)).toEqual({ A: '1', B: 'two words', C: 'x', D: 'raw' });
});

it('later files override earlier ones but existing env wins', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotenv-'));
  const a = path.join(dir, '.env');
  const b = path.join(dir, '.env.local');
  fs.writeFileSync(a, 'KEEP=file\nX=1\n');
  fs.writeFileSync(b, 'X=2\n');
  const target: NodeJS.ProcessEnv = { KEEP: 'shell' };
  loadDotEnvFiles([a, b], target);
  expect(target).toEqual({ KEEP: 'shell', X: '2' });
  fs.rmSync(dir, { recursive: true, force: true });
});

it('missing file is ignored', () => {
  const target: NodeJS.ProcessEnv = { A: '1' };
  loadDotEnvFiles([path.join(os.tmpdir(), 'definitely-missing-dotenv-file')], target);
  expect(target).toEqual({ A: '1' });
});

it('empty numeric values fall back to defaults', () => {
  const e = loadEnv({
    SESSION_SECRET: 's'.repeat(32),
    ADMIN_PASSWORD_HASH: 'x',
    PORT: '',
    PLACES_CALL_CAP: '',
    PLACES_MONTHLY_CAP: '',
    REFRESH_FAILURE_THRESHOLD: '',
    RATING_WARN_DELTA: '',
  });
  expect(e.PORT).toBe(3000);
  expect(e.PLACES_CALL_CAP).toBe(200);
  expect(e.PLACES_MONTHLY_CAP).toBe(800);
  expect(e.REFRESH_FAILURE_THRESHOLD).toBe(3);
  expect(e.RATING_WARN_DELTA).toBe(0.5);
});

it('zero threshold is rejected', () => {
  const base = { SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: 'x' };
  expect(() => loadEnv({ ...base, REFRESH_FAILURE_THRESHOLD: '0' })).toThrow(/REFRESH_FAILURE_THRESHOLD/);
  expect(() => loadEnv({ ...base, PLACES_CALL_CAP: '0' })).toThrow(/PLACES_CALL_CAP/);
  expect(() => loadEnv({ ...base, PORT: '1.5' })).toThrow(/PORT/);
  expect(() => loadEnv({ ...base, RATING_WARN_DELTA: '-1' })).toThrow(/RATING_WARN_DELTA/);
  expect(loadEnv({ ...base, RATING_WARN_DELTA: '0' }).RATING_WARN_DELTA).toBe(0);
});
