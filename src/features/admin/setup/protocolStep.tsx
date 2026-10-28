import type { Context, Hono } from 'hono';
import { slugify } from '../../../domain/slug.js';
import { llmOf } from '../../../services/resolver.js';
import { createProtocol, getProtocol, getProtocolBySlug, getPublished, listProtocols } from '../../protocols/repo.js';
import { createManualDraft, runDraft } from '../../protocols/service.js';
import { StepShell } from './StepShell.js';
import { Field, destination, goOf, str, type Errors, type SetupContext, type Status } from './shared.js';

type Values = { title: string; tags: string; urls: string };
/** A protocol whose draft from sources failed: shown with Try again and Write it yourself. */
type Failed = { id: number; urls: string; message: string };
const reviewUrl = (protocolId: number, versionId: number) => `/admin/protocols/${protocolId}/versions/${versionId}?from=setup`;
const EMPTY: Values = { title: '', tags: '', urls: '' };

/** Step 6: create a protocol, then draft it from sources or write it yourself. */
export function registerProtocolStep(app: Hono, ctx: SetupContext): void {
  const { deps, db, render, doneSteps, now } = ctx;

  const protocolPage = (c: Context, values: Values = EMPTY, errors: Errors = {}, status: Status = 200, failed?: Failed, noLlmAlert = false) => {
    const hasLlm = llmOf(deps) !== undefined;
    const published = getPublished(db);
    const inProgress = listProtocols(db).filter((p) => p.publishedVersion === null);
    return render(
      c,
      'protocol',
      <StepShell
        step="protocol"
        heading="Your first protocol"
        doneSteps={doneSteps()}
        intro={
          <p>
            A protocol is a short step-by-step guide for one emergency, like choking or a burn. Nothing shows on the family site
            until you read it and approve it.
          </p>
        }
        before={
          <>
            {published.length > 0 && (
              <p class="notice notice-status" role="status">
                Done: <a href={`/admin/protocols/${published[0]!.protocol.id}`}>{published[0]!.protocol.title}</a> is published
                {published.length > 1 ? ` (and ${published.length - 1} more)` : ''}. You can continue, or add more later under
                Protocols.
              </p>
            )}
            {published.length === 0 && inProgress.length > 0 && (
              <section class="card">
                <h2>In progress</h2>
                <ul>
                  {inProgress.map((p) => (
                    <li>
                      <a href={`/admin/protocols/${p.id}?from=setup`}>{p.title}</a> ({p.latestStatus ?? 'no draft yet'})
                      {failed?.id === p.id && (
                        <>
                          <form method="post" action={`/admin/setup/protocol/${p.id}/draft`} class="admin-form" data-busy="Drafting from your sources…">
                            <Field
                              id="retry_source_urls"
                              label="Source URLs (one per line)"
                              error={failed.message}
                              control={(describedBy, invalid) => (
                                <textarea
                                  id="retry_source_urls"
                                  name="source_urls"
                                  rows={4}
                                  disabled={!hasLlm}
                                  aria-describedby={describedBy}
                                  aria-invalid={invalid ? 'true' : undefined}
                                  autofocus
                                >
                                  {failed.urls}
                                </textarea>
                              )}
                            />
                            <button type="submit" disabled={!hasLlm}>
                              Try again
                            </button>
                          </form>
                          <form method="post" action={`/admin/protocols/${p.id}/manual-draft`}>
                            <input type="hidden" name="from" value="setup" />
                            <button type="submit" class="btn-secondary">
                              Write it yourself
                            </button>
                          </form>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {published.length === 0 && (
              <form method="post" action="/admin/setup/protocol/start" class="admin-form" id="protocol-start" data-busy="Working on it…">
                <input type="hidden" name="from" value="setup" />
                <Field
                  id="title"
                  label="Title"
                  hint="For example: Choking (adult)"
                  error={errors['title']}
                  control={(describedBy, invalid) => (
                    <input
                      id="title"
                      name="title"
                      value={values.title}
                      autocomplete="off"
                      aria-describedby={describedBy}
                      aria-invalid={invalid ? 'true' : undefined}
                      autofocus={invalid}
                    />
                  )}
                />
                <Field
                  id="tags"
                  label="Tags (optional, comma-separated)"
                  control={() => <input id="tags" name="tags" value={values.tags} autocomplete="off" />}
                />
                <h2>Write it yourself</h2>
                <p>Start from the four required headings and fill them in by hand. No key needed.</p>
                <button type="submit" name="path" value="manual">
                  Write it yourself
                </button>
                <h2>Draft from sources</h2>
                {hasLlm ? (
                  <p>Paste web pages (one per line) and we will draft a protocol from them. You review it before it is published.</p>
                ) : (
                  <p class="muted" id="no-llm-note" role={noLlmAlert ? 'alert' : undefined}>
                    Add an Anthropic key in <a href="/admin/setup/services">Setup → Services</a> to draft protocols from sources — or
                    write one yourself.
                  </p>
                )}
                <Field
                  id="source_urls"
                  label="Source URLs (one per line)"
                  control={() => (
                    <textarea id="source_urls" name="source_urls" rows={4} disabled={!hasLlm}>
                      {values.urls}
                    </textarea>
                  )}
                />
                <button
                  type="submit"
                  name="path"
                  value="sources"
                  class="btn-secondary"
                  disabled={!hasLlm}
                  aria-describedby={hasLlm ? undefined : 'no-llm-note'}
                >
                  Draft from sources
                </button>
              </form>
            )}
          </>
        }
      />,
      status,
    );
  };

  app.get('/protocol', (c) => protocolPage(c));

  app.post('/protocol', async (c) => {
    const body = await c.req.parseBody();
    return c.redirect(destination('protocol', goOf(body['go'])), 302);
  });

  app.post('/protocol/start', async (c) => {
    const body = await c.req.parseBody();
    const title = str(body['title']).trim();
    const tagsRaw = str(body['tags']);
    const values = { title: str(body['title']), tags: tagsRaw, urls: str(body['source_urls']) };
    const slug = slugify(title);
    if (slug === '') return protocolPage(c, values, { title: 'Give the protocol a title with letters or numbers.' }, 400);
    if (getProtocolBySlug(db, slug)) {
      return protocolPage(c, values, { title: `You already have a protocol called "${title}". Pick a different title.` }, 400);
    }
    const tags = [...new Set(tagsRaw.split(',').map((t) => t.trim()).filter((t) => t !== ''))];
    const path = str(body['path']);
    // A forged sources request with no key is refused before anything is created (no orphan protocol).
    if (path === 'sources' && llmOf(deps) === undefined) return protocolPage(c, values, {}, 503, undefined, true);
    const protocol = createProtocol(db, { slug, title, tags });
    if (path === 'sources') return draftFromSources(c, protocol.id, values.urls);
    const version = createManualDraft(db, protocol.id, now());
    return c.redirect(reviewUrl(protocol.id, version.id), 302);
  });

  /** Drafts from sources in-process; success goes to review, failure re-renders this step with a retry. */
  const draftFromSources = async (c: Context, protocolId: number, urls: string) => {
    const result = await runDraft(db, deps, protocolId, urls);
    if (result.ok) return c.redirect(reviewUrl(protocolId, result.version.id), 302);
    if (result.reason === 'not_found') return c.notFound();
    return protocolPage(c, EMPTY, {}, result.status, { id: protocolId, urls, message: result.plain }, result.reason === 'no_llm');
  };

  app.post('/protocol/:id/draft', async (c) => {
    const id = Number(c.req.param('id'));
    if (!getProtocol(db, id)) return c.notFound();
    const body = await c.req.parseBody();
    return draftFromSources(c, id, str(body['source_urls']));
  });
}
