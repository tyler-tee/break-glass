import { Hono, type Context } from 'hono';
import type { Child, FC } from 'hono/jsx';
import cron from 'node-cron';
import type { ResolvedAppDeps } from '../../../app.js';
import { BudgetExhausted, newPlacesBudget } from '../../../services/places/budget.js';
import { PlacesError, geocode } from '../../../services/places/client.js';
import { describePlacesError, testAnthropicKey, testPlacesKey, type ProbeResult } from '../../../services/keyProbe.js';
import { placesOf } from '../../../services/resolver.js';
import { page } from '../../../web/Layout.js';
import type { SecretName } from '../secrets.js';
import { SettingsValidationError, getSettings, updateSettings, type SettingsPatch } from '../settingsRepo.js';
import { describeCron } from './cronWords.js';
import { StepShell, type Notice } from './StepShell.js';
import { STEPS, STEP_LABELS, nextStep, prevStep, resumeTarget, stepDone, stepPath, type Step } from './steps.js';

type Status = 200 | 400 | 429 | 502;
type Errors = Partial<Record<string, string>>;
type Go = 'next' | 'skip' | 'back' | 'later';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const goOf = (v: unknown): Go => (v === 'skip' || v === 'back' || v === 'later' ? v : 'next');

const DEFAULT_HOUSEHOLD = 'Our household';
const HOUSEHOLD_MAX = 60;
const EMERGENCY_MAX = 20;
const KEY_MAX = 400;
// Pasted keys sometimes pick up spaces or line breaks; those would also break HTTP headers.
const KEY_BAD_CHARS = /[\s\x00-\x1f\x7f]/;
const BAD_KEY_MESSAGE = "That doesn't look like a key — paste it again without spaces";

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

/** Where Save and continue / Skip for now / Back / Finish later lead from a step. */
function destination(step: Step, go: Go): string {
  if (go === 'later') return '/admin';
  const target = go === 'back' ? prevStep(step) : nextStep(step);
  return stepPath(target ?? step);
}

