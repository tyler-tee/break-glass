import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { categories, locations, protocols, protocolVersions, settings } from '../src/db/schema.js';
import type { Area } from '../src/domain/types.js';
import { loadEnv } from '../src/env.js';
import { addPhoto, createFact, type HouseFactInput } from '../src/features/house/repo.js';
import { createTestDb } from './helpers/testDb.js';

const NOW = new Date('2026-10-28T16:00:00Z');
const OLDER = new Date('2026-09-02T16:00:00Z');
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

const BODY = [
  '## Title and scope',
  'Water is pooling and you cannot stop it at the fixture.',
  '',
  '## Steps',
  '1. Stay out of any water near outlets.',
  '2. Shut off the water main.',
  '3. Open a faucet in the lowest tub.',
  '4. Call the plumber.',
  '',
  '## Escalation criteria',
  '- Water reaches the breaker panel.',
  '',
  '## Do not',
  '- Do not touch wet outlets.',
].join('\n');

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

const get = async (path: string) => {
  const res = await app.request(path);
  return { status: res.status, html: await res.text() };
};
const guide = (slug: string, title: string, tags: string[], area: Area = 'home', bodyMd = BODY) => {
  const p = db.insert(protocols).values({ slug, title, tags, area }).returning().get();
  db.insert(protocolVersions)
    .values({ protocolId: p.id, version: 1, status: 'published', bodyMd, createdAt: NOW, reviewedAt: NOW })
    .run();
  return p;
};
const fact = (input: HouseFactInput, at = NOW) => createFact(db, input, at);
const homeCat = (name: string, slug: string) =>
  db.insert(categories).values({ name, slug, searchTerms: [slug], area: 'home' }).returning().get();
const place = (categoryId: number, name: string, over: Partial<typeof locations.$inferInsert> = {}) =>
  db.insert(locations).values({ categoryId, name, status: 'approved', createdAt: NOW, updatedAt: NOW, ...over }).returning().get();

const MAIN: HouseFactInput = { kind: 'shutoff', system: 'water', title: 'Water main', whereNote: 'Front yard by the mailbox', instructions: 'Quarter turn clockwise' };

describe('home banner on the family home page', () => {
  it('is hidden when there is no home content', async () => {
    guide('first-aid', 'Choking', [], 'health');
    const draft = db.insert(protocols).values({ slug: 'draft-leak', title: 'Draft leak', tags: ['water'], area: 'home' }).returning().get();
    db.insert(protocolVersions).values({ protocolId: draft.id, version: 1, status: 'draft', bodyMd: BODY, createdAt: NOW }).run();
    const { html } = await get('/');
    expect(html).not.toContain('House emergencies');
    expect(html).not.toContain('/house');
  });

  it('shows under the red banner for a published home guide', async () => {
    guide('burst-pipe', 'Burst pipe', ['water']);
    const { html } = await get('/');
    expect(html).toContain('House emergencies');
    expect(html).toContain('Leaks, power, AC · shutoffs and who to call');
    expect(html.indexOf('href="/emergency"')).toBeLessThan(html.indexOf('href="/house"'));
  });

  it('shows for a house fact alone', async () => {
    fact(MAIN);
    expect((await get('/')).html).toContain('href="/house"');
  });
});

