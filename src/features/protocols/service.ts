import { createHash } from 'node:crypto';
import type { Db } from '../../db/client.js';
import type { Logger } from '../../domain/types.js';
import { draftProtocol } from '../../services/llm/draft.js';
import type { LlmProvider } from '../../services/llm/provider.js';
import { fetchPage, type LookupFn } from '../../services/llm/web.js';
import { getProtocol, insertSources, insertVersion, nextVersionNumber, type ProtocolVersion } from './repo.js';

export type ProtocolErrorCode =
  | 'invalid'
  | 'not_found'
  | 'source_not_allowed'
  | 'source_unreachable'
  | 'invalid_transition';

export class ProtocolError extends Error {
  constructor(
    public code: ProtocolErrorCode,
    message: string,
    public detail?: string,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export function parseAllowlist(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');
}

export function isAllowedSource(url: URL, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const host = url.hostname.toLowerCase();
  return allowlist.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

export async function generateDraft(
  db: Db,
  protocolId: number,
  sourceUrls: string[],
  deps: {
    llm: LlmProvider;
    fetch: typeof fetch;
    model: string;
    allowlist: string[];
    now: () => Date;
    lookup?: LookupFn;
    log: Logger;
  },
): Promise<ProtocolVersion> {
  const protocol = getProtocol(db, protocolId);
  if (!protocol) throw new ProtocolError('not_found', 'Protocol not found');
  const urls = [...new Set(sourceUrls.map((u) => u.trim()).filter((u) => u !== ''))];
  if (urls.length === 0) throw new ProtocolError('invalid', 'At least one source URL is required');
  for (const raw of urls) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new ProtocolError('invalid', 'Source is not a valid http(s) URL', raw);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ProtocolError('invalid', 'Source is not a valid http(s) URL', raw);
    }
    if (!isAllowedSource(parsed, deps.allowlist)) {
      throw new ProtocolError('source_not_allowed', 'Source is not on the allowlist', raw);
    }
  }

  const pages: { url: string; title: string | null; text: string }[] = [];
  for (const url of urls) {
    const page = await fetchPage(url, {
      fetch: deps.fetch,
      log: deps.log,
      allowHost: (u) => isAllowedSource(u, deps.allowlist),
      ...(deps.lookup ? { lookup: deps.lookup } : {}),
    });
    if (!page) throw new ProtocolError('source_unreachable', 'Source could not be fetched', url);
    pages.push(page);
  }

  const bodyMd = await draftProtocol(deps.llm, deps.model, { title: protocol.title, sources: pages });

  const now = deps.now();
  return db.transaction((tx) => {
    const version = insertVersion(tx, {
      protocolId,
      version: nextVersionNumber(tx, protocolId),
      status: 'draft',
      bodyMd,
      createdAt: now,
    });
    insertSources(
      tx,
      pages.map((p) => ({
        protocolVersionId: version.id,
        url: p.url,
        title: p.title,
        fetchedAt: now,
        contentHash: createHash('sha256').update(p.text).digest('hex'),
      })),
    );
    return version;
  });
}
