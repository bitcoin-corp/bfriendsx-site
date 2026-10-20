// POST /api/onb { x: ["<X account id>", ...] }  (signed in) -> { x: { "<id>": { handle, identityKey } } }
// Which of your imported friends are already on b: people who linked that X account to their bWalletX
// (bmintx.com/link/x). Only linked accounts come back; ids that aren't on b are simply absent.
import { readCookie, verifySession } from '@bwalletx/connect/server';
import { body, originOk, secret } from './bwalletx/_auth.js';
import { db } from './_db.js';

const MAX = 5000, CHUNK = 200;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();
  if (!originOk(req.headers.origin)) return res.status(403).json({ error: 'Wrong origin.' });
  const s = secret(), q = db();
  if (!s || !q) return res.status(503).json({ error: 'Not switched on yet.' });
  if (!(await verifySession(readCookie(req.headers.cookie, 'bwx_session'), { secret: s }))?.sub) return res.status(401).json({ error: 'Connect bWalletX first.' });
  const ids = [...new Set(((await body(req)).x ?? []).map(String).filter((i) => /^\d{1,25}$/.test(i)))];
  if (ids.length > MAX) return res.status(400).json({ error: `Up to ${MAX} at a time.` });
  const x = {};
  for (let i = 0; i < ids.length; i += CHUNK) {
    const r = await q(`bx_handles?network=eq.x&account_id=in.(${ids.slice(i, i + CHUNK).join(',')})&select=account_id,handle,identity_key`);
    if (!r.ok) return res.status(502).json({ error: 'Lookup failed.' });
    for (const h of await r.json()) x[h.account_id] = { handle: h.handle, identityKey: h.identity_key };
  }
  return res.status(200).json({ x });
}
