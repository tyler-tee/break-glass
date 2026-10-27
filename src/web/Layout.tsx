import type { Context } from 'hono';
import { html } from 'hono/html';
import type { Child, FC, PropsWithChildren } from 'hono/jsx';

const css = `
*{box-sizing:border-box}
body{margin:0;padding:0 16px 32px;font:18px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#111;background:#fff}
main{max-width:720px;margin:0 auto}
a{color:#0b3d91}
a,button,input{min-height:44px}
h1{font-size:1.5rem;margin:16px 0}
h2{font-size:1.25rem;margin:24px 0 8px}
h3{font-size:1.1rem;margin:0 0 4px}
h3 a{display:inline-block;padding:10px 0}
.nav a{display:inline-block;padding:10px 0;font-weight:600}
.search{display:flex;gap:8px;margin:16px 0}
.search input{flex:1;font-size:1.25rem;padding:12px;border:2px solid #111;border-radius:8px;min-height:56px}
.search button{font-size:1.1rem;padding:0 20px;border:0;border-radius:8px;background:#0b3d91;color:#fff;min-height:56px}
.emergency{display:block;padding:14px 16px;margin:16px 0;background:#b00020;color:#fff;font-weight:700;text-align:center;text-decoration:none;border-radius:8px}
.row{display:flex;align-items:center;width:100%;padding:10px 12px;margin:8px 0;border:1px solid #888;border-radius:8px;text-decoration:none}
.card{border:1px solid #888;border-radius:8px;padding:12px;margin:12px 0}
.card p{margin:4px 0}
.muted{color:#444}
.hours{margin:4px 0;padding-left:20px}
.call{display:flex;align-items:center;justify-content:center;width:100%;padding:12px;margin:8px 0;background:#1b7f3b;color:#fff;font-weight:700;text-decoration:none;border-radius:8px}
.badge{display:inline-block;padding:6px 10px;border-radius:6px;font-weight:700}
.badge-warn{background:#ffd800;color:#111}
.badge-closed{background:#b00020;color:#fff}
.admin-nav ul{list-style:none;margin:0;padding:0}
.admin-nav li a{display:inline-block;padding:10px 0}
.admin-nav button{padding:0 20px}
`;

export const Layout: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <style dangerouslySetInnerHTML={{ __html: css }} />
    </head>
    <body>
      <main>
        <nav class="nav">
          <a href="/">Home</a>
        </nav>
        {children}
      </main>
    </body>
  </html>
);

export function page(c: Context, title: string, body: Child, status: 200 | 400 | 401 | 404 = 200) {
  c.status(status);
  return c.html(html`<!DOCTYPE html>${(<Layout title={title}>{body}</Layout>)}`);
}
