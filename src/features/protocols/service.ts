import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AppDeps } from '../../app.js';
import type { Db, DbOrTx } from '../../db/client.js';
import { settings } from '../../db/schema.js';
import type { Logger, ProtocolStatus } from '../../domain/types.js';
import { SOP_HEADINGS, assertSopHeadings, draftProtocol } from '../../services/llm/draft.js';
import { LlmRefusalError, LlmValidationError, type LlmProvider } from '../../services/llm/provider.js';
import { llmOf } from '../../services/resolver.js';
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

export type RunDraftResult =
  | { ok: true; version: ProtocolVersion }
  | { ok: false; status: 400 | 502 | 503; reason: 'not_found' | 'no_llm' | 'invalid' | 'rejected'; message: string; plain: string };

/**
 * The whole "draft from sources" flow for the classic route and the wizard: resolves the LLM, parses and checks
 * the URLs, fetches, drafts and stores the version, and turns every expected failure into a status plus plain
 * words (never raw upstream bodies or keys).
 */
export async function runDraft(
  db: Db,
  deps: AppDeps,
  protocolId: number,
  sourceUrlsText: string,
): Promise<RunDraftResult> {
  const llm = llmOf(deps);
  if (!llm) return { ok: false, status: 503, reason: 'no_llm', message: 'No Anthropic key is configured', plain: 'No Anthropic key is configured' };
  try {
    const version = await generateDraft(db, protocolId, sourceUrlsText.split(/\r?\n/), {
      llm,
      fetch: deps.siteFetch ?? globalThis.fetch,
      model: deps.env.LLM_DRAFT_MODEL,
      allowlist: parseAllowlist(deps.env.PROTOCOL_SOURCE_ALLOWLIST),
      now: deps.now ?? (() => new Date()),
      log: console,
      ...(deps.lookup ? { lookup: deps.lookup } : {}),
    });
    return { ok: true, version };
  } catch (e) {
    if (e instanceof ProtocolError) {
      if (e.code === 'not_found') return { ok: false, status: 400, reason: 'not_found', message: e.message, plain: e.message };
      const message = e.detail ? `${e.message}: ${e.detail}` : e.message;
      return { ok: false, status: 400, reason: 'invalid', message, plain: message };
    }
    if (e instanceof LlmValidationError || e instanceof LlmRefusalError) {
      const reason = e instanceof LlmRefusalError ? e.message : e.message.split(': ')[0];
      const message = `Draft rejected: ${reason}`;
      return { ok: false, status: 502, reason: 'rejected', message, plain: message };
    }
    if (e instanceof Error) {
      // Provider failures (rate limit, 5xx, auth, network). The SDK never echoes the key in messages.
      console.error(`LLM draft failed for protocol ${protocolId}: ${e.message}`);
      return {
        ok: false,
        status: 502,
        reason: 'rejected',
        message: `Draft rejected: LLM provider error: ${e.message.slice(0, 200)}`,
        plain: 'Draft rejected: the AI service had a problem. Try again in a minute, or write it yourself.',
      };
    }
    throw e;
  }
}

// The example lines a hand-written draft starts with. A version that still contains any of them is not ready:
// it cannot be submitted for review or published (see assertNoTemplatePlaceholders).
const SCOPE_PLACEHOLDER = 'What this covers and who it is for.';
const STEP_PLACEHOLDER = '1. First step.';
const DO_NOT_PLACEHOLDER = '- Common mistake to avoid.';
/** The escalation example, built from the household emergency number. The trailing "if ..." is the marker. */
const escalationPlaceholder = (emergencyNumber: string): string => `Call ${emergencyNumber} or go to the ER if ...`;
const ESCALATION_PLACEHOLDER = /^Call .+ or go to the ER if \.\.\.$/;
const PLACEHOLDER_LINES: readonly string[] = [SCOPE_PLACEHOLDER, STEP_PLACEHOLDER, DO_NOT_PLACEHOLDER];

export const PLACEHOLDER_MESSAGE = 'Replace the example text in every section before publishing.';

