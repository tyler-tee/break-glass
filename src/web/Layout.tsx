import type { Context } from 'hono';
import { html } from 'hono/html';
import type { Child, FC, PropsWithChildren } from 'hono/jsx';
import { assetUrl } from './assets.js';

export type LayoutKind = 'family' | 'admin' | 'auth';

export type AdminNavKey =
  | 'overview'
  | 'setup'
  | 'settings'
  | 'categories'
  | 'places'
  | 'review'
  | 'warnings'
  | 'protocols';

export type PageChrome = {
  layout?: LayoutKind;
  /** Overrides the household name from settings (rarely needed; the request context supplies it). */
  household?: string;
  emergencyNumber?: string;
  /** Admin layout only: which primary nav item is current. */
  activeNav?: AdminNavKey;
  /** Family layout only: class on <main> (the home screen uses wider gaps). */
  mainClass?: string;
};

/**
 * Per-request values the layouts need that page() cannot get from its arguments. createApp installs a
 * middleware that sets a lazy getter under this key, so the settings/install-state lookups only run
 * for pages that actually render a layout. Call sites stay `page(c, title, body, status?, chrome?)`.
 */
export type LayoutContext = { household?: string; setupIncomplete?: boolean };
declare module 'hono' {
  interface ContextVariableMap {
    layoutContext: () => LayoutContext;
  }
}

const DEFAULT_HOUSEHOLD = 'Our household';

const NAV: { key: AdminNavKey; href: string; label: string }[] = [
  { key: 'overview', href: '/admin', label: 'Overview' },
  { key: 'setup', href: '/admin/setup', label: 'Setup' },
  { key: 'settings', href: '/admin/settings', label: 'Settings' },
  { key: 'categories', href: '/admin/categories', label: 'Categories' },
  { key: 'places', href: '/admin/locations', label: 'Places' },
  { key: 'review', href: '/admin/candidates', label: 'Review queue' },
  { key: 'warnings', href: '/admin/warn', label: 'Warnings' },
  { key: 'protocols', href: '/admin/protocols', label: 'Protocols' },
];

const Head: FC<{ title: string; family?: boolean }> = ({ title, family }) => (
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content={family ? '#f6f5f1' : '#0f5f6e'} />
    <title>{title}</title>
    {family ? (
      <>
        <link rel="preload" href={assetUrl('public-sans-latin.woff2')} as="font" type="font/woff2" crossorigin="anonymous" />
        <link rel="stylesheet" href={assetUrl('family.css')} />
      </>
    ) : (
      <link rel="stylesheet" href={assetUrl('styles.css')} />
    )}
    <link rel="icon" href={assetUrl('favicon.svg')} type="image/svg+xml" />
    <link rel="manifest" href={assetUrl('manifest.webmanifest')} />
  </head>
);

const SkipLink: FC = () => (
  <a class="skip-link" href="#main">
    Skip to content
  </a>
);

const AdminNavList: FC<{ activeNav?: AdminNavKey; setupIncomplete: boolean }> = ({ activeNav, setupIncomplete }) => (
  <ul>
    {NAV.filter((n) => n.key !== 'setup' || setupIncomplete || activeNav === 'setup').map((n) => (
      <li>
        <a href={n.href} aria-current={n.key === activeNav ? 'page' : undefined}>
          {n.label}
        </a>
      </li>
    ))}
  </ul>
);

// No site header: every family screen carries its own back button, per the approved mockup.
export const FamilyLayout: FC<PropsWithChildren<{ title: string; mainClass?: string }>> = ({
  title,
  mainClass,
  children,
}) => (
  <html lang="en">
    <Head title={title} family />
    <body class="family">
      <SkipLink />
      <main id="main" class={mainClass}>
        {children}
      </main>
    </body>
  </html>
);

export const AuthLayout: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="en">
    <Head title={title} />
    <body class="auth">
      <SkipLink />
      <header class="site-header">
        <span class="site-name">Break Glass</span>
      </header>
      <main id="main">{children}</main>
    </body>
  </html>
);

export const AdminLayout: FC<
  PropsWithChildren<{ title: string; activeNav?: AdminNavKey; setupIncomplete: boolean }>
> = ({ title, activeNav, setupIncomplete, children }) => (
  <html lang="en">
    <Head title={title} />
    <body class="admin">
      <SkipLink />
      <header class="admin-bar">
        <span class="site-name">Break Glass admin</span>
        <div class="admin-bar-actions">
          <a href="/">View family site</a>
          <form method="post" action="/admin/logout">
            <button type="submit">Log out</button>
          </form>
        </div>
      </header>
      <div class="admin-shell">
        <nav class="admin-nav" aria-label="Admin">
          <details class="admin-menu">
            <summary>Menu</summary>
            <AdminNavList activeNav={activeNav} setupIncomplete={setupIncomplete} />
          </details>
          <div class="admin-sidebar">
            <AdminNavList activeNav={activeNav} setupIncomplete={setupIncomplete} />
          </div>
        </nav>
        <main id="main" class="wide">
          {children}
        </main>
      </div>
      <script src={assetUrl('admin.js')} defer></script>
    </body>
  </html>
);

export function readLayoutContext(c: Context): LayoutContext {
  try {
    return c.get('layoutContext')?.() ?? {};
  } catch (err) {
    console.error('layout context lookup failed', err);
    return {};
  }
}

export function householdName(c: Context): string {
  return readLayoutContext(c).household ?? DEFAULT_HOUSEHOLD;
}

export function page(
  c: Context,
  title: string,
  body: Child,
  status: 200 | 400 | 401 | 404 | 409 | 429 | 500 | 502 | 503 = 200,
  chrome: PageChrome = {},
) {
  const layout = chrome.layout ?? 'family';
  const ctx = readLayoutContext(c);
  c.status(status);
  const doc =
    layout === 'admin' ? (
      <AdminLayout title={title} activeNav={chrome.activeNav} setupIncomplete={ctx.setupIncomplete === true}>
        {body}
      </AdminLayout>
    ) : layout === 'auth' ? (
      <AuthLayout title={title}>{body}</AuthLayout>
    ) : (
      <FamilyLayout title={title} mainClass={chrome.mainClass}>
        {body}
      </FamilyLayout>
    );
  return c.html(html`<!DOCTYPE html>${doc}`);
}
