import type { Hono, Context } from 'hono';
import type { Child } from 'hono/jsx';
import { describePlacesError } from '../../../services/keyProbe.js';
import { BudgetExhausted, newPlacesBudget } from '../../../services/places/budget.js';
import { PlacesError } from '../../../services/places/client.js';
import { extractOf, placesOf } from '../../../services/resolver.js';
import { ReviewQueue } from '../../../web/components/ReviewQueue.js';
import { getCategory, listCategories } from '../../categories/repo.js';
import { NoHomeLocation, runDiscovery } from '../../locations/discovery.js';
import { listLocations } from '../../locations/repo.js';
import { LocationError, createManualLocation } from '../../locations/service.js';
import { StepShell, type Notice } from './StepShell.js';
import { Field, destination, firstError, goOf, one, many, str, type Errors, type SetupContext, type Status } from './shared.js';


/** Step 5: find places and approve them in place. */
export function registerPlacesStep(app: Hono, ctx: SetupContext): void {
  const { deps, db, render, doneSteps, now } = ctx;
  const { env } = deps;
  // ---- Step 5: Find places --------------------------------------------------------------------------

  const count = (v: string | undefined): number | undefined => (v !== undefined && /^\d{1,6}$/.test(v) ? Number(v) : undefined);
  type Found = { categoryId: number; inserted: number; skipped: number; stopped?: 'run' | 'month' };
  type ManualValues = { category_id: string; name: string; address: string; phone: string };
  const EMPTY_MANUAL: ManualValues = { category_id: '', name: '', address: '', phone: '' };

  const placesPage = (
    c: Context,
    opts: { found?: Found; notice?: Notice; manual?: ManualValues; manualError?: { field: string; message: string }; status?: Status } = {},
  ) => {
    const hasPlaces = placesOf(deps) !== undefined;
    const cats = listCategories(db);
    const all = listLocations(db);
    const manual = opts.manual ?? EMPTY_MANUAL;
    const err = opts.manualError;
    const findLine = (cat: { id: number; name: string }) => {
      const f = opts.found;
      if (!f || f.categoryId !== cat.id) return null;
      const text =
        f.inserted === 0
          ? `No new places found for ${cat.name}${f.skipped > 0 ? ` (${f.skipped} already known)` : ''}.`
          : `Added ${f.inserted} new ${f.inserted === 1 ? 'place' : 'places'} for ${cat.name}${f.skipped > 0 ? ` (${f.skipped} already known)` : ''}. Approve the ones you want below.`;
      const stopped = f.stopped
        ? f.stopped === 'month'
          ? " The search stopped early because this month's Places call limit was reached."
          : ' The search stopped early to stay under the per-run call limit.'
        : '';
      return (
        <p class="notice notice-status" role="status">
          {text}
          {stopped}
        </p>
      );
    };
    return render(
      c,
      'places',
      <StepShell
        step="places"
        heading="Find places"
        doneSteps={doneSteps()}
        notice={opts.notice}
        intro={
          <p>
            Approve the places your family would actually go to. Only approved places show up on the family site.
          </p>
        }
        before={
          <>
            {cats.length === 0 && (
              <p>
                You haven't picked any categories yet. <a href="/admin/setup/categories">Go back to Categories</a>.
              </p>
            )}
            {!hasPlaces && (
              <p class="muted">
                A Google Places key finds nearby places for you and re-checks their hours every week.{' '}
                <a href="/admin/setup/services">Add a key in Services</a>.
              </p>
            )}
            {cats.map((cat) => {
              const mine = all.filter((l) => l.categoryId === cat.id);
              const approved = mine.filter((l) => l.status === 'approved' || l.status === 'warn');
              const items = mine
                .filter((l) => l.status === 'candidate')
                .map((l) => ({
                  id: l.id,
                  title: l.name,
                  subtitle: [l.distanceMi === null ? null : `${l.distanceMi.toFixed(1)} mi`, l.rating === null ? null : `${l.rating} stars`, l.phone]
                    .filter((p) => p !== null)
                    .join(' · '),
                }));
              return (
                <section class="card" id={cat.slug}>
                  <h2>{cat.name}</h2>
                  <p>
                    {approved.length} approved of target {cat.targetCount ?? 5}
                  </p>
                  {approved.length > 0 && <p class="muted">Approved: {approved.map((l) => l.name).join(', ')}</p>}
                  {hasPlaces && (
                    <form method="post" action={`/admin/setup/places/discover/${cat.id}`} data-busy="Searching nearby…">
                      <button type="submit" class="btn-secondary">
                        Find places
                      </button>
                    </form>
                  )}
                  {findLine(cat)}
                  {items.length > 0 && (
                    <ReviewQueue
                      title={`Waiting for your decision: ${cat.name}`}
                      empty=""
                      items={items}
                      approveAction={(id) => `/admin/locations/${id}/approve`}
                      rejectAction={(id) => `/admin/locations/${id}/reject`}
                      returnTo={`/admin/setup/places#${cat.slug}`}
                    />
                  )}
                </section>
              );
            })}
            {cats.length > 0 && (
              <form method="post" action="/admin/setup/places/manual" class="admin-form">
                <fieldset>
                  <legend>Add a place by hand</legend>
                  <div class="field">
                    <label for="manual_category">Category</label>
                    <select
                      id="manual_category"
                      name="category_id"
                      aria-describedby={err?.field === 'manual_category' ? 'manual_category-error' : undefined}
                    >
                      {cats.map((cat) => (
                        <option value={String(cat.id)} selected={String(cat.id) === manual.category_id}>
                          {cat.name}
                        </option>
                      ))}
                    </select>
                    {err?.field === 'manual_category' && (
                      <p class="field-error" id="manual_category-error" role="alert">
                        {err.message}
                      </p>
                    )}
                  </div>
                  <Field id="manual_name" label="Name" error={err?.field === 'manual_name' ? err.message : undefined} control={(describedBy, invalid) => (
                      <input
                        id="manual_name"
                        name="name"
                        value={manual.name}
                        autocomplete="off"
                        aria-describedby={describedBy}
                        aria-invalid={invalid ? 'true' : undefined}
                        autofocus={invalid}
                      />
                    )} />
                  <Field id="manual_address" label="Address (optional)" control={() => (
                      <input id="manual_address" name="address" value={manual.address} autocomplete="off" />
                    )} />
                  <Field id="manual_phone" label="Phone (optional)" control={() => (
                      <input id="manual_phone" name="phone" type="tel" value={manual.phone} autocomplete="off" />
                    )} />
                  <button type="submit" class="btn-secondary">
                    Add this place
                  </button>
                </fieldset>
              </form>
            )}
          </>
        }
      />,
      opts.status ?? 200,
    );
  };

  app.get('/places', (c) => {
    const q = c.req.query();
    const categoryId = count(q['found']);
    const inserted = count(q['inserted']);
    const skipped = count(q['skipped']);
    const found: Found | undefined =
      categoryId !== undefined && inserted !== undefined && getCategory(db, categoryId)
        ? {
            categoryId,
            inserted,
            skipped: skipped ?? 0,
            ...(q['stopped'] === 'run' || q['stopped'] === 'month' ? { stopped: q['stopped'] } : {}),
          }
        : undefined;
    const notice: Notice | undefined =
      q['added'] === '1'
        ? { kind: 'status', text: 'Added. It is waiting for your decision below; approve it to use it.' }
        : undefined;
    return placesPage(c, { ...(found ? { found } : {}), ...(notice ? { notice } : {}) });
  });

  app.post('/places', async (c) => {
    const body = await c.req.parseBody();
    return c.redirect(destination('places', goOf(body['go'])), 302);
  });

  app.post('/places/discover/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const category = getCategory(db, id);
    if (!category) return c.notFound();
    const places = placesOf(deps);
    const fail = (text: Child, status: Status) => placesPage(c, { notice: { kind: 'alert', text }, status });
    if (!places) {
      return fail(
        <>
          Add a Google Places key in <a href="/admin/setup/services">Setup → Services</a> to find places, or add one by hand.
        </>,
        400,
      );
    }
    const extract = extractOf(deps);
    try {
      const report = await runDiscovery(db, id, {
        places: { ...places, budget: newPlacesBudget(db, env, deps.now) },
        now: now,
        log: console,
        ...(extract ? { extract } : {}),
      });
      // runDiscovery reports budget stops instead of throwing; with no calls made there is nothing to show.
      if (report.stoppedEarly && report.callsUsed === 0) {
        return fail(describePlacesError(new BudgetExhausted('budget', report.stopReason ?? 'run'), places.apiKey), 429);
      }
      const q = new URLSearchParams({ found: String(id), inserted: String(report.inserted), skipped: String(report.skipped) });
      if (report.stoppedEarly) q.set('stopped', report.stopReason ?? 'run');
      return c.redirect(`/admin/setup/places?${q}#${category.slug}`, 302);
    } catch (e) {
      if (e instanceof NoHomeLocation) {
        return fail(
          <>
            Set your home location first, so we know where to look. <a href="/admin/setup/home">Go to the Home step</a>.
          </>,
          400,
        );
      }
      if (e instanceof BudgetExhausted) return fail(describePlacesError(e, places.apiKey), 429);
      if (e instanceof PlacesError) return fail(describePlacesError(e, places.apiKey), 502);
      throw e;
    }
  });

  app.post('/places/manual', async (c) => {
    const body = await c.req.parseBody();
    const manual: ManualValues = {
      category_id: str(body['category_id']),
      name: str(body['name']),
      address: str(body['address']),
      phone: str(body['phone']),
    };
    let created;
    try {
      created = createManualLocation(
        db,
        { categoryId: Number(manual.category_id), name: manual.name, address: manual.address, phone: manual.phone },
        (now)(),
      );
    } catch (e) {
      if (!(e instanceof LocationError)) throw e;
      const field = e.field === 'name' ? 'manual_name' : 'manual_category';
      return placesPage(c, { manual, manualError: { field, message: e.message }, status: 400 });
    }
    const slug = getCategory(db, created.categoryId)?.slug;
    return c.redirect(`/admin/setup/places?added=1${slug ? `#${slug}` : ''}`, 302);
  });
}
