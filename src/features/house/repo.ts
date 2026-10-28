import { createHash } from 'node:crypto';
import { asc, count, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { houseFactPhotos, houseFacts, type HouseFact, type HouseFactPhoto } from '../../db/schema.js';
import { HOUSE_FACT_KINDS, HOUSE_SYSTEMS, type HouseSystem, type PhotoMime } from '../../domain/types.js';
import { getCategory } from '../categories/repo.js';

export type { HouseFact, HouseFactPhoto };

export type HouseFactErrorCode = 'invalid' | 'not_found' | 'heic' | 'type' | 'size' | 'per_fact' | 'total';

/** The form field a validation error belongs to, so callers need not parse the message. */
export type HouseFactField =
  | 'kind' | 'system' | 'title' | 'where_note' | 'instructions' | 'org' | 'phone' | 'category_id' | 'photo';

export class HouseFactError extends Error {
  constructor(
    public code: HouseFactErrorCode,
    message: string,
    public field?: HouseFactField,
  ) {
    super(message);
    this.name = 'HouseFactError';
  }
}

export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const MAX_PHOTOS_PER_FACT = 4;
export const MAX_PHOTOS_TOTAL = 200;
export type PhotoLimits = { maxBytes: number; perFact: number; total: number };
export const DEFAULT_PHOTO_LIMITS: PhotoLimits = {
  maxBytes: MAX_PHOTO_BYTES,
  perFact: MAX_PHOTOS_PER_FACT,
  total: MAX_PHOTOS_TOTAL,
};

export const HEIC_MESSAGE =
  "iPhone HEIC photos aren't supported. In Settings › Camera › Formats choose Most Compatible, or upload from a browser with JavaScript on.";

// ---- facts ----

export type HouseFactInput = {
  kind: string;
  system?: string | null;
  title?: string | null;
  whereNote?: string | null;
  instructions?: string | null;
  org?: string | null;
  phone?: string | null;
  categoryId?: number | null;
};

// Trimmed; empty becomes null.
const text = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim() || null : v ?? null),
  z.string().nullable(),
);
const FIELD_OF: Record<string, HouseFactField> = {
  kind: 'kind', system: 'system', title: 'title', whereNote: 'where_note', instructions: 'instructions',
  org: 'org', phone: 'phone', categoryId: 'category_id',
};

const baseSchema = z.object({
  kind: z.enum(HOUSE_FACT_KINDS, { error: 'Choose a kind' }),
  system: z.preprocess((v) => (typeof v === 'string' && v.trim() ? v.trim() : 'general'), z.enum(HOUSE_SYSTEMS, { error: 'Choose a system' })),
  title: text.refine((v) => v !== null, 'Title is required').refine((v) => v === null || v.length <= 80, 'Title must be 80 characters or fewer'),
  whereNote: text.refine((v) => v === null || v.length <= 300, 'Where must be 300 characters or fewer'),
  instructions: text.refine((v) => v === null || v.length <= 2000, 'Instructions must be 2000 characters or fewer'),
  org: text.refine((v) => v === null || v.length <= 80, 'Name must be 80 characters or fewer'),
  phone: text,
  categoryId: z.number().int().nullable().optional().transform((v) => v ?? null),
});

type Clean = {
  kind: (typeof HOUSE_FACT_KINDS)[number];
  system: HouseSystem;
  title: string;
  whereNote: string | null;
  instructions: string | null;
  org: string | null;
  phone: string | null;
  categoryId: number | null;
};

function validate(db: Db, input: HouseFactInput): Clean {
  const parsed = baseSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new HouseFactError('invalid', issue.message, FIELD_OF[String(issue.path[0])]);
  }
  const v = parsed.data as Omit<Clean, 'title'> & { title: string | null };
  if (v.kind === 'shutoff' && v.whereNote === null) {
    throw new HouseFactError('invalid', 'Say where the shutoff is', 'where_note');
  }
  if (v.kind === 'note' && v.instructions === null) {
    throw new HouseFactError('invalid', 'Write the note', 'instructions');
  }
  if (v.kind === 'utility' || v.kind === 'contact') {
    if (v.phone === null) throw new HouseFactError('invalid', 'Phone number is required', 'phone');
    if (v.phone.replace(/\D/g, '').length < 7) {
      throw new HouseFactError('invalid', 'Enter a phone number with at least 7 digits', 'phone');
    }
  }
  if (v.categoryId !== null) {
    if (v.kind !== 'contact') {
      throw new HouseFactError('invalid', 'Only contacts can be linked to a category', 'category_id');
    }
    const cat = getCategory(db, v.categoryId);
    if (!cat || cat.area !== 'home') {
      throw new HouseFactError('invalid', 'Choose a home category', 'category_id');
    }
  }
  return v as Clean;
}

export function listFacts(db: Db): HouseFact[] {
  return db.select().from(houseFacts).orderBy(asc(houseFacts.system), asc(houseFacts.sortOrder), asc(houseFacts.id)).all();
}

export function getFact(db: Db, id: number): HouseFact | null {
  return db.select().from(houseFacts).where(eq(houseFacts.id, id)).get() ?? null;
}

export function createFact(db: Db, input: HouseFactInput, now: Date): HouseFact {
  const values = validate(db, input);
  return db.insert(houseFacts).values({ ...values, checkedAt: now, createdAt: now, updatedAt: now }).returning().get();
}

