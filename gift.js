// FLICK ON gift pots: a little BSV left in an invite link for the friend to claim when they join.
// The pot is a one-off key made in the sender's browser. The sender's bWalletX pays into it; the key rides in the
// link's #fragment (browsers never send that to any server, ours included). Whoever opens the link and connects
// bWalletX claims it: this page spends the pot to a BRC-29 "wallet payment" address for their identity key,
// broadcasts, then hands it to their wallet with internalizeAction. A link is a BEARER secret, like cash.
import { PrivateKey, PublicKey, P2PKH, Transaction, SatoshisPerKilobyte, Random, Utils } from 'https://cdn.jsdelivr.net/npm/@bsv/sdk@2.8.10/+esm';

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const BRC29 = '3241645161d8';

/** The connected BRC-100 wallet: kept by bwx.js at sign-in, else reconnect (extension or stored pairing). */
export async function wallet() {
  if (window.bfxWallet) return window.bfxWallet;
  const { wallet } = await window.bWalletXConnect.connectBwalletX({ reusePairing: true });
  window.bfxWallet = wallet;
  return wallet;
}

export const fmtSats = (s) => (s >= 1e6 ? `${(s / 1e8).toFixed(s % 1e6 ? 4 : 2).replace(/0+$/, '').replace(/\.$/, '')} BSV` : `${s.toLocaleString()} sats`);

/** Sender: fund a new pot from their wallet. Returns the fragment to put on the link: "g=<wif>.<txid>". */
export async function makeGift(sats) {
  const key = PrivateKey.fromRandom();
  const lockingScript = new P2PKH().lock(key.toAddress()).toHex();
  const w = await wallet();
  const r = await w.createAction({
    description: 'FLICK ON gift',
    outputs: [{ lockingScript, satoshis: sats, outputDescription: 'FLICK ON gift pot' }],
    options: { randomizeOutputs: false },
  });
  if (!r?.txid) throw new Error('Your wallet did not make the payment.');
  return `g=${key.toWif()}.${r.txid}`;
}

/** Read "#g=<wif>.<txid>" from a fragment. */
export function giftFromHash(hash) {
  const m = /(?:^#|&)g=([1-9A-HJ-NP-Za-km-z]{51,52})\.([0-9a-f]{64})/.exec(hash || '');
  if (!m) return null;
  try { return { key: PrivateKey.fromWif(m[1]), txid: m[2] }; } catch { return null; }
}

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

/** What's left in the pot: unspent outputs of the funding tx locked to the pot key. */
export async function potOf(g) {
  const tx = await hydrate(g.txid);
  const lock = new P2PKH().lock(g.key.toAddress()).toHex();
  const outs = [];
  for (let i = 0; i < tx.outputs.length; i++) {
    if (tx.outputs[i].lockingScript.toHex() !== lock) continue;
    const s = await fetch(`${WOC}/tx/${g.txid}/${i}/spent`).catch(() => null);
    const spent = s && s.ok && (await s.text()).trim().length > 2;   // 404 / empty = unspent
    if (!spent) outs.push(i);
  }
  return { tx, outs, sats: outs.reduce((a, i) => a + tx.outputs[i].satoshis, 0) };
}

/** Claim the pot into the connected wallet (the recipient, or the sender taking it back). */
export async function claimGift(g, identityKey) {
  const pot = await potOf(g);
  if (!pot.outs.length) throw new Error('This gift has already been claimed.');
  const tx = new Transaction();
  for (const i of pot.outs) tx.addInput({ sourceTransaction: pot.tx, sourceOutputIndex: i, unlockingScriptTemplate: new P2PKH().unlock(g.key) });
  const derivationPrefix = Utils.toBase64(Random(10)), derivationSuffix = Utils.toBase64(Random(10));
  const child = PublicKey.fromString(identityKey).deriveChild(g.key, `2-${BRC29}-${derivationPrefix} ${derivationSuffix}`);
  tx.addOutput({ lockingScript: new P2PKH().lock(child.toAddress()), change: true });
  await tx.fee(new SatoshisPerKilobyte(100));
  await tx.sign();
  // broadcast first (the money is then theirs even if the tab closes), then give it to the wallet
  const b = await fetch(`${WOC}/tx/raw`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txhex: tx.toHex() }) });
  if (!b.ok) {
    const t = await b.text();
    if (/spent|conflict|missing/i.test(t)) throw new Error('This gift has already been claimed.');
    throw new Error('The network did not accept the claim. Try again in a minute.');
  }
  const w = await wallet();
  await w.internalizeAction({
    tx: tx.toAtomicBEEF(),
    outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: g.key.toPublicKey().toString() } }],
    description: 'FLICK ON gift',
  });
  return { sats: tx.outputs[0].satoshis, txid: tx.id('hex') };
}
