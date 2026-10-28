import { APIError } from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { categories, locations, placesUsage, protocols, protocolVersions, settings } from '../../src/db/schema.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword } from '../../src/features/admin/auth.js';
import { createSecretsStore } from '../../src/features/admin/secrets.js';
import { getSettings } from '../../src/features/admin/settingsRepo.js';
import { describeCron } from '../../src/features/admin/setup/cronWords.js';
import { STEPS, resumeTarget, stepDone } from '../../src/features/admin/setup/steps.js';
import type { LlmProvider } from '../../src/services/llm/provider.js';
import { makeServiceResolver } from '../../src/services/resolver.js';
import { adminLogin } from '../helpers/adminLogin.js';
import { createTestDb } from '../helpers/testDb.js';

const PW = 'correct horse battery';
let HASH: string;
beforeAll(async () => {
  HASH = await hashPassword(PW);
});

async function harness(opts: { env?: Record<string, string>; fetch?: typeof fetch; llm?: LlmProvider } = {}) {
  const db = createTestDb();
  // A freshly claimed install: no home yet (createTestDb seeds one for older tests).
  db.update(settings).set({ homeLat: null, homeLng: null, homeLabel: null }).where(eq(settings.id, 1)).run();
  const env = loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: HASH, ...opts.env });
  const secrets = createSecretsStore(db, env);
  const resolve = makeServiceResolver(db, env, secrets, opts.fetch ? { fetch: opts.fetch } : {});
  const reschedule = vi.fn();
  const app = createApp({ db, env, secrets, resolve, scheduler: { reschedule }, ...(opts.llm ? { llm: opts.llm } : {}) });
  const cookie = await adminLogin(app, PW);
  const get = (path: string) => app.request(path, { headers: { cookie } });
  const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, ...headers },
      body: new URLSearchParams(fields).toString(),
    });
  return { db, env, secrets, app, cookie, get, post, reschedule };
}

const seedApprovedLocation = (db: ReturnType<typeof createTestDb>) => {
  const cat = db.insert(categories).values({ name: 'Dentist', slug: 'dentist', searchTerms: [] }).returning().get();
  const at = new Date();
  db.insert(locations).values({ categoryId: cat.id, name: 'A', status: 'approved', createdAt: at, updatedAt: at }).run();
};

describe('wizard step model', () => {
  it('has seven steps in order', () => {
    expect(STEPS).toEqual(['welcome', 'services', 'home', 'categories', 'places', 'protocol', 'done']);
  });

  it('derives done-state from data and resumes at the first incomplete required step', async () => {
    const { db } = await harness();
    const deps = { db };
    expect(stepDone(deps, 'welcome')).toBe(false);
    expect(stepDone(deps, 'services')).toBe(true);
    expect(stepDone(deps, 'home')).toBe(false);
    expect(resumeTarget(deps)).toBe('/admin/setup/welcome');

    db.update(settings).set({ householdName: 'The Smiths', homeLat: 40, homeLng: -111 }).run();
    expect(resumeTarget(deps)).toBe('/admin/setup/categories');

    seedApprovedLocation(db);
    expect(stepDone(deps, 'categories')).toBe(true);
    expect(stepDone(deps, 'places')).toBe(true);
    expect(resumeTarget(deps)).toBe('/admin/setup/protocol');

    const p = db.insert(protocols).values({ slug: 'cut', title: 'Cut' }).returning().get();
    db.insert(protocolVersions)
      .values({ protocolId: p.id, version: 1, status: 'published', bodyMd: '# x', createdAt: new Date() })
      .run();
    expect(stepDone(deps, 'protocol')).toBe(true);
    expect(resumeTarget(deps)).toBe('/admin/setup/done');
    expect(stepDone(deps, 'done')).toBe(false);
    db.update(settings).set({ setupCompletedAt: new Date() }).run();
    expect(stepDone(deps, 'done')).toBe(true);
  });
});

