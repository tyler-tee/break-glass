import path from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppDeps } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { findRuns, locations, settings } from '../../src/db/schema.js';
import type { RankFlag } from '../../src/domain/ranking.js';
import type { LocationStatus, RankedBy, RankVerdict, WeeklyHours } from '../../src/domain/types.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword } from '../../src/features/admin/auth.js';
import { createCategory, type Category } from '../../src/features/categories/repo.js';
import { latestRun } from '../../src/features/locations/findAndRank.js';
import type { Extractor } from '../../src/services/llm/extract.js';
import type { LlmProvider } from '../../src/services/llm/provider.js';
import { adminLogin } from '../helpers/adminLogin.js';
import { recordingFetch } from '../helpers/recordingFetch.js';
import { createTestDb } from '../helpers/testDb.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../fixtures/places');
const now = new Date('2026-10-27T16:00:00Z');
const PW = 'correct horse';
const URL_ = '/admin/places/find';

let db: Db;
let dentist: Category;

beforeEach(() => {
  db = createTestDb();
  // The recorded places fixture answers "emergency dentist" with Near Dental Group and Far Dental.
  dentist = createCategory(db, { name: 'Test Dentist', searchTerms: ['emergency dentist'] });
});

const fakeLlm = { generateJson: vi.fn() } as unknown as LlmProvider;

async function harness(over: Partial<AppDeps> = {}) {
  const env = loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: await hashPassword(PW) });
  const app = createApp({
    db,
    env,
    now: () => now,
    places: { fetch: recordingFetch(FIXTURE_DIR, 'replay'), apiKey: 'test' },
    ...over,
  });
  const cookie = await adminLogin(app, PW);
  const get = (p: string) => app.request(p, { headers: { cookie } });
  const post = (p: string, fields: Record<string, string | string[]> = {}) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
    return app.request(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: body.toString() });
  };
  return { app, get, post };
}

const H24: WeeklyHours = {
  periods: Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, [{ open: '0000', close: '2400' }]])) as WeeklyHours['periods'],
  weekdayText: [],
};
const DAYTIME: WeeklyHours = {
  periods: Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, [{ open: '0800', close: '1700' }]])) as WeeklyHours['periods'],
  weekdayText: [],
};

type Seed = {
  name: string;
  status?: LocationStatus;
  verdict?: RankVerdict | null;
  rank?: number;
  flags?: RankFlag[];
  reason?: string;
  rankedBy?: RankedBy;
  hours?: WeeklyHours | null;
  address?: string;
  website?: string;
};

function seed(cat: Category, s: Seed): number {
  const verdict = s.verdict === undefined ? 'pick' : s.verdict;
  return db
    .insert(locations)
    .values({
      categoryId: cat.id,
      name: s.name,
      status: s.status ?? 'candidate',
      shortAddress: s.address ?? `${s.name.length} Main St, Springfield`,
      rating: 4.2,
      ratingCount: 120,
      distanceMi: 3.4,
      hours: s.hours === undefined ? H24 : s.hours,
      website: s.website ?? null,
      rankVerdict: verdict,
      rankPosition: verdict === null ? null : (s.rank ?? 1),
      rankReason: verdict === null ? null : (s.reason ?? `Why ${s.name}`),
      rankFlags: verdict === null ? null : (s.flags ?? []),
      rankedBy: verdict === null ? null : (s.rankedBy ?? 'llm'),
      rankedAt: verdict === null ? null : new Date(now.getTime() - 2 * 60_000),
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: locations.id })
    .get().id;
}

const statusOf = (id: number) => db.select().from(locations).where(eq(locations.id, id)).get()!.status;
const doneRun = (categoryIds: number[], progress: Record<string, { state: 'done' | 'failed' | 'stopped'; found?: number; message?: string }>) =>
  db.insert(findRuns).values({ startedAt: now, finishedAt: now, status: 'done', categoryIds, progress, callsUsed: 2, llmCalls: 1 }).run();
const sectionOf = (html: string, slug: string) => {
  const start = html.indexOf(`<section class="card sec" id="${slug}"`);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</section>', start));
};

