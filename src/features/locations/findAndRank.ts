import { and, desc, eq, notInArray } from 'drizzle-orm';
import type { AppDeps } from '../../app.js';
import type { Db, DbOrTx } from '../../db/client.js';
import { findRuns, locations, type FindRun, type NewFindRun } from '../../db/schema.js';
import { hoursProfile, type HoursProfile } from '../../domain/hours.js';
import { fallbackRank, type PlaceRanking, type RankFlag } from '../../domain/ranking.js';
import type { FindRunProgress, FindRunCategoryState, LatLng, Logger, RankedBy, RankVerdict } from '../../domain/types.js';
import { describePlacesError } from '../../services/keyProbe.js';
import type { LlmProvider } from '../../services/llm/provider.js';
import { prepass, rankPlaceFromCandidate, rankWithLlm, type RankPlace } from '../../services/llm/rankPlaces.js';
import { newPlacesBudget } from '../../services/places/budget.js';
import { BudgetExhausted, PlacesError, candidateToTracked, richSearch, type PlacesDeps } from '../../services/places/client.js';
import type { PlaceCandidate } from '../../services/places/types.js';
import { llmOf, type PlacesDep } from '../../services/resolver.js';
import { getSettings } from '../admin/settingsRepo.js';
import { getCategory, type Category } from '../categories/repo.js';
import { getLocation, type Location } from './repo.js';
import { LocationError } from './service.js';

export class NoHomeLocation extends Error {}

/** Only one find run at a time; starting another while one is running throws this. */
export class FindRunActive extends Error {
  constructor(readonly runId: number) {
    super(`Find run ${runId} is still running`);
    this.name = 'FindRunActive';
  }
}

export type FindRunDeps = {
  /** One budget covers the whole run. */
  places: PlacesDeps;
  /** Without a provider every category is ranked by rules. */
  llm?: LlmProvider;
  model: string;
  now: () => Date;
  log: Logger;
};

