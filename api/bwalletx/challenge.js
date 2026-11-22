// POST /api/bwalletx/challenge {} -> { nonce, message, expiresAt, ... } + the __Host-bwx_t_<nonce> ticket cookie
import { createChallenge, originAllowed } from '@bwalletx/connect/server';
import { ORIGIN, body, originOk, seal, secret, ticketCookie } from './_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!originOk(req.headers.origin)) return res.status(403).json({ error: 'Wrong origin.' });
  const s = secret();
  if (!s) return res.status(503).json({ error: 'bWalletX connect is not switched on yet.' });
  let pending = null;
  const store = { put: (nonce, c) => { pending = { nonce, c }; }, take: () => null };
  try {
    const ch = await createChallenge({ origin: ORIGIN, identityKey: (await body(req)).identityKey, store });
    res.setHeader('Cache-Control', 'no-store');
    // The sealed ticket goes in a one-time HttpOnly cookie only (see _auth.js), never to the page.
    res.setHeader('Set-Cookie', ticketCookie(ch.nonce, seal(s, pending)));
    return res.status(200).json(ch);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
}
