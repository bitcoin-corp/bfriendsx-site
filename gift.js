// FLICK ON gift pots: a little BSV left in an invite link for the friend to claim when they join.
// The pot is a one-off key made in the sender's browser. The sender's bWalletX pays into it; the key rides in the
// link's #fragment (browsers never send that to any server, ours included). Whoever opens the link and connects
// bWalletX claims it: this page spends the pot to a BRC-29 "wallet payment" address for their identity key,
// broadcasts, then hands it to their wallet with internalizeAction. A link is a BEARER secret, like cash.
//
// Safety (CEO ruling, 2 Nov 2026):
//  - CAP: no pot may hold more than CAP_USD at the WhatsOnChain BSV/USD rate. makeGift() is the only way a pot is
//    made, and it refuses (before the wallet is asked) if the rate is unknown or the amount is over the cap.
//  - EXPIRY + REFUND, no server: while the pot key is still in this browser, makeGift() signs a refund transaction
//    that spends the pot back to the sender's own wallet with nLockTime = expiry. (On BSV, OP_CHECKLOCKTIMEVERIFY is
//    a NOP since Genesis, so the lock is the transaction's nLockTime, not a script.) The refund holds no secret: it can
//    only pay the sender. It is kept in the sender's browser and as a file they can save; after expiry the sender
//    broadcasts it from any browser with reclaim(). Our server never sees the pot key, the refund or the money.
//  - Never log the pot key. Nothing here writes to the console.
import { PrivateKey, PublicKey, P2PKH, Transaction, SatoshisPerKilobyte, Random, Utils } from 'https://cdn.jsdelivr.net/npm/@bsv/sdk@2.8.10/+esm';

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const BRC29 = '3241645161d8';
const FEE = 100;                       // sat/kB, the house rate (same as claims)
export const CAP_USD = 20;             // the most any one pot may hold
export const EXPIRY_DAYS = [1, 7, 30]; // offered on /flick-on
export const WARNING = 'Anyone with this link can claim it.';

/** The connected BRC-100 wallet: kept by bwx.js at sign-in, else reconnect (extension or stored pairing). */
export async function wallet() {
  if (window.bfxWallet) return window.bfxWallet;
  const { wallet } = await window.bWalletXConnect.connectBwalletX({ reusePairing: true });
  window.bfxWallet = wallet;
  return wallet;
}

