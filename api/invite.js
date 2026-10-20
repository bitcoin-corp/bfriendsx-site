// Invite links for friends imported from another network.
//   POST /api/invite { friends: [{ name, network }] }  (signed in)  -> { links: [{ name, network, url }] }
//   GET  /api/invite?t=<token>                                      -> { from, name, network, at }
// No database: each link carries its invite sealed (AES-256-GCM) so it can't be read or forged. Only a name and
// a network go in. Emails and other contact details stay in the inviter's browser and are never sent here.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readCookie, verifySession } from '@bwalletx/connect/server';
import { ORIGIN, body, originOk, secret } from './bwalletx/_auth.js';

const NETWORKS = new Set(['x', 'facebook', 'instagram', 'linkedin', 'tiktok', 'youtube', 'telegram']);
const MAX = 500;
const key = (s) => createHash('sha256').update('bfriendsx invite\n' + s).digest();
export const seal = (s, d) => {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key(s), iv);
  const b = Buffer.concat([c.update(JSON.stringify(d), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), b]).toString('base64url');
};
export const open = (s, t) => {
  try {
    const b = Buffer.from(String(t), 'base64url');
    const d = createDecipheriv('aes-256-gcm', key(s), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
  } catch { return null; }
};
const clean = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const s = secret();
  if (!s) return res.status(503).json({ error: 'bWalletX connect is not switched on yet.' });

  if (req.method === 'GET') {
    const d = open(s, req.query?.t ?? new URL(req.url, ORIGIN).searchParams.get('t'));
    if (!d) return res.status(404).json({ error: 'That invite link is broken or was cut short.' });
    return res.status(200).json({ from: d.f, name: d.n, network: d.w, at: d.t });
  }
  if (req.method !== 'POST') return res.status(405).end();
  if (!originOk(req.headers.origin)) return res.status(403).json({ error: 'Wrong origin.' });
  const me = await verifySession(readCookie(req.headers.cookie, 'bwx_session'), { secret: s });
  if (!me?.sub) return res.status(401).json({ error: 'Connect bWalletX first, so your friends know the invite is from you.' });
  const list = (await body(req)).friends;
  if (!Array.isArray(list) || !list.length) return res.status(400).json({ error: 'No friends picked.' });
  if (list.length > MAX) return res.status(400).json({ error: `Up to ${MAX} invites at a time.` });
  const t = Date.now();
  const links = list.flatMap((f) => {
    const name = clean(f?.name), network = clean(f?.network).toLowerCase();
    if (!name || !NETWORKS.has(network)) return [];
    return [{ name, network, url: `${ORIGIN}/i/${seal(s, { f: me.sub, n: name, w: network, t })}` }];
  });
  return res.status(200).json({ links });
}
