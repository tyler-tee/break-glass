import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const walk = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return full.replaceAll(String.fromCharCode(92), '/') === 'test/fixtures' ? [] : walk(full);
      return [full];
    });
  } catch {
    return [];
  }
};

describe('encoding', () => {
  it('all source and test files are valid UTF-8', () => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const files = ['src', 'test', 'scripts'].flatMap(walk);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(() => decoder.decode(readFileSync(f)), f).not.toThrow();
  });
});
