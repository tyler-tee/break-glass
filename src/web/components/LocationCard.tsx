import type { FC } from 'hono/jsx';
import { isReportedClosed, type LocationView } from '../../features/locations/search.js';
import { formatHHMM, formatMiles, mapsHref, telHref } from '../format.js';
import { Icon } from './Icon.js';
import { WarningBadge } from './WarningBadge.js';

function OpenPill({ open }: { open: LocationView['openNow'] }) {
  if (open.state === 'open') {
    return (
      <p class="pill pill-open">
        <Icon name="check" /> <strong>Open now</strong>
        {open.until ? <span> until {formatHHMM(open.until)}</span> : null}
      </p>
    );
  }
  return open.state === 'closed' ? (
    <p class="pill pill-closed">
      <Icon name="clock" /> <strong>Closed</strong>
    </p>
  ) : (
    <p class="pill pill-unknown">
      <Icon name="alert-triangle" /> <strong>Hours unknown</strong>
    </p>
  );
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
  const hasDetails = Boolean(l.hours || l.afterHoursNotes || l.walkIns !== null || l.insuranceNotes);
  return (
    <article class="card">
      <h3>
        <a href={`/l/${l.id}`}>{l.name}</a>
      </h3>
      {showCategory ? <p class="muted">{l.category.name}</p> : null}
      {miles ? <p class="muted">{miles}</p> : null}
      <OpenPill open={l.openNow} />
      {closed ? (
        <WarningBadge kind="closed" summary={summary} />
      ) : l.status === 'warn' ? (
        <WarningBadge kind="warn" summary={summary} />
      ) : null}
      <div class="actions">
        {l.phone ? (
          <a class="call" href={telHref(l.phone)}>
            <Icon name="phone" /> Call {l.phone}
          </a>
        ) : null}
        <a class="directions" href={mapsHref(l)}>
          <Icon name="map-pin" /> Directions
        </a>
      </div>
      {hasDetails ? (
        <details class="details">
          <summary>Hours and details</summary>
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
        </details>
      ) : null}
    </article>
  );
};
