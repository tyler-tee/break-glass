import type { Hono, Context } from 'hono';
import { slugify } from '../../../domain/slug.js';
import { CategoryError, createCategory, getCategoryBySlug, listCategories } from '../../categories/repo.js';
import { CATEGORY_PRESETS } from './presets.js';
import { StepShell } from './StepShell.js';
import { Field, destination, firstError, goOf, one, many, type Errors, type SetupContext, type Status } from './shared.js';

/** Step 4: category presets and custom categories. */
export function registerCategoriesStep(app: Hono, ctx: SetupContext): void {
  const { db, render, doneSteps } = ctx;

  const presetSlugs = new Set(CATEGORY_PRESETS.map((p) => p.slug));

  type CategoryValues = { checked: ReadonlySet<string>; name: string; terms: string; target: string };
  const CATEGORY_ORDER = ['presets', 'custom_name', 'custom_terms', 'custom_target'];

  const categoriesPage = (c: Context, values: CategoryValues, errors: Errors = {}, status: Status = 200) => {
    const all = listCategories(db);
    const existing = new Set(all.map((x) => x.slug));
    const others = all.filter((x) => !presetSlugs.has(x.slug));
    const focus = firstError(errors, CATEGORY_ORDER);
    return render(
      c,
      'categories',
      <StepShell
        step="categories"
        heading="Categories"
        doneSteps={doneSteps()}
        intro={<p>Pick the kinds of places your family would want to find in an emergency. You can change these later.</p>}
      >
        <fieldset aria-describedby={errors['presets'] ? 'presets-error' : undefined}>
          <legend>Common choices</legend>
          {CATEGORY_PRESETS.map((p) => {
            const have = existing.has(p.slug);
            return (
              <div class="check">
                <input
                  type="checkbox"
                  id={`preset-${p.slug}`}
                  name="preset"
                  value={p.slug}
                  checked={have || values.checked.has(p.slug)}
                  disabled={have}
                  autofocus={focus === 'presets' && p === CATEGORY_PRESETS[0]}
                />
                <label for={`preset-${p.slug}`}>
                  {p.name}
                  <span class="field-hint">
                    {' '}
                    Looks for {p.searchTerms.join(' and ')}; aims for {p.targetCount}.{have ? ' Already added.' : ''}
                  </span>
                </label>
              </div>
            );
          })}
          {errors['presets'] && (
            <p class="field-error" id="presets-error" role="alert">
              {errors['presets']}
            </p>
          )}
        </fieldset>
        {others.length > 0 && (
          <fieldset>
            <legend>Already added</legend>
            <ul>
              {others.map((x) => (
                <li>
                  {x.name} <a href={`/admin/categories/${x.id}/edit`}>Edit</a>
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        <fieldset>
          <legend>Add your own</legend>
          <Field id="custom_name" label="Name" hint="For example, Eye doctor." error={errors['custom_name']} control={(describedBy, invalid) => (
              <input
                id="custom_name"
                name="custom_name"
                value={values.name}
                autocomplete="off"
                aria-describedby={describedBy}
                aria-invalid={invalid ? 'true' : undefined}
                autofocus={focus === 'custom_name'}
              />
            )} />
          <Field
            id="custom_terms"
            label="What to search for"
            hint="One search per line, like the words you'd type into a map."
            error={errors['custom_terms']}
            control={(describedBy, invalid) => (
              <textarea
                id="custom_terms"
                name="custom_terms"
                rows={3}
                aria-describedby={describedBy}
                aria-invalid={invalid ? 'true' : undefined}
                autofocus={focus === 'custom_terms'}
              >
                {values.terms}
              </textarea>
            )}
          />
          <Field
            id="custom_target"
            label="How many places do you want? (optional)"
            hint="Leave blank for 5."
            error={errors['custom_target']}
            control={(describedBy, invalid) => (
              <input
                id="custom_target"
                name="custom_target"
                value={values.target}
                inputmode="numeric"
                autocomplete="off"
                aria-describedby={describedBy}
                aria-invalid={invalid ? 'true' : undefined}
                autofocus={focus === 'custom_target'}
              />
            )}
          />
        </fieldset>
      </StepShell>,
      status,
    );
  };

  app.get('/categories', (c) => categoriesPage(c, { checked: new Set(), name: '', terms: '', target: '' }));

  app.post('/categories', async (c) => {
    const body = await c.req.parseBody({ all: true });
    const go = goOf(one(body['go']));
    if (go === 'skip' || go === 'back') return c.redirect(destination('categories', go), 302);

    const checked = new Set(many(body['preset']).filter((s) => presetSlugs.has(s)));
    const name = one(body['custom_name']).trim();
    const terms = one(body['custom_terms']);
    const target = one(body['custom_target']).trim();
    const values: CategoryValues = { checked, name, terms, target };
    const errors: Errors = {};

    // The custom category goes first so that an error saves nothing at all.
    if (name !== '' || terms.trim() !== '') {
      try {
        createCategory(db, {
          name,
          searchTerms: terms.split(/[\n\r,]+/),
          ...(target === '' ? {} : { targetCount: Number(target) }),
        });
      } catch (e) {
        if (!(e instanceof CategoryError)) throw e;
        const sameAsPreset = [...checked].some((slug) => slug === slugify(name));
        if (!(e.code === 'duplicate' && sameAsPreset)) {
          const field = e.field === 'target_count' ? 'custom_target' : e.field === 'search_terms' ? 'custom_terms' : 'custom_name';
          errors[field] = e.message;
        }
      }
    }
    if (Object.keys(errors).length > 0) return categoriesPage(c, values, errors, 400);

    for (const p of CATEGORY_PRESETS) {
      if (!checked.has(p.slug) || getCategoryBySlug(db, p.slug)) continue; // idempotent by slug
      try {
        createCategory(db, { name: p.name, searchTerms: [...p.searchTerms], targetCount: p.targetCount });
      } catch (e) {
        if (!(e instanceof CategoryError && e.code === 'duplicate')) throw e;
      }
    }
    if (go === 'next' && listCategories(db).length === 0) {
      return categoriesPage(c, values, { presets: 'Pick at least one kind of place, or add your own, to continue. Or choose Skip for now.' }, 400);
    }
    return c.redirect(destination('categories', go), 302);
  });
}
