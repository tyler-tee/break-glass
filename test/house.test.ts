import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { categories, houseFactPhotos } from '../src/db/schema.js';
import { loadEnv } from '../src/env.js';
import { hashPassword } from '../src/features/admin/auth.js';
import { CategoryError, deleteCategory } from '../src/features/categories/repo.js';
import {
  HouseFactError, addPhoto, createFact, deleteFact, deletePhoto, factsForCategory, factsForSystems, getFact,
  getPhoto, listFacts, listPhotos, markChecked, updateFact, type HouseFactInput,
} from '../src/features/house/repo.js';
import { adminLogin } from './helpers/adminLogin.js';
import { createTestDb } from './helpers/testDb.js';

const NOW = new Date('2026-10-27T16:00:00Z');
const LATER = new Date('2026-10-28T09:00:00Z');

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x1a, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const ftyp = (brand: string) => new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, ...[...brand].map((ch) => ch.charCodeAt(0)), 0, 0, 0, 0]);
const GIF = new TextEncoder().encode('GIF89a\x01\x00\x01\x00\x00\x00\x00;');
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const RANDOM = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 11, 12, 13]);

let db: Db;
let app: ReturnType<typeof createApp>;
let cookie: string;

beforeEach(async () => {
  db = createTestDb();
  app = createApp({
    db,
    env: loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: await hashPassword('correct horse') }),
    now: () => NOW,
  });
  cookie = await adminLogin(app, 'correct horse');
});

const shutoff = (over: Partial<HouseFactInput> = {}): HouseFactInput => ({
  kind: 'shutoff', system: 'water', title: 'Water main', whereNote: 'Basement, left of the heater', ...over,
});
const homeCat = (name = 'Plumber') =>
  db.insert(categories).values({ name, slug: name.toLowerCase(), searchTerms: [name], area: 'home' }).returning().get();
const healthCat = () =>
  db.insert(categories).values({ name: 'Dentist', slug: 'dentist', searchTerms: ['dentist'], area: 'health' }).returning().get();

function fieldOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HouseFactError);
    expect((e as HouseFactError).code).toBe('invalid');
    return (e as HouseFactError).field;
  }
  throw new Error('expected a HouseFactError');
}