describe('GET /admin/places/find', () => {
  it('before any run: every category checked, one run button, the helper text and the empty state', async () => {
    createCategory(db, { name: 'Test Clinic', searchTerms: ['clinic'], hoursNeed: 'daytime' });
    const { get } = await harness();
    const res = await get(URL_);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1>Find places</h1>');
    expect(html.match(/<input type="checkbox" name="category_id" value="\d+" checked=""/g)).toHaveLength(2);
    expect(html).toContain('Overnight · none on family site yet');
    expect(html).toContain('Daytime · none on family site yet');
    expect(html).toMatch(/data-run-button[^>]*>\s*Find &amp; rank 2 categories\s*</);
    expect(html).toContain('data-select="all" hidden');
    expect(html).toContain('No AI key is set, so places are ranked by hours, rating and distance.');
    expect(html).toContain('Nothing ranked yet');
    expect(html).not.toContain('http-equiv="refresh"');
    // The nav: Find places is current, the review queue is gone.
    expect(html).toMatch(/<a href="\/admin\/places\/find" aria-current="page">/);
    expect(html).not.toContain('Review queue');
  });

  it('shows how many picks each category has on the family site', async () => {
    seed(dentist, { name: 'A', status: 'approved' });
    seed(dentist, { name: 'B', status: 'warn' });
    const { get } = await harness();
    expect(await (await get(URL_)).text()).toContain('Overnight · 2 on family site');
  });

  it('while a run is going: the progress card, a 3 second refresh, and no picker', async () => {
    const vet = createCategory(db, { name: 'Test Vet', searchTerms: ['vet'] });
    const kid = createCategory(db, { name: 'Test Kids', searchTerms: ['kids'] });
    const gone = createCategory(db, { name: 'Test Gone', searchTerms: ['gone'] });
    seed(dentist, { name: 'Near', status: 'approved' });
    seed(dentist, { name: 'Better', rank: 2 });
    db.insert(findRuns)
      .values({
        startedAt: new Date(now.getTime() - 40_000),
        status: 'running',
        categoryIds: [dentist.id, vet.id, kid.id, gone.id],
        progress: {
          [dentist.id]: { state: 'done', found: 7 },
          [vet.id]: { state: 'failed', message: 'Google rejected this key. Make sure "Places API (New)" is turned on.' },
          [kid.id]: { state: 'ranking' },
          [gone.id]: { state: 'waiting' },
        },
        callsUsed: 7,
        llmCalls: 3,
      })
      .run();
    const { get } = await harness();
    const html = await (await get(URL_)).text();
    expect(html).toContain('<meta http-equiv="refresh" content="3"/>');
    expect(html).toContain('Finding &amp; ranking 4 categories');
    expect(html).toContain('2 of 4 done · started 40 s ago');
    expect(html).toContain('7 found, 2 recommended. 1 change to review.');
    expect(html).toContain('Google rejected this key.');
    expect(html).toContain('<a href="/admin/setup/services">Check the key in Setup → Services</a>, then run this category again.');
    expect(html).toContain('Ranking by hours, rating and distance.');
    expect(html).toMatch(/<span class="st wait">Waiting<\/span>/);
    expect(html).toContain('Used so far: 7 Google searches, 3 AI calls.');
    expect(html).not.toContain('data-find-picker');
  });

  it('results: banner, one section per category to decide, groups, the change line and the default checks', async () => {
    const pick1 = seed(dentist, { name: 'CVS Pharmacy', rank: 1, address: '4500 Pleasant Hill Rd, Kissimmee' });
    const pick2 = seed(dentist, { name: 'Bright Smiles', rank: 2, flags: ['few_reviews'] });
    const pick3 = seed(dentist, { name: 'Current Three', rank: 3, status: 'approved' });
    const backup = seed(dentist, { name: 'CVS Pharmacy', verdict: 'backup', rank: 4, status: 'approved', address: '7300 Curry Ford Rd, Orlando' });
    seed(dentist, { name: 'Night Owl', verdict: 'avoid', rank: 5, flags: ['not_24h', 'referral_listing'], hours: DAYTIME });
    doneRun([dentist.id], { [dentist.id]: { state: 'done', found: 5 } });
    const { get } = await harness();
    const html = await (await get(URL_)).text();
    expect(html).toContain('<b>Ranked 1 category just now.</b> 5 places considered. Review each category below');
    const sec = sectionOf(html, 'test-dentist');
    expect(sec).toContain('Ranked by AI 2 min ago · 5 found within 15 mi');
    expect(sec).toContain(
      'Saving adds CVS Pharmacy (Pleasant Hill Rd) and Bright Smiles and takes off CVS Pharmacy (Curry Ford Rd).',
    );
    expect(sec).toMatch(/data-save[^>]*>Save 3 picks</);
    const checked = [...sec.matchAll(/name="location_id" value="(\d+)" checked=""/g)].map((m) => Number(m[1]));
    expect(checked.sort()).toEqual([pick1, pick2, pick3].sort());
    expect(sec).toContain(`value="${backup}" data-short="CVS Pharmacy (Curry Ford Rd)" data-current="1"`);
    expect(sec).toContain('<span class="tag">On family site</span>');
    expect(sec).toContain('<span class="label">Recommended</span><span class="muted">top 3 by the AI</span>');
    // The backup is on the family site, so the rest starts open.
    expect(sec).toMatch(/<details class="rest" open="">/);
    expect(sec).toContain('Show 1 backup and 1 ruled out');
    expect(sec).toContain('<span class="label">Ruled out</span>');
    expect(sec).toContain('Few reviews');
    expect(sec).toContain('Not 24 hours');
    expect(sec).toContain('Referral listing');
    expect(sec).toContain('<span class="pill open">24 hours</span>');
    expect(sec).toContain('<span class="pill closed">Daily 8 AM – 5 PM</span>');
    expect(sec).toContain('4.2 ★');
    expect(sec).toContain('120 reviews');
    expect(sec).toContain('3.4 mi');
    expect(sec).toContain(`form="never-${pick1}"`);
    expect(html).toContain(`<form method="post" action="${URL_}/locations/${pick1}/never" id="never-${pick1}" hidden="">`);
    expect(sec).not.toContain('Ranked without AI');
  });

  it('a category already showing its 3 recommended picks goes in the compact list; ?show= expands it', async () => {
    for (const [i, name] of ['One', 'Two', 'Three'].entries()) seed(dentist, { name, rank: i + 1, status: 'approved' });
    doneRun([dentist.id], { [dentist.id]: { state: 'done', found: 3 } });
    const { get } = await harness();
    let html = await (await get(URL_)).text();
    expect(html).toContain('Also ranked in this run: no changes suggested');
    expect(html).toContain(`href="${URL_}?show=test-dentist#test-dentist"`);
    expect(html).toContain('Keeps One, Two and Three');
    expect(html).not.toContain('id="test-dentist"');
    expect(html).toContain('Nothing to change: every category already shows its best picks.');

    html = await (await get(`${URL_}?show=test-dentist`)).text();
    const sec = sectionOf(html, 'test-dentist');
    expect(sec).toContain('Same as what the family site shows now.');
    expect(sec).toMatch(/data-save[^>]*>No changes</);
  });

  it('ranked without AI: the alert, and Rank again with AI posts a run for just that category', async () => {
    seed(dentist, { name: 'Rules One', rankedBy: 'rules' });
    doneRun([dentist.id], { [dentist.id]: { state: 'done', found: 1, message: 'AI ranking failed, so these were ranked by rules: Request timed out.' } });
    const { get } = await harness({ llm: fakeLlm });
    const sec = sectionOf(await (await get(URL_)).text(), 'test-dentist');
    expect(sec).toContain('<b>Ranked without AI.</b> The AI request timed out, so this order comes from hours, rating and distance alone.');
    expect(sec).toContain(`<button class="linkbtn" type="submit" form="rerank-${dentist.id}">Rank again with AI</button>`);
    expect(sec).toContain(`<form method="post" action="${URL_}/runs" id="rerank-${dentist.id}" hidden=""><input type="hidden" name="category_id" value="${dentist.id}"/>`);
    expect(sec).toContain('<span class="label">Recommended</span><span class="muted">by hours, rating and distance</span>');
  });

  it('ranked without AI and no AI key: points to Setup → Services instead', async () => {
    seed(dentist, { name: 'Rules One', rankedBy: 'rules' });
    const { get } = await harness();
    const sec = sectionOf(await (await get(URL_)).text(), 'test-dentist');
    expect(sec).toContain('No AI key is set, so this order comes from hours, rating and distance alone.');
    expect(sec).toContain('<a href="/admin/setup/services">Add an AI key in Setup → Services</a>');
    expect(sec).not.toContain('Rank again with AI');
  });

  it('after a run, failed and stopped categories say what happened and what to do next', async () => {
    const vet = createCategory(db, { name: 'Test Vet', searchTerms: ['vet'] });
    doneRun([dentist.id, vet.id], {
      [dentist.id]: { state: 'failed', message: 'We couldn\'t reach Google. Check that the server is connected to the internet, then try again.' },
      [vet.id]: { state: 'stopped', message: "This month's Places call limit has been reached. Lookups start working again next month." },
    });
    const { get } = await harness();
    const html = await (await get(URL_)).text();
    expect(html).toContain('The last search did not rank anything.');
    expect(html).toContain('2 categories could not be ranked');
    expect(html).toContain('We couldn&#39;t reach Google.');
    expect(html).toMatch(new RegExp(`<input type="hidden" name="category_id" value="${dentist.id}"/><button type="submit" class="linkbtn">Run this category again</button>`));
    expect(html).toContain('This month&#39;s Places call limit has been reached. Lookups start working again next month. Nothing was changed.');
  });
});

