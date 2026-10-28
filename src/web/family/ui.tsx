import type { Child, FC } from 'hono/jsx';
import { isReportedTemporarilyClosed } from '../../features/locations/familyViews.js';
import type { LocationView } from '../../features/locations/search.js';
import { summarizeChanges } from '../changeSummary.js';
import { formatMiles, mapsHref, telHref } from '../format.js';

// Line icons from the approved mockup (24px grid, round caps). Pediatrics and the fallback pin are
// Lucide geometry (ISC License, https://lucide.dev).
const PATHS = {
  search: ['M20 20l-4-4'],
  plus: ['M12 5v14M5 12h14'],
  'chevron-right': ['M9 6l6 6-6 6'],
  'chevron-left': ['M15 6l-6 6 6 6'],
  phone: ['M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2'],
  flask: ['M9 3h6M10 3v6L4.5 18.5A2 2 0 0 0 6.2 21.5h11.6a2 2 0 0 0 1.7-3L14 9V3'],
  warning: ['M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
  directions: ['M3 11l19-9-9 19-2-8-8-2z'],
  tooth: [
    'M7 3c-2 0-3.5 1.6-3.5 4 0 3 1.5 5 2 8 .4 2.6 1 6 2.5 6s1.6-3 2.5-5c.4-.8 1.6-.8 2 0 .9 2 1 5 2.5 5s2.1-3.4 2.5-6c.5-3 2-5 2-8 0-2.4-1.5-4-3.5-4-1.8 0-3 1-5 1S8.8 3 7 3z',
  ],
  clock: ['M12 7v5l3 2'],
  hospital: ['M3 21h18M5 21V7l7-4 7 4v14M10 9h4M12 7v4M9 21v-5h6v5'],
  paw: ['M12 14c-3 0-5 3-5 5 0 1.5 1.5 2 2.5 2s1.5-.6 2.5-.6 1.5.6 2.5.6 2.5-.5 2.5-2c0-2-2-5-5-5z'],
  pill: ['M4.5 12.5l8-8a4.95 4.95 0 0 1 7 7l-8 8a4.95 4.95 0 0 1-7-7zM8.5 8.5l7 7'],
  baby: [
    'M9 12h.01M15 12h.01M10 16c.5.3 1.2.5 2 .5s1.5-.2 2-.5',
    'M19 6.3a9 9 0 0 1 1.8 3.9 2 2 0 0 1 0 3.6 9 9 0 0 1-17.6 0 2 2 0 0 1 0-3.6A9 9 0 0 1 12 3c2 0 3.5 1.1 3.5 2.5s-.9 2.5-2 2.5c-.8 0-1.5-.4-1.5-1',
  ],
  pin: ['M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z'],
} as const;
const CIRCLES: Partial<Record<IconName, [number, number, number][]>> = {
  search: [[11, 11, 7]],
  clock: [[12, 12, 9]],
  paw: [[5.5, 10, 1.6], [9, 5.5, 1.6], [15, 5.5, 1.6], [18.5, 10, 1.6]],
  pin: [[12, 10, 3]],
};

export type IconName = keyof typeof PATHS;

export const Svg: FC<{ name: IconName; size?: number; sw?: number }> = ({ name, size = 18, sw = 2.2 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={sw}
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    {PATHS[name].map((d) => <path d={d} />)}
    {(CIRCLES[name] ?? []).map(([cx, cy, r]) => <circle cx={cx} cy={cy} r={r} />)}
  </svg>
);

/** Picks a tile icon from the category's name and search terms. */
export function categoryIcon(cat: { name: string; searchTerms: string[] }): IconName {
  const text = [cat.name, ...cat.searchTerms].join(' ').toLowerCase();
  if (/dent|tooth|teeth/.test(text)) return 'tooth';
  if (/\bvet|animal|\bpet/.test(text)) return 'paw';
  if (/pharm|drug|prescription/.test(text)) return 'pill';
  if (/pediatric|child|kid|baby/.test(text)) return 'baby';
  if (/emergency room|hospital|\ber\b/.test(text)) return 'hospital';
  if (/urgent|walk-in|clinic/.test(text)) return 'clock';
  return 'pin';
}

export const BackLink: FC<{ href: string; label: string }> = ({ href, label }) => (
  <a class="back" href={href} aria-label={label}>
    <Svg name="chevron-left" size={20} />
  </a>
);

/** GET search form. Enter submits; the hidden button keeps it operable for keyboard and screen-reader users. */
export const SearchField: FC<{
  action: string;
  id: string;
  label: string;
  visibleLabel?: boolean;
  value?: string;
  placeholder?: string;
  compact?: boolean;
}> = ({ action, id, label, visibleLabel, value, placeholder, compact }) => (
  <form class="search" method="get" action={action} role="search">
    <label for={id} class={visibleLabel ? undefined : 'sr-only'}>
      {label}
    </label>
    <div class={`field${compact ? ' compact' : ''}${value ? ' active' : ''}`}>
      <Svg name="search" size={compact ? 18 : 20} sw={2} />
      <input id={id} name="q" type="search" value={value} placeholder={placeholder} enterkeyhint="search"
        autocomplete="off" autocapitalize="none" spellcheck={false} />
    </div>
    <button type="submit" class="sr-only">
      Search
    </button>
  </form>
);

export function daysAgo(then: Date, now: Date): string {
  const days = Math.floor((now.getTime() - then.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/** The oldest check across these places, so the claim holds for every one of them. */
export function oldestVerified(views: { lastVerifiedAt: Date | null }[]): Date | null {
  const dates = views.map((v) => v.lastVerifiedAt).filter((d): d is Date => d !== null);
  return dates.length === 0 ? null : new Date(Math.min(...dates.map((d) => d.getTime())));
}

function StatusRow({ view }: { view: LocationView }) {
  if (isReportedTemporarilyClosed(view)) {
    return (
      <div class="status">
        <span class="pill closed">Closed</span>
        <span>temporarily, per Google</span>
      </div>
    );
  }
  const h = view.hoursStatus;
  if (h.state === 'unknown') {
    return (
      <div class="status">
        <span class="pill unknown">Hours unknown</span>
        <span>call first</span>
      </div>
    );
  }
  return (
    <div class="status">
      <span class={`pill ${h.state}`}>{h.state === 'open' ? 'Open now' : 'Closed'}</span>
      <span>{h.label}</span>
    </div>
  );
}

export const ProviderCard: FC<{ view: LocationView; headingLevel?: 2 | 3 }> = ({ view: l, headingLevel = 2 }) => {
  const miles = formatMiles(l.distanceMi);
  const rating = l.rating !== null ? `${l.rating.toFixed(1)} rating${l.ratingCount ? ` (${l.ratingCount})` : ''}` : null;
  const meta = [miles, rating].filter(Boolean).join(' · ');
  const Heading = (props: { children: Child }) =>
    headingLevel === 3 ? <h3>{props.children}</h3> : <h2>{props.children}</h2>;
  const after = l.afterHoursNotes?.trim() ?? '';
  const walkIns = l.walkIns === true && !/walk-?ins?/i.test(after) ? 'Walk-ins accepted.' : null;
  const notes = [after, walkIns].filter(Boolean).join(' ');
  return (
    <article class="provider" id={`place-${l.id}`}>
      {l.status === 'warn' ? (
        <div class="alert" role="note">
          <Svg name="warning" />
          <span class="text">
            <strong>Needs re-approval</strong>
            <span>{summarizeChanges(l.openChanges)}</span>
          </span>
        </div>
      ) : null}
      <div>
        <Heading>{l.name}</Heading>
        {meta ? <p class="meta">{meta}</p> : null}
      </div>
      <StatusRow view={l} />
      {notes ? <p class="note">{notes}</p> : null}
      {l.insuranceNotes?.trim() ? (
        <details class="more-info">
          <summary>
            <Svg name="chevron-right" size={16} /> Insurance and payment
          </summary>
          <p>{l.insuranceNotes.trim()}</p>
        </details>
      ) : null}
      <div class={`actions${l.phone ? '' : ' single'}`}>
        {l.phone ? (
          <a class="btn sm btn-solid" href={telHref(l.phone)} aria-label={`Call ${l.name}, ${l.phone}`}>
            <Svg name="phone" /> Call
          </a>
        ) : null}
        <a class="btn sm btn-outline" href={mapsHref(l)} aria-label={`Directions to ${l.name}`}>
          <Svg name="directions" sw={2} /> Directions
        </a>
      </div>
    </article>
  );
};
