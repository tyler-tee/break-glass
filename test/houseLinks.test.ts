import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { categories, locations } from '../src/db/schema.js';
import { createFact, type HouseFactInput } from '../src/features/house/repo.js';
import {
  guideLinks, linkedFor, parseSteps, placeFacts, shortNames, stepMentions, systemsForTags, tradesForTags,
} from '../src/features/house/links.js';
import { createTestDb } from './helpers/testDb.js';

const NOW = new Date('2026-10-28T16:00:00Z');
const TZ = 'America/Denver';

let db: Db;
beforeEach(() => {
  db = createTestDb();
});

const cat = (name: string, slug: string, area: 'health' | 'home' = 'home', searchTerms: string[] = [slug]) =>
  db.insert(categories).values({ name, slug, searchTerms, area }).returning().get();
const place = (categoryId: number, name: string, over: Partial<typeof locations.$inferInsert> = {}) =>
  db.insert(locations).values({ categoryId, name, status: 'approved', createdAt: NOW, updatedAt: NOW, ...over }).returning().get();
const fact = (input: HouseFactInput) => createFact(db, input, NOW);

describe('systemsForTags and tradesForTags', () => {
  it('keeps only house systems, in tag order, ignoring case and repeats', () => {
    expect(systemsForTags(['Water', 'emergency-plumber', 'hvac', 'water'])).toEqual(['water', 'hvac']);
    expect(systemsForTags(null)).toEqual([]);
  });

  it('returns every home category matching a tag by slug, name or search term, in tag order, never health ones', () => {
    const plumber = cat('Emergency plumber', 'emergency-plumber', 'home', ['burst pipe']);
    const cooling = cat('Heating and cooling repair', 'heating-cooling-repair');
    const twin = cat('Plumbing Twin', 'plumbing-twin', 'home', ['Burst Pipe']);
    cat('Dentist', 'dentist', 'health', ['burst pipe']);
    const all = db.select().from(categories).all();
    expect(tradesForTags(all, ['heating-cooling-repair', 'burst pipe', 'EMERGENCY-PLUMBER']).map((c) => c.id)).toEqual([
      cooling.id, plumber.id, twin.id,
    ]);
    expect(tradesForTags(all, ['nothing'])).toEqual([]);
  });
});

describe('linkedFor', () => {
  it('links shutoffs, notes and utilities by system, and contacts by trade, in sort order', () => {
    const plumber = cat('Emergency plumber', 'emergency-plumber');
    const electrician = cat('Emergency electrician', 'emergency-electrician');
    const main = fact({ kind: 'shutoff', system: 'water', title: 'Water main', whereNote: 'By the mailbox' });
    fact({ kind: 'shutoff', system: 'electric', title: 'Breaker panel', whereNote: 'Garage' });
    const note = fact({ kind: 'note', system: 'water', title: 'Softener', instructions: 'Bypass is on the left' });
    const util = fact({ kind: 'utility', system: 'water', title: 'Water utility', org: 'Metro Water', phone: '555-010-0100' });
    fact({ kind: 'utility', system: 'electric', title: 'Power utility', org: 'Metro Power', phone: '555-010-0101' });
    const b = fact({ kind: 'contact', title: 'B Plumbing', phone: '555-010-0102', categoryId: plumber.id });
    const a = fact({ kind: 'contact', title: 'A Plumbing', phone: '555-010-0103', categoryId: plumber.id });
    fact({ kind: 'contact', title: 'Sparky', phone: '555-010-0104', categoryId: electrician.id });
    fact({ kind: 'contact', title: 'Unlinked', phone: '555-010-0105' });

    const links = linkedFor(db, ['water', 'emergency-plumber']);
    expect(links.systems).toEqual(['water']);
    expect(links.trades.map((t) => t.id)).toEqual([plumber.id]);
    expect(links.linkedFacts.map((f) => f.id)).toEqual([main.id, note.id, util.id]);
    expect(links.utilities.map((f) => f.id)).toEqual([util.id]);
    expect(links.ours.map((f) => f.id)).toEqual([b.id, a.id]);
  });

  it('links nothing for a guide with no matching tags', () => {
    fact({ kind: 'shutoff', system: 'water', title: 'Water main', whereNote: 'x' });
    const links = linkedFor(db, ['mystery']);
    expect(links).toMatchObject({ systems: [], trades: [], linkedFacts: [], ours: [], utilities: [] });
  });
});

