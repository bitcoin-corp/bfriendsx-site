// bfriendsx.com/friends: read friends lists from network exports on this device, pick people, make invite links.
import { friends, suggestMerges } from '/lib/flick/index.js';

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LABEL = { x: 'X', facebook: 'f', instagram: 'ig', linkedin: 'in', tiktok: 'tt', youtube: 'yt' };
const NAME = { x: 'X', facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', tiktok: 'TikTok', youtube: 'YouTube' };
const REL = { friend: 'friend', connection: 'connection', follower: 'follows you', following: 'you follow', mutual: 'follow each other' };

let all = [];             // Friend[] from every export opened so far
const picked = new Set(); // indexes into `all`
const shown = new Set(Object.keys(NAME));
let me = null;

// ── reading exports ──
const asFiles = async (file) => {
  if (/\.csv$/i.test(file.name)) return [{ path: file.name, size: file.size, text: () => file.text() }];
  const zip = await JSZip.loadAsync(file);
  return Object.values(zip.files).filter((e) => !e.dir).map((e) => ({ path: e.name, size: e._data?.uncompressedSize ?? 0, text: () => e.async('string') }));
};
async function open(list) {
  $('readErr').textContent = '';
  const seen = new Set(all.map((f) => f.network + '\n' + f.key));
  let added = 0;
  for (const file of list) {
    try {
      const got = await friends(await asFiles(file));
      if (!got.length) { $('readErr').textContent = `No friends list found in ${file.name}. Check it's the export with your friends or followers in it.`; continue; }
      for (const f of got) { const k = f.network + '\n' + f.key; if (!seen.has(k)) { seen.add(k); all.push(f); added++; } }
    } catch {
      $('readErr').textContent = `Couldn't read ${file.name}. Use the .zip file exactly as the network sent it.`;
    }
  }
  if (added) render();
}
$('files').onchange = (e) => open([...e.target.files]);
const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); open([...e.dataTransfer.files]); };

// ── the list ──
const visible = () => {
  const q = $('q').value.trim().toLowerCase();
  return all.map((f, i) => [f, i]).filter(([f]) => shown.has(f.network) && (!q || f.name.toLowerCase().includes(q) || (f.handle ?? '').toLowerCase().includes(q)));
};
function render() {
  $('step2').classList.remove('hidden'); $('step3').classList.remove('hidden');
  const by = {}; for (const f of all) by[f.network] = (by[f.network] ?? 0) + 1;
  $('summary').textContent = `${all.length.toLocaleString()} people: ` + Object.entries(by).map(([n, c]) => `${c.toLocaleString()} on ${NAME[n]}`).join(', ') + '.';
  $('nets').innerHTML = Object.keys(by).map((n) => `<button class="chip" type="button" data-n="${n}" aria-pressed="${shown.has(n)}"><span class="badge ${n}">${LABEL[n]}</span>${NAME[n]}</button>`).join('');
  const rows = visible();
  const CAP = 1000;
  $('list').innerHTML = rows.slice(0, CAP).map(([f, i]) => `<li><label><input type="checkbox" data-i="${i}" ${picked.has(i) ? 'checked' : ''}><span class="badge ${f.network}">${LABEL[f.network]}</span><span class="nm">${esc(f.name)}${f.handle && f.handle !== f.name ? ` <span class="small">@${esc(f.handle)}</span>` : ''}</span></label><span class="meta">${esc(REL[f.relation])}${f.since ? ' · ' + f.since.slice(0, 4) : ''}</span></li>`).join('')
    + (rows.length > CAP ? `<li class="small">and ${(rows.length - CAP).toLocaleString()} more. Search to find them.</li>` : '');
  const d = suggestMerges(all);
  $('dupes').textContent = d.length ? `${d.length} ${d.length === 1 ? 'person appears' : 'people appear'} on more than one network, e.g. ${d.slice(0, 3).map((g) => g[0].name).join(', ')}. Each gets one invite per network you pick.` : '';
  count();
}
function count() {
  $('picked').textContent = `${picked.size.toLocaleString()} picked`;
  $('make').disabled = !picked.size || !me;
  $('make').textContent = picked.size ? `Make ${picked.size.toLocaleString()} invite link${picked.size === 1 ? '' : 's'}` : 'Make invite links';
  $('needWallet').classList.toggle('hidden', !!me);
}
$('list').onchange = (e) => { const i = +e.target.dataset.i; if (e.target.checked) picked.add(i); else picked.delete(i); count(); };
$('nets').onclick = (e) => { const b = e.target.closest('[data-n]'); if (!b) return; const n = b.dataset.n; if (shown.has(n)) shown.delete(n); else shown.add(n); render(); };
$('q').oninput = render;
$('all').onclick = () => { for (const [f, i] of visible()) if (f.network !== 'x' || f.handle) picked.add(i); render(); };
$('none').onclick = () => { picked.clear(); render(); };