describe('GET /house', () => {
  it('says so when there is nothing yet', async () => {
    const { status, html } = await get('/house');
    expect(status).toBe(200);
    expect(html).toContain('Nothing here yet.');
    expect(html).not.toContain('Checked');
  });

  it('renders guides, shutoffs, notes, who to call, and the oldest checked date', async () => {
    const plumber = homeCat('Emergency plumber', 'emergency-plumber');
    guide('burst-pipe', 'Burst pipe or major leak', ['water', 'emergency-plumber']);
    guide('first-aid', 'Choking', ['water'], 'health');
    const main = fact(MAIN, NOW);
    fact({ kind: 'shutoff', system: 'electric', title: 'Breaker panel', whereNote: 'Garage, left wall' }, OLDER);
    fact({ kind: 'note', system: 'hvac', title: 'Filter size', instructions: 'Use 16x20x1' }, NOW);
    fact({ kind: 'utility', system: 'water', title: 'Water utility', org: 'Metro Water', phone: '555-010-0100', instructions: 'Water or sewer emergency, 24/7' });
    fact({ kind: 'contact', title: 'Rapid Rooter', org: 'Rapid Rooter', phone: '555-010-0111', categoryId: plumber.id });
    const photo = addPhoto(db, main.id, JPEG, 'The valve', NOW);

    const { status, html } = await get('/house');
    expect(status).toBe(200);
    expect(html).toContain('Checked Sep 2, 2026');
    expect(html).toContain('What&#39;s happening?');
    expect(html).toContain('href="/house/guide/burst-pipe"');
    expect(html).toContain('Water main · Metro Water · Rapid Rooter');
    expect(html).not.toContain('Choking');
    expect(html).toContain('Shutoffs');
    expect(html).toContain('Front yard by the mailbox');
    expect(html).toContain('Quarter turn clockwise');
    expect(html).toContain('Garage, left wall');
    expect(html).toContain(`href="/house/photos/${photo.id}"`);
    expect(html).toContain('Use 16x20x1');
    expect(html).toContain('Who to call');
    expect(html).toContain('href="tel:5550100100"');
    expect(html).toContain('555-010-0111');
    expect(html).toContain('Ours');
    expect(html).toContain('href="/house/print"');
  });
});

describe('GET /house/guide/:slug', () => {
  it('404s for a health protocol and for an unknown slug', async () => {
    guide('choking', 'Choking', [], 'health');
    expect((await get('/house/guide/choking')).status).toBe(404);
    expect((await get('/house/guide/nope')).status).toBe(404);
  });

  it('places a fact inside the step that names it, once, with its photo', async () => {
    const main = fact(MAIN);
    const photo = addPhoto(db, main.id, JPEG, null, NOW);
    guide('burst-pipe', 'Burst pipe or major leak', ['water']);
    const { status, html } = await get('/house/guide/burst-pipe');
    expect(status).toBe(200);
    expect(html).toContain('House emergency');
    expect(html).toContain('Call 911 if');
    expect(html).not.toContain('call-block');
    expect(html).not.toContain('Your house');
    expect(html.split('Front yard by the mailbox').length - 1).toBe(1);
    const step = html.slice(html.indexOf('Shut off the water main'), html.indexOf('Open a faucet'));
    expect(html.indexOf('Front yard by the mailbox')).toBeGreaterThan(html.indexOf('Shut off the water main'));
    expect(html.indexOf('Front yard by the mailbox')).toBeLessThan(html.indexOf('Open a faucet'));
    expect(step).toContain(`src="/house/photos/${photo.id}"`);
  });

  it('puts a fact that no step names under "Your house", above the steps', async () => {
    fact({ kind: 'shutoff', system: 'water', title: 'Hose bib valve', whereNote: 'Side of the garage' });
    guide('burst-pipe', 'Burst pipe', ['water']);
    const { html } = await get('/house/guide/burst-pipe');
    expect(html).toContain('Your house');
    expect(html.indexOf('Side of the garage')).toBeGreaterThan(html.indexOf('Your house'));
    expect(html.indexOf('Side of the garage')).toBeLessThan(html.indexOf('Stay out of any water'));
    expect(html.split('Side of the garage').length - 1).toBe(1);
  });

  it('lists ours before the picks, drops a pick sharing our phone, and shows the utility alert', async () => {
    const plumber = homeCat('Emergency plumber', 'emergency-plumber');
    fact({ kind: 'contact', title: 'Rapid Rooter', org: 'Rapid Rooter', phone: '555-010-0111', categoryId: plumber.id, instructions: 'Our plumber, 24 hours' });
    fact({ kind: 'utility', system: 'water', title: 'Water utility', org: 'Metro Water', phone: '555-010-0100', instructions: 'Water or sewer emergency?' });
    place(plumber.id, 'Same Number Plumbing', { phone: '(555) 010-0111', rankPosition: 1 });
    place(plumber.id, 'Pipe Pros', {
      phone: '555-010-0122', rankPosition: 2, distanceMi: 1.4, rating: 4.8, ratingCount: 1300,
      address: '12 Test St, Springfield, UT 84000, USA', rankReason: 'Answered an overnight call.',
    });
    guide('burst-pipe', 'Burst pipe', ['water', 'emergency-plumber']);

    const { html } = await get('/house/guide/burst-pipe');
    expect(html).toContain('1 · Ours');
    expect(html).toContain("2 · If they don&#39;t answer");
    expect(html.indexOf('Rapid Rooter')).toBeLessThan(html.indexOf('Pipe Pros'));
    expect(html).not.toContain('Same Number Plumbing');
    expect(html).toContain('Springfield · 1.4 mi · 4.8 ★ · 1,300 reviews');
    expect(html).toContain('Answered an overnight call.');
    expect(html).toContain('Directions to Pipe Pros');
    expect(html).toContain('Water or sewer emergency? Metro Water: <a href="tel:5550100100">555-010-0100</a>');
  });

  it('omits the ordinal labels when there is no company of ours', async () => {
    const plumber = homeCat('Emergency plumber', 'emergency-plumber');
    place(plumber.id, 'Pipe Pros', { phone: '555-010-0122' });
    guide('burst-pipe', 'Burst pipe', ['emergency-plumber']);
    const { html } = await get('/house/guide/burst-pipe');
    expect(html).toContain('Pipe Pros');
    expect(html).not.toContain('1 · Ours');
    expect(html).not.toContain('If they don');
  });

  it('uses the stored emergency number and renders the do-not section and version meta', async () => {
    db.update(settings).set({ emergencyNumber: '112' }).run();
    guide('burst-pipe', 'Burst pipe', []);
    const { html } = await get('/house/guide/burst-pipe');
    expect(html).toContain('Call 112 if');
    expect(html).toContain('Do not touch wet outlets.');
    expect(html).toContain('Version 1');
  });
});

