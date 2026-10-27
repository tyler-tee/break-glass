import type { FC } from 'hono/jsx';

export const WarningBadge: FC<{ kind: 'warn' | 'closed'; summary: string }> = ({ kind, summary }) =>
  kind === 'closed' ? (
    <p class="badge badge-closed">Reported closed</p>
  ) : (
    <p class="badge badge-warn">⚠ {summary}</p>
  );
