import { and, desc, eq, max } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client.js';
import { protocolSources, protocolVersions, protocols } from '../../db/schema.js';
import type { ProtocolStatus } from '../../domain/types.js';

export type Protocol = typeof protocols.$inferSelect;
export type ProtocolVersion = typeof protocolVersions.$inferSelect;
export type ProtocolSource = typeof protocolSources.$inferSelect;

export type ProtocolListItem = Protocol & {
  publishedVersion: number | null;
  latestVersion: number | null;
  latestStatus: ProtocolStatus | null;
};

export function createProtocol(db: DbOrTx, input: { slug: string; title: string; tags: string[] }): Protocol {
  return db.insert(protocols).values(input).returning().get();
}

export function listProtocols(db: Db): ProtocolListItem[] {
  return db
    .select()
    .from(protocols)
    .orderBy(protocols.title)
    .all()
    .map((p) => {
      const versions = listVersions(db, p.id);
      const latest = versions[0];
      return {
        ...p,
        publishedVersion: versions.find((v) => v.status === 'published')?.version ?? null,
        latestVersion: latest?.version ?? null,
        latestStatus: latest?.status ?? null,
      };
    });
}

export function getProtocol(db: DbOrTx, id: number): Protocol | null {
  return db.select().from(protocols).where(eq(protocols.id, id)).get() ?? null;
}

export function getProtocolBySlug(db: DbOrTx, slug: string): Protocol | null {
  return db.select().from(protocols).where(eq(protocols.slug, slug)).get() ?? null;
}

export function listVersions(db: DbOrTx, protocolId: number): ProtocolVersion[] {
  return db
    .select()
    .from(protocolVersions)
    .where(eq(protocolVersions.protocolId, protocolId))
    .orderBy(desc(protocolVersions.version))
    .all();
}

export function getVersion(db: DbOrTx, id: number): ProtocolVersion | null {
  return db.select().from(protocolVersions).where(eq(protocolVersions.id, id)).get() ?? null;
}

export function insertVersion(db: DbOrTx, values: typeof protocolVersions.$inferInsert): ProtocolVersion {
  return db.insert(protocolVersions).values(values).returning().get();
}

export function updateVersion(
  db: DbOrTx,
  id: number,
  values: Partial<typeof protocolVersions.$inferInsert>,
): ProtocolVersion | null {
  return db.update(protocolVersions).set(values).where(eq(protocolVersions.id, id)).returning().get() ?? null;
}

export function updateProtocolReview(
  db: DbOrTx,
  id: number,
  values: { needsRereview: boolean; rereviewReason: string | null },
): void {
  db.update(protocols).set(values).where(eq(protocols.id, id)).run();
}

export function insertSources(db: DbOrTx, rows: (typeof protocolSources.$inferInsert)[]): void {
  if (rows.length > 0) db.insert(protocolSources).values(rows).run();
}

export function listSources(db: DbOrTx, versionId: number): ProtocolSource[] {
  return db
    .select()
    .from(protocolSources)
    .where(eq(protocolSources.protocolVersionId, versionId))
    .orderBy(protocolSources.id)
    .all();
}

export function nextVersionNumber(db: DbOrTx, protocolId: number): number {
  const row = db
    .select({ v: max(protocolVersions.version) })
    .from(protocolVersions)
    .where(eq(protocolVersions.protocolId, protocolId))
    .get();
  return (row?.v ?? 0) + 1;
}

export type PublishedProtocol = { protocol: Protocol; version: ProtocolVersion; sources: ProtocolSource[] };

export function getPublished(db: DbOrTx): PublishedProtocol[] {
  return db
    .select({ protocol: protocols, version: protocolVersions })
    .from(protocolVersions)
    .innerJoin(protocols, eq(protocols.id, protocolVersions.protocolId))
    .where(eq(protocolVersions.status, 'published'))
    .orderBy(protocols.title)
    .all()
    .map(({ protocol, version }) => ({ protocol, version, sources: listSources(db, version.id) }));
}

export function getPublishedBySlug(db: DbOrTx, slug: string): PublishedProtocol | null {
  const row = db
    .select({ protocol: protocols, version: protocolVersions })
    .from(protocolVersions)
    .innerJoin(protocols, eq(protocols.id, protocolVersions.protocolId))
    .where(and(eq(protocols.slug, slug), eq(protocolVersions.status, 'published')))
    .get();
  return row ? { ...row, sources: listSources(db, row.version.id) } : null;
}
