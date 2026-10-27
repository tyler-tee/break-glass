import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Logger } from '../../domain/types.js';

export type ConsumeResult = 'ok' | 'wrong' | 'locked';

export type SetupCodeManager = {
  /** The active code (XXXX-XXXX), or null when none has been issued. Read-only. */
  current(): string | null;
  /** Returns the active code, generating and printing one when none exists. Idempotent. */
  ensure(): string;
  /** Checks a submitted code. 'ok' clears the code (one-time) and the failure counters. */
  consume(submitted: string): ConsumeResult;
  /** Discards the code and the limiter state. The next ensure() issues and prints a fresh code. */
  reset(): void;
};

// Crockford base32: 0-9 A-Z without I L O U.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_CHARS = 8; // 8 x 5 bits = 40 bits = randomBytes(5)
const MAX_INPUT = 64;

export const SETUP_MAX_FAILURES = 5;
export const SETUP_WINDOW_MS = 60 * 1000;
export const SETUP_LOCKOUT_MS = 15 * 60 * 1000;

function generate(): string {
  // 5 bytes fit exactly in a JS safe integer; use arithmetic, not 32-bit bitwise ops.
  let n = randomBytes(5).readUIntBE(0, 5);
  let out = '';
  for (let i = 0; i < CODE_CHARS; i++) {
    out = ALPHABET[n % 32]! + out;
    n = Math.floor(n / 32);
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Uppercase, drop dashes and whitespace, and map Crockford's look-alikes (O->0, I/L->1). */
function normalise(s: string): string {
  return s.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

function banner(code: string): string {
  const rule = '='.repeat(60);
  return [
    '',
    rule,
    '  BREAK GLASS SETUP',
    '  This install has no admin password yet. To claim it, open',
    '  /setup on this server in a browser and enter this one-time code:',
    '',
    `      ${code}`,
    '',
    '  The code works once. Restarting the server issues a new one.',
    rule,
    '',
  ].join('\n');
}

/**
 * One-time setup code plus a global in-memory brute-force limiter. Fixed 60s window: the 5th failure
 * inside a window starts a 15-minute lockout (so pacing attempts at the window edge cannot dodge it),
 * and every attempt while locked returns 'locked' without looking at the code. Lockout clears on time
 * or process restart; a successful claim clears all counters.
 */
export function createSetupCodeManager(opts: { now?: () => Date; log?: Logger } = {}): SetupCodeManager {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? console;
  let code: string | null = null;
  let windowStart = 0;
  let failures = 0;
  let lockedUntil = 0;

  const clearLimiter = () => {
    windowStart = 0;
    failures = 0;
    lockedUntil = 0;
  };

  return {
    current: () => code,

    ensure() {
      if (code === null) {
        code = generate();
        log.info(banner(code));
      }
      return code;
    },

    consume(submitted) {
      const t = now().getTime();
      if (lockedUntil !== 0) {
        if (t < lockedUntil) return 'locked';
        clearLimiter();
      }

      const expected = code;
      const given = typeof submitted === 'string' && submitted.length <= MAX_INPUT ? normalise(submitted) : '';
      // Compare fixed-length digests so the comparison itself takes the same time for any input.
      const match =
        timingSafeEqual(digest(given), digest(expected === null ? '' : normalise(expected))) &&
        expected !== null &&
        given.length === CODE_CHARS;

      if (match) {
        code = null;
        clearLimiter();
        return 'ok';
      }

      if (t - windowStart >= SETUP_WINDOW_MS) {
        windowStart = t;
        failures = 0;
      }
      failures++;
      if (failures >= SETUP_MAX_FAILURES) lockedUntil = t + SETUP_LOCKOUT_MS;
      return 'wrong';
    },

    reset() {
      code = null;
      clearLimiter();
    },
  };
}