describe('house fact validation', () => {
  it('creates a shutoff, trims, nulls empties, defaults system, and stamps checked_at', () => {
    const f = createFact(db, { kind: 'shutoff', title: '  Water main  ', whereNote: ' Basement ', org: '   ' }, NOW);
    expect(f).toMatchObject({ title: 'Water main', whereNote: 'Basement', org: null, instructions: null, system: 'general' });
    expect(f.checkedAt).toEqual(NOW);
  });

  it('requires a title, at most 80 characters', () => {
    expect(fieldOf(() => createFact(db, shutoff({ title: '  ' }), NOW))).toBe('title');
    expect(fieldOf(() => createFact(db, shutoff({ title: 'x'.repeat(81) }), NOW))).toBe('title');
    createFact(db, shutoff({ title: 'x'.repeat(80) }), NOW);
  });

  it('shutoff needs whereNote, note needs instructions, utility and contact need a phone', () => {
    expect(fieldOf(() => createFact(db, shutoff({ whereNote: '' }), NOW))).toBe('where_note');
    expect(fieldOf(() => createFact(db, { kind: 'note', title: 'Filter', instructions: ' ' }, NOW))).toBe('instructions');
    createFact(db, { kind: 'note', title: 'Filter', instructions: '20x25x1' }, NOW);
    for (const kind of ['utility', 'contact']) {
      expect(fieldOf(() => createFact(db, { kind, title: 'T' }, NOW))).toBe('phone');
      expect(fieldOf(() => createFact(db, { kind, title: 'T', phone: '12-34' }, NOW))).toBe('phone');
      createFact(db, { kind, title: 'T', phone: '(801) 555-0100' }, NOW);
    }
  });

  it('rejects an unknown kind or system, and over-long fields', () => {
    expect(fieldOf(() => createFact(db, shutoff({ kind: 'bogus' }), NOW))).toBe('kind');
    expect(fieldOf(() => createFact(db, shutoff({ system: 'plumbing' }), NOW))).toBe('system');
    expect(fieldOf(() => createFact(db, shutoff({ whereNote: 'x'.repeat(301) }), NOW))).toBe('where_note');
    expect(fieldOf(() => createFact(db, { kind: 'note', title: 'T', instructions: 'x'.repeat(2001) }, NOW))).toBe('instructions');
    expect(fieldOf(() => createFact(db, { kind: 'contact', title: 'T', phone: '8015550100', org: 'x'.repeat(81) }, NOW))).toBe('org');
  });

  it('allows categoryId only on a contact, and only for a home category', () => {
    const home = homeCat();
    const health = healthCat();
    const contact = { kind: 'contact', title: 'Joe Plumbing', phone: '8015550100' };
    const f = createFact(db, { ...contact, categoryId: home.id }, NOW);
    expect(f.categoryId).toBe(home.id);
    expect(fieldOf(() => createFact(db, { ...contact, categoryId: health.id }, NOW))).toBe('category_id');
    expect(fieldOf(() => createFact(db, { ...contact, categoryId: 9999 }, NOW))).toBe('category_id');
    expect(fieldOf(() => createFact(db, shutoff({ categoryId: home.id }), NOW))).toBe('category_id');
    expect(fieldOf(() => createFact(db, { kind: 'utility', title: 'Gas', phone: '8015550100', categoryId: home.id }, NOW))).toBe('category_id');
  });

  it('update re-validates, stamps checked_at, and 404s a missing id; markChecked only touches checked_at', () => {
    const f = createFact(db, shutoff(), NOW);
    const u = updateFact(db, f.id, shutoff({ title: 'Main valve' }), LATER);
    expect(u.title).toBe('Main valve');
    expect(u.checkedAt).toEqual(LATER);
    expect(fieldOf(() => updateFact(db, f.id, shutoff({ whereNote: '' }), LATER))).toBe('where_note');
    expect(() => updateFact(db, 999, shutoff(), LATER)).toThrow(HouseFactError);
    const later2 = new Date('2026-11-01T00:00:00Z');
    const m = markChecked(db, f.id, later2);
    expect(m.checkedAt).toEqual(later2);
    expect(m.title).toBe('Main valve');
    expect(() => markChecked(db, 999, later2)).toThrow(HouseFactError);
  });

  it('lists by system, sort_order, id; and finds facts for a category or systems', () => {
    const cat = homeCat();
    createFact(db, shutoff({ system: 'water', title: 'B' }), NOW);
    createFact(db, { kind: 'utility', system: 'gas', title: 'Gas co', phone: '8015550100' }, NOW);
    createFact(db, { kind: 'contact', system: 'hvac', title: 'Joe', phone: '8015550100', categoryId: cat.id }, NOW);
    expect(listFacts(db).map((f) => f.system)).toEqual(['gas', 'hvac', 'water']);
    expect(factsForCategory(db, cat.id).map((f) => f.title)).toEqual(['Joe']);
    expect(factsForSystems(db, ['gas', 'water']).map((f) => f.title)).toEqual(['Gas co', 'B']);
    expect(factsForSystems(db, [])).toEqual([]);
  });
});

