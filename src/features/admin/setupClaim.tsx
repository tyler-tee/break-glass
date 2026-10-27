import { Hono, type Context } from 'hono';
import type { ResolvedAppDeps } from '../../app.js';
import { page } from '../../web/Layout.js';
import { createSession, hashPassword, requireSameOrigin } from './auth.js';
import { installState } from './install.js';

export const MIN_PASSWORD_LENGTH = 12;

type FormErrors = { code?: string; password?: string; confirm?: string; form?: string };

const noStore = (c: Context) => c.header('Cache-Control', 'no-store');

/** The form never echoes submitted values back: not the code, not the passwords. */
function claimForm(c: Context, errors: FormErrors = {}, status: 200 | 400 | 401 | 429 = 200) {
  noStore(c);
  const describe = (id: 'code' | 'password' | 'confirm', hint?: string) =>
    [hint, errors[id] ? `${id}-error` : undefined].filter(Boolean).join(' ') || undefined;
  return page(
    c,
    'Set up Break Glass',
    <>
      <h1>Set up Break Glass</h1>
      <p>
        This install does not have an admin password yet. On the server, run <code>docker compose logs app</code> and
        look for the setup code, then choose the admin password below.
      </p>
      {errors.form && (
        <p class="field-error" role="alert">
          {errors.form}
        </p>
      )}
      <form method="post" action="/setup">
        <label for="code">Setup code</label>
        <input
          id="code"
          name="code"
          type="text"
          autocomplete="off"
          inputmode="text"
          spellcheck={false}
          autocapitalize="characters"
          placeholder="XXXX-XXXX"
          required
          aria-invalid={errors.code ? 'true' : undefined}
          aria-describedby={describe('code')}
        />
        {errors.code && (
          <p class="field-error" id="code-error" role="alert">
            {errors.code}
          </p>
        )}

        <label for="password">New admin password</label>
        <input
          id="password"
          name="password"
          type="password"
          autocomplete="new-password"
          minlength={MIN_PASSWORD_LENGTH}
          required
          aria-invalid={errors.password ? 'true' : undefined}
          aria-describedby={describe('password', 'password-hint')}
        />
        <p class="field-hint" id="password-hint">
          At least {MIN_PASSWORD_LENGTH} characters.
        </p>
        {errors.password && (
          <p class="field-error" id="password-error" role="alert">
            {errors.password}
          </p>
        )}

        <label for="confirm">Confirm password</label>
        <input
          id="confirm"
          name="confirm"
          type="password"
          autocomplete="new-password"
          minlength={MIN_PASSWORD_LENGTH}
          required
          aria-invalid={errors.confirm ? 'true' : undefined}
          aria-describedby={describe('confirm')}
        />
        {errors.confirm && (
          <p class="field-error" id="confirm-error" role="alert">
            {errors.confirm}
          </p>
        )}

        <button type="submit">Claim this install</button>
      </form>
    </>,
    status,
    { layout: 'auth' },
  );
}

/**
 * Public, unauthenticated claim of an unclaimed install. Only someone holding the one-time code printed
 * to the server logs can set the admin password. Order on POST: validate the passwords (no attempt
 * counted, code untouched), then consume the code (rate limited), then hash, then re-check that the
 * install is still unclaimed and store. Consuming before the async hash makes a racing second correct
 * submission fail, and the synchronous re-check + store closes the window against any other writer.
 */
export function setupClaimRoutes(deps: ResolvedAppDeps): Hono {
  const { secrets, setupCode } = deps;
  const now = deps.now ?? (() => new Date());
  const app = new Hono();

  app.get('/', (c) => {
    if (installState(deps) !== 'unclaimed') return c.notFound();
    setupCode.ensure();
    return claimForm(c);
  });

  app.post('/', requireSameOrigin, async (c) => {
    if (installState(deps) !== 'unclaimed') return c.notFound();
    setupCode.ensure(); // a code must exist (and be in the logs) before any attempt is checked
    const body = await c.req.parseBody();
    const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
    const code = str('code');
    const password = str('password');
    const confirm = str('confirm');

    const errors: FormErrors = {};
    if (password.length < MIN_PASSWORD_LENGTH) {
      errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    } else if (confirm !== password) {
      errors.confirm = 'The passwords do not match.';
    }
    if (errors.password || errors.confirm) return claimForm(c, errors, 400);

    const result = setupCode.consume(code);
    if (result === 'locked') {
      return claimForm(
        c,
        { form: 'Too many wrong codes. Wait 15 minutes and try again, or restart the server to get a new code.' },
        429,
      );
    }
    if (result === 'wrong') {
      return claimForm(c, { code: 'That code is not right. Check the server logs for the current code.' }, 401);
    }

    const hash = await hashPassword(password);
    // Re-check after the await: nothing between this check and the store yields, so it is atomic in-process.
    if (installState(deps) !== 'unclaimed') return c.notFound();
    secrets.setAdminHash(hash);
    setupCode.reset(); // drop any code another request issued while this one was hashing
    await createSession(c, secrets.getSessionSecret(), now());
    noStore(c);
    return c.redirect('/admin/setup', 302);
  });

  return app;
}
