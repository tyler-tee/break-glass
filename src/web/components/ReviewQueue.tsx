import type { FC } from 'hono/jsx';
import type { FieldChange } from '../../domain/types.js';
import { WarningBadge } from './WarningBadge.js';

export type ReviewItem = {
  id: number;
  title: string;
  subtitle?: string;
  changes?: FieldChange[];
  badge?: { kind: 'warn' | 'closed'; summary: string };
};

export const ReviewQueue: FC<{
  title: string;
  empty: string;
  items: ReviewItem[];
  approveAction: (id: number) => string;
  rejectAction: (id: number) => string;
  approveLabel?: string;
}> = ({ title, empty, items, approveAction, rejectAction, approveLabel }) => (
  <section>
    <h2>{title}</h2>
    {items.length === 0 ? <p>{empty}</p> : null}
    {items.map((item) => (
      <article class="card">
        <h3>{item.title}</h3>
        {item.subtitle ? <p class="muted">{item.subtitle}</p> : null}
        {item.badge ? <WarningBadge kind={item.badge.kind} summary={item.badge.summary} /> : null}
        {item.changes?.length ? (
          <ul>
            {item.changes.map((ch) => (
              <li>
                {ch.field}: {ch.oldValue ?? '(none)'} → {ch.newValue ?? '(none)'}
              </li>
            ))}
          </ul>
        ) : null}
        <form method="post" action={approveAction(item.id)}>
          <input type="hidden" name="return" value="1" />
          <button type="submit">
            {approveLabel ?? 'Approve'}
          </button>
        </form>
        <form method="post" action={rejectAction(item.id)}>
          <input type="hidden" name="return" value="1" />
          <button type="submit">
            Reject
          </button>
        </form>
      </article>
    ))}
  </section>
);
