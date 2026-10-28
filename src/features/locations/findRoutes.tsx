import { Hono, type Context } from 'hono';
import type { Child, FC } from 'hono/jsx';
import type { ResolvedAppDeps } from '../../app.js';
import type { FindRun } from '../../db/schema.js';
import { PICKS_PER_CATEGORY } from '../../domain/ranking.js';
import type { FindRunProgress, HoursNeed } from '../../domain/types.js';
import { extractOf, llmOf, placesOf } from '../../services/resolver.js';
import { page } from '../../web/Layout.js';
import { getSettings } from '../admin/settingsRepo.js';
import { getCategory, listCategories, type Category } from '../categories/repo.js';
import { safeReturnTo } from './adminRoutes.js';
import { FindRunActive, NoHomeLocation, findRunDeps, latestRun, rankedView, startFindRun, type RankedRow } from './findAndRank.js';
import {
  agoText,
  changeSummary,
  defaultPicks,
  flagLabel,
  hoursCell,
  listWords,
  plural,
  ratingText,
  saveLabel,
  shortNames,
  startedText,
} from './findView.js';
import { neverSuggest, savePicks } from './picks.js';
import { getLocation } from './repo.js';
import { LocationError } from './service.js';

const BASE = '/admin/places/find';
const SETUP_SERVICES = '/admin/setup/services';

type Status = 200 | 400;
type Notice = { kind: 'status' | 'alert'; text: Child };
/** A save that failed validation: that section re-renders with the submitted checks and the error. */
type PickError = { categoryId: number; checked: Set<number>; message: string };

const ids = (v: unknown): number[] =>
  (Array.isArray(v) ? v : v === undefined ? [] : [v])
    .filter((x): x is string => typeof x === 'string' && /^\d{1,9}$/.test(x))
    .map(Number);

/* Icons: Lucide geometry at the mockup's sizes and stroke widths. -------------------------------- */
const Svg: FC<{ size: number; sw: number; stroke?: string; children?: Child }> = ({ size, sw, stroke = 'currentColor', children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} stroke-width={sw} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {children}
  </svg>
);
const CheckIcon: FC<{ size?: number; sw?: number }> = ({ size = 20, sw = 2.4 }) => (
  <Svg size={size} sw={sw}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);
const WarnIcon: FC<{ size?: number; sw?: number }> = ({ size = 16, sw = 2.2 }) => (
  <Svg size={size} sw={sw}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </Svg>
);
const ClockIcon: FC = () => (
  <Svg size={16} sw={2.4}>
    <path d="M12 6v6l4 2" />
    <circle cx="12" cy="12" r="9" />
  </Svg>
);
const DashIcon: FC = () => (
  <Svg size={16} sw={2.2}>
    <path d="M8 12h8" />
  </Svg>
);
const ChevronDown: FC = () => (
  <Svg size={18} sw={2.2}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);
const ChevronRight: FC = () => (
  <Svg size={18} sw={2.2} stroke="#5b6068">
    <path d="m9 6 6 6-6 6" />
  </Svg>
);

const needWord = (need: HoursNeed): string => (need === 'daytime' ? 'Daytime' : 'Overnight');

const onSiteText = (n: number): string =>
  n === 0 ? 'none on family site yet' : n >= PICKS_PER_CATEGORY ? `${n} on family site` : `${n} of ${PICKS_PER_CATEGORY} on family site`;

const savedText = (n: number): string =>
  n === 0 ? 'Saved. Nothing from this category shows on the family site now.' : `Saved. The family site now shows ${n === 1 ? 'this one' : `these ${n}`}.`;

/* View model ------------------------------------------------------------------------------------ */
/** Everything one category section needs, computed once on the server. */
type SectionModel = {
  category: Category;
  rows: RankedRow[];
  names: Map<number, string>;
  checked: Set<number>;
  current: RankedRow[];
  /** Null when nothing in the category has been ranked yet (only places added by hand). */
  rankedBy: 'llm' | 'rules' | null;
  rankedAt: Date | null;
  found: number;
  changed: boolean;
};

