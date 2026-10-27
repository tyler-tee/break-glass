import type { Db } from '../db/client.js';
import type { Logger } from '../domain/types.js';
import { getPublished, updateProtocolReview } from '../features/protocols/repo.js';
import { hashSourceText } from '../features/protocols/service.js';
import { fetchPage, type LookupFn } from '../services/llm/web.js';

export type RecheckReport = { checked: number; flagged: number; unchanged: number; failed: number };

export async function recheckProtocols(
  db: Db,
  deps: { fetch: typeof fetch; now: () => Date; log: Logger; lookup?: LookupFn },
): Promise<RecheckReport> {
  const { log } = deps;
  const report: RecheckReport = { checked: 0, flagged: 0, unchanged: 0, failed: 0 };

  for (const { protocol, sources } of getPublished(db)) {
    try {
      const changed: string[] = [];
      for (const source of sources) {
        const page = await fetchPage(source.url, {
          fetch: deps.fetch,
          log,
          ...(deps.lookup ? { lookup: deps.lookup } : {}),
        });
        if (!page) {
          report.failed++;
          log.warn(`Re-check could not fetch ${source.url} for protocol ${protocol.slug}`);
          continue;
        }
        if (hashSourceText(page.text) !== source.contentHash) changed.push(source.url);
      }
      report.checked++;
      if (changed.length > 0) {
        updateProtocolReview(db, protocol.id, {
          needsRereview: true,
          rereviewReason: 'Source changed: ' + changed.join(', '),
        });
        report.flagged++;
      } else {
        report.unchanged++;
      }
    } catch (e) {
      log.error(`Re-check failed for protocol ${protocol.id}: ${e instanceof Error ? e.message : String(e)}`);
      report.checked++;
    }
  }
  return report;
}
