import { Hono } from 'hono';
import type { Child } from 'hono/jsx';
import type { ResolvedAppDeps } from '../../app.js';
import { BudgetExhausted, newPlacesBudget } from '../../services/places/budget.js';
import { PlacesError, geocode } from '../../services/places/client.js';
import { placesOf } from '../../services/resolver.js';
import { page } from '../../web/Layout.js';
import { budgetExhaustedPage, placesErrorPage } from '../../web/placesErrorPage.js';
import { createSession, hashPassword, sessionKey, verifyPassword } from './auth.js';
import { SettingsValidationError, getSettings, updateSettings, type Settings } from './settingsRepo.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const optNumber = (v: unknown): number | null => (str(v).trim() === '' ? null : Number(str(v)));

export function settingsRoutes(deps: ResolvedAppDeps): Hono {
  const { secrets } = deps;
  const now = deps.now ?? (() => new Date());
  const app = new Hono();

  type PwError = { field: 'current' | 'new' | 'confirm'; message: string };

  const envHash = secrets.isEnvProvided('adminHash');

  const formPage = (
    c: Parameters<typeof page>[0],
    s: Settings,
    opts: { saved?: boolean; error?: Child; pwError?: PwError; status?: 200 | 400 } = {},
  ) =>
    page(
      c,
      'Settings',
      <>
        <h1>Settings</h1>
        {opts.saved && <p role="status">Saved.</p>}
        {opts.error && <p role="alert">{opts.error}</p>}
        <form method="post" action="/admin/settings" class="admin-form">
          <fieldset>
            <legend>Home location</legend>
            <p class="muted">Used for distances on the family site. Use the address lookup below to fill these in.</p>
            <p>
              <label>
                Home label <input name="home_label" value={s.homeLabel ?? ''} />
              </label>
            </p>
            <p>
              <label>
                Latitude <input name="home_lat" value={s.homeLat ?? ''} />
              </label>
            </p>
            <p>
              <label>
                Longitude <input name="home_lng" value={s.homeLng ?? ''} />
              </label>
            </p>
            <p>
              <label>
                Default radius (miles) <input name="default_radius_mi" value={s.defaultRadiusMi ?? ''} />
              </label>
            </p>
            <p>
              <label>
                Time zone <input name="home_tz" value={s.homeTz} />
              </label>
            </p>
          </fieldset>
          <fieldset>
            <legend>Schedules</legend>
            <p class="muted">Cron expressions for the background refresh jobs.</p>
            <p>
              <label>
                Location refresh cron <input name="location_refresh_cron" value={s.locationRefreshCron ?? ''} />
              </label>
            </p>
            <p>
              <label>
                Protocol refresh cron <input name="protocol_refresh_cron" value={s.protocolRefreshCron ?? ''} />
              </label>
            </p>
          </fieldset>
          <button type="submit">Save</button>
        </form>
        <form method="post" action="/admin/settings/geocode" class="admin-form">
          <fieldset>
            <legend>Look up an address</legend>
            <p>
              <label>
                Address <input name="address" />
              </label>
            </p>
            <button type="submit" class="btn-secondary">Geocode address</button>
          </fieldset>
        </form>
        <form method="post" action="/admin/settings/password" class="admin-form">
          <fieldset disabled={envHash}>
            <legend>Change password</legend>
            {envHash ? (
              <p class="muted">
                Set by the server environment. To change it, edit ADMIN_PASSWORD_HASH in your server configuration and
                restart.
              </p>
            ) : (
              <p class="muted">Changing it signs out every other device.</p>
            )}
            <p>
              <label>
                Current password <input type="password" name="current" autocomplete="current-password" required />
              </label>
              {opts.pwError?.field === 'current' && <span role="alert">{opts.pwError.message}</span>}
            </p>
            <p>
              <label>
                New password (12 characters or more){' '}
                <input type="password" name="new" autocomplete="new-password" minlength={12} required />
              </label>
              {opts.pwError?.field === 'new' && <span role="alert">{opts.pwError.message}</span>}
            </p>
            <p>
              <label>
                Confirm new password <input type="password" name="confirm" autocomplete="new-password" required />
              </label>
              {opts.pwError?.field === 'confirm' && <span role="alert">{opts.pwError.message}</span>}
            </p>
            <button type="submit">Change password</button>
          </fieldset>
        </form>
      </>,
      opts.status ?? 200,
      { layout: 'admin', activeNav: 'settings' },
    );

  app.get('/', (c) => formPage(c, getSettings(deps.db), { saved: c.req.query('saved') === '1' }));

  app.post('/', async (c) => {
    const body = await c.req.parseBody();
    const patch = {
      homeLabel: str(body['home_label']),
      homeLat: optNumber(body['home_lat']),
      homeLng: optNumber(body['home_lng']),
      defaultRadiusMi: optNumber(body['default_radius_mi']),
      homeTz: str(body['home_tz']).trim(),
      locationRefreshCron: str(body['location_refresh_cron']).trim(),
      protocolRefreshCron: str(body['protocol_refresh_cron']).trim(),
    };
    try {
      updateSettings(deps.db, patch);
    } catch (e) {
      if (e instanceof SettingsValidationError) {
        // Re-render with the submitted values so the admin can correct them.
        return formPage(c, { ...getSettings(deps.db), ...patch }, { error: e.message, status: 400 });
      }
      throw e;
    }
    deps.scheduler?.reschedule();
    return c.redirect('/admin/settings?saved=1', 302);
  });

  app.post('/password', async (c) => {
    const settingsNow = getSettings(deps.db);
    if (secrets.isEnvProvided('adminHash')) {
      return formPage(c, settingsNow, {
        pwError: { field: 'current', message: 'The password is set by the server environment; edit ADMIN_PASSWORD_HASH to change it.' },
        status: 400,
      });
    }
    const body = await c.req.parseBody();
    const current = str(body['current']);
    const next = str(body['new']);
    const confirm = str(body['confirm']);
    const fail = (pwError: PwError) => formPage(c, settingsNow, { pwError, status: 400 });
    if (!(await verifyPassword(current, secrets.getAdminHash() ?? ''))) {
      return fail({ field: 'current', message: 'Current password is wrong' });
    }
    if (next.length < 12) return fail({ field: 'new', message: 'New password must be at least 12 characters' });
    if (next !== confirm) return fail({ field: 'confirm', message: 'Passwords do not match' });
    secrets.setAdminHash(await hashPassword(next));
    // The new hash alone changes the session signing key (sessionKey), so every other device is signed out even
    // with an env SESSION_SECRET; an app-managed secret is rotated as well.
    if (!secrets.isEnvProvided('sessionSecret')) secrets.rotateSessionSecret();
    await createSession(c, sessionKey(secrets), now());
    return c.redirect('/admin/settings?saved=1', 302);
  });

  app.post('/geocode', async (c) => {
    const body = await c.req.parseBody();
    const address = str(body['address']).trim();
    const places = placesOf(deps);
    if (!places) {
      return formPage(c, getSettings(deps.db), {
        error: (
          <>
            Add a Google Places key in Setup → Services to enable address lookup.{' '}
            <a href="/admin/setup/services">Add a key</a>
          </>
        ),
        status: 400,
      });
    }
    if (address === '') return formPage(c, getSettings(deps.db), { error: 'Address is required', status: 400 });
    let hit: Awaited<ReturnType<typeof geocode>>;
    try {
      hit = await geocode(address, { ...places, budget: newPlacesBudget(deps.db, deps.env, deps.now) });
    } catch (e) {
      if (e instanceof BudgetExhausted) return budgetExhaustedPage(c, e.reason);
      if (e instanceof PlacesError) return placesErrorPage(c, e);
      throw e;
    }
    if (!hit) return formPage(c, getSettings(deps.db), { error: 'Address not found', status: 400 });
    updateSettings(deps.db, { homeLabel: address, homeLat: hit.lat, homeLng: hit.lng });
    return c.redirect('/admin/settings?saved=1', 302);
  });

  return app;
}
