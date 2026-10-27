import { Hono } from 'hono';
import type { AppDeps } from '../../app.js';
import { AdminNav } from '../../web/components/AdminNav.js';
import { newPlacesBudget } from '../../services/places/budget.js';
import { PlacesError, geocode } from '../../services/places/client.js';
import { page } from '../../web/Layout.js';
import { placesErrorPage } from '../../web/placesErrorPage.js';
import { SettingsValidationError, getSettings, updateSettings, type Settings } from './settingsRepo.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const optNumber = (v: unknown): number | null => (str(v).trim() === '' ? null : Number(str(v)));

export function settingsRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  const formPage = (
    c: Parameters<typeof page>[0],
    s: Settings,
    opts: { saved?: boolean; error?: string; status?: 200 | 400 } = {},
  ) =>
    page(
      c,
      'Settings',
      <>
        <h1>Settings</h1>
        <AdminNav />
        {opts.saved && <p role="status">Saved.</p>}
        {opts.error && <p role="alert">{opts.error}</p>}
        <form method="post" action="/admin/settings">
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
          <button type="submit">Save</button>
        </form>
        <form method="post" action="/admin/settings/geocode">
          <p>
            <label>
              Address <input name="address" />
            </label>
          </p>
          <button type="submit">Geocode address</button>
        </form>
      </>,
      opts.status ?? 200,
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

  app.post('/geocode', async (c) => {
    const body = await c.req.parseBody();
    const address = str(body['address']).trim();
    if (!deps.places) {
      return formPage(c, getSettings(deps.db), { error: 'Set GOOGLE_PLACES_API_KEY to enable geocoding', status: 400 });
    }
    if (address === '') return formPage(c, getSettings(deps.db), { error: 'Address is required', status: 400 });
    let hit: Awaited<ReturnType<typeof geocode>>;
    try {
      hit = await geocode(address, { ...deps.places, budget: newPlacesBudget(deps.db, deps.env, deps.now) });
    } catch (e) {
      if (e instanceof PlacesError) return placesErrorPage(c, e);
      throw e;
    }
    if (!hit) return formPage(c, getSettings(deps.db), { error: 'Address not found', status: 400 });
    updateSettings(deps.db, { homeLabel: address, homeLat: hit.lat, homeLng: hit.lng });
    return c.redirect('/admin/settings?saved=1', 302);
  });

  return app;
}
