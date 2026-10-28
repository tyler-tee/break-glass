import { Hono } from 'hono';
import type { AppDeps } from '../../app.js';
import { requestClock } from '../clock.js';
import { getCategoryBySlug, listCategories } from '../categories/repo.js';
import {
  getVisibleLocation,
  isReportedClosed,
  listVisibleByCategory,
  listVisibleGrouped,
  searchLocations,
  type CategoryGroup,
  type LocationView,
} from '../locations/search.js';
import { getPublished, getPublishedBySlug, type PublishedProtocol } from '../protocols/repo.js';

export function toApiLocation(v: LocationView) {
  return {
    id: v.id,
    categorySlug: v.category.slug,
    name: v.name,
    address: v.address,
    phone: v.phone,
    website: v.website,
    lat: v.lat,
    lng: v.lng,
    distanceMi: v.distanceMi,
    rating: v.rating,
    ratingCount: v.ratingCount,
    businessStatus: v.businessStatus,
    reportedClosed: isReportedClosed(v),
    hours: v.hours,
    afterHoursNotes: v.afterHoursNotes,
    walkIns: v.walkIns,
    insuranceNotes: v.insuranceNotes,
    status: v.status,
    lastVerifiedAt: v.lastVerifiedAt ? v.lastVerifiedAt.toISOString() : null,
    openNow: v.openNow,
    openChanges: v.openChanges,
  };
}

type CategoryRow = ReturnType<typeof listCategories>[number];

export function toApiCategory(c: CategoryRow) {
  return { id: c.id, name: c.name, slug: c.slug, searchTerms: c.searchTerms, hoursNeed: c.hoursNeed, area: c.area };
}

const toApiProtocol = ({ protocol, version }: PublishedProtocol) => ({
  id: protocol.id,
  slug: protocol.slug,
  title: protocol.title,
  tags: protocol.tags ?? [],
  area: protocol.area,
  needsRereview: protocol.needsRereview,
  rereviewReason: protocol.rereviewReason,
  version: { number: version.version, publishedAt: version.reviewedAt ? version.reviewedAt.toISOString() : null },
});

const toApiGroup = (g: CategoryGroup) => ({
  category: { id: g.category.id, name: g.category.name, slug: g.category.slug },
  locations: g.locations.map(toApiLocation),
});

export function apiRoutes(deps: AppDeps): Hono {
  const { db } = deps;
  const { now, tz } = requestClock(deps);
  const app = new Hono();

  app.get('/categories', (c) => c.json({ categories: listCategories(db).map(toApiCategory) }));

  app.get('/locations', (c) => {
    const q = c.req.query('q');
    const slug = c.req.query('category');
    if (q) return c.json({ categories: searchLocations(db, q, now(), tz()).map(toApiGroup) });
    if (slug) {
      const category = getCategoryBySlug(db, slug);
      if (!category) return c.json({ error: 'not found' }, 404);
      const locations = listVisibleByCategory(db, slug, now(), tz());
      return c.json({ categories: [toApiGroup({ category, locations })] });
    }
    return c.json({ categories: listVisibleGrouped(db, now(), tz()).map(toApiGroup) });
  });

  app.get('/locations/:id', (c) => {
    const id = Number(c.req.param('id'));
    const view = Number.isInteger(id) ? getVisibleLocation(db, id, now(), tz()) : null;
    if (!view) return c.json({ error: 'not found' }, 404);
    return c.json({ location: toApiLocation(view) });
  });

  app.get('/protocols', (c) => c.json({ protocols: getPublished(db).map(toApiProtocol) }));

  app.get('/protocols/:slug', (c) => {
    const found = getPublishedBySlug(db, c.req.param('slug'));
    if (!found) return c.json({ error: 'not found' }, 404);
    return c.json({
      protocol: {
        ...toApiProtocol(found),
        bodyMd: found.version.bodyMd,
        sources: found.sources.map((s) => ({
          url: s.url,
          title: s.title,
          fetchedAt: s.fetchedAt ? s.fetchedAt.toISOString() : null,
        })),
      },
    });
  });

  return app;
}