export const fmtSats = (s) => (s >= 1e6 ? `${(s / 1e8).toFixed(s % 1e6 ? 4 : 2).replace(/0+$/, '').replace(/\.$/, '')} BSV` : `${s.toLocaleString()} sats`);
export const fmtUsd = (usd) => '$' + (usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2));
export const fmtDate = (sec) => new Date(sec * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// ── the cap ──────────────────────────────────────────────────────────────────────────────────────────────────────
// BSV/USD from WhatsOnChain, the same source bMintX and bWalletX use. Cached for 5 minutes.
let rateAt = 0, rateVal = 0;
export async function bsvUsd() {
  if (rateVal && Date.now() - rateAt < 300e3) return rateVal;
  const r = await fetch(`${WOC}/exchangerate`).catch(() => null);
  const j = r && r.ok ? await r.json().catch(() => null) : null;
  const v = Number(j && j.rate);
  if (!(v > 0 && Number.isFinite(v))) throw new Error('Could not get the BSV price, so no gift was made. Try again in a minute.');
  rateVal = v; rateAt = Date.now();
  return v;
}
/** The most satoshis a pot may hold at this rate. */
export const capSats = (rate) => Math.floor((CAP_USD / rate) * 1e8);
export const usdOf = (sats, rate) => (sats / 1e8) * rate;

// ── making a pot ─────────────────────────────────────────────────────────────────────────────────────────────────
const lockOf = (key) => new P2PKH().lock(key.toAddress());
/** A BRC-29 "wallet payment" output for `identityKey`, paid from `fromKey` (the pot). */
function paymentTo(identityKey, fromKey) {
  const derivationPrefix = Utils.toBase64(Random(10)), derivationSuffix = Utils.toBase64(Random(10));
  const child = PublicKey.fromString(identityKey).deriveChild(fromKey, `2-${BRC29}-${derivationPrefix} ${derivationSuffix}`);
  return { lockingScript: new P2PKH().lock(child.toAddress()), derivationPrefix, derivationSuffix };
}

/** Which output of the funding tx is the pot: from the wallet's own AtomicBEEF, else from WhatsOnChain. */
async function potVout(r, lockHex) {
  let tx = null;
  try { if (r.tx) tx = Transaction.fromAtomicBEEF(r.tx); } catch {}
  if (!tx || tx.id('hex') !== r.txid) tx = Transaction.fromHex(await get(`${WOC}/tx/${r.txid}/hex`));
  const i = tx.outputs.findIndex((o) => o.lockingScript.toHex() === lockHex);
  if (i < 0) throw new Error('pot output not found');
  return i;
}

/** Sign the refund: pot → sender's wallet, valid only once the chain passes `expiry` (unix seconds). */
async function signRefund(key, txid, vout, sats, lockingScript, senderKey, expiry) {
  const pay = paymentTo(senderKey, key);
  const tx = new Transaction(1, [], [], expiry);
  // nSequence below 0xffffffff, or nLockTime is ignored
  tx.addInput({ sourceTXID: txid, sourceOutputIndex: vout, sequence: 0xfffffffe, unlockingScriptTemplate: new P2PKH().unlock(key, 'all', false, sats, lockingScript) });
  tx.addOutput({ lockingScript: pay.lockingScript, satoshis: sats - 1 });
  await tx.sign();                                                        // sign once to learn the real size,
  const fee = Math.max(1, Math.ceil((tx.toBinary().length + 2) * FEE / 1000));
  tx.outputs[0].satoshis = sats - fee;
  await tx.sign();                                                        // then again with the real fee
  return { hex: tx.toHex(), refundTxid: tx.id('hex'), derivationPrefix: pay.derivationPrefix, derivationSuffix: pay.derivationSuffix };
}

/**
 * Sender: fund a new pot from their wallet. `senderKey` is their identity key (the refund goes back to it), `days`
 * how long the friend has to claim. Returns { fragment, expiry, refund }: put "#"+fragment on the link; keep the
 * refund (saveRefund / refundFile). refund is null only if the pot output could not be found to sign it.
 */
export async function makeGift(sats, { senderKey, days = 7 } = {}) {
  sats = Math.floor(+sats);
  if (!(sats >= 1000)) throw new Error('A gift needs at least 1,000 sats.');
  if (!senderKey) throw new Error('Connect bWalletX first.');
  if (!EXPIRY_DAYS.includes(+days)) throw new Error('Pick when the gift expires.');
  const rate = await bsvUsd();
  if (sats > capSats(rate)) throw new Error(`A gift can hold at most ${fmtUsd(CAP_USD)} (about ${fmtSats(capSats(rate))} today).`);
  const expiry = Math.floor(Date.now() / 1000) + days * 86400;

  const key = PrivateKey.fromRandom();
  const lockingScript = lockOf(key), lockHex = lockingScript.toHex();
  const w = await wallet();
  const r = await w.createAction({
    description: 'FLICK ON gift',
    outputs: [{ lockingScript: lockHex, satoshis: sats, outputDescription: 'FLICK ON gift pot' }],
    options: { randomizeOutputs: false },
  });
  if (!r?.txid) throw new Error('Your wallet did not make the payment.');
  const fragment = `g=${key.toWif()}.${r.txid}.${expiry}`;

  let refund = null;
  try {
    const vout = await potVout(r, lockHex);
    const s = await signRefund(key, r.txid, vout, sats, lockingScript, senderKey, expiry);
    refund = { v: 1, kind: 'bfriendsx-gift-refund', txid: r.txid, vout, sats, expiry, to: senderKey, pot: key.toPublicKey().toString(), made: Math.floor(Date.now() / 1000), ...s };
  } catch {}
  return { fragment, expiry, refund };
}

/** Read "#g=<wif>.<txid>[.<expiry>]" from a fragment. Links made before expiries have no expiry. */
export function giftFromHash(hash) {
  const m = /(?:^#|&)g=([1-9A-HJ-NP-Za-km-z]{51,52})\.([0-9a-f]{64})(?:\.(\d{9,11}))?/.exec(hash || '');
  if (!m) return null;
  try { return { key: PrivateKey.fromWif(m[1]), txid: m[2], expiry: m[3] ? +m[3] : null }; } catch { return null; }
}
export const expired = (expiry) => !!expiry && Date.now() / 1000 >= expiry;

// ── reading the chain ────────────────────────────────────────────────────────────────────────────────────────────
// WhatsOnChain serves BEEF only for CONFIRMED txs. A fresh gift isn't confirmed for ~10 minutes, so build it from the
// raw tx plus its parents (recursively, until a confirmed ancestor with a proof). WoC allows ~3 requests a second.
const get = async (u) => {
  for (let t = 0; t < 6; t++) {
    const r = await fetch(u).catch(() => null);
    const x = r && r.ok ? (await r.text()).trim().replace(/"/g, '') : '';
    if (x) return x;
    await new Promise((res) => setTimeout(res, 700 * (t + 1)));
  }
  throw new Error('Could not reach WhatsOnChain. Try again in a minute.');
};
async function hydrate(txid, depth = 0) {
  const b = await get(`${WOC}/tx/${txid}/beef`).catch(() => '');
  if (/^[0-9a-f]{20,}$/i.test(b)) return Transaction.fromHexBEEF(b);
  if (depth > 30) throw new Error('This gift is waiting on too many unconfirmed payments. Try again after the next block.');
  const tx = Transaction.fromHex(await get(`${WOC}/tx/${txid}/hex`));
  for (const inp of tx.inputs) { await new Promise((r) => setTimeout(r, 350)); inp.sourceTransaction = await hydrate(inp.sourceTXID, depth + 1); }
  return tx;
}
/** Who spent txid:vout, or null if unspent. */
async function spentBy(txid, vout) {
  const s = await fetch(`${WOC}/tx/${txid}/${vout}/spent`).catch(() => null);
  if (!s) throw new Error('Could not reach WhatsOnChain. Try again in a minute.');
  if (s.status === 404) return null;
  const t = s.ok ? (await s.text()).trim() : '';
  if (t.length <= 2) return null;                                      // 404 / empty = unspent
  try { return JSON.parse(t).txid || 'spent'; } catch { return 'spent'; }
}

/** What's left in the pot: unspent outputs of the funding tx locked to the pot key. */
export async function potOf(g) {
  const tx = await hydrate(g.txid);
  const lock = lockOf(g.key).toHex();
  const outs = [];
  for (let i = 0; i < tx.outputs.length; i++) {
    if (tx.outputs[i].lockingScript.toHex() !== lock) continue;
    if (!(await spentBy(g.txid, i).catch(() => null))) outs.push(i);
  }
  return { tx, outs, sats: outs.reduce((a, i) => a + tx.outputs[i].satoshis, 0) };
}

// ── spending a pot ───────────────────────────────────────────────────────────────────────────────────────────────
/** Broadcast first (the money is then theirs even if the tab closes), then give it to the connected wallet. */
async function deliver(tx, pay, potPub) {
  const b = await fetch(`${WOC}/tx/raw`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txhex: tx.toHex() }) });
  if (!b.ok) {
    const t = await b.text();
    if (/non-final|non_final|locktime/i.test(t)) throw new Error('The network’s clock hasn’t reached the expiry yet. Try again in an hour.');
    if (/spent|conflict|missing/i.test(t)) throw new Error('This gift has already been claimed.');
    throw new Error('The network did not accept it. Try again in a minute.');
  }
  const w = await wallet();
  await w.internalizeAction({
    tx: tx.toAtomicBEEF(),
    outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: { derivationPrefix: pay.derivationPrefix, derivationSuffix: pay.derivationSuffix, senderIdentityKey: potPub } }],
    description: 'FLICK ON gift',
  });
  return { sats: tx.outputs[0].satoshis, txid: tx.id('hex') };
}

