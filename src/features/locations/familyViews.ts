import type { Area } from '../../domain/types.js';
import type { Category } from '../categories/repo.js';
import { isReportedClosed, type LocationView } from './search.js';

// Family-side rules on top of the shared visible-location queries (the JSON API keeps its own).

/** Places reported permanently closed are hidden from the family entirely. */
export function forFamily(views: LocationView[]): LocationView[] {
  return views.filter((v) => !isReportedClosed(v));
}

export function isReportedTemporarilyClosed(view: LocationView): boolean {
  return (
    view.businessStatus === 'CLOSED_TEMPORARILY' ||
    view.openChanges.some((c) => c.field === 'businessStatus' && c.newValue === 'CLOSED_TEMPORARILY')
  );
}

/**
 * The provider category a guide points at: the first tag that equals a category's name, slug or one
 * of its search terms, ignoring case. Only categories in the given area (the protocol's) match. Lets "Knocked-out tooth" tagged "dentist" link to the dentists.
 */
export function categoryForTags(cats: Category[], tags: string[] | null, area: Area = 'health'): Category | null {
  for (const raw of tags ?? []) {
    const tag = raw.trim().toLowerCase();
    if (!tag) continue;
    const hit = cats.find(
      (c) =>
        c.area === area &&
        (c.name.toLowerCase() === tag || c.slug === tag || c.searchTerms.some((t) => t.toLowerCase() === tag)),
    );
    if (hit) return hit;
  }
  return null;
}