function sectionModel(category: Category, rows: RankedRow[], checked?: Set<number>): SectionModel | null {
  if (rows.length === 0) return null;
  const ranked = rows.filter((r) => r.rankVerdict !== null);
  const rankedAt = ranked.length ? new Date(Math.max(...ranked.map((r) => r.rankedAt?.getTime() ?? 0))) : null;
  // Pre-pass drops are always written as rules, so read who ranked the category off its best row.
  const rankedBy = ranked.length ? ((ranked.find((r) => r.rankVerdict === 'pick') ?? ranked[0]!).rankedBy ?? 'rules') : null;
  const names = shortNames(rows);
  const marks = checked ?? defaultPicks(rows);
  return {
    category,
    rows,
    names,
    checked: marks,
    current: rows.filter((r) => r.currentPick),
    rankedBy,
    rankedAt,
    found: ranked.length,
    changed: changeSummary(rows, marks, names).changed,
  };
}

/* Routes ---------------------------------------------------------------------------------------- */
export function findPlacesRoutes(deps: ResolvedAppDeps): Hono {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const app = new Hono();

  type RenderOpts = {
    notice?: Notice;
    status?: Status;
    /** A category to show in full even when nothing changed (from the compact list). */
    show?: string;
    saved?: string;
    removed?: string;
    pickError?: PickError;
  };

  const render = (c: Context, opts: RenderOpts = {}) => {
    const run = latestRun(db);
    const running = run?.status === 'running';
    const settings = getSettings(db);
    const radius = settings.defaultRadiusMi ?? 15;
    const tz = settings.homeTz;
    const t = now();
    const cats = listCategories(db);
    const hasLlm = llmOf(deps) !== undefined;
    const hasPlaces = placesOf(deps) !== undefined;
    const views = new Map(cats.map((cat) => [cat.id, rankedView(db, cat.id)]));

    const head = (
      <div>
        <h1>Find places</h1>
        <p class="lede">
          {running
            ? 'Searching and ranking. Finished categories are saved as they land, so you can leave this page and come back.'
            : "Pick categories and we'll search Google, then rank what comes back on three things: is it open when you'd need it, is it any good, and how far is it. You keep 3 per category. Nothing reaches the family site until you save."}
        </p>
      </div>
    );
    const notice = opts.notice && (
      <p class={`notice notice-${opts.notice.kind}`} role={opts.notice.kind}>
        {opts.notice.text}
      </p>
    );

    // "13 found, 3 recommended. Same 3 as now." for each finished category on the run card.
    const outcomes = new Map(
      cats.map((cat) => {
        const rows = views.get(cat.id)!;
        const s = changeSummary(rows, defaultPicks(rows));
        const current = rows.filter((r) => r.currentPick).length;
        const diff = rows.filter((r) => s.changed && (defaultPicks(rows).has(r.id) !== r.currentPick)).length;
        return [cat.id, { picks: defaultPicks(rows).size, current, changes: diff }] as const;
      }),
    );

    if (running && run) {
      return page(
        c,
        'Find places',
        <div class="find">
          {head}
          {notice}
          <RunCard run={run} cats={cats} hasLlm={hasLlm} t={t} outcomes={outcomes} />
          <p class="foot">
            This page refreshes every few seconds. Used so far: {plural(run.callsUsed, 'Google search', 'Google searches')},{' '}
            {plural(run.llmCalls, 'AI call')}.
          </p>
        </div>,
        opts.status ?? 200,
        { layout: 'admin', activeNav: 'find', head: <meta http-equiv="refresh" content="3" /> },
      );
    }

    // One section per category with something to decide; the rest go in the compact list.
    const models = cats.flatMap((cat) => {
      const rows = views.get(cat.id)!;
      let checked: Set<number> | undefined;
      if (opts.pickError?.categoryId === cat.id) checked = opts.pickError.checked;
      // Just saved: the boxes show what the family site now has.
      else if (opts.saved === cat.slug) checked = new Set(rows.filter((r) => r.currentPick).map((r) => r.id));
      const m = sectionModel(cat, rows, checked);
      return m ? [m] : [];
    });
    const show = new Set([opts.show, opts.saved, opts.removed].filter((s): s is string => s !== undefined));
    const full = models.filter(
      (m) =>
        m.changed ||
        m.current.length < PICKS_PER_CATEGORY ||
        show.has(m.category.slug) ||
        opts.pickError?.categoryId === m.category.id,
    );
    const compact = models.filter((m) => !full.includes(m));
    const runCats = new Set(run?.categoryIds ?? []);
    const progress: FindRunProgress = run?.progress ?? {};
    const problems = run ? run.categoryIds.filter((id) => ['failed', 'stopped'].includes(progress[String(id)]?.state ?? '')) : [];
    const onSite = new Map(cats.map((cat) => [cat.id, views.get(cat.id)!.filter((r) => r.currentPick).length]));

    return page(
      c,
      'Find places',
      <div class="find">
        {head}
        {notice}
        <Picker cats={cats} onSite={onSite} hasLlm={hasLlm} hasPlaces={hasPlaces} />
        {run && <RunBanner run={run} sectionsToReview={full.length} t={t} tz={tz} />}
        {run && problems.length > 0 && <RunCard run={run} cats={cats} hasLlm={hasLlm} t={t} outcomes={outcomes} only={problems} />}
        {full.map((m) => (
          <Section
            m={m}
            radius={radius}
            t={t}
            tz={tz}
            hasLlm={hasLlm}
            aiMessage={runCats.has(m.category.id) ? progress[String(m.category.id)]?.message : undefined}
            saved={opts.saved === m.category.slug}
            removed={opts.removed === m.category.slug}
            error={opts.pickError?.categoryId === m.category.id ? opts.pickError.message : undefined}
          />
        ))}
        {compact.length > 0 && (
          <section class="card" aria-labelledby="other-h">
            <h2 id="other-h" class="label others-h">
              {compact.every((m) => runCats.has(m.category.id))
                ? 'Also ranked in this run: no changes suggested'
                : 'Also ranked: no changes suggested'}
            </h2>
            <div class="others">
              {compact.map((m) => (
                <a href={`${BASE}?show=${encodeURIComponent(m.category.slug)}#${m.category.slug}`}>
                  <span>
                    <span class="t">{m.category.name}</span>
                    <br />
                    <span class="s">Keeps {listWords(m.current.map((r) => m.names.get(r.id)!))}</span>
                  </span>
                  <ChevronRight />
                </a>
              ))}
            </div>
          </section>
        )}
        {models.length === 0 && cats.length > 0 && (
          <section class="card empty-card" aria-labelledby="empty-h">
            <h2 id="empty-h">Nothing ranked yet</h2>
            <p>
              Choose categories above and press Find &amp; rank. Each category then gets its own section here: a ranked
              list with hours, reviews and distance side by side, where you keep 3.
            </p>
          </section>
        )}
      </div>,
      opts.status ?? 200,
      { layout: 'admin', activeNav: 'find' },
    );
  };

  app.get('/', (c) => {
    const q = c.req.query();
    const slugs = new Set(listCategories(db).map((cat) => cat.slug));
    const slug = (v: string | undefined) => (v !== undefined && slugs.has(v) ? v : undefined);
    const notice: Notice | undefined =
      q['notice'] === 'running'
        ? { kind: 'status', text: 'A search is already running. It is shown below; start another once it finishes.' }
        : undefined;
    const show = slug(q['show']);
    const saved = slug(q['saved']);
    const removed = slug(q['removed']);
    return render(c, {
      ...(notice ? { notice } : {}),
      ...(show ? { show } : {}),
      ...(saved ? { saved } : {}),
      ...(removed ? { removed } : {}),
    });
  });

  app.post('/runs', async (c) => {
    const body = await c.req.parseBody({ all: true });
    const places = placesOf(deps);
    if (!places) {
      return render(c, {
        status: 400,
        notice: {
          kind: 'alert',
          text: (
            <>
              Searching needs a Google Places key. <a href={SETUP_SERVICES}>Add one in Setup → Services</a>, then come back here.
            </>
          ),
        },
      });
    }
    try {
      startFindRun(db, ids(body['category_id']), findRunDeps(deps, places));
    } catch (e) {
      if (e instanceof FindRunActive) return c.redirect(`${BASE}?notice=running`, 302);
      if (e instanceof NoHomeLocation) {
        return render(c, {
          status: 400,
          notice: {
            kind: 'alert',
            text: (
              <>
                Set your home location first, so we know where to search. <a href="/admin/settings">Go to Settings</a>.
              </>
            ),
          },
        });
      }
      if (e instanceof LocationError) {
        return render(c, {
          status: 400,
          notice: {
            kind: 'alert',
            text: e.code === 'not_found' ? 'One of those categories no longer exists.' : 'Pick at least one category to search.',
          },
        });
      }
      throw e;
    }
    return c.redirect(BASE, 302);
  });

  app.post('/:categoryId/picks', async (c) => {
    const category = getCategory(db, Number(c.req.param('categoryId')));
    if (!category) return c.notFound();
    const body = await c.req.parseBody({ all: true });
    const chosen = [...new Set(ids(body['location_id']))];
    const fail = (message: string) => render(c, { status: 400, pickError: { categoryId: category.id, checked: new Set(chosen), message } });
    if (chosen.length === 0) return fail(`Pick at least 1 place to save, up to ${PICKS_PER_CATEGORY}.`);
    if (chosen.length > PICKS_PER_CATEGORY) return fail(`Pick at most ${PICKS_PER_CATEGORY} places. You checked ${chosen.length}.`);
    try {
      const extract = extractOf(deps);
      savePicks(db, category.id, chosen, now(), extract ? { extract } : {});
    } catch (e) {
      if (e instanceof LocationError) return fail(e.message);
      throw e;
    }
    return c.redirect(`${BASE}?saved=${encodeURIComponent(category.slug)}#${category.slug}`, 302);
  });

  app.post('/locations/:id/never', async (c) => {
    const loc = getLocation(db, Number(c.req.param('id')));
    if (!loc) return c.notFound();
    const body = await c.req.parseBody();
    try {
      neverSuggest(db, loc.id, now());
    } catch (e) {
      // Already rejected: nothing left to do.
      if (!(e instanceof LocationError)) throw e;
    }
    const slug = getCategory(db, loc.categoryId)?.slug;
    const back = slug ? `${BASE}?removed=${encodeURIComponent(slug)}#${slug}` : BASE;
    return c.redirect(safeReturnTo(body['return_to']) ?? back, 302);
  });

  return app;
}