/** Claim the pot into the connected wallet (the recipient, or the sender taking it back with the link). */
export async function claimGift(g, identityKey) {
  const pot = await potOf(g);
  if (!pot.outs.length) throw new Error('This gift has already been claimed.');
  const tx = new Transaction();
  for (const i of pot.outs) tx.addInput({ sourceTransaction: pot.tx, sourceOutputIndex: i, unlockingScriptTemplate: new P2PKH().unlock(g.key) });
  const pay = paymentTo(identityKey, g.key);
  tx.addOutput({ lockingScript: pay.lockingScript, change: true });
  await tx.fee(new SatoshisPerKilobyte(FEE));
  await tx.sign();
  return deliver(tx, pay, g.key.toPublicKey().toString());
}

// ── refunds (sender only, no server) ─────────────────────────────────────────────────────────────────────────────
const STORE = 'bfx-gift-refunds';
const isRefund = (r) => r && r.kind === 'bfriendsx-gift-refund' && /^[0-9a-f]{64}$/.test(r.txid) && /^[0-9a-f]+$/i.test(r.hex) && r.expiry > 0;
export function refunds() {
  try { const a = JSON.parse(localStorage.getItem(STORE) || '[]'); return Array.isArray(a) ? a.filter(isRefund) : []; } catch { return []; }
}
/** Keep a refund in this browser. Returns false if the browser won't store it (then the file is the only copy). */
export function saveRefund(r) {
  if (!isRefund(r)) return false;
  try { localStorage.setItem(STORE, JSON.stringify([r, ...refunds().filter((x) => x.txid !== r.txid)].slice(0, 200))); return true; } catch { return false; }
}
export function forgetRefund(txid) {
  try { localStorage.setItem(STORE, JSON.stringify(refunds().filter((x) => x.txid !== txid))); } catch {}
}
/** A file the sender can save (and load back with readRefundFile) so the refund doesn't depend on this browser. */
export const refundFile = (r) => new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
export async function readRefundFile(file) {
  let r = null;
  try { r = JSON.parse(await file.text()); } catch {}
  if (!isRefund(r)) throw new Error('That isn’t a bFriendsX gift refund file.');
  return r;
}

