import type { Hono, Context } from 'hono';
import { PICKS_PER_CATEGORY } from '../../../domain/ranking.js';
import { placesOf } from '../../../services/resolver.js';
import { listCategories } from '../../categories/repo.js';
import { listLocations } from '../../locations/repo.js';
import { LocationError, createManualLocation } from '../../locations/service.js';
import { StepShell, type Notice } from './StepShell.js';
import { Field, destination, goOf, str, type SetupContext, type Status } from './shared.js';

/** Step 5: one card that sends the admin to Find places, plus adding a place by hand. */
export function registerPlacesStep(app: Hono, ctx: SetupContext): void {
  const { deps, db, render, doneSteps, now } = ctx;

  type ManualValues = { category_id: string; name: string; address: string; phone: string };
  const EMPTY_MANUAL: ManualValues = { category_id: '', name: '', address: '', phone: '' };

  const placesPage = (
    c: Context,
    opts: { notice?: Notice; manual?: ManualValues; manualError?: { field: string; message: string }; status?: Status } = {},
  ) => {
    const hasPlaces = placesOf(deps) !== undefined;
    const cats = listCategories(db);
    const all = listLocations(db);
    const manual = opts.manual ?? EMPTY_MANUAL;
    const err = opts.manualError;
    const picksOf = (id: number) => all.filter((l) => l.categoryId === id && (l.status === 'approved' || l.status === 'warn')).length;
    const withPicks = cats.filter((cat) => picksOf(cat.id) > 0).length;
    const allPicked = cats.length > 0 && withPicks === cats.length;
    return render(
      c,
      'places',
      <StepShell
        step="places"
        heading="Find places"
        doneSteps={doneSteps()}
        notice={opts.notice}
        nextSecondary={!allPicked}
        intro={
          <p>
            Pick the places your family would actually go to; the top {PICKS_PER_CATEGORY} in each category come pre-picked. Only the places you save
            show up on the family site.
          </p>
        }
        before={
          <>
            {cats.length === 0 ? (
              <p>
                You haven't picked any categories yet. <a href="/admin/setup/categories">Go back to Categories</a>.
              </p>
            ) : (
              <section class="card places-card" aria-labelledby="places-card-h">
                <h2 id="places-card-h" class="label">
                  Places on the family site
                </h2>
                <p>
                  <b>
                    {withPicks} of {cats.length} {cats.length === 1 ? 'category has' : 'categories have'} picks.
                  </b>{' '}
                  {allPicked
                    ? 'You can rerun the search any time to compare and swap.'
                    : 'Search every category in one go, then keep the best 3 of each.'}
                </p>
                <ul>
                  {cats.map((cat) => {
                    const n = picksOf(cat.id);
                    return (
                      <li>
                        <span>{cat.name}</span>
                        <span class={n === 0 ? 'warn' : 'muted'}>
                          {n === 0 ? 'No picks yet' : `${n} picked`}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <a class="btn" href="/admin/places/find">
                  Find &amp; rank places
                </a>
                {!hasPlaces && (
                  <p class="muted">
                    Searching needs a Google Places key. <a href="/admin/setup/services">Add a key in Services</a>, or add
                    places by hand below.
                  </p>
                )}
              </section>
            )}
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
    const notice: Notice | undefined =
      c.req.query('added') === '1'
        ? {
            kind: 'status',
            text: (
              <>
                Added. It is waiting on <a href="/admin/places/find">Find places</a>, where you can save it as a pick.
              </>
            ),
          }
        : undefined;
    return placesPage(c, notice ? { notice } : {});
  });

  app.post('/places', async (c) => {
    const body = await c.req.parseBody();
    return c.redirect(destination('places', goOf(body['go'])), 302);
  });

  app.post('/places/manual', async (c) => {
    const body = await c.req.parseBody();
    const manual: ManualValues = {
      category_id: str(body['category_id']),
      name: str(body['name']),
      address: str(body['address']),
      phone: str(body['phone']),
    };
    try {
      createManualLocation(
        db,
        { categoryId: Number(manual.category_id), name: manual.name, address: manual.address, phone: manual.phone },
        now(),
      );
    } catch (e) {
      if (!(e instanceof LocationError)) throw e;
      const field = e.field === 'name' ? 'manual_name' : 'manual_category';
      return placesPage(c, { manual, manualError: { field, message: e.message }, status: 400 });
    }
    return c.redirect('/admin/setup/places?added=1', 302);
  });
}
