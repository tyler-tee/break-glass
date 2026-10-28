import type { FieldChange, WeeklyHours } from '../domain/types.js';

// Turns a place's unresolved refresh changes into one plain sentence for the family card, e.g.
// "Hours changed since you approved it (Sat: Closed)."

function parseHours(v: string | null): WeeklyHours | null {
  if (!v) return null;
  try {
    return JSON.parse(v) as WeeklyHours;
  } catch {
    return null;
  }
}

// "Saturday: Closed" -> "Sat: now closed"; only lines that differ between the old and new hours.
function changedDays(c: FieldChange): string[] {
  const before = new Set(parseHours(c.oldValue)?.weekdayText ?? []);
  const after = parseHours(c.newValue)?.weekdayText ?? [];
  return after
    .filter((line) => !before.has(line))
    .map((line) =>
      line
        .replace(/^(\w{3})\w*:/, '$1:')
        .replace(/: Closed$/, ': now closed')
        .replace(/ | /g, ' '),
    );
}

export function summarizeChanges(changes: FieldChange[]): string {
  const sentences: string[] = [];
  const fields = new Set(changes.map((c) => c.field));
  const hours = changes.find((c) => c.field === 'hours');
  if (hours) {
    const days = changedDays(hours);
    const detail = days.length === 0 ? '' : ` (${days.slice(0, 2).join('; ')}${days.length > 2 ? `; +${days.length - 2} more` : ''})`;
    sentences.push(`Hours changed since you approved it${detail}.`);
  }
  const status = changes.find((c) => c.field === 'businessStatus');
  if (status?.newValue === 'CLOSED_TEMPORARILY') sentences.push('Google now lists it as temporarily closed.');
  else if (status) sentences.push('Its open/closed listing changed.');
  const phone = changes.find((c) => c.field === 'phone');
  if (phone) sentences.push(phone.newValue ? `Phone number is now ${phone.newValue}.` : 'Phone number was removed.');
  if (fields.has('address')) sentences.push('Address changed.');
  if (fields.has('name')) sentences.push('Name changed.');
  if (fields.has('verification')) sentences.push('The weekly check could not reach its listing.');
  const other = [...fields].filter(
    (f) => !['hours', 'businessStatus', 'phone', 'address', 'name', 'verification'].includes(f),
  );
  if (other.length > 0 && sentences.length === 0) sentences.push('Details changed since you approved it.');
  return sentences.length > 0 ? sentences.join(' ') : 'Something changed since you approved it.';
}
