// Splits a protocol body on the four known SOP "## " headings so the family page can style them
// individually. Each heading line stays inside its chunk; text before the first heading is a leading
// chunk with an empty heading. Chunks are re-rendered through renderMarkdown by the caller.
const SOP_HEADING = /^## (Title and scope|Steps|Escalation criteria|Do not)[ \t]*$/;

export function splitSopSections(bodyMd: string): { heading: string; md: string }[] {
  const out: { heading: string; lines: string[] }[] = [];
  let current: { heading: string; lines: string[] } = { heading: '', lines: [] };
  // CommonMark: a closing fence uses the same character, is at least as long as the opener, and has no info string.
  let fence: { ch: string; len: number } | null = null;
  for (const line of bodyMd.split(/\r?\n/)) {
    const mf = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (mf) {
      const run = mf[1]!;
      const info = mf[2]!;
      if (fence === null) {
        // A backtick fence's info string may not contain backticks.
        if (!(run[0] === '`' && info.includes('`'))) fence = { ch: run[0]!, len: run.length };
      } else if (run[0] === fence.ch && run.length >= fence.len && info.trim() === '') {
        fence = null;
      }
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