describe('house fact photos', () => {
  const fact = () => createFact(db, shutoff(), NOW);

  it('accepts real JPEG, PNG and WebP headers, ignoring the claimed type', () => {
    const f = fact();
    expect(addPhoto(db, f.id, JPEG, ' behind heater ', NOW)).toMatchObject({ mime: 'image/jpeg', caption: 'behind heater', byteSize: JPEG.length });
    expect(addPhoto(db, f.id, PNG, null, NOW).mime).toBe('image/png');
    const w = addPhoto(db, f.id, WEBP, '', NOW);
    expect(w).toMatchObject({ mime: 'image/webp', caption: null, sortOrder: 2 });
    expect(w.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(listPhotos(db, f.id).map((p) => p.mime)).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    expect(listPhotos(db, f.id)[0]).not.toHaveProperty('bytes');
  });

  it('rejects HEIC with code heic and the iPhone message', () => {
    const f = fact();
    for (const brand of ['heic', 'heix', 'hevc', 'mif1', 'msf1']) {
      try {
        addPhoto(db, f.id, ftyp(brand), null, NOW);
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as HouseFactError).code).toBe('heic');
        expect((e as HouseFactError).message).toBe(
          "iPhone HEIC photos aren't supported. In Settings › Camera › Formats choose Most Compatible, or upload from a browser with JavaScript on.",
        );
      }
    }
  });

  it('rejects GIF, SVG text, random bytes and an mp4 as type', () => {
    const f = fact();
    for (const bytes of [GIF, SVG, RANDOM, ftyp('isom'), new Uint8Array()]) {
      expect(() => addPhoto(db, f.id, bytes, null, NOW)).toThrow(expect.objectContaining({ code: 'type' }));
    }
  });

  it('enforces size, per-fact and total caps (defaults kept, overridable)', () => {
    const f = fact();
    const limits = { maxBytes: 20, perFact: 2, total: 3 };
    expect(() => addPhoto(db, f.id, new Uint8Array(21).fill(0xff), null, NOW, limits)).toThrow(expect.objectContaining({ code: 'size' }));
    addPhoto(db, f.id, JPEG, null, NOW, limits);
    addPhoto(db, f.id, JPEG, null, NOW, limits);
    expect(() => addPhoto(db, f.id, JPEG, null, NOW, limits)).toThrow(expect.objectContaining({ code: 'per_fact' }));
    const g = createFact(db, shutoff({ title: 'Gas' }), NOW);
    addPhoto(db, g.id, JPEG, null, NOW, limits);
    expect(() => addPhoto(db, g.id, JPEG, null, NOW, limits)).toThrow(expect.objectContaining({ code: 'total' }));
  });

  it('default caps are 8 MB, 4 per fact, 200 total', async () => {
    const f = fact();
    const big = new Uint8Array(8 * 1024 * 1024 + 1);
    big.set(JPEG);
    expect(() => addPhoto(db, f.id, big, null, NOW)).toThrow(expect.objectContaining({ code: 'size' }));
    for (let i = 0; i < 4; i++) addPhoto(db, f.id, JPEG, null, NOW);
    expect(() => addPhoto(db, f.id, JPEG, null, NOW)).toThrow(expect.objectContaining({ code: 'per_fact' }));
  });

  it('deleting a fact removes its photos; deletePhoto removes one', () => {
    const f = fact();
    const other = createFact(db, shutoff({ title: 'Gas' }), NOW);
    const p1 = addPhoto(db, f.id, JPEG, null, NOW);
    addPhoto(db, f.id, PNG, null, NOW);
    const keep = addPhoto(db, other.id, PNG, null, NOW);
    deletePhoto(db, p1.id);
    expect(getPhoto(db, p1.id)).toBeNull();
    expect(() => deletePhoto(db, p1.id)).toThrow(HouseFactError);
    deleteFact(db, f.id);
    expect(getFact(db, f.id)).toBeNull();
    expect(db.select().from(houseFactPhotos).all().map((p) => p.id)).toEqual([keep.id]);
  });

  it('the foreign key cascade also removes photos (raw delete)', () => {
    const f = fact();
    addPhoto(db, f.id, JPEG, null, NOW);
    db.$client.prepare('delete from house_facts where id = ?').run(f.id);
    expect(db.select().from(houseFactPhotos).all()).toEqual([]);
  });
});

describe('deleteCategory and house facts', () => {
  it('is refused while a house fact references the category, allowed after', () => {
    const cat = homeCat();
    const f = createFact(db, { kind: 'contact', title: 'Joe', phone: '8015550100', categoryId: cat.id }, NOW);
    expect(() => deleteCategory(db, cat.id)).toThrow(expect.objectContaining({ code: 'in_use' }));
    expect(() => deleteCategory(db, cat.id)).toThrow(CategoryError);
    deleteFact(db, f.id);
    deleteCategory(db, cat.id);
  });
});

describe('GET /house/photos/:id', () => {
  it('serves the bytes with the safe headers, 304s on a matching ETag, 404s otherwise', async () => {
    const f = createFact(db, shutoff(), NOW);
    const p = addPhoto(db, f.id, PNG, null, NOW);
    const res = await app.request(`/house/photos/${p.id}`); // no session cookie
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('etag')).toBe(`"${p.sha256}"`);
    expect(res.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);

    const hit = await app.request(`/house/photos/${p.id}`, { headers: { 'if-none-match': `"${p.sha256}"` } });
    expect(hit.status).toBe(304);
    expect(hit.headers.get('etag')).toBe(`"${p.sha256}"`);
    expect(await hit.text()).toBe('');
    const miss = await app.request(`/house/photos/${p.id}`, { headers: { 'if-none-match': '"other"' } });
    expect(miss.status).toBe(200);

    expect((await app.request('/house/photos/9999')).status).toBe(404);
    expect((await app.request('/house/photos/abc')).status).toBe(404);
  });
});

