import { createHash } from 'node:crypto';
import type { Db, DbOrTx } from '../../db/client.js';
import type { Logger, ProtocolStatus } from '../../domain/types.js';
import { SOP_HEADINGS, assertSopHeadings, draftProtocol } from '../../services/llm/draft.js';
import { LlmValidationError, type LlmProvider } from '../../services/llm/provider.js';
import { fetchPage, type LookupFn } from '../../services/llm/web.js';
import {
  getProtocol,
  getVersion,
  insertSources,
  insertVersion,
  listVersions,
  nextVersionNumber,
  updateProtocolReview,
  updateVersion,
  type ProtocolVersion,
} from './repo.js';

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

export function hashSourceText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
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
        contentHash: hashSourceText(p.text),
      })),
    );
    return version;
  });
}

export const MANUAL_TEMPLATE =
  [
    `${SOP_HEADINGS[0]}\nWhat this covers and who it is for.`,
    `${SOP_HEADINGS[1]}\n1. First step.`,
    `${SOP_HEADINGS[2]}\nCall 911 or go to the ER if ...`,
    `${SOP_HEADINGS[3]}\n- Common mistake to avoid.`,
  ].join('\n\n') + '\n';

/**
 * Starts a hand-written draft prefilled with the four required SOP headings, so a household with no LLM key
 * can still publish a protocol. If the protocol already has an open (draft / in_review) version, that version
 * is returned instead of creating a second open draft.
 */
export function createManualDraft(db: Db, protocolId: number, now: Date): ProtocolVersion {
  if (!getProtocol(db, protocolId)) throw new ProtocolError('not_found', 'Protocol not found');
  return db.transaction((tx) => {
    const open = listVersions(tx, protocolId).find((v) => v.status === 'draft' || v.status === 'in_review');
    if (open) return open;
    assertSopHeadings(MANUAL_TEMPLATE);
    return insertVersion(tx, {
      protocolId,
      version: nextVersionNumber(tx, protocolId),
      status: 'draft',
      bodyMd: MANUAL_TEMPLATE,
      createdAt: now,
    });
  });
}

// Single source of truth for allowed version status moves.
const VERSION_TRANSITIONS: Record<ProtocolStatus, ProtocolStatus[]> = {
  draft: ['in_review', 'published', 'rejected'],
  in_review: ['published', 'rejected'],
  published: ['superseded'],
  superseded: [],
  rejected: [],
};

function loadVersion(db: DbOrTx, versionId: number): ProtocolVersion {
  const v = getVersion(db, versionId);
  if (!v) throw new ProtocolError('not_found', 'Version not found');
  return v;
}

function requireTransition(v: ProtocolVersion, to: ProtocolStatus): void {
  if (!VERSION_TRANSITIONS[v.status].includes(to)) {
    throw new ProtocolError('invalid_transition', `Cannot move a ${v.status} version to ${to}`);
  }
}

export function updateDraftBody(db: Db, versionId: number, bodyMd: string, _now: Date): ProtocolVersion {
  const v = loadVersion(db, versionId);
  if (v.status !== 'draft' && v.status !== 'in_review') {
    throw new ProtocolError('invalid_transition', `Cannot edit a ${v.status} version`);
  }
  try {
    assertSopHeadings(bodyMd);
  } catch (e) {
    if (e instanceof LlmValidationError) throw new ProtocolError('invalid', e.message.split(': ')[0] ?? e.message);
    throw e;
  }
  return updateVersion(db, versionId, { bodyMd }) as ProtocolVersion;
}

export function submitForReview(db: Db, versionId: number, now: Date): ProtocolVersion {
  const v = loadVersion(db, versionId);
  if (v.status !== 'draft') throw new ProtocolError('invalid_transition', `Cannot submit a ${v.status} version`);
  return updateVersion(db, versionId, { status: 'in_review', submittedAt: now }) as ProtocolVersion;
}

export function publishVersion(db: Db, versionId: number, now: Date, notes?: string): ProtocolVersion {
  return db.transaction((tx) => {
    const v = loadVersion(tx, versionId);
    requireTransition(v, 'published');
    for (const other of listVersions(tx, v.protocolId)) {
      if (other.status === 'published') updateVersion(tx, other.id, { status: 'superseded' });
    }
    const out = updateVersion(tx, versionId, {
      status: 'published',
      reviewedAt: now,
      reviewNotes: notes ?? null,
    }) as ProtocolVersion;
    updateProtocolReview(tx, v.protocolId, { needsRereview: false, rereviewReason: null });
    return out;
  });
}

export function rejectVersion(db: Db, versionId: number, now: Date, notes: string): ProtocolVersion {
  const v = loadVersion(db, versionId);
  requireTransition(v, 'rejected');
  return updateVersion(db, versionId, { status: 'rejected', reviewedAt: now, reviewNotes: notes }) as ProtocolVersion;
}
