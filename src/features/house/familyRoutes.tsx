import { Hono } from 'hono';
import type { Context } from 'hono';
import { html, raw } from 'hono/html';
import type { AppDeps } from '../../app.js';
import { getSettings } from '../admin/settingsRepo.js';
import { requestClock } from '../clock.js';
import { getPublished, getPublishedBySlug } from '../protocols/repo.js';
import { renderMarkdown, safeHref, telHref } from '../../web/format.js';
import { assetUrl } from '../../web/assets.js';
import { page } from '../../web/Layout.js';
import { splitSopSections } from '../../web/protocolSections.js';
import {
  BackLink, CallRow, FactCard, InlineFact, PickCard, Svg, systemIcon, photoSrc,
} from '../../web/family/ui.js';
import { POISON_CONTROL } from '../family/routes.js';
import { firstPhotos, formatDay, oldestChecked } from './familyQueries.js';
import { guideLinks, linkedFor, orderedFacts, parseSteps, placeFacts, uniqueByPhone } from './links.js';
import type { HouseFact } from './repo.js';

/** The family-facing Home pages. Mounted at /house, next to the photo route. */
export function houseFamilyRoutes(deps: AppDeps): Hono {
  const { db } = deps;
  const { now, tz } = requestClock(deps);
  const app = new Hono();

  const emergencyNumber = () => {
    const stored = getSettings(db).emergencyNumber?.trim() ?? '';
    return /\d/.test(stored) ? stored : '911';
  };
  const callName = (f: HouseFact) => f.org?.trim() || f.title;

  app.get('/', (c) => {
    const guides = getPublished(db, { area: 'home' });
    const facts = orderedFacts(db);
    const shutoffs = facts.filter((f) => f.kind === 'shutoff');
    const notes = facts.filter((f) => f.kind === 'note');
    const utilities = facts.filter((f) => f.kind === 'utility');
    const contacts = facts.filter((f) => f.kind === 'contact');
    const calls = uniqueByPhone([...utilities, ...contacts].filter((f) => f.phone));
    const photos = firstPhotos(db, shutoffs);
    const checked = oldestChecked(facts);
    const empty = guides.length === 0 && facts.length === 0;
    return page(
      c,
      'House emergencies',
      <>
        <div class="page-head">
          <BackLink href="/" label="Back to home" />
          <div>
            <h1>House emergencies</h1>
            {checked ? <div class="sub">Checked {formatDay(checked, tz())}</div> : null}
          </div>
        </div>
        {empty ? <p class="empty">Nothing here yet.</p> : null}
        {guides.length > 0 ? (
          <section class="group" aria-labelledby="happening-title">
            <h2 class="section-label" id="happening-title">
              What's happening?
            </h2>
            <nav class="list" aria-label="House emergency guides">
              {guides.map(({ protocol: p }) => {
                const linked = linkedFor(db, p.tags);
                const sub = dedupe([
                  ...linked.linkedFacts.filter((f) => f.kind === 'shutoff').map((f) => f.title),
                  ...linked.utilities.map(callName),
                  ...linked.ours.map(callName),
                ]);
                return (
                  <a href={`/house/guide/${p.slug}`}>
                    <Svg name={linked.systems[0] ? systemIcon(linked.systems[0]) : 'house'} size={24} sw={1.8} />
                    <span class="text">
                      <span class="title">{p.title}</span>
                      {sub.length > 0 ? <span class="sub">{sub.join(' · ')}</span> : null}
                    </span>
                    <span class="chev">
                      <Svg name="chevron-right" size={20} />
                    </span>
                  </a>
                );
              })}
            </nav>
          </section>
        ) : null}
        {shutoffs.length > 0 || notes.length > 0 ? (
          <section class="group" aria-labelledby="shutoffs-title">
            <h2 class="section-label" id="shutoffs-title">
              Shutoffs
            </h2>
            {shutoffs.map((f) => (
              <FactCard fact={f} photo={photos.get(f.id)} />
            ))}
            {notes.map((f) => (
              <p class="empty">
                <strong>{f.title}.</strong> {f.instructions ?? f.whereNote}
              </p>
            ))}
          </section>
        ) : null}
        {calls.length > 0 ? (
          <section class="group" aria-labelledby="call-title">
            <h2 class="section-label" id="call-title">
              Who to call
            </h2>
            {calls.map((f) => (
              <CallRow name={callName(f)} phone={f.phone!} ours={f.kind === 'contact'} note={f.instructions} />
            ))}
          </section>
        ) : null}
        <a class="btn btn-outline" href="/house/print">
          <Svg name="print" size={18} sw={2} /> Print the house sheet
        </a>
      </>,
    );
  });

  app.get('/guide/:slug', (c) => {
    const found = getPublishedBySlug(db, c.req.param('slug'));
    if (!found || found.protocol.area !== 'home') return notFound(c);
    const { protocol, version, sources } = found;
    const number = emergencyNumber();
    const links = guideLinks(db, protocol.tags, now(), tz());
    const chunks = splitSopSections(version.bodyMd);
    const body = (heading: string) => chunks.find((ch) => ch.heading === heading);
    const md = (chunkMd: string) => raw(renderMarkdown(withoutHeading(chunkMd)));
    const scope = body('Title and scope');
    const escalation = body('Escalation criteria');
    const steps = body('Steps');
    const doNot = body('Do not');
    const extra = chunks.filter((ch) => !['Title and scope', 'Escalation criteria', 'Steps', 'Do not'].includes(ch.heading));
    const reviewed = version.reviewedAt ? ` · reviewed ${version.reviewedAt.toISOString().slice(0, 10)}` : '';

    // Any shutoff, note or utility a step names goes inside that step, whatever the guide's tags ("Check the AC
    // breakers at the breaker panel" shows the panel on the AC guide). Linked shutoffs and notes no step names sit
    // above the steps; linked utilities no step names stay in Who to call.
    const inlineable = orderedFacts(db).filter((f) => f.kind === 'shutoff' || f.kind === 'note' || f.kind === 'utility');
    const parsed = steps ? parseSteps(withoutHeading(steps.md)) : null;
    const placed = parsed ? placeFacts(parsed.items.map((i) => i.text), inlineable) : { byStep: new Map<number, HouseFact[]>(), unplaced: inlineable };
    const inSteps = new Set([...placed.byStep.values()].flat().map((f) => f.id));
    const aboveSteps = links.linkedFacts.filter((f) => (f.kind === 'shutoff' || f.kind === 'note') && !inSteps.has(f.id));
    const utilities = links.utilities.filter((f) => f.phone && !inSteps.has(f.id));
    const photos = firstPhotos(db, inlineable);
    const ours = links.ours.filter((f) => f.phone);
    const hasCalls = ours.length > 0 || links.picks.length > 0 || utilities.length > 0;

    return page(
      c,
      protocol.title,
      <>
        <div class="page-head">
          <BackLink href="/house" label="Back to house emergencies" />
        </div>
        <div class="sop-head">
          <span class="eyebrow">House emergency</span>
          <h1>{protocol.title}</h1>
          {scope ? <div class="lede">{md(scope.md)}</div> : null}
        </div>
        {protocol.needsRereview ? (
          <div class="alert" role="note">
            <Svg name="warning" />
            <span class="text">
              <strong>Sources changed recently</strong>
              <span>This guide is being re-checked.</span>
            </span>
          </div>
        ) : null}
        {aboveSteps.length > 0 ? (
          <section class="group" aria-labelledby="yourhouse-title">
            <h2 class="section-label" id="yourhouse-title">
              Your house
            </h2>
            {aboveSteps.map((f) => (
              <InlineFact fact={f} photo={photos.get(f.id)} />
            ))}
          </section>
        ) : null}
        {steps ? (
          <section class="steps" aria-labelledby="steps-title">
            <h2 class="section-label" id="steps-title">
              Steps
            </h2>
            <div class="body">
              {parsed ? (
                <>
                  {parsed.before.trim() ? raw(renderMarkdown(parsed.before)) : null}
                  <ol>
                    {parsed.items.map((item, i) => (
                      <li>
                        {raw(renderMarkdown(item.md))}
                        {(placed.byStep.get(i) ?? []).map((f) => (
                          <InlineFact fact={f} photo={photos.get(f.id)} />
                        ))}
                      </li>
                    ))}
                  </ol>
                  {parsed.after.trim() ? raw(renderMarkdown(parsed.after)) : null}
                </>
              ) : (
                md(steps.md)
              )}
            </div>
          </section>
        ) : null}
        <section class="escalate" aria-labelledby="escalate-title">
          <h2 id="escalate-title">Call {number} if</h2>
          {escalation ? <div class="body">{md(escalation.md)}</div> : null}
        </section>
        {hasCalls ? (
          <section class="group" aria-labelledby="call-title">
            <h2 class="section-label" id="call-title">
              Who to call
            </h2>
            {ours.length > 0 ? <div class="ordinal">1 · Ours</div> : null}
            {ours.map((f) => (
              <CallRow name={callName(f)} phone={f.phone!} note={f.instructions} />
            ))}
            {ours.length > 0 && links.picks.length > 0 ? <div class="ordinal">2 · If they don't answer</div> : null}
            {links.picks.map((v) => (
              <PickCard view={v} />
            ))}
            {utilities.map((f) => (
                <div class="alert" role="note">
                  <Svg name="warning" />
                  <span>
                    {f.instructions ? `${f.instructions} ` : ''}
                    {callName(f)}: <a href={telHref(f.phone!)}>{f.phone}</a>
                  </span>
                </div>
              ))}
          </section>
        ) : null}
        {doNot ? (
          <section class="do-not" aria-labelledby="donot-title">
            <h2 id="donot-title">Do not</h2>
            <div class="body">{md(doNot.md)}</div>
          </section>
        ) : null}
        {extra.map((ch) => (
          <section class="sop-extra">{raw(renderMarkdown(ch.md.replace(/^# .*$/m, '')))}</section>
        ))}
        <footer class="sop-meta">
          <p class="version">
            <b>Version {version.version}</b>
            {reviewed}
          </p>
          {sources.length > 0 ? (
            <>
              <p>Sources</p>
              <ul>
                {sources.map((s) => (
                  <li>
                    {safeHref(s.url) ? <a href={safeHref(s.url)!}>{s.title ?? s.url}</a> : <span>{s.title ?? s.url}</span>}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </footer>
      </>,
    );
  });

  app.get('/print', (c) => {
    const number = emergencyNumber();
    const facts = orderedFacts(db);
    const shutoffs = facts.filter((f) => f.kind === 'shutoff');
    const notes = facts.filter((f) => f.kind === 'note');
    const calls = uniqueByPhone(
      [...facts.filter((f) => f.kind === 'utility'), ...facts.filter((f) => f.kind === 'contact')].filter((f) => f.phone),
    );
    const photos = firstPhotos(db, shutoffs);
    const withPhoto = shutoffs.filter((f) => photos.has(f.id));
    const doc = (
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="robots" content="noindex" />
          <title>House emergencies</title>
          <link rel="stylesheet" href={assetUrl('family.css')} />
        </head>
        <body class="family sheet">
          <div class="sheet-tools">
            <button type="button" class="btn btn-solid" onclick="window.print()">
              <Svg name="print" size={18} sw={2} /> Print
            </button>
          </div>
          <main id="main" class="paper">
            <div class="head">
              <h1>House emergencies</h1>
              <span>Printed {formatDay(now(), tz())}</span>
            </div>
            <p class="alarm">Fire, smoke, or someone hurt: get everyone out, then call {number}.</p>
            {shutoffs.length > 0 || notes.length > 0 ? (
              <>
                <h2>Shutoffs</h2>
                <table>
                  <tbody>
                    {shutoffs.map((f) => (
                      <tr>
                        <td class="k">{f.title}</td>
                        <td>{[f.whereNote, f.instructions].filter(Boolean).join(' · ')}</td>
                      </tr>
                    ))}
                    {notes.map((f) => (
                      <tr>
                        <td class="k">{f.title}</td>
                        <td>{f.instructions ?? f.whereNote}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : null}
            {withPhoto.length > 0 ? (
              <div class="thumbs">
                {withPhoto.map((f) => (
                  <figure>
                    <img src={photoSrc(photos.get(f.id)!)} alt={`Photo of ${f.title}`} />
                    <figcaption>{f.title}</figcaption>
                  </figure>
                ))}
              </div>
            ) : null}
            <h2>Who to call</h2>
            <table>
              <tbody>
                <tr>
                  <td class="k">Emergency</td>
                  <td>Police, fire, ambulance</td>
                  <td class="n">{number}</td>
                </tr>
                {calls.map((f) => (
                  <tr>
                    <td class="k">{callName(f)}</td>
                    <td>{f.instructions ?? (f.kind === 'contact' ? 'Ours' : '')}</td>
                    <td class="n">{f.phone}</td>
                  </tr>
                ))}
                <tr>
                  <td class="k">Poison control</td>
                  <td>24/7</td>
                  <td class="n">{POISON_CONTROL.display}</td>
                </tr>
              </tbody>
            </table>
            <p class="foot">Reprint every spring and after any change.</p>
          </main>
        </body>
      </html>
    );
    return c.html(html`<!DOCTYPE html>${doc}`);
  });

  return app;
}

function notFound(c: Context) {
  return page(
    c,
    'Not found',
    <>
      <div class="page-head">
        <BackLink href="/house" label="Back to house emergencies" />
        <h1>Not found</h1>
      </div>
      <p class="empty">We could not find that guide.</p>
    </>,
    404,
  );
}

const dedupe = (items: string[]): string[] => {
  const seen = new Set<string>();
  return items.filter((s) => {
    const key = s.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// The page draws its own heading for each SOP section, so drop the "## ..." line (and any "# title").
function withoutHeading(md: string): string {
  return md.replace(/^\s*##? .*(\r?\n|$)/, '').replace(/^# .*$/m, '');
}
