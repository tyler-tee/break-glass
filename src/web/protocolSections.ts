// Splits a protocol body on the four known SOP "## " headings so the family page can style them
// individually. Each heading line stays inside its chunk; text before the first heading is a leading
// chunk with an empty heading. Chunks are re-rendered through renderMarkdown by the caller.
const SOP_HEADING = /^## (Title and scope|Steps|Escalation criteria|Do not)[ \t]*$/;

export function splitSopSections(bodyMd: string): { heading: string; md: string }[] {
  const out: { heading: string; lines: string[] }[] = [];
  let current: { heading: string; lines: string[] } = { heading: '', lines: [] };
  let fence: string | null = null;
  for (const line of bodyMd.split(/\r?\n/)) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (f) {
      if (fence === null) fence = f[0]!;
      else if (f[0] === fence) fence = null;
    }
    const m = fence === null ? SOP_HEADING.exec(line) : null;
    if (m) {
      out.push(current);
      current = { heading: m[1]!, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  out.push(current);
  return out
    .map((c) => ({ heading: c.heading, md: c.lines.join('\n') }))
    .filter((c) => c.md.trim() !== '');
}