/** 'waiting' (unclaimed, not expired), 'expired' (unclaimed, reclaim now), 'claimed', or 'refunded'. */
export async function refundStatus(r) {
  const by = await spentBy(r.txid, r.vout);
  if (by) return by === r.refundTxid ? 'refunded' : 'claimed';
  return expired(r.expiry) ? 'expired' : 'waiting';
}

/** After expiry, send an unclaimed pot back to the sender's wallet (which must be the one connected). */
export async function reclaim(r, identityKey) {
  if (!isRefund(r)) throw new Error('That refund is damaged.');
  if (identityKey !== r.to) throw new Error('Connect the bWalletX that made this gift to reclaim it.');
  if (!expired(r.expiry)) throw new Error('You can reclaim this gift after ' + fmtDate(r.expiry) + '.');
  const by = await spentBy(r.txid, r.vout);
  if (by && by !== r.refundTxid) throw new Error('Your friend already claimed this gift.');
  const tx = Transaction.fromHex(r.hex);
  const fund = await hydrate(r.txid);
  const out = fund.outputs[r.vout];
  if (!out || out.lockingScript.toHex() !== new P2PKH().lock(PublicKey.fromString(r.pot).toAddress()).toHex()) throw new Error('That refund doesn’t match its gift.');
  tx.inputs[0].sourceTransaction = fund;
  if (by === r.refundTxid) {                                            // broadcast before, but not yet in the wallet
    const w = await wallet();
    await w.internalizeAction({ tx: tx.toAtomicBEEF(), outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: { derivationPrefix: r.derivationPrefix, derivationSuffix: r.derivationSuffix, senderIdentityKey: r.pot } }], description: 'FLICK ON gift refund' });
    return { sats: tx.outputs[0].satoshis, txid: r.refundTxid };
  }
  return deliver(tx, r, r.pot);
}