/** One labelled field with its hint and an error beside it; the first invalid field gets focus. */
const Field: FC<{
  id: string;
  label: string;
  hint?: Child;
  error?: string;
  control: (describedBy: string | undefined, invalid: boolean) => Child;
}> = ({ id, label, hint, error, control }) => {
  const ids = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ');
  return (
    <div class="field">
      <label for={id}>{label}</label>
      {hint && (
        <p class="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {control(ids || undefined, Boolean(error))}
      {error && (
        <p class="field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
};

/** Name of the first field with an error, in the order the fields appear on the page. */
const firstError = (errors: Errors, order: readonly string[]): string | undefined => order.find((f) => errors[f]);

type KeyName = 'places' | 'anthropic';
type KeyState = { kind: 'env' } | { kind: 'saved'; last4: string } | { kind: 'none' };

export function setupRoutes(deps: ResolvedAppDeps): Hono {
  const { db, env, secrets } = deps;
  const app = new Hono();

  const render = (c: Context, step: Step, body: Child, status: Status = 200) =>
    page(c, `Setup: ${STEP_LABELS[step]}`, body, status, { layout: 'admin', activeNav: 'setup' });

  const doneSteps = (): Step[] => STEPS.filter((s) => s !== 'services' && stepDone({ db }, s));

  app.get('/', (c) => c.redirect(resumeTarget({ db }), 302));

  // ---- Step 1: Welcome / household -------------------------------------------------------------

  const welcomePage = (c: Context, values: { name: string; number: string }, errors: Errors = {}, status: Status = 200) => {
    const focus = firstError(errors, ['household_name', 'emergency_number']);
    return render(
      c,
      'welcome',
      <StepShell
        step="welcome"
        heading="Welcome"
        doneSteps={doneSteps()}
        intro={
          <p>
            A few short steps get your family's emergency toolkit ready. You can skip any step and come back later.
          </p>
        }
      >
        <Field id="household_name" label="Household name" hint="Shown at the top of the family site." error={errors['household_name']} control={(describedBy, invalid) => (
            <input
              id="household_name"
              name="household_name"
              value={values.name}
              maxlength={HOUSEHOLD_MAX}
              autocomplete="off"
              aria-describedby={describedBy}
              aria-invalid={invalid ? 'true' : undefined}
              autofocus={focus === 'household_name'}
            />
          )} />
        <Field
          id="emergency_number"
          label="Emergency number"
          hint="The big red button on the family site calls this number. In the US it's 911."
          error={errors['emergency_number']}
         control={(describedBy, invalid) => (
            <input
              id="emergency_number"
              name="emergency_number"
              type="tel"
              value={values.number}
              maxlength={EMERGENCY_MAX}
              autocomplete="off"
              aria-describedby={describedBy}
              aria-invalid={invalid ? 'true' : undefined}
              autofocus={focus === 'emergency_number'}
            />
          )} />
      </StepShell>,
      status,
    );
  };

  app.get('/welcome', (c) => {
    const s = getSettings(db);
    return welcomePage(c, { name: s.householdName ?? DEFAULT_HOUSEHOLD, number: s.emergencyNumber });
  });

  app.post('/welcome', async (c) => {
    const body = await c.req.parseBody();
    const go = goOf(body['go']);
    if (go === 'skip' || go === 'back') return c.redirect(destination('welcome', go), 302);
    const name = str(body['household_name']).trim() || DEFAULT_HOUSEHOLD;
    const number = str(body['emergency_number']).trim();
    const errors: Errors = {};
    if (name.length > HOUSEHOLD_MAX) errors['household_name'] = `Keep the name to ${HOUSEHOLD_MAX} characters or fewer.`;
    if (number === '') errors['emergency_number'] = 'Enter the number to call in an emergency (911 in the US).';
    else if (!/\d/.test(number)) errors['emergency_number'] = 'The emergency number needs at least one digit, like 911.';
    else if (!/^[0-9+\-() ]+$/.test(number)) errors['emergency_number'] = 'Use only digits, spaces, and + - ( ).';
    else if (number.length > EMERGENCY_MAX) errors['emergency_number'] = `Keep the number to ${EMERGENCY_MAX} characters or fewer.`;
    if (Object.keys(errors).length > 0) return welcomePage(c, { name, number }, errors, 400);
    updateSettings(db, { householdName: name, emergencyNumber: number });
    return c.redirect(destination('welcome', go), 302);
  });

  // ---- Step 2: Services (optional API keys) -----------------------------------------------------

  const KEYS: Record<
    KeyName,
    {
      secret: SecretName;
      field: string;
      legend: string;
      get: () => string | undefined;
      set: (v: string) => void;
      remove: () => void;
      what: string;
      cost: string;
      where: { href: string; text: string };
    }
  > = {
    places: {
      secret: 'placesKey',
      field: 'places_key',
      legend: 'Google Places key',
      get: () => secrets.getPlacesKey(),
      set: (v) => secrets.setPlacesKey(v),
      remove: () => secrets.removePlacesKey(),
      what: 'Finds nearby clinics, pharmacies and ERs for you, looks up your home address, and re-checks their hours every week.',
      cost: `Cost: usually covered by Google's monthly free allowance for one household; this app stops itself at ${env.PLACES_MONTHLY_CAP} calls a month.`,
      where: {
        href: 'https://developers.google.com/maps/documentation/places/web-service/get-api-key',
        text: 'Get a key from the Google Cloud console (turn on "Places API (New)")',
      },
    },
    anthropic: {
      secret: 'anthropicKey',
      field: 'anthropic_key',
      legend: 'Anthropic key',
      get: () => secrets.getAnthropicKey(),
      set: (v) => secrets.setAnthropicKey(v),
      remove: () => secrets.removeAnthropicKey(),
      what: 'Reads clinic websites for after-hours details and drafts step-by-step protocols from trusted medical sources.',
      cost: 'Cost: pay as you go, usually a few cents per clinic or draft.',
      where: { href: 'https://console.anthropic.com/settings/keys', text: 'Get a key from the Anthropic console' },
    },
  };
  const KEY_NAMES = Object.keys(KEYS) as KeyName[];
  const isKeyName = (v: string): v is KeyName => v === 'places' || v === 'anthropic';

  const keyState = (k: KeyName): KeyState => {
    if (secrets.isEnvProvided(KEYS[k].secret)) return { kind: 'env' };
    const v = KEYS[k].get();
    return v ? { kind: 'saved', last4: v.slice(-4) } : { kind: 'none' };
  };

  const servicesPage = (
    c: Context,
    opts: { errors?: Errors; probe?: { key: KeyName; result: ProbeResult }; notice?: Notice; status?: Status } = {},
  ) => {
    const errors = opts.errors ?? {};
    const focus = firstError(errors, KEY_NAMES.map((k) => KEYS[k].field));
    return render(
      c,
      'services',
      <StepShell
        step="services"
        heading="Optional services"
        doneSteps={doneSteps()}
        notice={opts.notice}
        intro={
          <p>
            Both keys are optional. Without them you can still add places and write protocols by hand. Keys are stored on
            this server and are never shown again after you save them.
          </p>
        }
        after={<form id="svc-aux" method="post" action="/admin/setup/services"></form>}
      >
        {KEY_NAMES.map((k) => {
          const def = KEYS[k];
          const state = keyState(k);
          const probe = opts.probe?.key === k ? opts.probe.result : undefined;
          return (
            <fieldset>
              <legend>{def.legend}</legend>
              <p>{def.what}</p>
              <p class="muted">{def.cost}</p>
              <p>
                <a href={def.where.href} rel="noopener noreferrer">
                  {def.where.text}
                </a>
              </p>
              <p class="key-status">
                <strong>
                  {state.kind === 'env'
                    ? 'Set by the server environment'
                    : state.kind === 'saved'
                      ? `Saved (ends in …${state.last4})`
                      : 'Not set'}
                </strong>
              </p>
              {state.kind !== 'env' && (
                <Field
                  id={def.field}
                  label={state.kind === 'saved' ? 'Replace with a new key' : 'Paste your key'}
                  hint={state.kind === 'saved' ? 'Leave blank to keep the saved key.' : undefined}
                  error={errors[def.field]}
                 control={(describedBy, invalid) => (
                    <input
                      type="password"
                      id={def.field}
                      name={def.field}
                      autocomplete="off"
                      spellcheck={false}
                      autocapitalize="off"
                      aria-describedby={describedBy}
                      aria-invalid={invalid ? 'true' : undefined}
                      autofocus={focus === def.field}
                    />
                  )} />
              )}
              {state.kind === 'saved' && (
                <div class="button-row">
                  <button type="submit" form="svc-aux" name="test" value={k} class="btn-secondary">
                    Test saved key
                  </button>
                  <button type="submit" form="svc-aux" name="remove" value={k} class="btn-danger">
                    Remove key
                  </button>
                </div>
              )}
              {probe &&
                (probe.ok ? (
                  <p class="notice notice-status" role="status">
                    The saved key works.
                  </p>
                ) : (
                  <p class="notice notice-alert" role="alert">
                    {probe.message}
                  </p>
                ))}
            </fieldset>
          );
        })}
      </StepShell>,
      opts.status ?? 200,
    );
  };

  app.get('/services', (c) => {
    const removed = c.req.query('removed') ?? '';
    const notice: Notice | undefined = isKeyName(removed)
      ? { kind: 'status', text: `${KEYS[removed].legend} removed.` }
      : undefined;
    return servicesPage(c, { notice });
  });

  const probe = async (k: KeyName): Promise<ProbeResult> => {
    // Always the key as saved/effective (env or DB), never a value typed into the form.
    const key = KEYS[k].get();
    if (!key) return { ok: false, message: 'There is no saved key to test yet. Paste one and save it first.' };
    if (k === 'places') return testPlacesKey(key, { fetch: placesOf(deps)?.fetch ?? globalThis.fetch });
    return testAnthropicKey(key, env, deps.llm ? { provider: deps.llm } : {});
  };

  app.post('/services', async (c) => {
    const body = await c.req.parseBody();

    const remove = str(body['remove']);
    if (remove !== '') {
      // set*/remove* throw for env-provided keys; those have no Remove button and are never touched.
      if (!isKeyName(remove) || secrets.isEnvProvided(KEYS[remove].secret)) return c.redirect('/admin/setup/services', 302);
      KEYS[remove].remove();
      return c.redirect(`/admin/setup/services?removed=${remove}`, 302);
    }

    const test = str(body['test']);
    if (test !== '') {
      if (!isKeyName(test)) return c.redirect('/admin/setup/services', 302);
      return servicesPage(c, { probe: { key: test, result: await probe(test) } });
    }

    const go = goOf(body['go']);
    if (go === 'skip' || go === 'back') return c.redirect(destination('services', go), 302);

    const errors: Errors = {};
    const toSave: { k: KeyName; value: string }[] = [];
    for (const k of KEY_NAMES) {
      const def = KEYS[k];
      if (secrets.isEnvProvided(def.secret)) continue;
      const value = str(body[def.field]).trim();
      if (value === '') continue; // blank keeps the saved key
      if (KEY_BAD_CHARS.test(value) || value.length > KEY_MAX) errors[def.field] = BAD_KEY_MESSAGE;
      else toSave.push({ k, value });
    }
    // Never echo a submitted key: the inputs carry no value attribute, and nothing is saved if any field is bad.
    if (Object.keys(errors).length > 0) return servicesPage(c, { errors, status: 400 });
    for (const { k, value } of toSave) KEYS[k].set(value);
    return c.redirect(destination('services', go), 302);
  });

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

    if (values.radius !== '') {
      const r = Number(values.radius);
      if (!(Number.isFinite(r) && r > 0 && r <= 500)) {
        errors['default_radius_mi'] = 'Search radius must be a number of miles greater than 0, like 15.';
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

  return app;
}
