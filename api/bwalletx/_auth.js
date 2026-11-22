// Connect bWalletX on bfriendsx.com (@bwalletx/connect, BRC-100). bfriendsx has no database, so instead of a
// nonce table the pending challenge is sealed (AES-256-GCM) into a `ticket` the browser carries back to
// /verify. It can't be read or forged; the nonce is still single-origin, single-key and expires in 2 min.
// Env: BWALLETX_SESSION_SECRET (32+ chars) signs the session cookie and keys the ticket.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readCookie, serializeCookie, verifySession } from '@bwalletx/connect/server';

export const ORIGIN = process.env.SITE_ORIGIN || 'https://bfriendsx.com';
/** The apex and its www twin both serve the site; the signed message always names the apex. */
export const originOk = (o) => { try { const h = new URL(String(o)).host; const a = new URL(ORIGIN).host; return h === a || h === 'www.' + a; } catch { return false; } };
export const secret = () => {
  const s = process.env.BWALLETX_SESSION_SECRET || '';
  return s.length >= 32 ? s : null;
};
const key = (s) => createHash('sha256').update('bfriendsx bwalletx ticket\n' + s).digest();

export function seal(s, data) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key(s), iv);
  const body = Buffer.concat([c.update(JSON.stringify(data), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}
export function open(s, ticket) {
  try {
    const b = Buffer.from(String(ticket), 'base64url');
    const d = createDecipheriv('aes-256-gcm', key(s), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
  } catch { return null; }
}

export async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

const secure = () => ORIGIN.startsWith('https');
const cookie = (name, value, maxAge) => serializeCookie(value, { name, maxAge, secure: secure(), sameSite: 'Lax', path: '/' });

// Session cookie. __Host-: Secure, Path=/, no Domain, so no subdomain or plain-http page can set or shadow it.
export const SESSION = '__Host-bwx_session';
/** The name before 22 Nov 2026: read once by GET /api/bwalletx/session, then moved to SESSION. */
export const OLD_SESSION = 'bwx_session';
export const sessionCookie = (token, maxAge) => cookie(SESSION, token, maxAge);
export const clearSessions = () => [cookie(SESSION, '', 0), cookie(OLD_SESSION, '', 0)];
/** The session from SESSION, else from the old name (`legacy` then holds its token, to move it). */
export async function readSession(req, s) {
  const p = await verifySession(readCookie(req.headers.cookie, SESSION), { secret: s });
  if (p) return p;
  const token = readCookie(req.headers.cookie, OLD_SESSION);
  const old = await verifySession(token, { secret: s });
  return old ? Object.assign(old, { legacy: token }) : null;
}

// The challenge's sealed ticket rides in a one-time HttpOnly cookie, __Host-bwx_t_<nonce> (10 min), never in the
// page: /verify needs it and clears it on every attempt, so one verify body can't be posted again to mint sessions.
const ticketName = (nonce) => (typeof nonce === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(nonce) ? `__Host-bwx_t_${nonce}` : null);
export const ticketCookie = (nonce, ticket) => cookie(ticketName(nonce), ticket, 600);
export const readTicket = (req, nonce) => (ticketName(nonce) ? readCookie(req.headers.cookie, ticketName(nonce)) : null);
export const clearTicket = (nonce) => (ticketName(nonce) ? [cookie(ticketName(nonce), '', 0)] : []);