describe('POST /admin/places/find/runs', () => {
  it('starts a run for the checked categories and goes back to the page', async () => {
    const other = createCategory(db, { name: 'Test Other', searchTerms: ['other'] });
    const { post, get } = await harness();
    const res = await post(`${URL_}/runs`, { category_id: [String(dentist.id)] });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(URL_);
    expect(latestRun(db)).toMatchObject({ categoryIds: [dentist.id] });
    expect(latestRun(db)!.categoryIds).not.toContain(other.id);
    await vi.waitFor(() => expect(latestRun(db)!.status).toBe('done'));
    const html = await (await get(URL_)).text();
    const sec = sectionOf(html, 'test-dentist');
    expect(sec).toContain('Near Dental Group');
    expect(sec).toContain('Ranked without AI');
  });

  it('while a run is going, another start redirects with a notice and starts nothing', async () => {
    db.insert(findRuns).values({ startedAt: now, status: 'running', categoryIds: [dentist.id], progress: {} }).run();
    const { post, get } = await harness();
    const res = await post(`${URL_}/runs`, { category_id: String(dentist.id) });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${URL_}?notice=running`);
    expect(db.select().from(findRuns).all()).toHaveLength(1);
    expect(await (await get(`${URL_}?notice=running`)).text()).toContain('A search is already running.');
  });

  it('400 with no category checked', async () => {
    const { post } = await harness();
    const res = await post(`${URL_}/runs`, {});
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Pick at least one category to search.');
    expect(latestRun(db)).toBeNull();
  });

  it('400 without a home location, linking to Settings', async () => {
    db.update(settings).set({ homeLat: null, homeLng: null }).run();
    const { post } = await harness();
    const res = await post(`${URL_}/runs`, { category_id: String(dentist.id) });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Set your home location first, so we know where to search. <a href="/admin/settings">Go to Settings</a>.');
    expect(latestRun(db)).toBeNull();
  });

  it('400 without a Places key, linking to where keys are entered', async () => {
    const env = loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: await hashPassword(PW) });
    const app = createApp({ db, env, now: () => now });
    const cookie = await adminLogin(app, PW);
    const res = await app.request(`${URL_}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: `category_id=${dentist.id}`,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Searching needs a Google Places key. <a href="/admin/setup/services">Add one in Setup → Services</a>');
    expect(latestRun(db)).toBeNull();
  });
});

