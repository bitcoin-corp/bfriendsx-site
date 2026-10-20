// POST /api/claims { t }  (signed in as the invited friend) -> { claimed: true }   records that the invite was accepted
// GET  /api/claims        (signed in)                       -> { claims: [{ name, network, invitee, claimedAt }] }
import { readCookie, verifySession } from '@bwalletx/connect/server';
import { body, originOk, secret } from './bwalletx/_auth.js';
import { open } from './invite.js';
import { db } from './_db.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const s = secret(), q = db();
  if (!s || !q) return res.status(503).json({ error: 'Claims are not switched on yet.' });
  const me = (await verifySession(readCookie(req.headers.cookie, 'bwx_session'), { secret: s }))?.sub;
  if (!me) return res.status(401).json({ error: 'Connect bWalletX first.' });

  if (req.method === 'GET') {
    const r = await q(`bfriendsx_claims?inviter_key=eq.${me}&select=name,network,invitee_key,claimed_at&order=claimed_at.desc&limit=5000`);
    if (!r.ok) return res.status(502).json({ error: 'Could not load your friends.' });
    return res.status(200).json({ claims: (await r.json()).map((c) => ({ name: c.name, network: c.network, invitee: c.invitee_key, claimedAt: c.claimed_at })) });
  }
  if (req.method !== 'POST') return res.status(405).end();
  if (!originOk(req.headers.origin)) return res.status(403).json({ error: 'Wrong origin.' });
  const d = open(s, (await body(req)).t);
  if (!d) return res.status(404).json({ error: 'That invite link is broken.' });
  if (d.f === me) return res.status(200).json({ claimed: false, own: true });
  const r = await q('bfriendsx_claims?on_conflict=inviter_key,invitee_key,network', {
    method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({ inviter_key: d.f, invitee_key: me, network: d.w, name: d.n || 'Your FLICK ON link', invited_at: new Date(d.t).toISOString() }),
  });
  if (!r.ok) return res.status(502).json({ error: 'Could not record that. Try again.' });
  return res.status(200).json({ claimed: true });
}
