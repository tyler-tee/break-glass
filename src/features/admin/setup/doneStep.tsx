import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { settings } from '../../../db/schema.js';
import { llmOf, placesOf } from '../../../services/resolver.js';
import { StepShell } from './StepShell.js';
import { goOf, type SetupContext } from './shared.js';
import { prevStep, stepDone, stepPath, type Step } from './steps.js';

const CHECKLIST: { step: Step; label: string; optional?: boolean }[] = [
  { step: 'welcome', label: 'Household name' },
  { step: 'services', label: 'Service keys (optional)', optional: true },
  { step: 'home', label: 'Home location' },
  { step: 'categories', label: 'Categories' },
  { step: 'places', label: 'Approved places' },
  { step: 'protocol', label: 'First protocol' },
];

/** Step 7: summary, then mark setup complete. */
export function registerDoneStep(app: Hono, ctx: SetupContext): void {
  const { deps, db, render, doneSteps, now } = ctx;

  app.get('/done', (c) => {
    const rows = CHECKLIST.map((r) => ({
      ...r,
      done: r.step === 'services' ? llmOf(deps) !== undefined || placesOf(deps) !== undefined : stepDone({ db }, r.step),
    }));
    const open = rows.filter((r) => !r.done && !r.optional);
    return render(
      c,
      'done',
      <StepShell
        step="done"
        heading="All set"
        doneSteps={doneSteps()}
        nextLabel="Finish setup"
        intro={
          open.length === 0 ? (
            <p>Everything is in place. Finish to open the admin overview.</p>
          ) : (
            <p>
              You can finish now and come back to the rest later. Still open: {open.map((r) => r.label.toLowerCase()).join(', ')}.
            </p>
          )
        }
        before={
          <>
            <ul class="checklist">
              {rows.map((r) => (
                <li>
                  <span aria-hidden="true">{r.done ? '✓' : '○'}</span> {r.label}:{' '}
                  {r.done ? 'done' : r.optional ? 'not added' : 'not done yet'}{' '}
                  {!r.done && <a href={stepPath(r.step)}>{r.optional ? 'Add' : 'Fix this'}</a>}
                </li>
              ))}
            </ul>
            <p>
              <a href="/">Open the family site</a>
            </p>
            <section class="card">
              <h2>Add it to your family's phones</h2>
              <p>
                On each phone, open the family site, then use Share → Add to Home Screen (iPhone) or the browser menu → Install app
                (Android).
              </p>
            </section>
          </>
        }
      />,
    );
  });

  app.post('/done', async (c) => {
    const go = goOf((await c.req.parseBody())['go']);
    if (go === 'later') return c.redirect('/admin', 302);
    if (go === 'back') return c.redirect(stepPath(prevStep('done') ?? 'protocol'), 302);
    db.update(settings).set({ setupCompletedAt: now() }).where(eq(settings.id, 1)).run();
    return c.redirect('/admin', 302);
  });
}
