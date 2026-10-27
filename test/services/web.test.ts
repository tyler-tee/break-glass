import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fetchWebsiteText, htmlToText, isSafeTarget, pickPages } from '../../src/services/llm/web.js';
import { fakeSiteFetch } from '../helpers/fakeSiteFetch.js';

const ROOT = path.resolve(import.meta.dirname, '../fixtures/web');
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const BASE = 'https://near-dental.example/';
const homepage = fs.readFileSync(path.join(ROOT, 'near-dental.example/index.html'), 'utf8');

describe('htmlToText', () => {
  it('drops scripts, styles and comments and decodes entities', () => {
    const text = htmlToText(
      '<style>p{}</style><script>var x=1;</script><!-- hidden --><noscript>nojs</noscript>' +
        '<p>Tom &amp; Jerry &lt;3 &quot;hi&quot; it&#39;s&nbsp;ok &#65;&#x42;</p><div>Next</div>',
    );
    expect(text).toBe('Tom & Jerry <3 "hi" it\'s ok AB\nNext');
  });
});

describe('htmlToText block separation', () => {
  it('separates table cells and block elements', () => {
    expect(htmlToText('<table><tr><td>Monday</td><td>8am-5pm</td></tr><tr><td>Tuesday</td><td>9am-5pm</td></tr></table>')).toBe(
      'Monday 8am-5pm\nTuesday 9am-5pm',
    );
    expect(htmlToText('<section>A</section><section>B</section>')).toBe('A\nB');
  });
});

describe('pickPages', () => {
  it('selects hours/contact/insurance/patients links and caps at 4', () => {
    expect(pickPages(homepage, BASE)).toEqual([
      'https://near-dental.example/hours',
      'https://near-dental.example/contact',
      'https://near-dental.example/insurance',
      'https://near-dental.example/patients/new',
    ]);
    const many = ['hours', 'contact', 'insurance', 'patients', 'emergency']
      .map((p) => `<a href="/${p}">x</a>`)
      .join('');
    expect(pickPages(many, BASE)).toHaveLength(4);
    expect(pickPages(many, BASE, 2)).toHaveLength(2);
  });

  it('matches on anchor text as well as href', () => {
    expect(pickPages('<a href="/p/12">Our Hours</a>', BASE)).toEqual([
      'https://near-dental.example/p/12',
    ]);
  });

  it('ignores off-site links', () => {
    const html =
      '<a href="https://other.example/hours">Hours</a><a href="http://near-dental.example/contact">Contact</a>';
    expect(pickPages(html, BASE)).toEqual([]);
  });

  it('dedupes trailing-slash variants', () => {
    const html = '<a href="/hours">Hours</a><a href="/hours/">Hours</a><a href="/hours#top">Hours</a>';
    expect(pickPages(html, BASE)).toEqual(['https://near-dental.example/hours']);
  });
});