export function updateFact(db: Db, id: number, input: HouseFactInput, now: Date): HouseFact {
  if (!getFact(db, id)) throw new HouseFactError('not_found', 'Fact not found');
  const values = validate(db, input);
  return db.update(houseFacts).set({ ...values, checkedAt: now, updatedAt: now }).where(eq(houseFacts.id, id)).returning().get();
}

export function deleteFact(db: Db, id: number): void {
  if (!getFact(db, id)) throw new HouseFactError('not_found', 'Fact not found');
  // The foreign key cascade would also do this (foreign_keys is ON); explicit so it never depends on the pragma.
  db.transaction((tx) => {
    tx.delete(houseFactPhotos).where(eq(houseFactPhotos.factId, id)).run();
    tx.delete(houseFacts).where(eq(houseFacts.id, id)).run();
  });
}

export function markChecked(db: Db, id: number, now: Date): HouseFact {
  const row = db.update(houseFacts).set({ checkedAt: now }).where(eq(houseFacts.id, id)).returning().get();
  if (!row) throw new HouseFactError('not_found', 'Fact not found');
  return row;
}

export function factsForCategory(db: Db, categoryId: number): HouseFact[] {
  return db.select().from(houseFacts).where(eq(houseFacts.categoryId, categoryId))
    .orderBy(asc(houseFacts.sortOrder), asc(houseFacts.id)).all();
}

export function factsForSystems(db: Db, systems: readonly HouseSystem[]): HouseFact[] {
  if (systems.length === 0) return [];
  return db.select().from(houseFacts).where(inArray(houseFacts.system, [...systems]))
    .orderBy(asc(houseFacts.system), asc(houseFacts.sortOrder), asc(houseFacts.id)).all();
}

// ---- photos ----


/** Finds the image type from the file's leading bytes; any client-supplied MIME type is ignored. */
export function sniffImage(b: Uint8Array): PhotoMime | 'heic' | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((x, k) => b[i + k] === x);
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (b.length >= 12 && at(4, 0x66, 0x74, 0x79, 0x70)) {
    const brand = String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!);
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  return null;
}

export function addPhoto(
  db: Db,
  factId: number,
  bytes: Uint8Array,
  caption: string | null | undefined,
  now: Date,
  limits: PhotoLimits = DEFAULT_PHOTO_LIMITS,
): HouseFactPhoto {
  if (!getFact(db, factId)) throw new HouseFactError('not_found', 'Fact not found');
  if (bytes.length > limits.maxBytes) {
    throw new HouseFactError('size', `That photo is too large (the limit is ${Math.round(limits.maxBytes / 1024 / 1024)} MB)`, 'photo');
  }
  const kind = sniffImage(bytes);
  if (kind === 'heic') throw new HouseFactError('heic', HEIC_MESSAGE, 'photo');
  if (kind === null) throw new HouseFactError('type', 'Photos must be JPEG, PNG or WebP images', 'photo');
  const forFact = db.select({ n: count() }).from(houseFactPhotos).where(eq(houseFactPhotos.factId, factId)).get()?.n ?? 0;
  if (forFact >= limits.perFact) {
    throw new HouseFactError('per_fact', `A fact can have at most ${limits.perFact} photos`, 'photo');
  }
  const total = db.select({ n: count() }).from(houseFactPhotos).get()?.n ?? 0;
  if (total >= limits.total) {
    throw new HouseFactError('total', `The household can store at most ${limits.total} photos`, 'photo');
  }
  const cap = (caption ?? '').trim();
  if (cap.length > 200) throw new HouseFactError('invalid', 'Caption must be 200 characters or fewer', 'photo');
  const last = db.select({ s: houseFactPhotos.sortOrder }).from(houseFactPhotos)
    .where(eq(houseFactPhotos.factId, factId)).orderBy(asc(houseFactPhotos.sortOrder)).all().at(-1);
  return db
    .insert(houseFactPhotos)
    .values({
      factId,
      mime: kind,
      bytes: Buffer.from(bytes),
      byteSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      caption: cap || null,
      sortOrder: last ? last.s + 1 : 0,
      createdAt: now,
    })
    .returning()
    .get();
}

export function getPhoto(db: Db, id: number): HouseFactPhoto | null {
  return db.select().from(houseFactPhotos).where(eq(houseFactPhotos.id, id)).get() ?? null;
}

/** Photos for a fact without the image bytes. */
export function listPhotos(db: Db, factId: number): Omit<HouseFactPhoto, 'bytes'>[] {
  return db
    .select({
      id: houseFactPhotos.id, factId: houseFactPhotos.factId, mime: houseFactPhotos.mime,
      byteSize: houseFactPhotos.byteSize, sha256: houseFactPhotos.sha256, caption: houseFactPhotos.caption,
      sortOrder: houseFactPhotos.sortOrder, createdAt: houseFactPhotos.createdAt,
    })
    .from(houseFactPhotos)
    .where(eq(houseFactPhotos.factId, factId))
    .orderBy(asc(houseFactPhotos.sortOrder), asc(houseFactPhotos.id))
    .all();
}

export function deletePhoto(db: Db, id: number): void {
  const res = db.delete(houseFactPhotos).where(eq(houseFactPhotos.id, id)).run();
  if (res.changes === 0) throw new HouseFactError('not_found', 'Photo not found');
}
