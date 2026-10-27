import { Hono } from 'hono';
import type { AppDeps } from '../../app.js';
import { slugify } from '../../domain/slug.js';
import { LlmRefusalError, LlmValidationError } from '../../services/llm/provider.js';
import { AdminNav } from '../../web/components/AdminNav.js';
import { page } from '../../web/Layout.js';
import { createProtocol, getProtocol, getProtocolBySlug, listProtocols, listSources, listVersions } from './repo.js';
import { ProtocolError, generateDraft, parseAllowlist } from './service.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
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
        <AdminNav />
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
    );

  const detailPage = (
    c: Parameters<typeof page>[0],
    id: number,
    opts: { error?: string; status?: 200 | 400 | 404 | 502 | 503; urls?: string } = {},
  ) => {
    const protocol = getProtocol(db, id);
    if (!protocol) return c.notFound();
    const versions = listVersions(db, id);
    const latest = versions[0];
    const prefill = opts.urls ?? (latest ? listSources(db, latest.id).map((s) => s.url).join('\n') : '');
    return page(
      c,
      protocol.title,
      <>
        <h1>{protocol.title}</h1>
        <AdminNav />
        {opts.error && <p role="alert">{opts.error}</p>}
        <h2>Versions</h2>
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Status</th>
              <th>Created</th>
              <th>Reviewed</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr>
                <td>
                  <a href={`/admin/protocols/${id}/versions/${v.id}`}>v{v.version}</a>
                </td>
                <td>{v.status}</td>
                <td>{fmt(v.createdAt)}</td>
                <td>{fmt(v.reviewedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h2>Generate draft</h2>
        {allowlist.length > 0 && <p class="muted">Allowed source hosts: {allowlist.join(', ')}</p>}
        <form method="post" action={`/admin/protocols/${id}/draft`}>
          <p>
            <label>
              Source URLs (one per line)
              <textarea name="source_urls" rows={5}>
                {prefill}
              </textarea>
            </label>
          </p>
          <button type="submit">Generate draft</button>
        </form>
        <p>
          <a href="/admin/protocols">Back to protocols</a>
        </p>
      </>,
      opts.status ?? 200,
    );
  };

  app.get('/', (c) =>
    page(
      c,
      'Protocols',
      <>
        <h1>Protocols</h1>
        <AdminNav />
        <p>
          <a href="/admin/protocols/new">New protocol</a>
        </p>
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Slug</th>
              <th>Published</th>
              <th>Latest</th>
            </tr>
          </thead>
          <tbody>
            {listProtocols(db).map((p) => (
              <tr>
                <td>
                  <a href={`/admin/protocols/${p.id}`}>{p.title}</a>
                </td>
                <td>{p.slug}</td>
                <td>{p.publishedVersion === null ? 'none' : `v${p.publishedVersion}`}</td>
                <td>{p.latestVersion === null ? '' : `v${p.latestVersion} ${p.latestStatus}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>,
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

  app.get('/:id', (c) => detailPage(c, Number(c.req.param('id'))));

  app.post('/:id/draft', async (c) => {
    const id = Number(c.req.param('id'));
    if (!getProtocol(db, id)) return c.notFound();
    const body = await c.req.parseBody();
    const urls = str(body['source_urls']);
    if (!deps.llm) {
      return detailPage(c, id, {
        error: 'Set LLM_PROVIDER and LLM_API_KEY to enable drafting',
        status: 503,
        urls,
      });
    }
    try {
      await generateDraft(db, id, urls.split(/\r?\n/), {
        llm: deps.llm,
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
        });
      }
      if (e instanceof LlmValidationError || e instanceof LlmRefusalError) {
        const reason = e instanceof LlmRefusalError ? e.message : e.message.split(': ')[0];
        return detailPage(c, id, { error: `Draft rejected: ${reason}`, status: 502, urls });
      }
      throw e;
    }
    return c.redirect(`/admin/protocols/${id}`, 302);
  });

  return app;
}
