import { expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';

it('rejects missing SESSION_SECRET', () =>
  expect(() => loadEnv({ ADMIN_PASSWORD_HASH: 'x' })).toThrow(/SESSION_SECRET/));

it('applies defaults', () => {
  const e = loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: 'x' });
  expect(e.PORT).toBe(3000);
  expect(e.PLACES_CALL_CAP).toBe(200);
  expect(e.LLM_EXTRACT_MODEL).toBe('claude-haiku-5-5');
  expect(e.LLM_DRAFT_MODEL).toBe('claude-opus-5-5');
});
