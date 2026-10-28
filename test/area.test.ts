import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { categories, locations, protocols, protocolVersions } from '../src/db/schema.js';
import type { Area } from '../src/domain/types.js';
import { loadEnv } from '../src/env.js';
import { stepDone } from '../src/features/admin/setup/steps.js';
import { CategoryError, createCategory, updateCategory } from '../src/features/categories/repo.js';
import { categoryForTags } from '../src/features/locations/familyViews.js';
import { getPublished } from '../src/features/protocols/repo.js';
import { SOP_HEADINGS } from '../src/services/llm/draft.js';
import { createTestDb } from './helpers/testDb.js';

const NOW = new Date('2026-10-27T16:00:00Z');
const body = SOP_HEADINGS.map((h) => `${h}\nsome text`).join('\n\n');

let db: Db;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = createTestDb();
  app = createApp({
    db,
    env: loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: 'x' }),
    now: () => NOW,
  });
});

function addCategory(name: string, slug: string, area: Area, withLocation = true) {
  const cat = db.insert(categories).values({ name, slug, searchTerms: [slug], area }).returning().get();
  if (withLocation) {
    db.insert(locations)
      .values({ categoryId: cat.id, name: `${name} Place`, status: 'approved', distanceMi: 1, createdAt: NOW, updatedAt: NOW })
      .run();
  }
  return cat;
}

function addProtocol(slug: string, title: string, area: Area, tags: string[] = []) {
  const p = db.insert(protocols).values({ slug, title, tags, area }).returning().get();
  db.insert(protocolVersions)
    .values({ protocolId: p.id, version: 1, status: 'published', bodyMd: body, createdAt: NOW, reviewedAt: NOW })
    .run();
  return p;
}

describe('area on the family side', () => {
  it('hides a home category everywhere, and 404s its page', async () => {
    addCategory('Dentist', 'dentist', 'health');
    addCategory('Plumber', 'plumber', 'home');

    for (const path of ['/', '/categories', '/search?q=plumber', '/search?q=place']) {
      const html = await (await app.request(path)).text();
      expect(html, path).not.toContain('Plumber');
      expect(html, path).not.toContain('/c/plumber');
    }
    expect(await (await app.request('/categories')).text()).toContain('Dentist');
    expect(await (await app.request('/search?q=place')).text()).toContain('Dentist Place');
    expect((await app.request('/c/plumber')).status).toBe(404);
    expect((await app.request('/c/dentist')).status).toBe(200);
    const [dentistPlace, plumberPlace] = db.select().from(locations).orderBy(locations.id).all();
    expect((await app.request(`/l/${plumberPlace!.id}`)).status).toBe(404);
    expect((await app.request(`/l/${dentistPlace!.id}`)).status).toBe(302);
  });

  it('hides a home protocol from the list and 404s its page', async () => {
    addProtocol('cut', 'Cut', 'health');
    addProtocol('burst-pipe', 'Burst pipe', 'home');

    const html = await (await app.request('/emergency')).text();
    expect(html).toContain('Cut');
    expect(html).not.toContain('Burst pipe');
    expect((await app.request('/emergency/burst-pipe')).status).toBe(404);
    expect((await app.request('/emergency/cut')).status).toBe(200);
    expect(getPublished(db).length).toBe(2);
    expect(getPublished(db, { area: 'home' }).map((r) => r.protocol.slug)).toEqual(['burst-pipe']);
  });

  it('the API exposes area', async () => {
    addCategory('Plumber', 'plumber', 'home', false);
    addProtocol('burst-pipe', 'Burst pipe', 'home');
    const cats = (await (await app.request('/api/categories')).json()) as { categories: { slug: string; area: string }[] };
    expect(cats.categories.find((c) => c.slug === 'plumber')?.area).toBe('home');
    const prots = (await (await app.request('/api/protocols')).json()) as { protocols: { area: string }[] };
    expect(prots.protocols[0]?.area).toBe('home');
  });
});

describe('categoryForTags', () => {
  it('only matches categories in the protocol area', () => {
    const health = addCategory('Dentist', 'dentist', 'health', false);
    const home = addCategory('Plumber', 'plumber', 'home', false);
    const cats = [health, home];
    expect(categoryForTags(cats, ['plumber'], 'health')).toBeNull();
    expect(categoryForTags(cats, ['plumber'], 'home')?.slug).toBe('plumber');
    expect(categoryForTags(cats, ['dentist'], 'home')).toBeNull();
    expect(categoryForTags(cats, ['dentist'])?.slug).toBe('dentist');
  });
});

describe('category area validation', () => {
  it('defaults to health, rejects unknown values, and keeps the stored area on edit', () => {
    const made = createCategory(db, { name: 'Dentist', searchTerms: ['dentist'] });
    expect(made.area).toBe('health');
    expect(() => createCategory(db, { name: 'X', searchTerms: ['x'], area: 'garden' as Area })).toThrow(CategoryError);
    const home = createCategory(db, { name: 'Plumber', searchTerms: ['plumber'], area: 'home' });
    expect(updateCategory(db, home.id, { name: 'Plumbers' }).area).toBe('home');
  });
});

describe('wizard places step', () => {
  it('ignores home categories without picks', () => {
    addCategory('Dentist', 'dentist', 'health');
    expect(stepDone({ db }, 'places')).toBe(true);
    addCategory('Plumber', 'plumber', 'home', false);
    expect(stepDone({ db }, 'places')).toBe(true);
    addCategory('Vet', 'vet', 'health', false);
    expect(stepDone({ db }, 'places')).toBe(false);
  });
});
