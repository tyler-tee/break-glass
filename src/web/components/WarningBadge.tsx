import type { FC } from 'hono/jsx';
import { Icon } from './Icon.js';

// Status is always icon + text, never color alone. The visually hidden glyph keeps a plain-text cue
// for tools that read the page without styles.
export const WarningBadge: FC<{ kind: 'warn' | 'closed'; summary: string }> = ({ kind, summary }) =>
  kind === 'closed' ? (
    <p class="badge badge-closed">
      <Icon name="x-octagon" /> Reported closed
    </p>
  ) : (
    <p class="badge badge-warn">
      <Icon name="alert-triangle" />
      <span class="sr-only">⚠ Warning: </span> {summary}
    </p>
  );