describe('GET /house/print', () => {
  it('lists the shutoffs, notes, numbers and the date on a standalone page', async () => {
    const plumber = homeCat('Emergency plumber', 'emergency-plumber');
    const main = fact(MAIN);
    fact({ kind: 'note', system: 'hvac', title: 'Filter size', instructions: 'Use 16x20x1' });
    fact({ kind: 'utility', system: 'water', title: 'Water utility', org: 'Metro Water', phone: '555-010-0100', instructions: 'Water emergency, 24/7' });
    fact({ kind: 'contact', title: 'Rapid Rooter', org: 'Rapid Rooter', phone: '555-010-0111', categoryId: plumber.id });
    const photo = addPhoto(db, main.id, JPEG, null, NOW);

    const { status, html } = await get('/house/print');
    expect(status).toBe(200);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).not.toContain('Skip to content');
    expect(html).toContain('Printed Oct 28, 2026');
    expect(html).toContain('Fire, smoke, or someone hurt: get everyone out, then call 911.');
    expect(html).toContain('Water main');
    expect(html).toContain('Front yard by the mailbox · Quarter turn clockwise');
    expect(html).toContain('Use 16x20x1');
    expect(html).toContain(`src="/house/photos/${photo.id}"`);
    expect(html).toContain('Metro Water');
    expect(html).toContain('Water emergency, 24/7');
    expect(html).toContain('555-010-0100');
    expect(html).toContain('Rapid Rooter');
    expect(html).toContain('555-010-0111');
    expect(html).toContain('Poison control');
    expect(html).toContain('1-800-222-1222');
    expect(html).toContain('Reprint every spring and after any change.');
    expect(html.indexOf('Metro Water')).toBeLessThan(html.indexOf('Rapid Rooter'));
    expect(html.indexOf('Rapid Rooter')).toBeLessThan(html.indexOf('Poison control'));
  });

  it('still prints the emergency and poison lines with no facts', async () => {
    const { status, html } = await get('/house/print');
    expect(status).toBe(200);
    expect(html).toContain('Poison control');
    expect(html).not.toContain('<h2>Shutoffs</h2>');
  });
});