describe('POST /admin/places/find/:categoryId/picks', () => {
  it('saves the checked places, demotes a former pick, and shows the saved line', async () => {
    const a = seed(dentist, { name: 'A', rank: 1 });
    const b = seed(dentist, { name: 'B', rank: 2 });
    const old = seed(dentist, { name: 'Old', verdict: 'backup', rank: 4, status: 'approved' });
    const kept = seed(dentist, { name: 'Kept', rank: 3, status: 'warn' });
    const { post, get } = await harness();
    const res = await post(`${URL_}/${dentist.id}/picks`, { location_id: [String(a), String(b), String(kept)] });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${URL_}?saved=test-dentist#test-dentist`);
    expect([statusOf(a), statusOf(b), statusOf(kept), statusOf(old)]).toEqual(['approved', 'approved', 'approved', 'candidate']);

    const sec = sectionOf(await (await get(`${URL_}?saved=test-dentist`)).text(), 'test-dentist');
    expect(sec).toContain('<div class="saved" role="status">Saved. The family site now shows these 3.</div>');
    expect(sec).toContain('<div class="change" data-summary="true" aria-live="polite" hidden="">');
  });

  it('more than 3 picks is fine: all of them go on the family site', async () => {
    const rows = ['A', 'B', 'C', 'D'].map((name, i) => seed(dentist, { name, rank: i + 1, verdict: i < 3 ? 'pick' : 'backup' }));
    const { post } = await harness();
    const res = await post(`${URL_}/${dentist.id}/picks`, { location_id: rows.map(String) });
    expect(res.status).toBe(302);
    expect(rows.map(statusOf)).toEqual(['approved', 'approved', 'approved', 'approved']);
  });

  it('none checked is a 400 too; a place from another category is refused', async () => {
    const vet = createCategory(db, { name: 'Test Vet', searchTerms: ['vet'] });
    const foreign = seed(vet, { name: 'Vet Place' });
    seed(dentist, { name: 'A' });
    const { post } = await harness();
    expect((await post(`${URL_}/${dentist.id}/picks`, {})).status).toBe(400);
    const res = await post(`${URL_}/${dentist.id}/picks`, { location_id: String(foreign) });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('That place is not in this category');
    expect(statusOf(foreign)).toBe('candidate');
  });

  it('reads website notes for the new picks in the background', async () => {
    const a = seed(dentist, { name: 'A', website: 'https://a.example' });
    const extract = vi.fn(async () => ({ extraction: null, pageHash: null })) as unknown as Extractor;
    const { post } = await harness({ extract });
    expect((await post(`${URL_}/${dentist.id}/picks`, { location_id: String(a) })).status).toBe(302);
    await vi.waitFor(() => expect(extract).toHaveBeenCalledWith('https://a.example', undefined));
  });

  it('404 for an unknown category', async () => {
    const { post } = await harness();
    expect((await post(`${URL_}/9999/picks`, { location_id: '1' })).status).toBe(404);
  });
});