describe('admin house routes', () => {
  const origin = { origin: 'http://localhost' };
  const upload = (factId: number | string, bytes: Uint8Array, headers: Record<string, string> = { cookie, ...origin }, extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set('photo', new File([bytes], 'p.bin', { type: 'image/jpeg' }));
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    return app.request(`/admin/house/${factId}/photos`, { method: 'POST', headers, body: fd });
  };
  const form = (path: string, body: Record<string, string>, headers: Record<string, string> = { cookie, ...origin }) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(body).toString(),
    });

  it('creates, updates and deletes a fact; a bad one is a 400 with the message', async () => {
    const bad = await form('/admin/house', { kind: 'shutoff', title: 'Water' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('Say where the shutoff is');

    const ok = await form('/admin/house', { kind: 'shutoff', system: 'water', title: 'Water main', where_note: 'Basement' });
    expect(ok.status).toBe(302);
    const f = listFacts(db)[0]!;
    expect(f.title).toBe('Water main');

    const list = await app.request('/admin/house', { headers: { cookie } });
    expect(list.status).toBe(200);
    expect(await list.text()).toContain('Water main');

    const upd = await form(`/admin/house/${f.id}`, { kind: 'shutoff', system: 'water', title: 'Main valve', where_note: 'Basement' });
    expect(upd.status).toBe(302);
    expect(getFact(db, f.id)!.title).toBe('Main valve');
    expect((await form('/admin/house/999', { kind: 'shutoff', title: 'x', where_note: 'y' })).status).toBe(404);

    expect((await form(`/admin/house/${f.id}/delete`, {})).status).toBe(302);
    expect(getFact(db, f.id)).toBeNull();
  });

  it('uploads and deletes a photo, redirecting to a safe return_to or /admin', async () => {
    const f = createFact(db, shutoff(), NOW);
    const ok = await upload(f.id, JPEG, undefined, { caption: 'valve', return_to: '/admin/house' });
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('/admin/house');
    expect(listPhotos(db, f.id)).toHaveLength(1);

    const unsafe = await upload(f.id, PNG, undefined, { return_to: '//evil.example' });
    expect(unsafe.headers.get('location')).toBe('/admin');

    const [p1] = listPhotos(db, f.id);
    const del = await form(`/admin/house/photos/${p1!.id}/delete`, { return_to: '/admin/house' });
    expect(del.status).toBe(302);
    expect(del.headers.get('location')).toBe('/admin/house');
    expect(getPhoto(db, p1!.id)).toBeNull();
    expect((await form(`/admin/house/photos/${p1!.id}/delete`, {})).status).toBe(404);
  });

  it('returns 400 with the plain message for HEIC, a wrong type, or no file', async () => {
    const f = createFact(db, shutoff(), NOW);
    const heic = await upload(f.id, ftyp('heic'));
    expect(heic.status).toBe(400);
    expect(await heic.text()).toContain("iPhone HEIC photos aren't supported");
    expect((await upload(f.id, GIF)).status).toBe(400);
    const none = await app.request(`/admin/house/${f.id}/photos`, {
      method: 'POST', headers: { cookie, ...origin }, body: new FormData(),
    });
    expect(none.status).toBe(400);
    expect((await upload(9999, JPEG)).status).toBe(404);
  });

  it('redirects an upload with no session to login, and refuses a cross-origin one with 403', async () => {
    const f = createFact(db, shutoff(), NOW);
    const anon = await upload(f.id, JPEG, origin);
    expect(anon.status).toBe(302);
    expect(anon.headers.get('location')).toContain('/admin/login');
    const cross = await upload(f.id, JPEG, { cookie, origin: 'http://evil.example' });
    expect(cross.status).toBe(403);
    expect(listPhotos(db, f.id)).toHaveLength(0);
  });

  it('a ~1 MB upload to the photo route succeeds', async () => {
    const f = createFact(db, shutoff(), NOW);
    const big = new Uint8Array(1024 * 1024);
    big.set(JPEG);
    const res = await upload(f.id, big);
    expect(res.status).toBe(302);
    expect(listPhotos(db, f.id)[0]!.byteSize).toBe(big.length);
  });

  it('an upload over 8 MB plus overhead is a 413', async () => {
    const f = createFact(db, shutoff(), NOW);
    const huge = new Uint8Array(8 * 1024 * 1024 + 100 * 1024);
    huge.set(JPEG);
    const res = await upload(f.id, huge);
    expect(res.status).toBe(413);
    expect(listPhotos(db, f.id)).toHaveLength(0);
  });

  it('the exemption is narrow: a body over 256 KB to any other admin POST is still a 413', async () => {
    const res = await form('/admin/categories', { name: 'x'.repeat(300 * 1024), search_terms: 'a' });
    expect(res.status).toBe(413);
    const f = createFact(db, shutoff(), NOW);
    const sameFolder = await form(`/admin/house/${f.id}`, { kind: 'shutoff', title: 'x'.repeat(300 * 1024), where_note: 'y' });
    expect(sameFolder.status).toBe(413);
    const big = new Uint8Array(300 * 1024);
    big.set(JPEG);
    const fd = new FormData();
    fd.set('photo', new File([big], 'p.jpg'));
    const getLike = await app.request(`/admin/house/${f.id}/photos-x`, { method: 'POST', headers: { cookie, ...origin }, body: fd });
    expect(getLike.status).toBe(413);
  });
});
