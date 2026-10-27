import type { FC } from 'hono/jsx';

// Icon geometry vendored from Lucide (https://lucide.dev), ISC License.
// Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT);
// all other copyright (c) for Lucide are held by Lucide Contributors 2022.

type Shape = { t: 'path'; d: string } | { t: 'circle'; cx: number; cy: number; r: number }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number } | { t: 'poly'; points: string };

const p = (d: string): Shape => ({ t: 'path', d });
const line = (x1: number, y1: number, x2: number, y2: number): Shape => ({ t: 'line', x1, y1, x2, y2 });

const ICONS = {
  phone: [p('M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z')],
  'map-pin': [p('M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z'), { t: 'circle', cx: 12, cy: 10, r: 3 }],
  clock: [{ t: 'circle', cx: 12, cy: 12, r: 10 }, { t: 'poly', points: '12 6 12 12 16 14' }],
  'alert-triangle': [p('m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3'), line(12, 9, 12, 13), line(12, 17, 12.01, 17)],
  'x-octagon': [{ t: 'poly', points: '7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2' }, line(15, 9, 9, 15), line(9, 9, 15, 15)],
  check: [p('M20 6 9 17l-5-5')],
  menu: [line(4, 12, 20, 12), line(4, 6, 20, 6), line(4, 18, 20, 18)],
  search: [{ t: 'circle', cx: 11, cy: 11, r: 8 }, p('m21 21-4.3-4.3')],
  'chevron-right': [p('m9 18 6-6-6-6')],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;

export const Icon: FC<{ name: IconName; label?: string }> = ({ name, label }) => (
  <>
    <svg class="icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      {(ICONS[name] as Shape[]).map((s) => {
        switch (s.t) {
          case 'path': return <path d={s.d} />;
          case 'circle': return <circle cx={s.cx} cy={s.cy} r={s.r} />;
          case 'line': return <line x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} />;
          case 'poly': return <polyline points={s.points} />;
        }
      })}
    </svg>
    {label ? <span class="sr-only">{label}</span> : null}
  </>
);
