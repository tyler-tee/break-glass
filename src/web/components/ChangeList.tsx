import type { FC } from 'hono/jsx';
import type { FieldChange } from '../../domain/types.js';

const MAX = 120;
const show = (v: string | null): string => (v === null ? '—' : v.length > MAX ? `${v.slice(0, MAX)}…` : v);

export const ChangeList: FC<{ changes: FieldChange[] }> = ({ changes }) => (
  <ul>
    {changes.map((ch) => (
      <li>{ch.field === 'hours' ? 'hours: changed' : `${ch.field}: ${show(ch.oldValue)} → ${show(ch.newValue)}`}</li>
    ))}
  </ul>
);
