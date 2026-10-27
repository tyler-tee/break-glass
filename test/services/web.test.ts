import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fetchWebsiteText, htmlToText, pickPages } from '../../src/services/llm/web.js';
import { fakeSiteFetch } from '../helpers/fakeSiteFetch.js';

const ROOT = path.resolve(import.meta.dirname, '../fixtures/web');
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
    const pages = await fetchWebsiteText('https://near-dental.example/', { fetch });
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
    });
    const urls = pages.map((p) => p.url);
    expect(urls).not.toContain('https://near-dental.example/insurance');
    expect(urls).toHaveLength(4);
  });

  it('homepage failure is logged', async () => {
    const warn = vi.fn();
    const failing = fakeSiteFetch(ROOT, { fail: ['https://near-dental.example/'] });
    await fetchWebsiteText('https://near-dental.example/', { fetch: failing, log: { info() {}, warn, error() {} } });
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = vi.fn();
    await fetchWebsiteText('https://nowhere.example/', { fetch, log: { info() {}, warn: logged, error() {} } });
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it('returns [] when the homepage fails', async () => {
    const failing = fakeSiteFetch(ROOT, { fail: ['https://near-dental.example/'] });
    expect(await fetchWebsiteText('https://near-dental.example/', { fetch: failing })).toEqual([]);
    const missing = await fetchWebsiteText('https://nowhere.example/', { fetch });
    expect(missing).toEqual([]);
  });

  it('caps text length', async () => {
    const pages = await fetchWebsiteText('https://near-dental.example/', { fetch, maxChars: 50 });
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) expect(p.text.length).toBeLessThanOrEqual(50);
  });
});
