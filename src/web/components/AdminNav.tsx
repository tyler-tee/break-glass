import type { FC } from 'hono/jsx';

const links: [string, string][] = [
  ['/admin/settings', 'Settings'],
  ['/admin/categories', 'Categories'],
  ['/admin/locations', 'Locations'],
  ['/admin/candidates', 'Candidates'],
  ['/admin/warn', 'Warnings'],
  ['/admin/protocols', 'Protocols'],
];

export const AdminNav: FC = () => (
  <nav class="admin-nav" aria-label="Admin">
    <ul>
      {links.map(([href, label]) => (
        <li>
          <a href={href}>{label}</a>
        </li>
      ))}
    </ul>
    <form method="post" action="/admin/logout">
      <button type="submit">Log out</button>
    </form>
  </nav>
);