describe('fetchWebsiteText', () => {
  const fetch = fakeSiteFetch(ROOT);

  it('returns homepage plus picked pages', async () => {
    const pages = await fetchWebsiteText('https://near-dental.example/', { fetch, lookup: publicLookup });
    expect(pages.map((p) => p.url)).toEqual([
      'https://near-dental.example/',
      'https://near-dental.example/hours',
      'https://near-dental.example/contact',
      'https://near-dental.example/insurance',
      'https://near-dental.example/patients/new',
    ]);
    const all = pages.map((p) => p.text).join('\n');
    expect(all).toContain('Near Dental Group');
    expect(all).toContain('8am');
    expect(all).toContain('Delta Dental');
    expect(all).not.toContain('do-not-extract');
  });

  it('skips a failing subpage', async () => {
    const pages = await fetchWebsiteText('https://near-dental.example/', {
      fetch: fakeSiteFetch(ROOT, { fail: ['https://near-dental.example/contact'] }),
      lookup: publicLookup,
      log: { info() {}, warn() {}, error() {} },
    });
    const urls = pages.map((p) => p.url);
    expect(urls).not.toContain('https://near-dental.example/contact');
    expect(urls).toContain('https://near-dental.example/hours');
    expect(urls).toContain('https://near-dental.example/insurance');
  });

  it('skips non-HTML pages', async () => {
    const pages = await fetchWebsiteText('https://near-dental.example/', {
      fetch: fakeSiteFetch(ROOT, { nonHtml: ['https://near-dental.example/insurance'] }),
      lookup: publicLookup,
    });
    const urls = pages.map((p) => p.url);
    expect(urls).not.toContain('https://near-dental.example/insurance');
    expect(urls).toHaveLength(4);
  });

  it('homepage failure is logged', async () => {
    const warn = vi.fn();
    const failing = fakeSiteFetch(ROOT, { fail: ['https://near-dental.example/'] });
    await fetchWebsiteText('https://near-dental.example/', { fetch: failing, lookup: publicLookup, log: { info() {}, warn, error() {} } });
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = vi.fn();
    await fetchWebsiteText('https://nowhere.example/', { fetch, lookup: publicLookup, log: { info() {}, warn: logged, error() {} } });
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it('returns [] when the homepage fails', async () => {
    const failing = fakeSiteFetch(ROOT, { fail: ['https://near-dental.example/'] });
    expect(await fetchWebsiteText('https://near-dental.example/', { fetch: failing, lookup: publicLookup })).toEqual([]);
    const missing = await fetchWebsiteText('https://nowhere.example/', { fetch, lookup: publicLookup });
    expect(missing).toEqual([]);
  });

  it('caps text length', async () => {
    const pages = await fetchWebsiteText('https://near-dental.example/', { fetch, maxChars: 50, lookup: publicLookup });
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) expect(p.text.length).toBeLessThanOrEqual(50);
  });

  it('missing content-type is skipped', async () => {
    const noType = (async () => new Response(new Uint8Array([60, 112, 62]), { status: 200 })) as typeof fetch;
    expect(await fetchWebsiteText('https://near-dental.example/', { fetch: noType, lookup: publicLookup })).toEqual([]);
  });

  it('oversized body is cut off', async () => {
    const big = '<p>x</p>'.repeat(375_000);
    const bigFetch = (async () =>
      new Response(big, { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
    const pages = await fetchWebsiteText('https://near-dental.example/', { fetch: bigFetch, lookup: publicLookup });
    expect(pages).toHaveLength(1);
    expect(pages[0]?.text.length).toBeGreaterThan(0);
  });

  it('redirect to a private address is blocked', async () => {
    const warn = vi.fn();
    const redirect = (async () =>
      new Response(null, { status: 302, headers: { location: 'http://192.168.1.1/' } })) as typeof fetch;
    const pages = await fetchWebsiteText('https://near-dental.example/', {
      fetch: redirect,
      lookup: publicLookup,
      log: { info() {}, warn, error() {} },
    });
    expect(pages).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('blocked unsafe target'));
  });

  it('redirect to a public address is followed once', async () => {
    const inner = fakeSiteFetch(ROOT);
    const calls: string[] = [];
    const redirecting = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input);
      calls.push(u);
      if (u === 'https://www.near-dental.example/') {
        return new Response(null, { status: 302, headers: { location: 'https://near-dental.example/' } });
      }
      return inner(input, init);
    }) as typeof fetch;
    const pages = await fetchWebsiteText('https://www.near-dental.example/', {
      fetch: redirecting,
      lookup: publicLookup,
    });
    expect(calls.slice(0, 2)).toEqual(['https://www.near-dental.example/', 'https://near-dental.example/']);
    expect(pages[0]?.text).toContain('Near Dental Group');
  });
});

describe('isSafeTarget', () => {
  it('blocks loopback, private and link-local targets', async () => {
    const answer = (address: string) => async () => [{ address, family: address.includes(':') ? 6 : 4 }];
    const check = (address: string) => isSafeTarget(new URL('https://site.example/'), answer(address));
    const bad = [
      '127.0.0.1', '10.0.0.5', '169.254.1.1', '::1', 'fe80::1', '172.16.0.1',
      'fd00::1', '224.0.0.1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:a00:1', '0.0.0.0', '::',
    ];
    for (const address of bad) {
      expect(await check(address), address).toBe(false);
    }
    expect(await check('93.184.216.34')).toBe(true);
    const never = async (): Promise<never> => {
      throw new Error('DNS must not be called');
    };
    expect(await isSafeTarget(new URL('http://192.168.1.1/'), never)).toBe(false);
    expect(await isSafeTarget(new URL('http://localhost/'), never)).toBe(false);
    expect(await isSafeTarget(new URL('http://printer.local/'), never)).toBe(false);
    expect(await isSafeTarget(new URL('ftp://site.example/'), never)).toBe(false);
    expect(await isSafeTarget(new URL('https://site.example/'), never)).toBe(false);
  });
});
