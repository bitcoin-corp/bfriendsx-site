// The self-hosted Supabase on Hetzner, over its REST API (same settings as path401.com).
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY. Server-side only; the table is closed to anon.
export const db = () => {
  // values copied with `vercel env pull` can carry a literal "\n" on the end; drop it and any whitespace
  const clean = (v) => String(v || '').trim().replace(/(\\n)+$/, '').trim();
  const url = clean(process.env.SUPABASE_URL), key = clean(process.env.SUPABASE_SERVICE_KEY);
  if (!url || !key) return null;
  return (path, init = {}) => fetch(`${url.replace(/\/$/, '')}/rest/v1/${path}`, {
    ...init, headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...init.headers },
  });
};
