import { marked } from 'marked';
import type { Db } from '../../db/client.js';
import { HOUSE_SYSTEMS, type HouseSystem } from '../../domain/types.js';
import { normPhone } from '../../services/llm/rankPlaces.js';
import { listCategories, type Category } from '../categories/repo.js';
import { forFamily } from '../locations/familyViews.js';
import { listVisibleByCategory, type LocationView } from '../locations/search.js';
import { listFacts, type HouseFact } from './repo.js';

// How a home guide finds the household's own facts and the vetted trades. One module so the family pages
// and the admin "Linked" line agree.

export const MAX_PICKS_PER_TRADE = 3;

const bySort = (a: HouseFact, b: HouseFact) => a.sortOrder - b.sortOrder || a.id - b.id;

/** Every fact, in the order the household set (sort order, then creation). */
export function orderedFacts(db: Db): HouseFact[] {
  return listFacts(db).sort(bySort);
}

const cleanTags = (tags: readonly string[] | null | undefined): string[] =>
  (tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);

/** House systems named by the tags, in tag order. */
export function systemsForTags(tags: readonly string[] | null | undefined): HouseSystem[] {
  const out: HouseSystem[] = [];
  for (const t of cleanTags(tags)) {
    const hit = HOUSE_SYSTEMS.find((s) => s === t);
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/**
 * Home categories a tag points at: slug, name or a search term equals the tag (the categoryForTags rule),
 * but every match is returned, in tag order.
 */
export function tradesForTags(cats: readonly Category[], tags: readonly string[] | null | undefined): Category[] {
  const out: Category[] = [];
  for (const tag of cleanTags(tags)) {
    for (const c of cats) {
      if (c.area !== 'home' || out.includes(c)) continue;
      if (c.name.toLowerCase() === tag || c.slug === tag || c.searchTerms.some((s) => s.toLowerCase() === tag)) out.push(c);
    }
  }
  return out;
}

export type LinkedFacts = {
  systems: HouseSystem[];
  trades: Category[];
  /** Shutoff, note and utility facts of the guide's systems. */
  linkedFacts: HouseFact[];
  /** Contact facts for the guide's trades: the household's own companies. */
  ours: HouseFact[];
  utilities: HouseFact[];
};

/** The fact-side links for a guide's tags; no clock needed. */
export function linkedFor(db: Db, tags: readonly string[] | null | undefined): LinkedFacts {
  const systems = systemsForTags(tags);
  const trades = tradesForTags(listCategories(db, { area: 'home' }), tags);
  const facts = orderedFacts(db);
  const inSystems = (f: HouseFact) => systems.includes(f.system as HouseSystem);
  const tradeIds = new Set(trades.map((t) => t.id));
  return {
    systems,
    trades,
    linkedFacts: facts.filter((f) => (f.kind === 'shutoff' || f.kind === 'note' || f.kind === 'utility') && inSystems(f)),
    ours: facts.filter((f) => f.kind === 'contact' && f.categoryId !== null && tradeIds.has(f.categoryId)),
    utilities: facts.filter((f) => f.kind === 'utility' && inSystems(f)),
  };
}

const distance = (v: LocationView) => v.distanceMi ?? Number.POSITIVE_INFINITY;

/** Approved or warn places in the trades: ranked first, then nearest; minus our own companies; at most 3 per trade. */
export function picksFor(
  db: Db,
  trades: readonly Category[],
  ours: readonly HouseFact[],
  now: Date,
  tz: string,
): LocationView[] {
  const ourPhones = new Set(ours.map((f) => normPhone(f.phone)).filter((p): p is string => p !== null));
  const seen = new Set<number>();
  const out: LocationView[] = [];
  for (const trade of trades) {
    const ranked = forFamily(listVisibleByCategory(db, trade.slug, now, tz)).sort(
      (a, b) =>
        (a.rankPosition ?? Number.POSITIVE_INFINITY) - (b.rankPosition ?? Number.POSITIVE_INFINITY) ||
        distance(a) - distance(b) ||
        a.id - b.id,
    );
    let taken = 0;
    for (const v of ranked) {
      if (taken >= MAX_PICKS_PER_TRADE) break;
      const phone = normPhone(v.phone);
      if (phone !== null && ourPhones.has(phone)) continue;
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      out.push(v);
      taken++;
    }
  }
  return out;
}

export type GuideLinks = LinkedFacts & { picks: LocationView[] };

export function guideLinks(db: Db, tags: readonly string[] | null | undefined, now: Date, tz: string): GuideLinks {
  const linked = linkedFor(db, tags);
  return { ...linked, picks: picksFor(db, linked.trades, linked.ours, now, tz) };
}

/** Drops facts whose phone repeats an earlier one, e.g. one company entered as both our plumber and our AC company. */
export function uniqueByPhone(facts: readonly HouseFact[]): HouseFact[] {
  const seen = new Set<string>();
  return facts.filter((f) => {
    const p = normPhone(f.phone);
    if (p === null) return true;
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
}

// ---- inline placement in steps ----

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const plain = (html: string) => html.replace(/<\/(?:p|li|ul|ol|h\d)>/g, ' ').replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m]!);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when the step's text contains the title as whole words, ignoring case. */
export function stepMentions(stepText: string, title: string): boolean {
  const words = title.trim().split(/\s+/).filter(Boolean).map(escapeRe);
  if (words.length === 0) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${words.join('\\s+')}(?![\\p{L}\\p{N}])`, 'iu').test(stepText);
}

const QUALIFIERS = new Set(['ac', 'a/c', 'hvac', 'water', 'gas', 'electric', 'electrical', 'power', 'house', 'home']);

/**
 * Shorter names a step may use for a fact: the title without its leading system words ("AC air handler" →
 * "air handler"). Only when at least two words remain, so "Water main" never shrinks to a bare "main".
 */
export function shortNames(title: string): string[] {
  const words = title.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && QUALIFIERS.has(words[i]!.toLowerCase())) i++;
  return i > 0 && words.length - i >= 2 ? [words.slice(i).join(' ')] : [];
}

/**
 * Puts each fact in the first step that names it (by its title, or a short name from shortNames). Facts no step names come back in `unplaced`.
 * Each fact lands once.
 */
export function placeFacts(
  stepTexts: readonly string[],
  facts: readonly HouseFact[],
): { byStep: Map<number, HouseFact[]>; unplaced: HouseFact[] } {
  const byStep = new Map<number, HouseFact[]>();
  const unplaced: HouseFact[] = [];
  for (const fact of facts) {
    const names = [fact.title, ...shortNames(fact.title)];
    const at = stepTexts.findIndex((t) => names.some((n) => stepMentions(t, n)));
    if (at === -1) {
      unplaced.push(fact);
    } else {
      byStep.set(at, [...(byStep.get(at) ?? []), fact]);
    }
  }
  return { byStep, unplaced };
}

export type StepsParts = { before: string; items: { md: string; text: string }[]; after: string } | null;

/** Splits a Steps section into its first list's items (markdown and plain text) plus the markdown around it. Null when there is no list. */
export function parseSteps(md: string): StepsParts {
  const tokens = marked.lexer(md);
  const at = tokens.findIndex((t) => t.type === 'list');
  if (at === -1) return null;
  const list = tokens[at] as unknown as { items: { text: string }[] };
  const raw = (ts: { raw: string }[]) => ts.map((t) => t.raw).join('');
  return {
    before: raw(tokens.slice(0, at)),
    items: list.items.map((i) => ({ md: i.text, text: plain(marked.parse(i.text, { async: false }) as string) })),
    after: raw(tokens.slice(at + 1)),
  };
}
