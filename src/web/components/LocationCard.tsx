import type { FC } from 'hono/jsx';
import { isReportedClosed, type LocationView } from '../../features/locations/search.js';
import { formatHHMM, formatMiles, mapsHref, telHref } from '../format.js';
import { WarningBadge } from './WarningBadge.js';

function openLine(open: LocationView['openNow']): string {
  if (open.state === 'open') return open.until ? `Open now · until ${formatHHMM(open.until)}` : 'Open now';
  return open.state === 'closed' ? 'Closed' : 'Hours unknown';
}

export const LocationCard: FC<{ location: LocationView; showCategory?: boolean }> = ({
  location: l,
  showCategory,
}) => {
  const miles = formatMiles(l.distanceMi);
  const closed = isReportedClosed(l);
  const summary = l.openChanges.length
    ? [...new Set(l.openChanges.map((c) => c.field))].join(', ')
    : 'Details changed';
  return (
    <article class="card">
      <h3>
        <a href={`/l/${l.id}`}>{l.name}</a>
      </h3>
      {showCategory ? <p class="muted">{l.category.name}</p> : null}
      {miles ? <p class="muted">{miles}</p> : null}
      {closed ? (
        <WarningBadge kind="closed" summary={summary} />
      ) : l.status === 'warn' ? (
        <WarningBadge kind="warn" summary={summary} />
      ) : null}
      {l.phone ? (
        <a class="call" href={telHref(l.phone)}>
          Call {l.phone}
        </a>
      ) : null}
      <a class="row" href={mapsHref(l)}>
        Open in maps
      </a>
      <p>
        <strong>{openLine(l.openNow)}</strong>
      </p>
      {l.hours ? (
        <ul class="hours">
          {l.hours.weekdayText.map((line) => (
            <li>{line}</li>
          ))}
        </ul>
      ) : null}
      {l.afterHoursNotes ? <p>After hours: {l.afterHoursNotes}</p> : null}
      {l.walkIns !== null ? <p>Walk-ins: {l.walkIns ? 'yes' : 'no'}</p> : null}
      {l.insuranceNotes ? <p>Insurance: {l.insuranceNotes}</p> : null}
    </article>
  );
};
