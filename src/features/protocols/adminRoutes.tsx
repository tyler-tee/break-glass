import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { Child } from 'hono/jsx';
import type { AppDeps } from '../../app.js';
import { slugify } from '../../domain/slug.js';
import { LlmRefusalError, LlmValidationError } from '../../services/llm/provider.js';
import { llmOf } from '../../services/resolver.js';
import { WarningBadge } from '../../web/components/WarningBadge.js';
import { renderMarkdown, safeHref } from '../../web/format.js';
import { page } from '../../web/Layout.js';
import {
  createProtocol,
  getProtocol,
  getProtocolBySlug,
  getVersion,
  listProtocols,
  listSources,
  listVersions,
} from './repo.js';
import {
  ProtocolError,
  createManualDraft,
  generateDraft,
  parseAllowlist,
  publishVersion,
  rejectVersion,
  submitForReview,
  updateDraftBody,
} from './service.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** Only the wizard may ask for the "Back to setup" link; any other value is ignored. */
const fromSetup = (v: unknown): boolean => v === 'setup';
const NO_LLM: Child = (
  <>
    Add an Anthropic key in <a href="/admin/setup/services">Setup → Services</a> to draft protocols from sources — or write one
    yourself.
  </>
);
const BackToSetup = () => (
  <p>
    <a href="/admin/setup/protocol">Back to setup</a>
  </p>
);
const fmt = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : '');