// ── invites ──
const MAX = 500;
$('make').onclick = async () => {
  $('makeErr').textContent = ''; $('make').disabled = true;
  const chosen = [...picked].map((i) => all[i]);
  const out = [];
  try {
    for (let k = 0; k < chosen.length; k += MAX) {
      const part = chosen.slice(k, k + MAX);
      const r = await fetch('/api/invite', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ friends: part.map((f) => ({ name: f.name, network: f.network })) }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      // the API drops nothing it can read, so links line up with `part`; match by name+network to be safe
      for (const l of j.links) out.push({ ...l, friend: part.find((f) => f.name.slice(0, 80) === l.name && f.network === l.network) });
    }
  } catch (e) { $('makeErr').textContent = e.message; }
  showLinks(out); count();
};
let lastLinks = [];
function showLinks(links) {
  lastLinks = links;
  $('copyAll').classList.toggle('hidden', !links.length);
  const share = !!navigator.share;
  $('links').innerHTML = links.map((l, i) => {
    const mail = l.friend?.email ? `<a class="btn btn-ghost mini" href="mailto:${encodeURIComponent(l.friend.email)}?subject=${encodeURIComponent('Come and join me on bWalletX')}&body=${encodeURIComponent(`Hi ${l.name.split(' ')[0]}, I'm moving my friends onto Bitcoin with bFriendsX. Here's your invite: ${l.url}`)}">Email</a>` : '';
    return `<li><span class="badge ${l.network}">${LABEL[l.network]}</span><span class="nm">${esc(l.name)}</span><code>${esc(l.url)}</code><button class="btn btn-ghost mini" type="button" data-copy="${i}">Copy</button>${share ? `<button class="btn btn-ghost mini" type="button" data-share="${i}">Share</button>` : ''}${mail}</li>`;
  }).join('');
}
$('links').onclick = async (e) => {
  const c = e.target.closest('[data-copy]'), s = e.target.closest('[data-share]');
  if (c) { await navigator.clipboard?.writeText(lastLinks[+c.dataset.copy].url); c.textContent = 'Copied'; }
  if (s) { const l = lastLinks[+s.dataset.share]; navigator.share({ title: 'bFriendsX invite', text: `Come and join me on bWalletX, ${l.name.split(' ')[0]}.`, url: l.url }).catch(() => {}); }
};
$('copyAll').onclick = async () => { await navigator.clipboard?.writeText(lastLinks.map((l) => `${l.name} (${NAME[l.network]}): ${l.url}`).join('\n')); $('copyAll').textContent = 'Copied'; };

// ── wallet ──
const setMe = (k) => { me = k || null; count(); };
document.addEventListener('bfriendsx-wallet', (e) => setMe(e.detail.identityKey));
fetch('/api/bwalletx/session', { credentials: 'same-origin' }).then((r) => r.json()).then((j) => setMe(j.identityKey)).catch(() => {});