describe('POST /admin/places/find/locations/:id/never', () => {
  it('rejects the place for good and returns to its section', async () => {
    const a = seed(dentist, { name: 'Spammy Listing', verdict: 'avoid', rank: 2 });
    seed(dentist, { name: 'Good', rank: 1 });
    const { post, get } = await harness();
    const res = await post(`${URL_}/locations/${a}/never`, { return_to: `${URL_}?removed=test-dentist#test-dentist` });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${URL_}?removed=test-dentist#test-dentist`);
    expect(statusOf(a)).toBe('rejected');
    const html = await (await get(`${URL_}?removed=test-dentist`)).text();
    expect(sectionOf(html, 'test-dentist')).toContain('Done. That place won&#39;t be suggested again.');
    expect(html).not.toContain('Spammy Listing');
  });

  it('ignores an off-site return_to and 404s an unknown place', async () => {
    const a = seed(dentist, { name: 'A' });
    const { post } = await harness();
    const res = await post(`${URL_}/locations/${a}/never`, { return_to: 'https://evil.example/' });
    expect(res.headers.get('location')).toBe(`${URL_}?removed=test-dentist#test-dentist`);
    expect((await post(`${URL_}/locations/9999/never`)).status).toBe(404);
  });
});

describe('old review queue', () => {
  it('/admin/candidates redirects to Find places', async () => {
    const { get } = await harness();
    const res = await get('/admin/candidates?category=test-dentist');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(URL_);
  });

  it('the Categories page links to Find places and has no Discover button or route', async () => {
    const { get, post } = await harness();
    const html = await (await get('/admin/categories')).text();
    expect(html).toContain('href="/admin/places/find"');
    expect(html).not.toContain('/discover');
    expect((await post(`/admin/categories/${dentist.id}/discover`)).status).toBe(404);
  });
});
