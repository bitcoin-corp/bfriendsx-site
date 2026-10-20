// The self-hosted Supabase on Hetzner, over its REST API (same settings as path401.com).
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY. Server-side only; the table is closed to anon.
export const db = () => {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return (path, init = {}) => fetch(`${url.replace(/\/$/, '')}/rest/v1/${path}`, {
    ...init, headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...init.headers },
  });
};