export function protocolsAdminRoutes(deps: AppDeps): Hono {
  const { db } = deps;
  const app = new Hono();
  const now = deps.now ?? (() => new Date());
  const allowlist = parseAllowlist(deps.env.PROTOCOL_SOURCE_ALLOWLIST);

  const formPage = (
    c: Parameters<typeof page>[0],
    v: { title: string; tags: string },
    error?: string,
  ) =>
    page(
      c,
      'New protocol',
      <>
        <h1>New protocol</h1>
        {error && <p role="alert">{error}</p>}
        <form method="post" action="/admin/protocols/new">
          <p>
            <label>
              Title <input name="title" value={v.title} />
            </label>
          </p>
          <p>
            <label>
              Tags (comma-separated) <input name="tags" value={v.tags} />
            </label>
          </p>
          <button type="submit">Create</button>
        </form>
        <p>
          <a href="/admin/protocols">Back to protocols</a>
        </p>
      </>,
      error ? 400 : 200,
      { layout: 'admin', activeNav: 'protocols' },
    );

  const detailPage = (
    c: Parameters<typeof page>[0],
    id: number,
    opts: { error?: Child; status?: 200 | 400 | 404 | 502 | 503; urls?: string; setup?: boolean } = {},
  ) => {
    const protocol = getProtocol(db, id);
    if (!protocol) return c.notFound();
    const hasLlm = llmOf(deps) !== undefined;
    const versions = listVersions(db, id);
    const latest = versions[0];
    const prefill = opts.urls ?? (latest ? listSources(db, latest.id).map((s) => s.url).join('\n') : '');
    return page(
      c,
      protocol.title,
      <>
        <h1>{protocol.title}</h1>
        {opts.error && <p role="alert">{opts.error}</p>}
        <h2>Versions</h2>
        <table class="stack-table t-versions">
          <thead>
            <tr>
              <th>Version</th>
              <th>Status</th>
              <th>Created</th>
              <th>Reviewed</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr>
                <td>
                  <a href={`/admin/protocols/${id}/versions/${v.id}`}>v{v.version}</a>
                </td>
                <td>{v.status === 'published' ? 'published (current)' : v.status}</td>
                <td>{fmt(v.createdAt)}</td>
                <td>{fmt(v.reviewedAt)}</td>
                <td>{v.reviewNotes ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {opts.setup && <BackToSetup />}
        <h2>Write it yourself</h2>
        <form method="post" action={`/admin/protocols/${id}/manual-draft`}>
          {opts.setup && <input type="hidden" name="from" value="setup" />}
          <p class="muted">Start from the four required headings and fill them in by hand. Nothing is published until you approve it.</p>
          <button type="submit" class="btn-secondary">
            Write it yourself
          </button>
        </form>
        <h2>Generate draft</h2>
        {!hasLlm && !opts.error && <p class="muted">{NO_LLM}</p>}
        {allowlist.length > 0 && <p class="muted">Allowed source hosts: {allowlist.join(', ')}</p>}
        <form id="draft" method="post" action={`/admin/protocols/${id}/draft`}>
          {opts.setup && <input type="hidden" name="from" value="setup" />}
          <p>
            <label>
              Source URLs (one per line)
              <textarea name="source_urls" rows={5}>
                {prefill}
              </textarea>
            </label>
          </p>
          <button type="submit" disabled={!hasLlm}>
            Generate draft
          </button>
        </form>
        <p>
          <a href="/admin/protocols">Back to protocols</a>
        </p>
      </>,
      opts.status ?? 200,
      { layout: 'admin', activeNav: 'protocols' },
    );
  };

  const reviewPage = (
    c: Parameters<typeof page>[0],
    protocolId: number,
    versionId: number,
    opts: { error?: string; status?: 200 | 400 | 409; bodyMd?: string; setup?: boolean } = {},
  ) => {
    const protocol = getProtocol(db, protocolId);
    const version = getVersion(db, versionId);
    if (!protocol || !version || version.protocolId !== protocolId) return c.notFound();
    const sources = listSources(db, versionId);
    const base = `/admin/protocols/${protocolId}/versions/${versionId}`;
    const open = version.status === 'draft' || version.status === 'in_review';
    return page(
      c,
      `${protocol.title} v${version.version}`,
      <>
        <h1>
          {protocol.title} v{version.version}
        </h1>
        <p class="badge badge-warn">{version.status}</p>
        {version.reviewNotes && <p>Review notes: {version.reviewNotes}</p>}
        {opts.error && <p role="alert">{opts.error}</p>}
        <div class="review">
          <section class="card">
            <h2>Draft</h2>
            <div class="protocol-body">{raw(renderMarkdown(opts.bodyMd ?? version.bodyMd))}</div>
          </section>
          <section class="card">
            <h2>Sources</h2>
            <ul>
              {sources.map((s) => (
                <li>
                  {s.title ?? s.url}
                  <br />
                  {safeHref(s.url) ? <a href={safeHref(s.url)!}>{s.url}</a> : <span>{s.url}</span>}
                  <br />
                  <span class="muted">
                    {(s.contentHash ?? '').slice(0, 12)} {fmt(s.fetchedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
        {open && (
          <>
            <h2>Edit</h2>
            <form method="post" action={`${base}/body${opts.setup ? "?from=setup" : ""}`}>
              <textarea name="body_md" rows={20}>
                {opts.bodyMd ?? version.bodyMd}
              </textarea>
              <button type="submit">Save</button>
            </form>
            {version.status === 'draft' && (
              <form method="post" action={`${base}/submit${opts.setup ? "?from=setup" : ""}`}>
                <button type="submit">Submit for review</button>
              </form>
            )}
            <form method="post" action={`${base}/publish${opts.setup ? "?from=setup" : ""}`}>
              <label>
                Notes <input name="notes" />
              </label>
              <button type="submit">Approve &amp; publish</button>
            </form>
            <form method="post" action={`${base}/reject${opts.setup ? "?from=setup" : ""}`}>
              <label>
                Notes <input name="notes" required />
              </label>
              <button type="submit" class="btn-danger">Reject</button>
            </form>
          </>
        )}
        <p>
          <a href={`/admin/protocols/${protocolId}`}>Back to protocol</a>
        </p>
        {opts.setup && <BackToSetup />}
      </>,
      opts.status ?? 200,
      { layout: 'admin', activeNav: 'protocols' },
    );
  };

  const reviewAction =
    (run: (versionId: number, form: Record<string, unknown>) => void, redisplay?: (form: Record<string, unknown>) => string | undefined) =>
    async (c: Parameters<typeof page>[0] & { req: { param: (k: string) => string; parseBody: () => Promise<Record<string, unknown>> } }) => {
      const protocolId = Number(c.req.param('id'));
      const versionId = Number(c.req.param('vid'));
      const version = getVersion(db, versionId);
      if (!version || version.protocolId !== protocolId) return c.notFound();
      const form = await c.req.parseBody();
      try {
        run(versionId, form);
      } catch (e) {
        if (e instanceof ProtocolError) {
          if (e.code === 'not_found') return c.notFound();
          const bodyMd = redisplay?.(form);
          return reviewPage(c, protocolId, versionId, {
            error: e.message,
            status: e.code === 'invalid_transition' ? 409 : 400,
            setup: fromSetup(c.req.query('from')),
            ...(bodyMd !== undefined ? { bodyMd } : {}),
          });
        }
        throw e;
      }
      return c.redirect(
        `/admin/protocols/${protocolId}/versions/${versionId}${fromSetup(c.req.query('from')) ? '?from=setup' : ''}`,
        302,
      );
    };

  app.get('/:id/versions/:vid', (c) =>
    reviewPage(c, Number(c.req.param('id')), Number(c.req.param('vid')), { setup: fromSetup(c.req.query('from')) }),
  );

  app.post(
    '/:id/versions/:vid/body',
    reviewAction(
      (vid, f) => void updateDraftBody(db, vid, str(f['body_md']), now()),
      (f) => str(f['body_md']),
    ),
  );
  app.post('/:id/versions/:vid/submit', reviewAction((vid) => void submitForReview(db, vid, now())));
  app.post(
    '/:id/versions/:vid/publish',
    reviewAction((vid, f) => void publishVersion(db, vid, now(), str(f['notes']).trim() || undefined)),
  );
  app.post(
    '/:id/versions/:vid/reject',
    reviewAction((vid, f) => {
      const notes = str(f['notes']).trim();
      if (notes === '') throw new ProtocolError('invalid', 'Notes are required to reject a version');
      void rejectVersion(db, vid, now(), notes);
    }),
  );

  app.get('/', (c) =>
    page(
      c,
      'Protocols',
      <>
        <h1>Protocols</h1>
        <p>
          <a href="/admin/protocols/new">New protocol</a>
        </p>
        <table class="stack-table t-protocols">
          <thead>
            <tr>
              <th>Title</th>
              <th>Slug</th>
              <th>Published</th>
              <th>Latest</th>
            </tr>
          </thead>
          <tbody>
            {[...listProtocols(db)]
              .sort((a, b) => Number(b.needsRereview) - Number(a.needsRereview))
              .map((p) => (
              <tr>
                <td>
                  <a href={`/admin/protocols/${p.id}`}>{p.title}</a>
                  {p.needsRereview && (
                    <>
                      <WarningBadge kind="warn" summary={p.rereviewReason ?? 'Sources changed; under re-review'} />
                      <a href={`/admin/protocols/${p.id}#draft`}>Start new draft from these sources</a>
                    </>
                  )}
                </td>
                <td>{p.slug}</td>
                <td>{p.publishedVersion === null ? 'none' : `v${p.publishedVersion}`}</td>
                <td>{p.latestVersion === null ? '' : `v${p.latestVersion} ${p.latestStatus}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>,
      200,
      { layout: 'admin', activeNav: 'protocols' },
    ),
  );

  app.get('/new', (c) => formPage(c, { title: '', tags: '' }));

  app.post('/new', async (c) => {
    const body = await c.req.parseBody();
    const title = str(body['title']).trim();
    const tagsRaw = str(body['tags']);
    const values = { title: str(body['title']), tags: tagsRaw };
    const slug = slugify(title);
    if (slug === '') return formPage(c, values, 'Title must contain letters or numbers');
    if (getProtocolBySlug(db, slug)) return formPage(c, values, `A protocol with slug "${slug}" already exists`);
    const tags = [...new Set(tagsRaw.split(',').map((t) => t.trim()).filter((t) => t !== ''))];
    createProtocol(db, { slug, title, tags });
    return c.redirect('/admin/protocols', 302);
  });

  app.get('/:id', (c) => detailPage(c, Number(c.req.param('id')), { setup: fromSetup(c.req.query('from')) }));

  app.post('/:id/draft', async (c) => {
    const id = Number(c.req.param('id'));
    if (!getProtocol(db, id)) return c.notFound();
    const body = await c.req.parseBody();
    const urls = str(body['source_urls']);
    const setup = fromSetup(body['from']);
    const llm = llmOf(deps);
    if (!llm) {
      return detailPage(c, id, {
        error: NO_LLM,
        setup,
        status: 503,
        urls,
      });
    }
    try {
      await generateDraft(db, id, urls.split(/\r?\n/), {
        llm,
        fetch: deps.siteFetch ?? globalThis.fetch,
        model: deps.env.LLM_DRAFT_MODEL,
        allowlist,
        now,
        log: console,
        ...(deps.lookup ? { lookup: deps.lookup } : {}),
      });
    } catch (e) {
      if (e instanceof ProtocolError) {
        if (e.code === 'not_found') return c.notFound();
        return detailPage(c, id, {
          error: e.detail ? `${e.message}: ${e.detail}` : e.message,
          status: 400,
          urls,
          setup,
        });
      }
      if (e instanceof LlmValidationError || e instanceof LlmRefusalError) {
        const reason = e instanceof LlmRefusalError ? e.message : e.message.split(': ')[0];
        return detailPage(c, id, { error: `Draft rejected: ${reason}`, status: 502, urls, setup });
      }
      if (e instanceof Error) {
        // Provider failures (rate limit, 5xx, auth, network). The SDK never echoes the key in messages.
        console.error(`LLM draft failed for protocol ${id}: ${e.message}`);
        return detailPage(c, id, {
          error: `Draft rejected: LLM provider error: ${e.message.slice(0, 200)}`,
          status: 502,
          urls,
          setup,
        });
      }
      throw e;
    }
    const latest = listVersions(db, id)[0];
    if (setup && latest) return c.redirect(`/admin/protocols/${id}/versions/${latest.id}?from=setup`, 302);
    return c.redirect(`/admin/protocols/${id}`, 302);
  });

  app.post('/:id/manual-draft', async (c) => {
    const id = Number(c.req.param('id'));
    const body = await c.req.parseBody();
    let version;
    try {
      version = createManualDraft(db, id, now());
    } catch (e) {
      if (e instanceof ProtocolError && e.code === 'not_found') return c.notFound();
      throw e;
    }
    return c.redirect(
      `/admin/protocols/${id}/versions/${version.id}${fromSetup(body['from']) ? '?from=setup' : ''}`,
      302,
    );
  });

  return app;
}