/** Run deps from the app's deps, the way the routes resolve them: a fresh budget, the LLM if a key is set. */
export function findRunDeps(deps: AppDeps, places: PlacesDep): FindRunDeps {
  const now = deps.now ?? (() => new Date());
  const llm = llmOf(deps);
  return {
    places: { ...places, budget: newPlacesBudget(deps.db, deps.env, deps.now) },
    ...(llm ? { llm } : {}),
    model: deps.env.LLM_DRAFT_MODEL,
    now,
    log: console,
  };
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function homeOf(db: Db): { home: LatLng; radiusMi: number } {
  const { homeLat, homeLng, defaultRadiusMi } = getSettings(db);
  if (homeLat === null || homeLng === null) throw new NoHomeLocation('Home location is not set');
  return { home: { lat: homeLat, lng: homeLng }, radiusMi: defaultRadiusMi ?? 15 };
}

export function getRun(db: Db, id: number): FindRun | null {
  return db.select().from(findRuns).where(eq(findRuns.id, id)).get() ?? null;
}

export function latestRun(db: Db): FindRun | null {
  return db.select().from(findRuns).orderBy(desc(findRuns.id)).limit(1).get() ?? null;
}

function failRun(db: Db, id: number, error: string, at: Date): void {
  const run = getRun(db, id);
  if (!run || run.status !== 'running') return;
  const progress: FindRunProgress = {};
  for (const [key, p] of Object.entries(run.progress)) {
    progress[key] = ['waiting', 'searching', 'ranking'].includes(p.state) ? { state: 'failed', message: error } : p;
  }
  db.update(findRuns).set({ status: 'failed', error, finishedAt: at, progress }).where(eq(findRuns.id, id)).run();
}

/**
 * Records a run for the given categories and returns its id at once; the searching and ranking carry on in the
 * background (see runFindRun). Throws NoHomeLocation, LocationError for an unknown category, or FindRunActive.
 */
export function startFindRun(db: Db, categoryIds: number[], deps: FindRunDeps): number {
  const ids = [...new Set(categoryIds)];
  if (ids.length === 0) throw new LocationError('invalid', 'Choose at least one category');
  for (const id of ids) if (!getCategory(db, id)) throw new LocationError('not_found', 'Category not found');
  homeOf(db);

  const id = db.transaction((tx) => {
    const running = tx.select({ id: findRuns.id }).from(findRuns).where(eq(findRuns.status, 'running')).get();
    if (running) throw new FindRunActive(running.id);
    return tx
      .insert(findRuns)
      .values({
        startedAt: deps.now(),
        status: 'running',
        categoryIds: ids,
        progress: Object.fromEntries(ids.map((c) => [String(c), { state: 'waiting' as const }])),
      })
      .returning({ id: findRuns.id })
      .get().id;
  });

  void runFindRun(db, id, deps).catch((e: unknown) => {
    deps.log.error(`Find run ${id} failed: ${errorText(e)}`);
    failRun(db, id, errorText(e), deps.now());
  });
  return id;
}

/** At boot: a run still marked running was cut off by a restart. Returns how many were closed. */
export function recoverInterruptedRuns(db: Db, now: Date): number {
  const running = db.select({ id: findRuns.id }).from(findRuns).where(eq(findRuns.status, 'running')).all();
  for (const { id } of running) failRun(db, id, 'Interrupted by a restart', now);
  return running.length;
}

/**
 * The run itself, awaitable for tests: each category in turn is searched, merged with its stored rows, ranked
 * and written back. A Places error fails that category only; an exhausted budget stops it and every later one.
 * The run ends `done`, or `failed` (rethrown) only on an unexpected error.
 */
export async function runFindRun(db: Db, runId: number, deps: FindRunDeps): Promise<FindRun> {
  const run = getRun(db, runId);
  if (!run) throw new Error(`Find run ${runId} not found`);
  const progress: FindRunProgress = { ...run.progress };
  let llmCalls = run.llmCalls;
  const save = (patch: Partial<NewFindRun> = {}) =>
    db
      .update(findRuns)
      .set({ progress, callsUsed: deps.places.budget.used, llmCalls, ...patch })
      .where(eq(findRuns.id, runId))
      .run();

  try {
    const area = homeOf(db);
    let stopped: string | null = null;
    for (const categoryId of run.categoryIds) {
      const key = String(categoryId);
      if (stopped !== null) {
        progress[key] = { state: 'stopped', message: stopped };
        continue;
      }
      const category = getCategory(db, categoryId);
      if (!category) {
        progress[key] = { state: 'failed', message: 'This category was deleted.' };
        save();
        continue;
      }
      try {
        const setState = (state: FindRunCategoryState) => {
          progress[key] = { state };
          save();
        };
        const result = await findAndRankCategory(db, category, area, deps, setState, () => llmCalls++);
        progress[key] = { state: 'done', found: result.found, ...(result.message ? { message: result.message } : {}) };
      } catch (e) {
        if (e instanceof BudgetExhausted) {
          stopped = describePlacesError(e, deps.places.apiKey);
          progress[key] = { state: 'stopped', message: stopped };
          deps.log.warn(`Find run ${runId} stopped at ${category.name}: ${e.message}`);
        } else if (e instanceof PlacesError) {
          progress[key] = { state: 'failed', message: describePlacesError(e, deps.places.apiKey) };
          deps.log.warn(`Find run ${runId}: ${category.name} failed: ${e.message.slice(0, 200)}`);
        } else {
          throw e;
        }
      }
      save();
    }
    save({ status: 'done', finishedAt: deps.now() });
  } catch (e) {
    save();
    failRun(db, runId, errorText(e), deps.now());
    throw e;
  }
  return getRun(db, runId)!;
}

type RankItem = RankPlace & { row: Location | null; candidate: PlaceCandidate | null };

const rankPlaceFromRow = (row: Location): RankPlace => ({
  name: row.name,
  address: row.address,
  shortAddress: row.shortAddress,
  lat: row.lat,
  lng: row.lng,
  distanceMi: row.distanceMi,
  businessStatus: row.businessStatus,
  rating: row.rating,
  ratingCount: row.ratingCount,
  primaryType: row.primaryType,
  hours: row.hours,
  openNow: null,
  phone: row.phone,
  reviews: [],
});

const NO_RANK = {
  rankVerdict: null,
  rankPosition: null,
  rankReason: null,
  rankFlags: null,
  rankedBy: null,
  rankedAt: null,
} as const;

type RankFields = { verdict: RankVerdict; position: number; reason: string; flags: RankFlag[]; rankedBy: RankedBy };

async function findAndRankCategory(
  db: Db,
  category: Category,
  area: { home: LatLng; radiusMi: number },
  deps: FindRunDeps,
  setState: (state: FindRunCategoryState) => void,
  countLlmCall: () => void,
): Promise<{ found: number; message?: string }> {
  setState('searching');
  const merged = new Map<string, PlaceCandidate>();
  for (const term of category.searchTerms) {
    for (const c of await richSearch(term, { center: area.home, radiusMi: area.radiusMi }, deps.places)) {
      if (!merged.has(c.placeId)) merged.set(c.placeId, c);
    }
  }
  setState('ranking');

  // Search results (minus places rejected in this category), then this category's stored rows the search missed.
  const rows = db.select().from(locations).where(eq(locations.categoryId, category.id)).all();
  const byPlaceId = new Map(rows.flatMap((r) => (r.placeId ? [[r.placeId, r] as const] : [])));
  const items: RankItem[] = [];
  for (const c of merged.values()) {
    const row = byPlaceId.get(c.placeId) ?? null;
    if (row?.status === 'rejected') continue;
    items.push({ ...rankPlaceFromCandidate(c), row, candidate: c });
  }
  for (const row of rows) {
    if (row.status === 'rejected' || (row.placeId !== null && merged.has(row.placeId))) continue;
    items.push({ ...rankPlaceFromRow(row), row, candidate: null });
  }

  const { kept, dropped } = prepass(items, { ...area, dedupePhone: category.area === 'home' });
  let ranking: PlaceRanking[];
  let rankedBy: RankedBy = 'rules';
  let message: string | undefined;
  if (deps.llm && kept.length > 0) {
    try {
      countLlmCall();
      ranking = await rankWithLlm(deps.llm, deps.model, category, kept);
      rankedBy = 'llm';
    } catch (e) {
      message = `AI ranking failed, so these were ranked by rules: ${errorText(e).slice(0, 200)}`;
      deps.log.warn(`Ranking ${category.name} with the LLM failed: ${errorText(e).slice(0, 200)}`);
      ranking = fallbackRank(category.hoursNeed, kept);
    }
  } else {
    ranking = fallbackRank(category.hoursNeed, kept);
  }

  const at = deps.now();
  db.transaction((tx) => {
    const written: number[] = [];
    const write = (item: RankItem, distanceMi: number | null, rank: RankFields) => {
      const id = writeItem(tx, category.id, item, distanceMi, rank, at);
      if (id !== null) written.push(id);
    };
    const byRef = new Map(kept.map((k) => [k.ref, k]));
    for (const r of ranking) {
      const k = byRef.get(r.ref)!;
      write(k.place, k.distanceMi, { verdict: r.verdict, position: r.rank, reason: r.reason, flags: r.flags, rankedBy });
    }
    // A stored place that now fails the pre-pass is shown as avoid; a new one is never stored.
    let position = ranking.length;
    for (const d of dropped) {
      if (!d.place.row) continue;
      write(d.place, d.distanceMi, {
        verdict: 'avoid',
        position: ++position,
        reason: d.reason === 'closed_permanently' ? 'Marked permanently closed by Google.' : 'Outside the search radius.',
        flags: d.reason === 'outside_radius' ? ['far'] : [],
        rankedBy: 'rules',
      });
    }
    // Anything else in the category (rejected, or deleted from Google's results and the store) loses its old rank.
    tx.update(locations)
      .set(NO_RANK)
      .where(and(eq(locations.categoryId, category.id), notInArray(locations.id, written)))
      .run();
  });
  return { found: kept.length, ...(message ? { message } : {}) };
}

/**
 * Inserts a new search result as a candidate, or refreshes a stored row. Approved and warn rows keep their
 * tracked fields (refresh and review own those); only display facts and the rank change.
 */
function writeItem(
  tx: DbOrTx,
  categoryId: number,
  item: RankItem,
  distanceMi: number | null,
  rank: RankFields,
  at: Date,
): number | null {
  const rankValues = {
    rankVerdict: rank.verdict,
    rankPosition: rank.position,
    rankReason: rank.reason,
    rankFlags: rank.flags,
    rankedBy: rank.rankedBy,
    rankedAt: at,
  };
  const c = item.candidate;
  const display = c
    ? {
        lat: c.lat,
        lng: c.lng,
        ...(distanceMi !== null ? { distanceMi } : {}),
        shortAddress: c.shortAddress,
        primaryType: c.primaryTypeDisplay ?? c.primaryType,
        mapsUri: c.mapsUri,
      }
    : {};
  // Website notes come from extraction, never from search, so a search result does not clear them.
  let tracked: Partial<typeof locations.$inferInsert> = {};
  if (c) {
    const { afterHoursNotes: _a, walkIns: _w, insuranceNotes: _i, ...facts } = candidateToTracked(c);
    tracked = { ...facts, name: c.name };
  }

  if (!item.row) {
    if (!c) return null;
    return tx
      .insert(locations)
      .values({
        ...tracked,
        ...display,
        categoryId,
        placeId: c.placeId,
        name: c.name,
        status: 'candidate',
        createdAt: at,
        updatedAt: at,
        ...rankValues,
      })
      .returning({ id: locations.id })
      .get().id;
  }
  // Re-read: the admin may have saved picks while the LLM was working.
  const current = getLocation(tx, item.row.id);
  if (!current || current.status === 'rejected') return null;
  tx.update(locations)
    .set({ ...(current.status === 'candidate' ? tracked : {}), ...display, ...rankValues, updatedAt: at })
    .where(eq(locations.id, current.id))
    .run();
  return current.id;
}

export type RankedRow = Location & {
  hoursProfile: HoursProfile;
  /** Approved or warn: what the family sees now. */
  currentPick: boolean;
};

const VERDICT_ORDER: Record<RankVerdict, number> = { pick: 0, backup: 1, avoid: 2 };

/** A category's places for the pick view: not rejected, picks then backups then avoid, by rank; unranked last. */
export function rankedView(db: Db, categoryId: number): RankedRow[] {
  return db
    .select()
    .from(locations)
    .where(eq(locations.categoryId, categoryId))
    .all()
    .filter((r) => r.status !== 'rejected')
    .sort(
      (a, b) =>
        (a.rankVerdict ? VERDICT_ORDER[a.rankVerdict] : 3) - (b.rankVerdict ? VERDICT_ORDER[b.rankVerdict] : 3) ||
        (a.rankPosition ?? Infinity) - (b.rankPosition ?? Infinity) ||
        (a.distanceMi ?? Infinity) - (b.distanceMi ?? Infinity) ||
        a.id - b.id,
    )
    .map((r) => ({ ...r, hoursProfile: hoursProfile(r.hours), currentPick: r.status === 'approved' || r.status === 'warn' }));
}
