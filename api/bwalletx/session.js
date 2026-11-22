// GET /api/bwalletx/session -> { identityKey } | { identityKey: null }   POST -> sign out
import { serializeCookie } from '@bwalletx/connect/server';
import { ORIGIN, OLD_SESSION, clearSessions, originOk, readSession, secret, sessionCookie } from './_auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const s = secret();
  if (req.method === 'POST') {
    if (!originOk(req.headers.origin)) return res.status(403).json({ error: 'Wrong origin.' });
    res.setHeader('Set-Cookie', clearSessions());
    return res.status(200).json({ identityKey: null });
  }
  if (!s) return res.status(200).json({ identityKey: null, off: true });
  const p = await readSession(req, s);
  if (p?.legacy) {
    // Signed in under the old cookie name: move the same token to the __Host- cookie for the time it has left.
    res.setHeader('Set-Cookie', [sessionCookie(p.legacy, Math.max(0, p.exp - Math.floor(Date.now() / 1000))), serializeCookie('', { name: OLD_SESSION, maxAge: 0, secure: ORIGIN.startsWith('https'), sameSite: 'Lax', path: '/' })]);
  }
  return res.status(200).json({ identityKey: p?.sub ?? null });
}
