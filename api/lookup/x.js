// POST /api/lookup/x { p: ["abc", ...] }  ->  { rows: [{ accountId, handle, identityKey }] }
// For the bWalletX messenger (and any family app): which X accounts are on b, without telling us who you follow.
// The client sends only 3-hex-char prefixes of SHA-256(X account id) (4096 buckets, <= 200 per call) and gets
// back every linked account in those buckets; it matches its own follow list locally. No auth, no cookies,
// no body logging. Only people who linked their X at bmintx.com/link/x (opt-in) are in the directory.
import { createHash } from 'node:crypto';
import { db } from '../_db.js';

const MAX = 200, PER_MIN = 30, TTL = 60_000;
let cache = null, cachedAt = 0;          // the whole directory, bucketed: prefix -> rows (small table; refreshed each minute)
const hits = new Map();                  // ip -> [count, windowStart]  (per instance; a speed bump, not a wall)

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
async function directory(q) {
  if (cache && Date.now() - cachedAt < TTL) return cache;
  const r = await q('bx_handles?network=eq.x&select=account_id,handle,identity_key&limit=100000');
  if (!r.ok) throw new Error('db');
  const m = new Map();
  for (const h of await r.json()) {
    const k = sha(h.account_id).slice(0, 3);
    m.set(k, [...(m.get(k) ?? []), { accountId: h.account_id, handle: h.handle, identityKey: h.identity_key }]);
  }
  cache = m; cachedAt = Date.now();
  return m;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now(), h = hits.get(ip);
  if (!h || now - h[1] > 60_000) hits.set(ip, [1, now]);
  else if (++h[0] > PER_MIN) return res.status(429).json({ error: 'Slow down.' });
  const q = db();
  if (!q) return res.status(503).json({ error: 'Not switched on yet.' });
  let p = req.body;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = {}; } }
  const pre = [...new Set((p?.p ?? []).map((x) => String(x).toLowerCase()))].filter((x) => /^[0-9a-f]{3}$/.test(x));
  if (!pre.length || pre.length > MAX) return res.status(400).json({ error: `Send 1 to ${MAX} three-character hex prefixes as { p: [...] }.` });
  try {
    const d = await directory(q);
    return res.status(200).json({ rows: pre.flatMap((k) => d.get(k) ?? []) });
  } catch { return res.status(502).json({ error: 'Lookup failed.' }); }
}
