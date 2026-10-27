import { randomBytes, scrypt, timingSafeEqual, type BinaryLike, type ScryptOptions } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getSignedCookie, setSignedCookie } from 'hono/cookie';

export const SESSION_COOKIE = 'bg_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const KEYLEN = 64;
const PARAMS: ScryptOptions = { N: 16384, r: 8, p: 1 };

function derive(pw: string, salt: BinaryLike): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pw, salt, KEYLEN, PARAMS, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(pw, salt);
  return `scrypt:${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  try {
    // ':' is the current separator; '$' is legacy (earlier hashes keep working).
    const parts = stored.split(/[:$]/);
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const [, saltHex, keyHex] = parts as [string, string, string];
    if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(keyHex)) return false;
    const expected = Buffer.from(keyHex, 'hex');
    if (expected.length !== KEYLEN) return false;
    const actual = await derive(pw, Buffer.from(saltHex, 'hex'));
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export async function createSession(c: Context, secret: string, now: Date): Promise<void> {
  await setSignedCookie(c, SESSION_COOKIE, JSON.stringify({ exp: now.getTime() + SESSION_TTL_MS }), secret, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function readSession(c: Context, secret: string, now: Date): Promise<boolean> {
  const raw = await getSignedCookie(c, secret, SESSION_COOKIE);
  if (!raw) return false;
  try {
    const { exp } = JSON.parse(raw) as { exp?: unknown };
    return typeof exp === 'number' && exp > now.getTime();
  } catch {
    return false;
  }
}

export function requireAdmin(secret: string, now: () => Date): MiddlewareHandler {
  return async (c, next) => {
    if (!(await readSession(c, secret, now()))) {
      return c.redirect(`/admin/login?next=${encodeURIComponent(c.req.path)}`, 302);
    }
    await next();
  };
}

// Rejects browser POSTs whose Origin (or Referer) host differs from Host. Closes the same-site,
// different-port CSRF gap that SameSite=Lax leaves open. Clients that send neither header are allowed.
export const requireSameOrigin: MiddlewareHandler = async (c, next) => {
  if (c.req.method === 'POST') {
    const claimed = c.req.header('origin') ?? c.req.header('referer');
    if (claimed !== undefined) {
      let host: string | null;
      try {
        host = new URL(claimed).host;
      } catch {
        host = null;
      }
      const expected = c.req.header('host') ?? new URL(c.req.url).host;
      if (host === null || host.toLowerCase() !== expected.toLowerCase()) {
        return c.text('Forbidden: cross-origin request', 403);
      }
    }
  }
  await next();
};
