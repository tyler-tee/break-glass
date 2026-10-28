import type { Hono, Context } from 'hono';
import type { Child } from 'hono/jsx';
import { testAnthropicKey, testPlacesKey, type ProbeResult } from '../../../services/keyProbe.js';
import { placesOf } from '../../../services/resolver.js';
import type { SecretName } from '../secrets.js';
import { StepShell, type Notice } from './StepShell.js';
import { nextStep, stepPath } from './steps.js';
import { Field, destination, firstError, goOf, one, many, str, type Errors, type SetupContext, type Status } from './shared.js';

const KEY_MIN = 20;
const KEY_MAX = 400;
// Printable ASCII only: pasted keys sometimes pick up spaces, line breaks or invisible characters (zero-width
// spaces), which would also break HTTP headers.
const KEY_CHARS = /^[\x21-\x7e]+$/;
const SHORT_KEY_MESSAGE = 'That key looks too short — copy the whole key and paste it again';
// Below this length, showing the last four characters would reveal too much of the key.
const LAST4_MIN_LENGTH = 12;
type SavedWhich = 'places' | 'anthropic' | 'both';
const isSavedWhich = (v: string): v is SavedWhich => v === 'places' || v === 'anthropic' || v === 'both';
const BAD_KEY_MESSAGE = "That doesn't look like a key — paste it again without spaces";
type KeyName = 'places' | 'anthropic';
type KeyState = { kind: 'env' } | { kind: 'saved'; last4: string | null } | { kind: 'none' };

/** Step 2: optional API keys. */
export function registerServicesStep(app: Hono, ctx: SetupContext): void {
  const { deps, render, doneSteps } = ctx;
  const { env, secrets } = deps;
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
    return v ? { kind: 'saved', last4: v.length >= LAST4_MIN_LENGTH ? v.slice(-4) : null } : { kind: 'none' };
  };

  const servicesPage = (
    c: Context,
    opts: {
      errors?: Errors;
      probe?: { key: KeyName; result: ProbeResult };
      notice?: Notice;
      justSaved?: boolean;
      status?: Status;
    } = {},
  ) => {
    const errors = opts.errors ?? {};
    const focus = firstError(errors, KEY_NAMES.map((k) => KEYS[k].field));
    const next = nextStep('services');
    return render(
      c,
      'services',
      <StepShell
        step="services"
        heading="Optional services"
        doneSteps={doneSteps()}
        notice={opts.notice}
        nextSecondary={Boolean(opts.justSaved && next)}
        intro={
          <p>
            Both keys are optional. Without them you can still add places and write protocols by hand. Keys are stored on
            this server and are never shown again after you save them.
          </p>
        }
        before={
          opts.justSaved &&
          next && (
            <p class="wizard-continue">
              <a class="btn" href={stepPath(next)}>
                Continue
              </a>
            </p>
          )
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
                      ? state.last4
                        ? `Saved (ends in …${state.last4})`
                        : 'Saved'
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
    const saved = c.req.query('saved') ?? '';
    if (isSavedWhich(saved)) {
      return servicesPage(c, { notice: { kind: 'status', text: 'Saved. Use Test to check it, or continue.' }, justSaved: true });
    }
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
      if (!KEY_CHARS.test(value) || value.length > KEY_MAX) errors[def.field] = BAD_KEY_MESSAGE;
      else if (value.length < KEY_MIN) errors[def.field] = SHORT_KEY_MESSAGE;
      else toSave.push({ k, value });
    }
    // Never echo a submitted key: the inputs carry no value attribute, and nothing is saved if any field is bad.
    if (Object.keys(errors).length > 0) return servicesPage(c, { errors, status: 400 });
    for (const { k, value } of toSave) KEYS[k].set(value);
    // A newly saved key stays on this step so the admin can Test it before moving on.
    if (go === 'next' && toSave.length > 0) {
      const which: SavedWhich = toSave.length > 1 ? 'both' : toSave[0]!.k;
      return c.redirect(`/admin/setup/services?saved=${which}`, 302);
    }
    return c.redirect(destination('services', go), 302);
  });
}
