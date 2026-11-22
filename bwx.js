/* Connect bWalletX on bfriendsx.com: drop <span data-bwx></span> anywhere and include this after
   @bwalletx/connect's global build and qrcode-generator. Extension / in-app wallets connect straight away;
   on a desktop with no extension it shows a QR to pair the phone app (or paste into web.bwalletx.com).
   On a phone (connect 0.9.0) it opens the bWalletX app, which signs in on its Connect card and sends the user back
   to this origin's root with #bwx=… (connect strips it as it loads); that page finishes the sign-in here and goes
   back to the page it started on. */
(() => {
  const C = window.bWalletXConnect;
  const slots = [...document.querySelectorAll('[data-bwx]')];
  if (!C || !slots.length) return;
  const short = (k) => k.slice(0, 6) + '…' + k.slice(-4);
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const css = document.createElement('style');
  css.textContent = `.bwx-btn{display:inline-flex;align-items:center;gap:8px;min-height:38px;padding:0 16px;border-radius:999px;border:1px solid rgba(255,210,77,.45);background:#0b0b0c;color:#ffd24d;font:600 14px 'Space Grotesk',sans-serif;cursor:pointer}
  .bwx-btn:hover{border-color:#ffd24d}.bwx-btn.on{background:linear-gradient(180deg,#ffe58a,#ffd24d 55%,#e0a800);color:#000;border:0}
  .bwx-dot{width:8px;height:8px;border-radius:50%;background:currentColor}
  .bwx-modal{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.8);display:grid;place-items:center;padding:16px}
  .bwx-card{background:#0b0b0c;border:1px solid rgba(255,210,77,.3);border-radius:20px;padding:24px;max-width:360px;width:100%;text-align:center;color:#f4f1e8;font:400 15px/1.5 'IBM Plex Sans',sans-serif}
  .bwx-card h3{font:700 22px 'Space Grotesk';margin:0 0 6px}.bwx-qr{background:#fff;border-radius:12px;padding:12px;margin:14px auto;width:max-content}
  .bwx-code{font:700 30px 'Space Grotesk';letter-spacing:.2em;color:#ffd24d}.bwx-x{margin-top:14px;background:none;border:0;color:#9a968b;cursor:pointer;font-size:14px}
  .bwx-link{word-break:break-all;font-size:11px;color:#9a968b;background:#000;border-radius:8px;padding:8px;margin-top:8px;cursor:copy}`;
  document.head.appendChild(css);

  let key = null;
  let handle = null;
  // Public, CORS-open lookup: the $handle (bWalletX paymail) for this identity key, if it has one.
  const lookup = async (k) => {
    handle = null;
    try {
      const r = await fetch(`https://pay.bwallet.space/api/paymail/lookup?key=${encodeURIComponent(k)}`);
      const j = r.ok ? await r.json() : null;
      if (j && typeof j.paymail === 'string' && key === k) { handle = '$' + j.paymail.split('@')[0]; draw(); }
    } catch {}
  };
  const draw = () => slots.forEach((s) => {
    s.innerHTML = '';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bwx-btn' + (key ? ' on' : '');
    b.innerHTML = key ? `<span class="bwx-dot"></span>${esc(handle || 'bWalletX ' + short(key))}` : 'Connect bWalletX';
    b.title = key ? 'Connected. Click to disconnect.' : 'Connect your bWalletX';
    b.onclick = key ? disconnect : connect;
    s.appendChild(b);
  });
  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  };
  let modal = null;
  const close = () => { modal?.remove(); modal = null; };
  const show = (html) => {
    close();
    modal = document.createElement('div'); modal.className = 'bwx-modal';
    modal.innerHTML = `<div class="bwx-card">${html}<button class="bwx-x" type="button">Cancel</button></div>`;
    modal.querySelector('.bwx-x').onclick = close;
    modal.onclick = (e) => { if (e.target === modal) close(); };
    document.body.appendChild(modal);
    return modal.querySelector('.bwx-card');
  };

  // The verify route needs the challenge's sealed ticket. On a phone the sign-in comes back in another tab (the
  // root), so the ticket waits in localStorage under its nonce until then (2 min; gone once used).
  const TICKETS = 'bfx:tickets';
  const tickets = () => { try { const t = JSON.parse(localStorage.getItem(TICKETS) || '{}'); return t && typeof t === 'object' ? t : {}; } catch { return {}; } };
  const keepTicket = (nonce, ticket) => { try { const t = tickets(); for (const k in t) if (!(t[k].at > Date.now() - 300e3)) delete t[k]; t[nonce] = { ticket, at: Date.now() }; localStorage.setItem(TICKETS, JSON.stringify(t)); } catch {} };
  const takeTicket = (nonce) => { try { const t = tickets(), v = t[nonce]; delete t[nonce]; localStorage.setItem(TICKETS, JSON.stringify(t)); return v ? v.ticket : null; } catch { return null; } };
  const signedIn = (k, wallet) => {
    key = k; if (wallet) window.bfxWallet = wallet; close(); draw(); lookup(key);   // keep the wallet for gift pots (gift.js)
    document.dispatchEvent(new CustomEvent('bfriendsx-wallet', { detail: { identityKey: key } }));
  };

  async function connect() {
    let ticket = null;
    let pm = null;
    try {
      const challenge = async (identityKey) => { const ch = await post('/api/bwalletx/challenge', identityKey ? { identityKey } : {}); ticket = ch.ticket; return ch; };
      // A wallet in this browser (extension, in-app): sign in straight away.
      let wallet = (await C.discoverBwalletX(C.DEFAULT_DISCOVER_MS || 300))?.wallet || null;
      let first = null, paired = false;
      if (!wallet) {
        paired = true;
        // Pairing: fetch the challenge first and fold it into the link, so bWalletX asks once ("Connect and sign in").
        const pre = await challenge();
        keepTicket(pre.nonce, pre.ticket);
        const login = C.foldableLogin(pre, location.origin);
        // Phones get bWalletX's own sheet ("Open bWalletX", and the way back to this page); computers our QR.
        pm = C.isTouchDevice && C.isTouchDevice() ? C.pairingModal({ mode: 'app' }) : null;
        const pairing = pm || {
          onLink: (link) => {
            let qr = '';
            if (window.qrcode) { const q = window.qrcode(0, 'M'); q.addData(link); q.make(); qr = q.createSvgTag({ cellSize: 4, margin: 0 }); }
            const card = show(`<h3>Connect bWalletX</h3><p>Scan with the bWalletX app on your phone, or paste the link into <a href="https://web.bwalletx.com" target="_blank" rel="noopener" style="color:#ffd24d">web.bwalletx.com</a>.</p><div class="bwx-qr">${qr}</div><div class="bwx-link" title="Click to copy">${esc(link)}</div><p id="bwxCode" style="margin:12px 0 0"></p>`);
            card.querySelector('.bwx-link').onclick = () => navigator.clipboard?.writeText(link);
          },
          onCode: (code) => { const el = document.getElementById('bwxCode'); if (el) el.innerHTML = `Check your wallet shows <span class="bwx-code">${esc(code)}</span>, then tap Connect.`; },
        };
        const c = await C.connectBwalletX({ pairing: login ? { ...pairing, login } : pairing, discoverMs: 0 });
        wallet = c.wallet;
        // The challenge bWalletX signed with Connect, or one still fresh enough to sign now.
        if (wallet.signedIn || pre.expiresAt - Date.now() > 30e3) { first = pre; ticket = pre.ticket; }
      }
      const r = await C.signInWithBwalletX({
        wallet, skipWaitForAuthentication: paired, // a paired phone: no lock check over the link (as before)
        challenge: (k) => { const c = first; first = null; return c ? Promise.resolve(c) : challenge(k); },
      });
      takeTicket(r.nonce);
      const v = await post('/api/bwalletx/verify', { identityKey: r.identityKey, nonce: r.nonce, signature: r.signature, ticket });
      signedIn(v.identityKey, r.wallet || null);
    } catch (e) {
      if (e && e.code === 'RETURNED_IN_ANOTHER_TAB') {
        // bWalletX sent the user back to a new tab, which signed in: re-read the session here.
        close(); recheck();
      } else if (e && e.code === 'NOT_FOUND') {
        show(`<h3>No bWalletX found</h3><p>Get the bWalletX extension or app, or use the web wallet.</p><p><a class="bwx-btn on" href="https://bwalletx.com/get">Get bWalletX</a></p>`);
      } else if (modal) {
        modal.querySelector('.bwx-card').insertAdjacentHTML('beforeend', `<p style="color:#ff8a7a">${esc((e && e.message) || 'That didn’t work. Try again.')}</p>`);
      } else {
        show(`<h3>Couldn’t connect</h3><p style="color:#ff8a7a">${esc((e && e.message) || 'Try again.')}</p>`);
      }
    } finally {
      try { pm && pm.close(); } catch {}
    }
  }
  // Signed in from another tab meanwhile (bWalletX's return on a phone): pick up the session, and tell the page
  // (invite.html then turns the badge gold and claims a gift that is still in THIS tab's link).
  const recheck = () => { if (!key) fetch('/api/bwalletx/session', { credentials: 'same-origin' }).then((r) => r.json()).then((j) => { if (j.identityKey && !key) signedIn(j.identityKey, null); }).catch(() => {}); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') recheck(); });
  async function disconnect() {
    await post('/api/bwalletx/session', {}).catch(() => {});
    try { C.clearPairing?.(); } catch {}
    // Tell the bWalletX extension this site disconnected, so it stops wearing the site's theme.
    try { window.postMessage({ type: 'bwallet:disconnect' }, location.origin); } catch {}
    key = null; handle = null; draw();
  }
  // After a reload the session cookie says who you are, but bWalletX only wears this site's theme once the page has
  // talked to it. With an extension or in-app wallet, quietly ask for the identity key again (never pairs).
  const touch = async () => { try { const f = await C.discoverBwalletX?.(800); if (f && f.wallet) await f.wallet.getPublicKey({ identityKey: true }); } catch {} };
  // bWalletX's return on a phone: finish the pairing, post the sign-in it folded into Connect, go back to the page.
  const returned = C.hasReturnFragment && C.hasReturnFragment()
    ? C.resumeReturnedPairing().catch(() => null).then(async (r) => {
      if (!r) return;
      window.bfxWallet = r.wallet;
      const ticket = r.login && takeTicket(r.login.nonce);
      if (ticket) {
        try {
          const v = await post('/api/bwalletx/verify', { identityKey: r.login.identityKey, nonce: r.login.nonce, signature: r.login.signature, ticket });
          if (!(r.page && r.page !== location.origin + location.pathname)) signedIn(v.identityKey, r.wallet);
        } catch { /* expired or refused: the button works as usual */ }
      }
      if (r.page && r.page !== location.origin + location.pathname) location.replace(r.page);
    })
    : Promise.resolve();
  returned.then(() => fetch('/api/bwalletx/session', { credentials: 'same-origin' })).then((r) => r.json()).then((j) => { if (!key) key = j.identityKey || null; draw(); if (key) { lookup(key); touch(); } }).catch(draw);
  draw();
})();
