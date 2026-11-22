// POST /api/bwalletx/verify { identityKey, nonce, signature } + the challenge's ticket cookie -> session cookie + { identityKey }
import { serializeCookie, signSession, verifySignIn } from '@bwalletx/connect/server';
import { ORIGIN, OLD_SESSION, body, clearTicket, open, originOk, readTicket, secret, sessionCookie } from './_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!originOk(req.headers.origin)) return res.status(403).json({ error: 'Wrong origin.' });
  const s = secret();
  if (!s) return res.status(503).json({ error: 'bWalletX connect is not switched on yet.' });
  const b = await body(req);
  // One use: the ticket cookie is cleared whatever happens next.
  res.setHeader('Set-Cookie', clearTicket(b.nonce));
  const t = open(s, readTicket(req, b.nonce));
  // the "store" holds exactly the one challenge this ticket sealed, for exactly its nonce
  const store = { put: () => {}, take: (nonce) => (t && t.nonce === nonce ? t.c : null) };
  const identityKey = await verifySignIn({ origin: ORIGIN, store, identityKey: b.identityKey, nonce: b.nonce, signature: b.signature });
  if (!identityKey) return res.status(401).json({ error: 'That signature was not accepted. Start again.' });
  const token = await signSession({ sub: identityKey }, { secret: s });
  res.setHeader('Set-Cookie', [...clearTicket(b.nonce), sessionCookie(token, 7 * 86400), serializeCookie('', { name: OLD_SESSION, maxAge: 0, secure: ORIGIN.startsWith('https'), sameSite: 'Lax', path: '/' })]);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ identityKey });
}
