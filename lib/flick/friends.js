/**
 * Friend readers for bFriendsX: who you know on each network, from that network's own data export.
 * Exports hold very little about friends (Facebook: name + date; X: account id; Instagram: username), so every
 * friend starts as an unclaimed contact. It becomes a real link when that person joins bWalletX and claims it.
 * PURE like the rest of the package: no DOM, no network.
 */
import { csv, ytd } from './index.js';
const find = (files, re) => files.filter((f) => re.test(f.path));
const iso = (v) => {
    if (v == null || v === '')
        return null;
    const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
};
/** Meta's JSON exports store UTF-8 bytes as \u00XX escapes ("JosÃ©"): turn them back into text. */
export function metaText(s) {
    if (!/[\u0080-ÿ]/.test(s) || /[^\u0000-ÿ]/.test(s))
        return s;
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));
    }
    catch {
        return s;
    }
}
const json = async (f) => { try {
    return JSON.parse(await f.text());
}
catch {
    return null;
} };
export async function facebookFriends(files) {
    const out = [];
    for (const f of find(files, /(^|\/)(connections\/)?friends\/(your_)?friends\.json$/i)) {
        const j = await json(f);
        const list = j?.friends_v2 ?? j?.friends ?? (Array.isArray(j) ? j : []);
        for (const x of list)
            if (x?.name) {
                const name = metaText(x.name);
                out.push({ network: 'facebook', key: name, name, handle: null, url: null, email: null, company: null, relation: 'friend', since: iso(x.timestamp) });
            }
    }
    return out;
}
export async function instagramFriends(files) {
    const by = new Map();
    const add = (rows, relation) => {
        for (const r of rows)
            for (const d of r.string_list_data ?? [{}]) {
                const handle = d.value ?? r.title;
                if (!handle)
                    continue;
                const had = by.get(handle);
                if (had) {
                    if (had.relation !== relation)
                        had.relation = 'mutual';
                    continue;
                }
                by.set(handle, { network: 'instagram', key: handle, name: handle, handle, url: d.href ?? `https://www.instagram.com/${handle}`, email: null, company: null, relation, since: iso(d.timestamp) });
            }
    };
    for (const f of find(files, /followers_and_following\/followers(_\d+)?\.json$/i)) {
        const j = await json(f);
        add(Array.isArray(j) ? j : j?.relationships_followers ?? [], 'follower');
    }
    for (const f of find(files, /followers_and_following\/following\.json$/i)) {
        const j = await json(f);
        add(j?.relationships_following ?? (Array.isArray(j) ? j : []), 'following');
    }
    return [...by.values()];
}
/** LinkedIn's Connections.csv starts with a few lines of notes before the real header. */
export async function linkedinFriends(files) {
    const f = find(files, /(^|\/)connections\.csv$/i)[0];
    if (!f)
        return [];
    const rows = csv(await f.text());
    const hi = rows.findIndex((r) => r.some((c) => /^first name$/i.test(c.trim())));
    if (hi < 0)
        return [];
    const h = rows[hi].map((c) => c.trim().toLowerCase());
    const c = (k) => h.indexOf(k);
    const [fn, ln, url, em, co, on] = ['first name', 'last name', 'url', 'email address', 'company', 'connected on'].map(c);
    return rows.slice(hi + 1).flatMap((r) => {
        const name = [r[fn], r[ln]].filter(Boolean).join(' ').trim();
        if (!name)
            return [];
        const u = r[url]?.trim() || null;
        return [{ network: 'linkedin', key: u ?? name, name, handle: null, url: u, email: r[em]?.trim() || null, company: r[co]?.trim() || null, relation: 'connection', since: iso(r[on]) }];
    });
}
/** X archives list followers/following as account ids only; handles need a lookup (the bMintX X API) later. */
export async function xFriends(files) {
    const read = async (n) => { const f = find(files, new RegExp(`(^|/)data/${n}\\.js$`))[0]; return f ? f.text() : null; };
    const by = new Map();
    const add = (rows, relation) => {
        for (const r of rows) {
            const v = r.follower ?? r.following;
            const id = v?.accountId;
            if (!id)
                continue;
            const had = by.get(id);
            if (had) {
                if (had.relation !== relation)
                    had.relation = 'mutual';
                continue;
            }
            by.set(id, { network: 'x', key: id, name: `X user ${id}`, handle: null, url: v.userLink ?? `https://x.com/i/user/${id}`, email: null, company: null, relation, since: null });
        }
    };
    add(ytd(await read('follower')), 'follower');
    add(ytd(await read('following')), 'following');
    return [...by.values()];
}
/** Every friend in the export, whichever network it's from. */
export async function friends(files) {
    return (await Promise.all([xFriends(files), facebookFriends(files), instagramFriends(files), linkedinFriends(files)])).flat();
}
const nameKey = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, '').split(/\s+/).filter(Boolean).sort().join(' ');
/**
 * Same person on several networks? Groups friends whose names match after accents, case, punctuation and word order
 * are ignored. These are SUGGESTIONS: the user confirms each merge (two different John Smiths are common).
 */
export function suggestMerges(list) {
    const g = new Map();
    for (const f of list) {
        if (f.network === 'x' && !f.handle)
            continue;
        const k = nameKey(f.name);
        if (k)
            g.set(k, [...(g.get(k) ?? []), f]);
    }
    return [...g.values()].filter((x) => new Set(x.map((f) => f.network)).size > 1);
}