describe('guideLinks picks', () => {
  it('orders by rank then distance (nulls last), drops our own phone, caps at 3 per trade', () => {
    const plumber = cat('Emergency plumber', 'emergency-plumber');
    const restoration = cat('Water damage restoration', 'water-damage-restoration');
    fact({ kind: 'contact', title: 'Ours Plumbing', phone: '(555) 010-0100', categoryId: plumber.id });
    place(plumber.id, 'Unranked far', { distanceMi: 9 });
    place(plumber.id, 'Unranked near', { distanceMi: 1 });
    place(plumber.id, 'Rank 2', { rankPosition: 2, distanceMi: 5 });
    place(plumber.id, 'Rank 1', { rankPosition: 1, distanceMi: 7 });
    place(plumber.id, 'Same as ours', { rankPosition: 0, phone: '+1 555-010-0100' });
    place(plumber.id, 'Rejected', { status: 'rejected', rankPosition: 0 });
    place(restoration.id, 'Dryout', { rankPosition: 1 });

    const links = guideLinks(db, ['emergency-plumber', 'water-damage-restoration'], NOW, TZ);
    expect(links.picks.map((p) => p.name)).toEqual(['Rank 1', 'Rank 2', 'Unranked near', 'Dryout']);
  });

  it('skips places reported permanently closed', () => {
    const plumber = cat('Emergency plumber', 'emergency-plumber');
    place(plumber.id, 'Gone', { businessStatus: 'CLOSED_PERMANENTLY' });
    place(plumber.id, 'Here');
    expect(guideLinks(db, ['emergency-plumber'], NOW, TZ).picks.map((p) => p.name)).toEqual(['Here']);
  });
});

describe('stepMentions and placeFacts', () => {
  it('matches whole words, ignoring case and spacing', () => {
    expect(stepMentions('Shut off the water main.', 'Water main')).toBe(true);
    expect(stepMentions('Shut off the WATER   MAIN now', 'water main')).toBe(true);
    expect(stepMentions('Call the water mains crew', 'Water main')).toBe(false);
    expect(stepMentions('Anything', '   ')).toBe(false);
    expect(stepMentions('Flip the (A) breaker', '(A) breaker')).toBe(true);
  });

  it('places each fact in the first matching step once; the rest are unplaced', () => {
    const main = fact({ kind: 'shutoff', system: 'water', title: 'Water main', whereNote: 'x' });
    const panel = fact({ kind: 'shutoff', system: 'electric', title: 'Breaker panel', whereNote: 'y' });
    const { byStep, unplaced } = placeFacts(
      ['Stay out of the water.', 'Shut off the water main.', 'Check the water main again.'],
      [main, panel],
    );
    expect([...byStep.entries()]).toEqual([[1, [main]]]);
    expect(unplaced).toEqual([panel]);
  });

  it('also places a fact by its title without leading system words, when two or more words remain', () => {
    expect(shortNames('AC air handler')).toEqual(['air handler']);
    expect(shortNames('Water main')).toEqual([]);
    expect(shortNames('Breaker panel')).toEqual([]);
    const handler = fact({ kind: 'shutoff', system: 'hvac', title: 'AC air handler', whereNote: 'closet' });
    const main = fact({ kind: 'shutoff', system: 'water', title: 'Water main', whereNote: 'yard' });
    const { byStep, unplaced } = placeFacts(['Check the filter at the air handler.', 'Turn off the main.'], [handler, main]);
    expect([...byStep.entries()]).toEqual([[0, [handler]]]);
    expect(unplaced).toEqual([main]);
  });
});

describe('parseSteps', () => {
  it('returns the first list items with plain text, and the markdown around it', () => {
    const parsed = parseSteps('Before text\n\n1. Stop **the water main**.\n2. Call [us](https://example.com).\n\nAfter text\n');
    expect(parsed?.items.map((i) => i.text.trim())).toEqual(['Stop the water main.', 'Call us.']);
    expect(parsed?.items[0]?.md).toBe('Stop **the water main**.');
    expect(parsed?.before.trim()).toBe('Before text');
    expect(parsed?.after.trim()).toBe('After text');
  });

  it('is null when there is no list', () => {
    expect(parseSteps('Just a paragraph.')).toBeNull();
  });
});
