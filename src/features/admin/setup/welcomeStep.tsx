import type { Hono, Context } from 'hono';
import type { Child } from 'hono/jsx';
import { SettingsValidationError, getSettings, updateSettings } from '../settingsRepo.js';
import { StepShell } from './StepShell.js';
import { Field, destination, firstError, goOf, one, many, str, type Errors, type SetupContext, type Status } from './shared.js';

const DEFAULT_HOUSEHOLD = 'Our household';
const HOUSEHOLD_MAX = 60;
const EMERGENCY_MAX = 20;

/** Step 1: household name and emergency number. */
export function registerWelcomeStep(app: Hono, ctx: SetupContext): void {
  const { db, render, doneSteps } = ctx;
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
    try {
      updateSettings(db, { householdName: name, emergencyNumber: number });
    } catch (e) {
      if (!(e instanceof SettingsValidationError)) throw e;
      // updateSettings re-validates the whole row; a bad value saved elsewhere must not turn into a 500 here.
      return welcomePage(
        c,
        { name, number },
        { household_name: 'Another setting has a problem, so this could not be saved. Fix it in Settings, then try again.' },
        400,
      );
    }
    return c.redirect(destination('welcome', go), 302);
  });
}
