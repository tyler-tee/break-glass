import dns from 'node:dns';
import net from 'node:net';
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

export type LookupFn = (
  hostname: string,
  opts: { all: true },
) => Promise<{ address: string; family: number }[]>;

const defaultLookup = dns.promises.lookup as unknown as LookupFn;

const MAX_BODY_CHARS = 2_000_000;
const MAX_REDIRECTS = 3;

function isBlockedV4(addr: string): boolean {
  const parts = addr.split('.').map(Number);
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  return a >= 224; // multicast 224/4 and reserved 240/4
}

function isBlockedIp(raw: string): boolean {
  const addr = raw.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  const kind = net.isIP(addr);
  if (kind === 4) return isBlockedV4(addr);
  if (kind !== 6) return true;
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (dotted) return isBlockedV4(dotted[1] as string);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
  if (hex) {
    const hi = parseInt(hex[1] as string, 16);
    const lo = parseInt(hex[2] as string, 16);
    return isBlockedV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (addr.startsWith('::')) return true; // unspecified, loopback, IPv4-compatible
  const first = parseInt(addr.split(':')[0] || '0', 16);
  if (first >= 0xfe80 && first <= 0xfebf) return true; // link-local fe80::/10
  if (first >= 0xfc00 && first <= 0xfdff) return true; // unique local fc00::/7
  if (first === 0x2002) return true; // 6to4 2002::/16
  if (first === 0x64 && parseInt(addr.split(':')[1] || '0', 16) === 0xff9b) return true; // NAT64 64:ff9b::/96
  return first >= 0xff00; // multicast ff00::/8
}

export async function isSafeTarget(url: URL, lookup: LookupFn = defaultLookup): Promise<boolean> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (net.isIP(host) !== 0) return !isBlockedIp(host);
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isBlockedIp(a.address));
  } catch {
    return false;
  }
}

async function readCapped(res: Response, maxChars: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
    if (out.length >= maxChars) {
      await reader.cancel();
      break;
    }
  }
  return out.slice(0, maxChars);
}

type FetchCtx = { fetch: typeof fetch; timeoutMs: number; lookup: LookupFn; log?: Logger };

async function fetchHtml(startUrl: string, ctx: FetchCtx): Promise<string | null> {
  let current = new URL(startUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await isSafeTarget(current, ctx.lookup))) {
      ctx.log?.warn(`blocked unsafe target: ${current.href}`);
      return null;
    }
    const res = await ctx.fetch(current.href, {
      signal: AbortSignal.timeout(ctx.timeoutMs),
      redirect: 'manual',
      headers: { 'User-Agent': 'break-glass/1.0 (household emergency toolkit)' },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return null;
      try {
        current = new URL(location, current);
      } catch {
        return null;
      }
      continue;
    }
    if (!res.ok) return null;
    const type = res.headers.get('content-type');
    if (!type || !/^\s*(text\/html|application\/xhtml\+xml)\b/i.test(type)) return null;
    const length = Number(res.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_BODY_CHARS) return null;
    return (await readCapped(res, MAX_BODY_CHARS)).slice(0, MAX_HTML_CHARS);
  }
  ctx.log?.warn(`too many redirects for ${startUrl}`);
  return null;
}

export async function fetchWebsiteText(
  url: string,
  deps: {
    fetch: typeof fetch;
    timeoutMs?: number;
    maxChars?: number;
    log?: Logger;
    lookup?: LookupFn;
  },
): Promise<FetchedPage[]> {
  const ctx: FetchCtx = {
    fetch: deps.fetch,
    timeoutMs: deps.timeoutMs ?? 10_000,
    lookup: deps.lookup ?? defaultLookup,
    ...(deps.log ? { log: deps.log } : {}),
  };
  const maxChars = deps.maxChars ?? 20_000;
  let homepageHtml: string | null;
  try {
    homepageHtml = await fetchHtml(url, ctx);
  } catch (err) {
    deps.log?.warn(`website fetch failed for ${url}: ${String(err)}`);
    return [];
  }
  if (homepageHtml === null) {
    deps.log?.warn(`website fetch for ${url}: non-OK, non-HTML or blocked response`);
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
      const html = await fetchHtml(target, ctx);
      if (html === null) {
        deps.log?.warn(`skipping ${target}: non-OK, non-HTML or blocked response`);
        continue;
      }
      pages.push({ url: target, text: htmlToText(html).slice(0, maxChars) });
    } catch (err) {
      deps.log?.warn(`skipping ${target}: ${String(err)}`);
    }
  }
  return pages;
}

const MAX_PAGE_CHARS = 60_000;

export async function fetchPage(
  url: string,
  deps: { fetch: typeof fetch; lookup?: LookupFn; timeoutMs?: number; log?: Logger },
): Promise<{ url: string; text: string; title: string | null } | null> {
  const ctx: FetchCtx = {
    fetch: deps.fetch,
    timeoutMs: deps.timeoutMs ?? 10_000,
    lookup: deps.lookup ?? defaultLookup,
    ...(deps.log ? { log: deps.log } : {}),
  };
  try {
    const html = await fetchHtml(url, ctx);
    if (html === null) {
      deps.log?.warn(`page fetch for ${url}: non-OK, non-HTML or blocked response`);
      return null;
    }
    const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
    const title = m ? decodeEntities(m[1] ?? '').replace(/\s+/g, ' ').trim() : '';
    return { url, text: htmlToText(html).slice(0, MAX_PAGE_CHARS), title: title === '' ? null : title };
  } catch (err) {
    deps.log?.warn(`page fetch failed for ${url}: ${String(err)}`);
    return null;
  }
}
