import type { Hono } from 'hono';

export async function adminLogin(app: Hono, password: string): Promise<string> {
  const res = await app.request('/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password, next: '/admin' }).toString(),
  });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}
