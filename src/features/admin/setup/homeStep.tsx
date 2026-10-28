import type { Hono, Context } from 'hono';
import type { Child } from 'hono/jsx';
import cron from 'node-cron';
import { describePlacesError } from '../../../services/keyProbe.js';
import { BudgetExhausted, newPlacesBudget } from '../../../services/places/budget.js';
import { PlacesError, geocode } from '../../../services/places/client.js';
import { placesOf } from '../../../services/resolver.js';
import { SettingsValidationError, getSettings, updateSettings, type SettingsPatch } from '../settingsRepo.js';
import { describeCron } from './cronWords.js';
import { StepShell, type Notice } from './StepShell.js';
import { Field, destination, firstError, goOf, one, many, str, type Errors, type SetupContext, type Status } from './shared.js';

const TIME_ZONES: readonly string[] = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
})();

const validTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** Step 3: home location, search area and schedules. */
export function registerHomeStep(app: Hono, ctx: SetupContext): void {
  const { deps, db, render, doneSteps } = ctx;
  const { env } = deps;
  // ---- Step 3: Home -------------------------------------------------------------------------------

  type HomeValues = { lat: string; lng: string; radius: string; tz: string; locCron: string; protoCron: string };
  const HOME_ORDER = ['home_lat', 'home_lng', 'default_radius_mi', 'home_tz', 'location_refresh_cron', 'protocol_refresh_cron'];

  const currentHome = (): HomeValues => {
    const s = getSettings(db);
    const serverTz = process.env['TZ'];
    // Before home is set, a valid server TZ is a better guess than the column default.
    const tz = s.homeLat === null && serverTz && validTimeZone(serverTz) ? serverTz : s.homeTz;
    return {
      lat: s.homeLat === null ? '' : String(s.homeLat),
      lng: s.homeLng === null ? '' : String(s.homeLng),
      radius: s.defaultRadiusMi === null ? '' : String(s.defaultRadiusMi),
      tz,
      locCron: s.locationRefreshCron ?? '',
      protoCron: s.protocolRefreshCron ?? '',
    };
  };

  const homePage = (
    c: Context,
    values: HomeValues,
    opts: { errors?: Errors; lookupError?: Child; address?: string; notice?: Notice; status?: Status } = {},
  ) => {
    const errors = opts.errors ?? {};
    const hasPlaces = placesOf(deps) !== undefined;
    const focus = firstError(errors, HOME_ORDER);
    const coordsInvalid = Boolean(errors['home_lat'] || errors['home_lng']);
    const cronInvalid = Boolean(errors['location_refresh_cron'] || errors['protocol_refresh_cron']);
    const saved = getSettings(db);
    const num = (name: string, label: string, value: string, hint?: Child) => (
      <Field id={name} label={label} hint={hint} error={errors[name]} control={(describedBy, invalid) => (
          <input
            id={name}
            name={name}
            value={value}
            inputmode="decimal"
            autocomplete="off"
            aria-describedby={describedBy}
            aria-invalid={invalid ? 'true' : undefined}
            autofocus={focus === name}
          />
        )} />
    );
    const howTo = (
      <>
        To find them, long-press your home in Google Maps or Apple Maps and copy the two numbers it shows (latitude
        first, for example 40.7608, -111.891).
      </>
    );
    const coords = (
      <>
        {num('home_lat', 'Latitude', values.lat, howTo)}
        {num('home_lng', 'Longitude', values.lng)}
      </>
    );
    const cronField = (name: string, label: string, value: string, sentence: string) => (
      <>
        <p>{sentence}</p>
        <Field id={name} label={label} hint="Five cron fields: minute, hour, day of month, month, day of week." error={errors[name]} control={(describedBy, invalid) => (
            <input
              id={name}
              name={name}
              value={value}
              autocomplete="off"
              spellcheck={false}
              aria-describedby={describedBy}
              aria-invalid={invalid ? 'true' : undefined}
              autofocus={focus === name}
            />
          )} />
      </>
    );
    return render(
      c,
      'home',
      <StepShell
        step="home"
        heading="Home"
        doneSteps={doneSteps()}
        notice={opts.notice}
        intro={<p>Your home location is used to find places nearby and show how far away each one is.</p>}
        before={
          hasPlaces && (
            <form method="post" action="/admin/setup/home/lookup" class="admin-form">
              <fieldset>
                <legend>Look up your address</legend>
                <div class="field">
                  <label for="address">Home address</label>
                  <input
                    id="address"
                    name="address"
                    value={opts.address ?? ''}
                    autocomplete="street-address"
                    aria-describedby={opts.lookupError ? 'address-error' : undefined}
                    aria-invalid={opts.lookupError ? 'true' : undefined}
                    autofocus={Boolean(opts.lookupError)}
                  />
                  {opts.lookupError && (
                    <p class="field-error" id="address-error" role="alert">
                      {opts.lookupError}
                    </p>
                  )}
                </div>
                <button type="submit" class="btn-secondary">
                  Look up
                </button>
              </fieldset>
            </form>
          )
        }
      >
        {!hasPlaces && opts.lookupError && (
          <p class="notice notice-alert" role="alert">
            {opts.lookupError}
          </p>
        )}
        <fieldset>
          <legend>Coordinates</legend>
          {hasPlaces ? (
            <details open={coordsInvalid}>
              <summary>Enter coordinates by hand</summary>
              {coords}
            </details>
          ) : (
            <>
              <p class="muted">
                Add a Google Places key in <a href="/admin/setup/services">Services</a> to look up an address instead.
              </p>
              {coords}
            </>
          )}
        </fieldset>
        <fieldset>
          <legend>Search area</legend>
          {num('default_radius_mi', 'Search radius (miles)', values.radius, 'How far from home to look for places.')}
          <Field id="home_tz" label="Time zone" hint="Used for opening hours. Start typing a city, like Denver." error={errors['home_tz']} control={(describedBy, invalid) => (
              <input
                id="home_tz"
                name="home_tz"
                value={values.tz}
                list="tz-list"
                autocomplete="off"
                aria-describedby={describedBy}
                aria-invalid={invalid ? 'true' : undefined}
                autofocus={focus === 'home_tz'}
              />
            )} />
          <datalist id="tz-list">
            {TIME_ZONES.map((tz) => (
              <option value={tz}></option>
            ))}
          </datalist>
        </fieldset>
        <details open={cronInvalid}>
          <summary>Advanced</summary>
          {cronField(
            'location_refresh_cron',
            'Place re-check schedule',
            values.locCron,
            `Re-check places ${saved.locationRefreshCron ? describeCron(saved.locationRefreshCron) : 'never (no schedule set)'}.`,
          )}
          {cronField(
            'protocol_refresh_cron',
            'Protocol re-check schedule',
            values.protoCron,
            `Re-check protocol sources ${saved.protocolRefreshCron ? describeCron(saved.protocolRefreshCron) : 'never (no schedule set)'}.`,
          )}
        </details>
      </StepShell>,
      opts.status ?? 200,
    );
  };

  app.get('/home', (c) => {
    const notice: Notice | undefined =
      c.req.query('found') === '1'
        ? {
            kind: 'status',
            text: `Found it. Home is set to ${getSettings(db).homeLabel ?? 'that address'}. Check the details below, then choose Save and continue.`,
          }
        : undefined;
    return homePage(c, currentHome(), { notice });
  });

  app.post('/home', async (c) => {
    const body = await c.req.parseBody();
    const go = goOf(body['go']);
    if (go === 'skip' || go === 'back') return c.redirect(destination('home', go), 302);

    const current = currentHome();
    // An absent field keeps its current value; a present one is validated.
    const field = (name: string, fallback: string) => (name in body ? str(body[name]).trim() : fallback);
    const values: HomeValues = {
      lat: field('home_lat', current.lat),
      lng: field('home_lng', current.lng),
      radius: field('default_radius_mi', current.radius),
      tz: field('home_tz', current.tz),
      locCron: field('location_refresh_cron', current.locCron),
      protoCron: field('protocol_refresh_cron', current.protoCron),
    };
    const errors: Errors = {};
    const patch: SettingsPatch = {};

    const lat = values.lat === '' ? null : Number(values.lat);
    const lng = values.lng === '' ? null : Number(values.lng);
    if (lat !== null && !(Number.isFinite(lat) && lat >= -90 && lat <= 90)) {
      errors['home_lat'] = 'Latitude must be a number between -90 and 90, like 40.7608.';
    }
    if (lng !== null && !(Number.isFinite(lng) && lng >= -180 && lng <= 180)) {
      errors['home_lng'] = 'Longitude must be a number between -180 and 180, like -111.891.';
    }
    if (!errors['home_lat'] && !errors['home_lng'] && (lat === null) !== (lng === null)) {
      errors[lat === null ? 'home_lat' : 'home_lng'] = 'Enter both latitude and longitude, or leave both empty.';
    }
    patch.homeLat = lat;
    patch.homeLng = lng;
    // Coordinates typed by hand no longer match a label saved by an earlier address lookup.
    const savedHome = getSettings(db);
    if (lat !== savedHome.homeLat || lng !== savedHome.homeLng) patch.homeLabel = null;

    if (values.radius !== '') {
      const r = Number(values.radius);
      if (!(Number.isFinite(r) && r > 0 && r <= 500)) {
        errors['default_radius_mi'] = 'Search radius must be a number of miles above 0 and up to 500, like 15.';
      } else patch.defaultRadiusMi = r;
    }
    if (values.tz !== '') {
      if (!validTimeZone(values.tz)) errors['home_tz'] = 'Pick a time zone from the list, like America/Denver.';
      else patch.homeTz = values.tz;
    }
    const cronError = "That schedule isn't valid. Use five cron fields, like 0 3 * * 0.";
    if (values.locCron !== '') {
      if (!cron.validate(values.locCron)) errors['location_refresh_cron'] = cronError;
      else patch.locationRefreshCron = values.locCron;
    }
    if (values.protoCron !== '') {
      if (!cron.validate(values.protoCron)) errors['protocol_refresh_cron'] = cronError;
      else patch.protocolRefreshCron = values.protoCron;
    }

    if (Object.keys(errors).length === 0) {
      try {
        updateSettings(db, patch);
      } catch (e) {
        if (!(e instanceof SettingsValidationError)) throw e;
        errors[e.field] = 'Please check this value.';
      }
    }
    if (Object.keys(errors).length > 0) return homePage(c, values, { errors, status: 400 });
    deps.scheduler?.reschedule();
    return c.redirect(destination('home', go), 302);
  });

  app.post('/home/lookup', async (c) => {
    const body = await c.req.parseBody();
    const address = str(body['address']).trim();
    const places = placesOf(deps);
    const fail = (lookupError: Child, status: Status) => homePage(c, currentHome(), { lookupError, address, status });
    if (!places) {
      return fail(
        <>
          Add a Google Places key in <a href="/admin/setup/services">Setup → Services</a> to look up an address, or enter
          the coordinates by hand below.
        </>,
        400,
      );
    }
    if (address === '') return fail('Enter your home address, like 123 Main St, Springfield.', 400);
    let hit: Awaited<ReturnType<typeof geocode>>;
    try {
      hit = await geocode(address, { ...places, budget: newPlacesBudget(db, env, deps.now) });
    } catch (e) {
      if (e instanceof BudgetExhausted) return fail(describePlacesError(e, places.apiKey), 429);
      if (e instanceof PlacesError) return fail(describePlacesError(e, places.apiKey), 502);
      throw e;
    }
    if (!hit) return fail("We couldn't find that address. Try adding the city and state, or enter the coordinates by hand.", 400);
    updateSettings(db, { homeLabel: address.slice(0, 200), homeLat: hit.lat, homeLng: hit.lng });
    return c.redirect('/admin/setup/home?found=1', 302);
  });
}
