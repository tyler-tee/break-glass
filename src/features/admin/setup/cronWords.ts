const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const int = (s: string, min: number, max: number): number | null => {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
};

const clock = (h: number, m: number): string =>
  `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;

/** Plain words for the simple cron shapes the app uses ("weekly on Sunday at 3:00 am"); anything else is shown as-is. */
export function describeCron(expr: string): string {
  const custom = `on a custom schedule (${expr})`;
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return custom;
  const [mi, hr, dom, mon, dow] = f as [string, string, string, string, string];
  const m = int(mi, 0, 59);
  const h = int(hr, 0, 23);
  if (m === null || h === null || mon !== '*') return custom;
  const at = clock(h, m);
  if (dom === '*' && dow === '*') return `every day at ${at}`;
  if (dom === '*') {
    const d = int(dow, 0, 7);
    return d === null ? custom : `weekly on ${DAYS[d]} at ${at}`;
  }
  if (dow === '*') {
    const d = int(dom, 1, 31);
    return d === null ? custom : `monthly on day ${d} at ${at}`;
  }
  return custom;
}
