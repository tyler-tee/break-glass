import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { categories, locations } from '../../db/schema.js';
import { slugify } from '../../domain/slug.js';

export type Category = typeof categories.$inferSelect;

export type CategoryErrorCode = 'duplicate' | 'in_use' | 'invalid' | 'not_found';

/** The form field a validation error belongs to, so callers need not parse the message. */
export type CategoryField = 'name' | 'search_terms' | 'target_count';

export class CategoryError extends Error {
  constructor(
    public code: CategoryErrorCode,
    message: string,
    public field?: CategoryField,
  ) {
    super(message);
    this.name = 'CategoryError';
  }
}

export function listCategories(db: Db): Category[] {
  return db.select().from(categories).orderBy(categories.name).all();
}

export function getCategory(db: Db, id: number): Category | null {
  return db.select().from(categories).where(eq(categories.id, id)).get() ?? null;
}

export function getCategoryBySlug(db: Db, slug: string): Category | null {
  return db.select().from(categories).where(eq(categories.slug, slug)).get() ?? null;
}

type CategoryFields = {
  name: string;
  searchTerms: string[];
  targetCount: number;
};

function validate(db: Db, fields: CategoryFields, selfId?: number): CategoryFields & { slug: string } {
  const name = fields.name.trim();
  if (name === '') throw new CategoryError('invalid', 'Name is required', 'name');
  const slug = slugify(name);
  if (slug === '') throw new CategoryError('invalid', 'Name must contain letters or numbers', 'name');
  const searchTerms = [...new Set(fields.searchTerms.map((t) => t.trim()).filter((t) => t !== ''))];
  if (searchTerms.length === 0) throw new CategoryError('invalid', 'At least one search term is required', 'search_terms');
  if (!Number.isInteger(fields.targetCount) || fields.targetCount < 1) {
    throw new CategoryError('invalid', 'Target count must be a whole number of at least 1', 'target_count');
  }
  const clash = listCategories(db).find(
    (c) => c.id !== selfId && (c.slug === slug || c.name.toLowerCase() === name.toLowerCase()),
  );
  if (clash) throw new CategoryError('duplicate', `A category named "${clash.name}" already exists`, 'name');
  return { name, slug, searchTerms, targetCount: fields.targetCount };
}

export function createCategory(db: Db, input: { name: string; searchTerms: string[]; targetCount?: number }): Category {
  const values = validate(db, {
    ...input,
    targetCount: input.targetCount ?? 5,
  });
  return db.insert(categories).values(values).returning().get();
}

export function updateCategory(
  db: Db,
  id: number,
  patch: Partial<{ name: string; searchTerms: string[]; targetCount: number }>,
): Category {
  const current = getCategory(db, id);
  if (!current) throw new CategoryError('not_found', 'Category not found');
  const values = validate(
    db,
    {
      name: patch.name ?? current.name,
      searchTerms: patch.searchTerms ?? current.searchTerms,
      targetCount: patch.targetCount ?? current.targetCount ?? 5,
    },
    id,
  );
  return db.update(categories).set(values).where(eq(categories.id, id)).returning().get();
}

export function deleteCategory(db: Db, id: number): void {
  if (!getCategory(db, id)) throw new CategoryError('not_found', 'Category not found');
  const used = db.select({ id: locations.id }).from(locations).where(eq(locations.categoryId, id)).get();
  if (used) throw new CategoryError('in_use', 'Category is in use by existing locations and cannot be deleted');
  db.delete(categories).where(eq(categories.id, id)).run();
}
