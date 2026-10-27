import { describe, expect, it } from 'vitest';
import { splitSopSections } from '../src/web/protocolSections.js';

const headings = (md: string) => splitSopSections(md).map((c) => c.heading);

describe('splitSopSections', () => {
  it('splits the four SOP headings and keeps each heading in its chunk', () => {
    const r = splitSopSections('## Title and scope\na\n\n## Steps\n1. x\n\n## Escalation criteria\nb\n\n## Do not\nc');
    expect(r.map((c) => c.heading)).toEqual(['Title and scope', 'Steps', 'Escalation criteria', 'Do not']);
    expect(r[1]!.md.startsWith('## Steps')).toBe(true);
  });

  it('handles CRLF input', () => {
    expect(headings('## Steps\r\n1. x\r\n\r\n## Do not\r\nc\r\n')).toEqual(['Steps', 'Do not']);
  });

  it('keeps leading content as a chunk with an empty heading', () => {
    const r = splitSopSections('intro\n\n## Steps\n1. x');
    expect(r.map((c) => c.heading)).toEqual(['', 'Steps']);
    expect(r[0]!.md).toContain('intro');
  });

  it('does not split on a heading inside a fenced block', () => {
    const r = splitSopSections('## Steps\n```\n## Do not\n```\n## Do not\nreal');
    expect(r.map((c) => c.heading)).toEqual(['Steps', 'Do not']);
    expect(r[0]!.md).toContain('## Do not');
  });

  it('a shorter inner fence does not close a longer outer fence', () => {
    const md = '## Steps\n````\n```\n## Do not\n```\n````\n## Do not\nreal';
    const r = splitSopSections(md);
    expect(r.map((c) => c.heading)).toEqual(['Steps', 'Do not']);
    expect(r[0]!.md).toContain('````');
  });

  it('a fence line with an info string or a different char does not close the fence', () => {
    expect(headings('## Steps\n```\n```js\n## Do not\n~~~\n```\n## Do not\nx')).toEqual(['Steps', 'Do not']);
  });

  it('starts a new chunk for duplicate headings', () => {
    expect(headings('## Steps\na\n## Steps\nb')).toEqual(['Steps', 'Steps']);
  });

  it('keeps unknown headings inside the preceding chunk', () => {
    const r = splitSopSections('## Steps\na\n## Extra notes\nb\n## Do not\nc');
    expect(r.map((c) => c.heading)).toEqual(['Steps', 'Do not']);
    expect(r[0]!.md).toContain('## Extra notes');
  });
});
