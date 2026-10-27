import fs from 'node:fs';
import path from 'node:path';

export function fakeSiteFetch(
  root: string,
  opts: { fail?: string[]; nonHtml?: string[] } = {},
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (opts.fail?.includes(url)) throw new TypeError('fetch failed');
    if (opts.nonHtml?.includes(url)) {
      return new Response('%PDF-1.4', { status: 200, headers: { 'content-type': 'application/pdf' } });
    }
    const { hostname, pathname } = new URL(url);
    const file = path.join(root, hostname, `${pathname === '/' ? '/index' : pathname}.html`);
    if (!fs.existsSync(file)) return new Response('not found', { status: 404 });
    return new Response(fs.readFileSync(file, 'utf8'), {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  }) as typeof fetch;
}