/* Category picker ------------------------------------------------------------------------------- */
const Picker: FC<{ cats: Category[]; onSite: Map<number, number>; hasLlm: boolean; hasPlaces: boolean }> = ({
  cats,
  onSite,
  hasLlm,
  hasPlaces,
}) => (
  <section class="card picker" aria-labelledby="pick-h">
    <form method="post" action={`${BASE}/runs`} class="picker-form" data-find-picker>
      <div class="picker-top">
        <h2 id="pick-h" class="label">
          Categories to search
        </h2>
        {cats.length > 1 && (
          <div>
            {/* admin.js reveals these; without it every box simply starts checked. */}
            <button class="linkbtn" type="button" data-select="all" hidden>
              Select all
            </button>
            <button class="linkbtn" type="button" data-select="none" hidden>
              Select none
            </button>
          </div>
        )}
      </div>
      {cats.length === 0 ? (
        <p class="muted">
          No categories yet. <a href="/admin/categories/new">Add one on the Categories page</a>.
        </p>
      ) : (
        <fieldset class="cats">
          <legend class="sr-only">Categories to search</legend>
          {cats.map((cat) => {
            const n = onSite.get(cat.id) ?? 0;
            return (
              <label class="cat">
                <input type="checkbox" name="category_id" value={String(cat.id)} checked />
                <span>
                  <span class="n">{cat.name}</span>
                  <span class={n < PICKS_PER_CATEGORY ? 's warn' : 's'}>
                    {needWord(cat.hoursNeed)} · {onSiteText(n)}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
      )}
      {!hasPlaces && cats.length > 0 && (
        <p class="notice notice-alert">
          Searching needs a Google Places key. <a href={SETUP_SERVICES}>Add one in Setup → Services</a>.
        </p>
      )}
      <div class="run">
        <button class="btn" type="submit" data-run-button disabled={cats.length === 0}>
          Find &amp; rank {plural(cats.length, 'category', 'categories')}
        </button>
        <span class="muted">
          {hasLlm
            ? 'About 2 Google searches and 1 AI call per category. Takes about a minute.'
            : 'About 2 Google searches per category. No AI key is set, so places are ranked by hours, rating and distance.'}
        </span>
      </div>
    </form>
  </section>
);

/* After a run ----------------------------------------------------------------------------------- */
const RunBanner: FC<{ run: FindRun; sectionsToReview: number; t: Date; tz: string }> = ({ run, sectionsToReview, t, tz }) => {
  const done = run.categoryIds.map((id) => run.progress[String(id)]).filter((p) => p?.state === 'done');
  const considered = done.reduce((n, p) => n + (p?.found ?? 0), 0);
  const when = agoText(run.finishedAt ?? run.startedAt, t, tz);
  if (done.length === 0) {
    return (
      <div class="banner problem" role="alert">
        <WarnIcon size={20} />
        <p>
          <b>The last search did not rank anything.</b>{' '}
          {run.status === 'failed' && run.error ? `${run.error}. ` : ''}Your current picks are untouched.
        </p>
      </div>
    );
  }
  const total = run.categoryIds.length;
  const ranked =
    done.length === total ? plural(total, 'category', 'categories') : `${done.length} of ${plural(total, 'category', 'categories')}`;
  return (
    <div class="banner" role="status">
      <CheckIcon />
      <p>
        <b>
          Ranked {ranked} {when}.
        </b>{' '}
        {plural(considered, 'place')} considered.{' '}
        {sectionsToReview > 0
          ? 'Review each category below and save the ones you want to change.'
          : 'Nothing to change: every category already shows its best picks.'}
      </p>
    </div>
  );
};

type Outcome = { picks: number; current: number; changes: number };

/** The progress card from the Running mockup. After a run, the same rows explain what failed and what to do. */
const RunCard: FC<{ run: FindRun; cats: Category[]; hasLlm: boolean; t: Date; outcomes: Map<number, Outcome>; only?: number[] }> = ({
  run,
  cats,
  hasLlm,
  t,
  outcomes,
  only,
}) => {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const list = only ?? run.categoryIds;
  const running = run.status === 'running';
  const finished = run.categoryIds.filter((id) => ['done', 'failed', 'stopped'].includes(run.progress[String(id)]?.state ?? '')).length;
  return (
    <section class="card runcard" aria-labelledby="run-h" aria-live={running ? 'polite' : undefined}>
      <div class="ch">
        <h2 id="run-h">
          {running
            ? `Finding & ranking ${plural(run.categoryIds.length, 'category', 'categories')}`
            : `${plural(list.length, 'category', 'categories')} could not be ranked`}
        </h2>
        {running && (
          <span>
            {finished} of {run.categoryIds.length} done · started {startedText(run.startedAt, t)}
          </span>
        )}
      </div>
      {list.map((id) => (
        <RunRow
          id={id}
          cat={byId.get(id)}
          p={run.progress[String(id)] ?? { state: 'waiting' }}
          running={running}
          hasLlm={hasLlm}
          outcome={outcomes.get(id)}
        />
      ))}
    </section>
  );
};

const RunRow: FC<{
  id: number;
  cat: Category | undefined;
  p: FindRunProgress[string];
  running: boolean;
  hasLlm: boolean;
  outcome: Outcome | undefined;
}> = ({ id, cat, p, running, hasLlm, outcome }) => {
  let icon: Child;
  let cls: 'done' | 'busy' | 'wait' | 'fail';
  let chip: string;
  let text: Child;
  switch (p.state) {
    case 'done': {
      cls = 'done';
      chip = 'Done';
      icon = <CheckIcon size={16} sw={2.6} />;
      const found = p.found ?? 0;
      const o = outcome ?? { picks: 0, current: 0, changes: 0 };
      const verdict =
        found === 0
          ? 'Nothing open nearby fits this category. Try other search terms on the Categories page.'
          : `${found} found, ${o.picks} recommended. ${
              o.changes === 0
                ? o.current === 1
                  ? 'Same pick as now.'
                  : `Same ${o.current} as now.`
                : `${plural(o.changes, 'change')} to review.`
            }`;
      text = p.message ? `${verdict} Ranked without AI.` : verdict;
      break;
    }
    case 'searching':
    case 'ranking':
      cls = 'busy';
      chip = p.state === 'searching' ? 'Searching' : 'Ranking';
      icon = <ClockIcon />;
      text =
        p.state === 'searching'
          ? `Searching Google for ${listWords((cat?.searchTerms ?? []).map((term) => `“${term}”`))}.`
          : hasLlm
            ? 'The AI is comparing hours, reviews and distance.'
            : 'Ranking by hours, rating and distance.';
      break;
    case 'failed':
    case 'stopped': {
      cls = 'fail';
      chip = p.state === 'failed' ? 'Failed' : 'Stopped';
      icon = <WarnIcon size={16} sw={2.4} />;
      const message = p.message ?? 'Something went wrong.';
      const keyProblem = /\bkey\b/i.test(message);
      const monthCap = /month/i.test(message);
      const n = outcome?.current ?? 0;
      text = (
        <>
          {message} {n > 0 ? `Your current ${plural(n, 'pick')} ${n === 1 ? 'is' : 'are'} untouched.` : 'Nothing was changed.'}{' '}
          {keyProblem ? (
            <>
              <a href={SETUP_SERVICES}>Check the key in Setup → Services</a>, then run this category again.
            </>
          ) : monthCap ? null : running ? (
            'Run it again when this search finishes.'
          ) : (
            cat && (
              <form method="post" action={`${BASE}/runs`}>
                <input type="hidden" name="category_id" value={String(id)} />
                <button type="submit" class="linkbtn">
                  Run this category again
                </button>
              </form>
            )
          )}
        </>
      );
      break;
    }
    default:
      cls = 'wait';
      chip = 'Waiting';
      icon = <DashIcon />;
      text = 'Waiting';
  }
  return (
    <div class="runrow">
      <span class={`ic ${cls}`}>{icon}</span>
      <div>
        <div class="n">{cat?.name ?? 'Deleted category'}</div>
        <div class={cls === 'fail' ? 's fail' : 's'}>{text}</div>
      </div>
      <span class={`st ${cls}`}>{chip}</span>
    </div>
  );
};

/* Category section ------------------------------------------------------------------------------ */
const GROUP_NOTES = {
  backup: 'good, but not top 3',
  avoid: 'closed when it matters, poor or suspicious, or wrong kind of place',
  none: 'added by hand, or missing from the latest search',
};

const Section: FC<{
  m: SectionModel;
  radius: number;
  t: Date;
  tz: string;
  hasLlm: boolean;
  aiMessage: string | undefined;
  saved: boolean;
  removed: boolean;
  error: string | undefined;
}> = ({ m, radius, t, tz, hasLlm, aiMessage, saved, removed, error }) => {
  const { category: cat, rows } = m;
  const summary = changeSummary(rows, m.checked, m.names);
  const formId = `picks-${cat.id}`;
  const picks = rows.filter((r) => r.rankVerdict === 'pick');
  const backups = rows.filter((r) => r.rankVerdict === 'backup');
  const outs = rows.filter((r) => r.rankVerdict === 'avoid');
  const unranked = rows.filter((r) => r.rankVerdict === null);
  const rest = [...backups, ...outs, ...unranked];
  const restParts = [
    backups.length ? plural(backups.length, 'backup') : null,
    outs.length ? `${outs.length} ruled out` : null,
    unranked.length ? `${unranked.length} not ranked` : null,
  ].filter((p): p is string => p !== null);
  // Open the rest when it holds something on the family site, or a box the admin checked.
  const restOpen = picks.length === 0 || rest.some((r) => r.currentPick || m.checked.has(r.id));
  const meta = [
    cat.hoursNeed === 'daytime' ? 'Daytime category: whoever is open during the day. At night, use the ER.' : null,
    m.rankedAt
      ? `${m.rankedBy === 'llm' ? 'Ranked by AI' : 'Ranked without AI'} ${agoText(m.rankedAt, t, tz)}`
      : 'Not searched yet',
    m.rankedAt ? `${m.found} found within ${radius} mi` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const returnTo = `${BASE}?removed=${encodeURIComponent(cat.slug)}#${cat.slug}`;
  const rowProps = { m, formId };
  const label = saveLabel(summary);
  const why = aiMessage && /timed? ?out|timeout/i.test(aiMessage) ? 'The AI request timed out' : aiMessage ? 'The AI request failed' : null;

  return (
    <section class="card sec" id={cat.slug} aria-labelledby={`${cat.slug}-h`}>
      <form method="post" action={`${BASE}/${cat.id}/picks`} id={formId} class="picks" data-picks data-max={String(PICKS_PER_CATEGORY)}>
        <div class="sec-head">
          <div>
            <h2 id={`${cat.slug}-h`}>{cat.name}</h2>
            <div class="meta">{meta}</div>
          </div>
          <button class="btn" type="submit" data-save>
            {label}
          </button>
        </div>
        {m.rankedBy === 'rules' && (
          <div class="alert">
            <WarnIcon />
            <span>
              <b>Ranked without AI.</b>{' '}
              {why
                ? `${why}, so this order comes from hours, rating and distance alone.`
                : hasLlm
                  ? 'This order comes from hours, rating and distance alone.'
                  : 'No AI key is set, so this order comes from hours, rating and distance alone.'}{' '}
              {hasLlm ? (
                <button class="linkbtn" type="submit" form={`rerank-${cat.id}`}>
                  Rank again with AI
                </button>
              ) : (
                <a href={SETUP_SERVICES}>Add an AI key in Setup → Services</a>
              )}
            </span>
          </div>
        )}
        {saved && !error && (
          <div class="saved" role="status">
            {savedText(m.current.length)}
          </div>
        )}
        {removed && !error && (
          <div class="saved" role="status">
            Done. That place won't be suggested again.
          </div>
        )}
        {error ? (
          <div class="change err" role="alert" data-summary>
            {error}
          </div>
        ) : (
          // Hidden right after a save; admin.js shows it again once a box changes.
          <div class={summary.error ? 'change err' : 'change'} data-summary aria-live="polite" hidden={saved}>
            {summary.text}
          </div>
        )}
        <div class="phead" aria-hidden="true">
          <span>Pick</span>
          <span>#</span>
          <span>Place</span>
          <span>Hours</span>
          <span>Reviews</span>
          <span>Dist.</span>
          <span>Why</span>
        </div>
        <div class="rows">
          {m.rankedAt && (
            <GroupHead text="Recommended" note={m.rankedBy === 'llm' ? 'top 3 by the AI' : 'by hours, rating and distance'} />
          )}
          {m.rankedAt && picks.length === 0 && <p class="muted ghead">None. Nothing found fits this category well; check the backups.</p>}
          {picks.map((r) => (
            <Row r={r} {...rowProps} />
          ))}
        </div>
        {rest.length > 0 && (
          <details class="rest" open={restOpen}>
            <summary>
              <ChevronDown />
              <span class="when-closed">Show {listWords(restParts)}</span>
              <span class="when-open">Hide {listWords(restParts.map((p) => p.replace(/^\d+ /, '')))}</span>
            </summary>
            <div class="rows">
              {backups.length > 0 && <GroupHead text="Backups" note={GROUP_NOTES.backup} />}
              {backups.map((r) => (
                <Row r={r} {...rowProps} />
              ))}
              {outs.length > 0 && <GroupHead text="Ruled out" note={GROUP_NOTES.avoid} />}
              {outs.map((r) => (
                <Row r={r} {...rowProps} />
              ))}
              {unranked.length > 0 && <GroupHead text="Not ranked" note={GROUP_NOTES.none} />}
              {unranked.map((r) => (
                <Row r={r} {...rowProps} />
              ))}
            </div>
          </details>
        )}
        <div class="savebar">
          <button class="btn" type="submit" data-save>
            {label}
          </button>
        </div>
      </form>
      {/* Forms cannot nest: the row buttons reach these through their form attribute. */}
      {rows.map((r) => (
        <form method="post" action={`${BASE}/locations/${r.id}/never`} id={`never-${r.id}`} hidden>
          <input type="hidden" name="return_to" value={returnTo} />
        </form>
      ))}
      {m.rankedBy === 'rules' && hasLlm && (
        <form method="post" action={`${BASE}/runs`} id={`rerank-${cat.id}`} hidden>
          <input type="hidden" name="category_id" value={String(cat.id)} />
        </form>
      )}
    </section>
  );
};

const GroupHead: FC<{ text: string; note: string }> = ({ text, note }) => (
  <div class="ghead">
    <span class="label">{text}</span>
    <span class="muted">{note}</span>
  </div>
);

const Row: FC<{ r: RankedRow; m: SectionModel; formId: string }> = ({ r, m }) => {
  const hours = hoursCell(r, m.category.hoursNeed);
  const rating = ratingText(r);
  const flags = (r.rankFlags ?? []).map(flagLabel);
  const out = r.rankVerdict === 'avoid' || r.rankVerdict === null;
  const showRank = r.rankVerdict === 'pick' || r.rankVerdict === 'backup';
  return (
    <div class={out ? 'prow is-out' : 'prow'}>
      <label class="pick">
        <input
          type="checkbox"
          name="location_id"
          value={String(r.id)}
          checked={m.checked.has(r.id)}
          data-short={m.names.get(r.id)}
          data-current={r.currentPick ? '1' : undefined}
        />
        <span class="sr-only">Pick {r.name}</span>
      </label>
      <div class="rk">
        {showRank && r.rankPosition !== null && (
          <span class={r.rankVerdict === 'pick' ? 'rank pick-r' : 'rank backup-r'}>{r.rankPosition}</span>
        )}
      </div>
      <div class="place">
        <div class="name">
          {r.name}
          {r.currentPick && <span class="tag">On family site</span>}
        </div>
        <div class="addr">{r.shortAddress ?? r.address ?? ''}</div>
        {/* Phones show the tag under the address, as in the phone mockup; only one of the two is ever displayed. */}
        {r.currentPick && <span class="tag tag-below">On family site</span>}
      </div>
      <div class="hours">
        <span class={`pill ${hours.pill}`}>{hours.text}</span>
        {hours.note && <div class="hnote">{hours.note}</div>}
      </div>
      <div class="rv">
        <b>{rating.rating}</b>
        <span class="c">{rating.reviews}</span>
      </div>
      <div class="dist">{r.distanceMi === null ? '—' : `${r.distanceMi.toFixed(1)} mi`}</div>
      <div class="why">
        {r.rankReason && <p>{r.rankReason}</p>}
        {flags.length > 0 && (
          <div class="flags">
            {flags.map((f) => (
              <span class="flag">
                <WarnIcon size={13} sw={2.4} />
                {f}
              </span>
            ))}
          </div>
        )}
        <button class="never" type="submit" form={`never-${r.id}`}>
          Never suggest this place
        </button>
      </div>
    </div>
  );
};