describe('describeCron', () => {
  it('describes common schedules in plain words', () => {
    expect(describeCron('0 3 * * 0')).toBe('weekly on Sunday at 3:00 am');
    expect(describeCron('0 4 1 * *')).toBe('monthly on day 1 at 4:00 am');
    expect(describeCron('30 13 * * *')).toBe('every day at 1:30 pm');
    expect(describeCron('0 0 * * 7')).toBe('weekly on Sunday at 12:00 am');
    expect(describeCron('*/5 * * * *')).toBe('on a custom schedule (*/5 * * * *)');
  });
});

describe('wizard routes', () => {
  it('resume lands on first incomplete step', async () => {
    const { get, post } = await harness();
    let res = await get('/admin/setup');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/setup/welcome');

    expect((await post('/admin/setup/welcome', { household_name: 'The Smiths', emergency_number: '911' })).status).toBe(302);
    res = await post('/admin/setup/home', {
      home_lat: '40.5',
      home_lng: '-111.9',
      default_radius_mi: '15',
      home_tz: 'America/Denver',
      location_refresh_cron: '0 3 * * 0',
      protocol_refresh_cron: '0 4 1 * *',
    });
    expect(res.status).toBe(302);

    res = await get('/admin/setup');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/setup/categories');
  });

  it('a finished install re-runs setup from the start; an unfinished one resumes', async () => {
    const { get, db } = await harness();
    db.update(settings).set({ householdName: 'The Smiths', homeLat: 40, homeLng: -111 }).run();
    let res = await get('/admin/setup');
    expect(res.headers.get('location')).toBe('/admin/setup/categories');
    db.update(settings).set({ setupCompletedAt: new Date() }).run();
    res = await get('/admin/setup');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/setup/welcome');
  });

  it('requires login and rejects cross-origin posts', async () => {
    const { app, post } = await harness();
    const anon = await app.request('/admin/setup/welcome');
    expect(anon.status).toBe(302);
    expect(anon.headers.get('location')).toMatch(/^\/admin\/login/);
    const cross = await post('/admin/setup/welcome', { household_name: 'X', emergency_number: '911' }, { origin: 'http://evil.test' });
    expect(cross.status).toBe(403);
  });

  it('login with no next on an incomplete install lands on a real wizard page', async () => {
    const { app, cookie } = await harness();
    const res = await app.request('/admin/setup/welcome', { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('shows the step indicator with the current step marked', async () => {
    const { get } = await harness();
    const html = await (await get('/admin/setup/services')).text();
    expect(html).toContain('Step 2 of 7');
    expect(html).toMatch(/<li[^>]*aria-current="step"[^>]*>[\s\S]*?Services[\s\S]*?<\/li>/);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain('Save and continue');
    expect(html).toContain('Skip for now');
    expect(html).toContain('Back');
    expect(html).toContain('Finish later');
  });

  it('household save persists and advances', async () => {
    const { get, post, db, app } = await harness();
    const page = await (await get('/admin/setup/welcome')).text();
    expect(page).toContain('value="Our household"');
    expect(page).toContain('value="911"');

    const res = await post('/admin/setup/welcome', { household_name: '  The Smiths  ', emergency_number: '+1 (801) 555-0100' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/setup/services');
    expect(getSettings(db)).toMatchObject({ householdName: 'The Smiths', emergencyNumber: '+1 (801) 555-0100' });

    const family = await (await app.request('/')).text();
    expect(family).toContain('The Smiths');
    expect(family).toContain('href="tel:+18015550100"');
  });

  it('household validation errors re-render with 400 beside the field', async () => {
    const { post, db } = await harness();
    let res = await post('/admin/setup/welcome', { household_name: 'Ok', emergency_number: 'call mom' });
    expect(res.status).toBe(400);
    let html = await res.text();
    expect(html).toMatch(/role="alert"[^>]*>[^<]*digit/);
    expect(getSettings(db).householdName).toBeNull();

    res = await post('/admin/setup/welcome', { household_name: 'x'.repeat(61), emergency_number: '911' });
    expect(res.status).toBe(400);
    html = await res.text();
    expect(html).toMatch(/role="alert"[^>]*>[^<]*60 characters/);
    expect(getSettings(db).householdName).toBeNull();
  });

  it('household save re-renders with an alert instead of a 500 when another setting is invalid', async () => {
    const { post, db } = await harness();
    db.update(settings).set({ locationRefreshCron: 'bogus' }).where(eq(settings.id, 1)).run();
    const res = await post('/admin/setup/welcome', { household_name: 'The Smiths', emergency_number: '911' });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/role="alert"[^>]*>[^<]*Settings/);
    expect(getSettings(db).householdName).toBeNull();
  });

  it('Back and Skip for now redirect without saving; Finish later saves and leaves', async () => {
    const { post, db } = await harness();
    const fields = { household_name: 'Ignored', emergency_number: '911' };
    let res = await post('/admin/setup/welcome', { ...fields, go: 'skip' });
    expect(res.headers.get('location')).toBe('/admin/setup/services');
    expect(getSettings(db).householdName).toBeNull();

    res = await post('/admin/setup/services', { go: 'back' });
    expect(res.headers.get('location')).toBe('/admin/setup/welcome');
    res = await post('/admin/setup/services', { go: 'skip' });
    expect(res.headers.get('location')).toBe('/admin/setup/home');
    res = await post('/admin/setup/home', { go: 'back' });
    expect(res.headers.get('location')).toBe('/admin/setup/services');
    res = await post('/admin/setup/home', { go: 'skip' });
    expect(res.headers.get('location')).toBe('/admin/setup/categories');

    // Finish later keeps what was entered, then leaves the wizard.
    res = await post('/admin/setup/welcome', { ...fields, go: 'later' });
    expect(res.headers.get('location')).toBe('/admin');
    expect(getSettings(db).householdName).toBe('Ignored');
  });

  describe('services step', () => {
    it('blank key save keeps existing; remove clears', async () => {
      const { post, secrets } = await harness();
      secrets.setPlacesKey('AIzaSyEXISTING-key-abcd');
      secrets.setAnthropicKey('sk-ant-existing-wxyz');

      let res = await post('/admin/setup/services', { places_key: '', anthropic_key: '   ' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/admin/setup/home');
      expect(secrets.getPlacesKey()).toBe('AIzaSyEXISTING-key-abcd');
      expect(secrets.getAnthropicKey()).toBe('sk-ant-existing-wxyz');

      res = await post('/admin/setup/services', { remove: 'places' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/admin/setup/services?removed=places');
      expect(secrets.getPlacesKey()).toBeUndefined();
      expect(secrets.getAnthropicKey()).toBe('sk-ant-existing-wxyz');

      res = await post('/admin/setup/services', { remove: 'anthropic' });
      expect(secrets.getAnthropicKey()).toBeUndefined();
    });

    it('saves trimmed keys and shows only the last four characters', async () => {
      const { post, get, secrets } = await harness();
      const res = await post('/admin/setup/services', { places_key: '  AIzaSyNEW-places-1a2b  ', anthropic_key: 'sk-ant-new-test-key-9z8y' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/admin/setup/services?saved=both');
      expect(secrets.getPlacesKey()).toBe('AIzaSyNEW-places-1a2b');
      expect(secrets.getAnthropicKey()).toBe('sk-ant-new-test-key-9z8y');

      const html = await (await get('/admin/setup/services')).text();
      expect(html).toContain('Saved (ends in …1a2b)');
      expect(html).toContain('Saved (ends in …9z8y)');
      expect(html).not.toContain('AIzaSyNEW-places');
      expect(html).not.toContain('sk-ant-new-test-key');
      expect(html).toMatch(/<input[^>]*type="password"[^>]*name="places_key"[^>]*autocomplete="off"/);
      expect(html).toMatch(/<input[^>]*type="password"[^>]*name="anthropic_key"[^>]*autocomplete="off"/);
    });

    it('saving a new key stays on services with Test and a Continue link', async () => {
      const { post, get, secrets } = await harness();
      const res = await post('/admin/setup/services', { places_key: 'AIzaSyFRESH-places-key-4444', anthropic_key: '' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/admin/setup/services?saved=places');
      expect(secrets.getPlacesKey()).toBe('AIzaSyFRESH-places-key-4444');
      const html = await (await get('/admin/setup/services?saved=places')).text();
      expect(html).toMatch(/role="status"[^>]*>Saved\. Use Test to check it, or continue\.</);
      expect(html).toMatch(/<button[^>]*form="svc-aux"[^>]*name="test"[^>]*value="places"/);
      expect(html).toMatch(/<a class="btn" href="\/admin\/setup\/home">\s*Continue\s*<\/a>/);
      // Only whitelisted values show the notice.
      const other = await (await get('/admin/setup/services?saved=%3Cscript%3E')).text();
      expect(other).not.toContain('Use Test to check it');
      expect(other).not.toContain('<script>');
    });

    it('Save and continue with blank fields advances to Home', async () => {
      const { post } = await harness();
      const res = await post('/admin/setup/services', { places_key: '', anthropic_key: '' });
      expect(res.headers.get('location')).toBe('/admin/setup/home');
    });

    it('rejects zero-width-space and too-short keys without echoing them', async () => {
      const { post, secrets } = await harness();
      let res = await post('/admin/setup/services', { places_key: 'AIzaSyZWSP\u200bkey-000000001', anthropic_key: '' });
      expect(res.status).toBe(400);
      let html = await res.text();
      expect(html).toContain('That doesn&#39;t look like a key — paste it again without spaces');
      expect(html).not.toContain('SyZWSP');
      res = await post('/admin/setup/services', { places_key: 'AIzaSyTINY-12', anthropic_key: '' });
      expect(res.status).toBe(400);
      html = await res.text();
      expect(html).toMatch(/role="alert"[^>]*>[^<]*too short/);
      expect(html).not.toContain('SyTINY');
      expect(secrets.getPlacesKey()).toBeUndefined();
    });

    it('a short stored key shows only "Saved", without its last four', async () => {
      const { get, secrets } = await harness();
      secrets.setAnthropicKey('short-k9x7');
      const html = await (await get('/admin/setup/services')).text();
      expect(html).toContain('<strong>Saved</strong>');
      expect(html).not.toContain('k9x7');
    });

    it('rejects a key with whitespace or control characters and never echoes it', async () => {
      const { post, secrets } = await harness();
      for (const bad of ['AIza SyBAD-key-0001', 'AIzaSyBAD\tkey-0002', 'AIzaSyBAD\u0007key-0003']) {
        const res = await post('/admin/setup/services', { places_key: bad, anthropic_key: '' });
        expect(res.status).toBe(400);
        const html = await res.text();
        // hono/jsx escapes the apostrophe in text content.
        expect(html).toContain('That doesn&#39;t look like a key — paste it again without spaces');
        expect(html).toMatch(/role="alert"/);
        expect(html).not.toContain('SyBAD');
        expect(secrets.getPlacesKey()).toBeUndefined();
      }
      // One bad field saves nothing, not even the good one.
      const res = await post('/admin/setup/services', { places_key: 'AIzaSyGOOD-key-000004', anthropic_key: 'sk-ant bad' });
      expect(res.status).toBe(400);
      expect(secrets.getPlacesKey()).toBeUndefined();
    });

    it('env-provided key is read-only', async () => {
      const { get, post, secrets, db } = await harness({ env: { GOOGLE_PLACES_API_KEY: 'AIzaSyENV-provided-key-7777' } });
      const html = await (await get('/admin/setup/services')).text();
      expect(html).toContain('Set by the server environment');
      expect(html).not.toContain('name="places_key"');
      expect(html).not.toMatch(/name="remove" value="places"/); // no Remove button for it (Test is allowed)
      expect(html).not.toContain('AIzaSyENV');
      expect(html).not.toContain('7777');
      expect(html).toContain('name="anthropic_key"');

      let res = await post('/admin/setup/services', { places_key: 'AIzaSyOTHER-1111', anthropic_key: '' });
      expect(res.status).toBe(302);
      expect(secrets.getPlacesKey()).toBe('AIzaSyENV-provided-key-7777');
      res = await post('/admin/setup/services', { remove: 'places' });
      expect(res.status).toBeLessThan(500);
      expect(secrets.getPlacesKey()).toBe('AIzaSyENV-provided-key-7777');
      // Nothing was written to the DB store either.
      expect(db.all(`select * from app_secrets where key = 'google_places_api_key'`)).toEqual([]);
    });

    it('Test probes the saved Places key and reports the result in plain words, scrubbed', async () => {
      const key = 'AIzaSyPROBED-key-5555';
      const fetch = vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: `key ${key} is blocked` } }), { status: 403 }),
      ) as unknown as typeof globalThis.fetch;
      const { post, secrets } = await harness({ fetch });
      secrets.setPlacesKey(key);
      // A typed-but-unsaved value is not what gets tested.
      const res = await post('/admin/setup/services', { test: 'places', places_key: 'AIzaSyUNSAVED-0000' });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/role="alert"[^>]*>[^<]*Google rejected this key/);
      expect(html).not.toContain(key);
      expect(html).not.toContain('UNSAVED');
      expect(secrets.getPlacesKey()).toBe(key);
      const headers = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].headers as Record<string, string>;
      expect(headers['X-Goog-Api-Key']).toBe(key);
    });

    it('Test does not count against the monthly Places cap, even when the cap is reached', async () => {
      const fetch = vi.fn(async () => new Response(JSON.stringify({ places: [{ id: 'x' }] }), { status: 200 })) as unknown as typeof globalThis.fetch;
      const { post, secrets, db, env } = await harness({ fetch });
      const month = new Date().toISOString().slice(0, 7);
      const at = new Date('2026-01-01T00:00:00Z');
      db.insert(placesUsage).values({ month, calls: env.PLACES_MONTHLY_CAP, updatedAt: at }).run();
      secrets.setPlacesKey('AIzaSyCAPPED-key-000123');
      const html = await (await post('/admin/setup/services', { test: 'places' })).text();
      expect(html).toMatch(/role="status"[^>]*>[^<]*works/);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(db.select().from(placesUsage).all()).toEqual([{ month, calls: env.PLACES_MONTHLY_CAP, updatedAt: at }]);
    });

    it('Test reports success with role=status', async () => {
      const fetch = vi.fn(async () => new Response(JSON.stringify({ places: [] }), { status: 200 })) as unknown as typeof globalThis.fetch;
      const { post, secrets } = await harness({ fetch });
      secrets.setPlacesKey('AIzaSyWORKS-6666');
      const html = await (await post('/admin/setup/services', { test: 'places' })).text();
      expect(html).toMatch(/role="status"[^>]*>[^<]*works/);
    });

    it('Test probes the saved Anthropic key and scrubs it from errors', async () => {
      const key = 'sk-ant-api03-route-probe-4321';
      const llm = {
        generateJson: vi.fn(async () => {
          throw new APIError(401, undefined, `invalid x-api-key ${key}`, new Headers());
        }),
      } as unknown as LlmProvider;
      const { post, secrets } = await harness({ llm });
      secrets.setAnthropicKey(key);
      const res = await post('/admin/setup/services', { test: 'anthropic' });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/role="alert"[^>]*>[^<]*Anthropic rejected this key/);
      expect(html).not.toContain(key);
    });
  });

  describe('home step', () => {
    it('without a Places key offers manual coordinates with a how-to hint, time zones and Advanced schedules', async () => {
      const { get } = await harness();
      const html = await (await get('/admin/setup/home')).text();
      expect(html).toContain('Step 3 of 7');
      expect(html).not.toContain('action="/admin/setup/home/lookup"');
      expect(html).toContain('name="home_lat"');
      expect(html).toContain('name="home_lng"');
      expect(html).toMatch(/long-press/i);
      expect(html).toMatch(/<input[^>]*list="tz-list"/);
      expect(html).toContain('<datalist id="tz-list">');
      expect(html).toContain('<option value="America/New_York"');
      expect(html).toMatch(/<details[^>]*>\s*<summary>Advanced<\/summary>/);
      expect(html).toContain('weekly on Sunday at 3:00 am');
      expect(html).toContain('monthly on day 1 at 4:00 am');
    });

    it('saves manual coordinates, radius, time zone and schedules, then advances', async () => {
      const { post, db, reschedule } = await harness();
      const res = await post('/admin/setup/home', {
        home_lat: '40.5',
        home_lng: '-111.9',
        default_radius_mi: '20',
        home_tz: 'America/Los_Angeles',
        location_refresh_cron: '0 2 * * 1',
        protocol_refresh_cron: '0 5 2 * *',
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/admin/setup/categories');
      expect(getSettings(db)).toMatchObject({
        homeLat: 40.5,
        homeLng: -111.9,
        defaultRadiusMi: 20,
        homeTz: 'America/Los_Angeles',
        locationRefreshCron: '0 2 * * 1',
        protocolRefreshCron: '0 5 2 * *',
      });
      expect(reschedule).toHaveBeenCalledTimes(1);
    });

    it('invalid fields re-render with 400 and plain-words errors beside each field', async () => {
      const { post, db, reschedule } = await harness();
      const res = await post('/admin/setup/home', {
        home_lat: '123',
        home_lng: '-111.9',
        default_radius_mi: '0',
        home_tz: 'Mars/Olympus',
        location_refresh_cron: 'every day',
        protocol_refresh_cron: '0 4 1 * *',
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toMatch(/role="alert"[^>]*>[^<]*Latitude/);
      expect(html).toMatch(/role="alert"[^>]*>[^<]*radius[^<]*500/i);
      expect(html).toMatch(/role="alert"[^>]*>[^<]*time zone/i);
      expect(html).toMatch(/role="alert"[^>]*>[^<]*schedule/i);
      // The submitted values are kept for correction, and the Advanced section opens to show its error.
      expect(html).toContain('value="Mars/Olympus"');
      expect(html).toMatch(/<details[^>]*open/);
      expect(getSettings(db).homeLat).toBeNull();
      expect(reschedule).not.toHaveBeenCalled();
    });

    it('with a Places key, looks up the address, saves home and stays on the step', async () => {
      const fetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            places: [{ id: 'p1', displayName: { text: 'Home' }, formattedAddress: '1 Main St', location: { latitude: 40.1, longitude: -111.2 } }],
          }),
          { status: 200 },
        ),
      ) as unknown as typeof globalThis.fetch;
      const { get, post, db, secrets } = await harness({ fetch });
      secrets.setPlacesKey('AIzaSyLOOKUP-2222');
      const page = await (await get('/admin/setup/home')).text();
      expect(page).toContain('action="/admin/setup/home/lookup"');

      const res = await post('/admin/setup/home/lookup', { address: '1 Main St, Springville' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/admin/setup/home?found=1');
      expect(getSettings(db)).toMatchObject({ homeLabel: '1 Main St, Springville', homeLat: 40.1, homeLng: -111.2 });
      const after = await (await get('/admin/setup/home?found=1')).text();
      expect(after).toMatch(/role="status"/);
      expect(after).toContain('value="40.1"');
    });

    it('manual coordinates that differ from a looked-up home clear its label; unchanged ones keep it', async () => {
      const { post, db } = await harness();
      db.update(settings).set({ homeLabel: '1 Main St', homeLat: 40.1, homeLng: -111.2 }).where(eq(settings.id, 1)).run();
      const base = { default_radius_mi: '15', home_tz: 'America/Denver', location_refresh_cron: '0 3 * * 0', protocol_refresh_cron: '0 4 1 * *' };
      expect((await post('/admin/setup/home', { ...base, home_lat: '40.1', home_lng: '-111.2' })).status).toBe(302);
      expect(getSettings(db).homeLabel).toBe('1 Main St');
      expect((await post('/admin/setup/home', { ...base, home_lat: '41', home_lng: '-111.2' })).status).toBe(302);
      expect(getSettings(db)).toMatchObject({ homeLabel: null, homeLat: 41 });
    });

    it('lookup without a key or with a blank address explains in plain words', async () => {
      const { post, secrets } = await harness({ fetch: vi.fn() as unknown as typeof globalThis.fetch });
      let res = await post('/admin/setup/home/lookup', { address: '1 Main St' });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('/admin/setup/services');
      secrets.setPlacesKey('AIzaSyLOOKUP-3333');
      res = await post('/admin/setup/home/lookup', { address: '  ' });
      expect(res.status).toBe(400);
      expect(await res.text()).toMatch(/role="alert"[^>]*>[^<]*address/i);
    });
  });
});
