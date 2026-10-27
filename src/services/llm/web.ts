import type { Logger } from '../../domain/types.js';

export type FetchedPage = { url: string; text: string };

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  nbsp: ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|nbsp)|#39);/gi, (m, dec, hex, name) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? m;
    if (m === '&#39;') return "'";
    const code = dec !== undefined ? Number(dec) : parseInt(hex, 16);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/(?:td|th)\s*>/gi, ' ')
    .replace(
      /<br\s*\/?>|<hr\s*\/?>|<\/(?:p|div|li|h[1-6]|tr|dt|dd|section|article|header|footer|nav|ul|ol|table|blockquote|pre|option)\s*>/gi,
      '\n',
    )
    .replace(/<[^>]*>/g, '');
  return decodeEntities(stripped)
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const MAX_HTML_CHARS = 500_000;

const RELEVANT = /hours|contact|insurance|patients|new-patient|location|emergenc/i;

function normalize(u: URL): string {
  const copy = new URL(u.href);
  copy.hash = '';
  return copy.href.replace(/\/+$/, '');
}

export function pickPages(homepageHtml: string, baseUrl: string, max = 4): string[] {
  const base = new URL(baseUrl);
  const seen = new Set<string>([normalize(base)]);
  const picked: string[] = [];
  const anchor = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi;
  for (const m of homepageHtml.matchAll(anchor)) {
    if (picked.length >= max) break;
    const href = decodeEntities((m[1] ?? m[2] ?? '').trim());
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== base.origin) continue;
    if (!RELEVANT.test(url.pathname) && !RELEVANT.test(htmlToText(m[3] ?? ''))) continue;
    const key = normalize(url);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(key);
  }
  return picked;
}

async function fetchHtml(
  url: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<string | null> {
  const res = await fetchFn(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'break-glass/1.0 (household emergency toolkit)' },
  });
  if (!res.ok) return null;
  const type = res.headers.get('content-type');
  if (type !== null && !/^\s*(text\/html|application\/xhtml\+xml)\b/i.test(type)) return null;
  return (await res.text()).slice(0, MAX_HTML_CHARS);
}

export async function fetchWebsiteText(
  url: string,
  deps: { fetch: typeof fetch; timeoutMs?: number; maxChars?: number; log?: Logger },
): Promise<FetchedPage[]> {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const maxChars = deps.maxChars ?? 20_000;
  let homepageHtml: string | null;
  try {
    homepageHtml = await fetchHtml(url, deps.fetch, timeoutMs);
  } catch (err) {
    deps.log?.warn(`website fetch failed for ${url}: ${String(err)}`);
    return [];
  }
  if (homepageHtml === null) {
    deps.log?.warn(`website fetch for ${url}: non-OK or non-HTML response`);
    return [];
  }

  const pages: FetchedPage[] = [{ url, text: htmlToText(homepageHtml).slice(0, maxChars) }];
  let targets: string[];
  try {
    targets = pickPages(homepageHtml, url);
  } catch (err) {
    deps.log?.warn(`could not pick pages for ${url}: ${String(err)}`);
    return pages;
  }
  for (const target of targets) {
    try {
      const html = await fetchHtml(target, deps.fetch, timeoutMs);
      if (html === null) {
        deps.log?.warn(`skipping ${target}: non-OK or non-HTML response`);
        continue;
      }
      pages.push({ url: target, text: htmlToText(html).slice(0, maxChars) });
    } catch (err) {
      deps.log?.warn(`skipping ${target}: ${String(err)}`);
    }
  }
  return pages;
}