/** The hand-written starting point: the four required headings, each with an example line to replace. */
export function manualTemplate(emergencyNumber: string): string {
  return (
    [
      `${SOP_HEADINGS[0]}\n${SCOPE_PLACEHOLDER}`,
      `${SOP_HEADINGS[1]}\n${STEP_PLACEHOLDER}`,
      `${SOP_HEADINGS[2]}\n${escalationPlaceholder(emergencyNumber)}`,
      `${SOP_HEADINGS[3]}\n${DO_NOT_PLACEHOLDER}`,
    ].join('\n\n') + '\n'
  );
}

/** The template with the US default number. */
export const MANUAL_TEMPLATE = manualTemplate('911');

/** True when any line of the body is still one of the template example lines. */
export function hasTemplatePlaceholders(bodyMd: string): boolean {
  return bodyMd.split(/\r?\n/).some((raw) => {
    const line = raw.trim();
    return PLACEHOLDER_LINES.includes(line) || ESCALATION_PLACEHOLDER.test(line);
  });
}

function assertNoTemplatePlaceholders(bodyMd: string): void {
  if (hasTemplatePlaceholders(bodyMd)) throw new ProtocolError('invalid', PLACEHOLDER_MESSAGE);
}

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
    const number = tx.select({ n: settings.emergencyNumber }).from(settings).where(eq(settings.id, 1)).get()?.n || '911';
    const bodyMd = manualTemplate(number);
    assertSopHeadings(bodyMd);
    return insertVersion(tx, {
      protocolId,
      version: nextVersionNumber(tx, protocolId),
      status: 'draft',
      bodyMd,
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

/** assertSopHeadings, reported as a ProtocolError with the short reason. */
function checkHeadings(bodyMd: string): void {
  try {
    assertSopHeadings(bodyMd);
  } catch (e) {
    if (e instanceof LlmValidationError) throw new ProtocolError('invalid', e.message.split(': ')[0] ?? e.message);
    throw e;
  }
}

function requireOpen(v: ProtocolVersion): void {
  if (v.status !== 'draft' && v.status !== 'in_review') {
    throw new ProtocolError('invalid_transition', `Cannot edit a ${v.status} version`);
  }
}

export function updateDraftBody(db: Db, versionId: number, bodyMd: string, _now: Date): ProtocolVersion {
  requireOpen(loadVersion(db, versionId));
  checkHeadings(bodyMd);
  return updateVersion(db, versionId, { bodyMd }) as ProtocolVersion;
}

export function submitForReview(db: Db, versionId: number, now: Date): ProtocolVersion {
  const v = loadVersion(db, versionId);
  if (v.status !== 'draft') throw new ProtocolError('invalid_transition', `Cannot submit a ${v.status} version`);
  assertNoTemplatePlaceholders(v.bodyMd);
  return updateVersion(db, versionId, { status: 'in_review', submittedAt: now }) as ProtocolVersion;
}

/** Publishes inside the caller transaction: supersedes the current published version and clears re-review. */
function publishIn(tx: DbOrTx, versionId: number, now: Date, notes?: string): ProtocolVersion {
  const v = loadVersion(tx, versionId);
  requireTransition(v, 'published');
  assertNoTemplatePlaceholders(v.bodyMd);
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
}

export function publishVersion(db: Db, versionId: number, now: Date, notes?: string): ProtocolVersion {
  return db.transaction((tx) => publishIn(tx, versionId, now, notes));
}

/**
 * Saves an edited body and publishes it in one transaction, so text typed into the review form is never
 * discarded by publishing. Runs the same checks as Save and Publish; on any failure nothing is saved.
 */
export function saveAndPublish(db: Db, versionId: number, bodyMd: string, now: Date, notes?: string): ProtocolVersion {
  return db.transaction((tx) => {
    requireOpen(loadVersion(tx, versionId));
    checkHeadings(bodyMd);
    assertNoTemplatePlaceholders(bodyMd);
    updateVersion(tx, versionId, { bodyMd });
    return publishIn(tx, versionId, now, notes);
  });
}

export function rejectVersion(db: Db, versionId: number, now: Date, notes: string): ProtocolVersion {
  const v = loadVersion(db, versionId);
  requireTransition(v, 'rejected');
  return updateVersion(db, versionId, { status: 'rejected', reviewedAt: now, reviewNotes: notes }) as ProtocolVersion;
}
