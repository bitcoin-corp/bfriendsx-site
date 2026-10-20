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
/** Plain text of an HTML fragment: tags dropped, entities decoded, whitespace collapsed. */
export function htmlText(h) {
    return h.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ').trim();
}
/** Inner HTML of the first <div class="...cls..."> inside `h` (Telegram's export nests no divs inside these). */
const divText = (h, cls) => { const m = new RegExp(`<div class="${cls}"[^>]*>([\\s\\S]*?)</div>`).exec(h); return m ? htmlText(m[1]) : ''; };
/** Telegram HTML dates: "23.04.2019 11:29:04" (local time; read as UTC, good enough for a year). */
const tgDate = (s) => { const m = /(\d{2})\.(\d{2})\.(\d{4})(?: (\d{2}):(\d{2}))?/.exec(s); return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4] ?? '00'}:${m[5] ?? '00'}:00.000Z` : null; };
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
    // HTML exports: each person is a link to their profile
    const fromHtml = async (re, relation) => {
        for (const f of find(files, re)) {
            const rows = [];
            for (const m of (await f.text()).matchAll(/href="https:\/\/www\.instagram\.com\/(?:_u\/)?([A-Za-z0-9._]{1,30})\/?"/g))
                rows.push({ string_list_data: [{ value: m[1], href: `https://www.instagram.com/${m[1]}` }] });
            add(rows, relation);
        }
    };
    await fromHtml(/followers_and_following\/followers(_\d+)?\.html$/i, 'follower');
    await fromHtml(/followers_and_following\/following\.html$/i, 'following');
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
const tgExport = async (files) => {
    const f = find(files, /(^|\/)result\.json$/i)[0];
    if (!f)
        return null;
    const j = await json(f);
    return j && (j.contacts || j.chats) ? j : null;
};
const GROUP = /group|supergroup/;
/** Telegram contacts (with phone numbers, kept private) plus everyone you have a one-to-one chat with. */
export async function telegramFriends(files) {
    const t = await tgExport(files);
    if (!t)
        return telegramHtmlFriends(files);
    const out = [], seen = new Set();
    for (const c of t.contacts?.list ?? []) {
        const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.phone_number || '';
        if (!name)
            continue;
        const key = c.user_id != null ? 'user' + c.user_id : 'phone:' + (c.phone_number ?? name);
        seen.add(key);
        out.push({ network: 'telegram', key, name, handle: null, url: null, email: null, company: null, phone: c.phone_number || null, relation: 'contact', since: iso(c.date_unixtime ? +c.date_unixtime : c.date) });
    }
    for (const c of t.chats?.list ?? []) {
        if (c.type !== 'personal_chat' || !c.name || c.id == null)
            continue;
        const key = 'user' + c.id;
        if (seen.has(key))
            continue;
        // contacts saved without a user id: match the chat by name instead of adding the same person twice
        const byName = out.find((f) => f.name === c.name && f.key.startsWith('phone:'));
        if (byName) {
            byName.key = key;
            seen.add(key);
            continue;
        }
        seen.add(key);
        out.push({ network: 'telegram', key, name: c.name, handle: null, url: null, email: null, company: null, phone: null, relation: 'chat', since: null });
    }
    return out;
}
/** Your Telegram groups, each with the people seen in it: the raw material for "rebuild this group on bChatX". */
export async function telegramGroups(files) {
    const t = await tgExport(files);
    if (!t)
        return telegramHtmlGroups(files);
    const me = t.personal_information?.user_id != null ? 'user' + t.personal_information.user_id : null;
    return (t.chats?.list ?? []).filter((c) => GROUP.test(c.type ?? '')).map((c) => {
        const m = new Map();
        for (const x of c.messages ?? []) {
            const id = x.from_id ?? x.actor_id, name = x.from ?? x.actor;
            if (id && id !== me && id.startsWith('user') && name)
                m.set(id, name);
        }
        return { name: c.name ?? 'Unnamed group', type: c.type ?? '', members: [...m].map(([userId, name]) => ({ userId, name })), messages: c.messages?.length ?? 0 };
    }).sort((a, b) => b.members.length - a.members.length);
}
/** Each `entry` block of a Telegram list page, with its link (chats list) if any. */
const tgEntries = (h) => h.split(/(?=<(?:div|a) class="entry[ "])/).slice(1).map((e) => ({ href: (/^<a [^>]*href="([^"]*)"/.exec(e) ?? [])[1] ?? '', body: e }));
async function tgHtml(files) {
    const c = find(files, /(^|\/)lists\/contacts\.html$/i)[0], ch = find(files, /(^|\/)lists\/chats\.html$/i)[0];
    if (!c && !ch)
        return null;
    const contacts = c ? tgEntries(await c.text()).map((e) => ({ name: divText(e.body, 'name bold'), phone: divText(e.body, 'details_entry details'), at: tgDate(divText(e.body, 'pull_right info details')) })).filter((x) => x.name) : [];
    const chats = ch ? tgEntries(await ch.text()).map((e) => ({ name: divText(e.body, 'name bold'), type: divText(e.body, 'pull_right info details').toLowerCase(), dir: (/chats\/(chat_\d+)\//.exec(e.href) ?? [])[1] ?? '' })).filter((x) => x.name) : [];
    return { contacts, chats };
}
const GONE = /^deleted account$/i;
async function telegramHtmlFriends(files) {
    const t = await tgHtml(files);
    if (!t)
        return [];
    const out = [], seen = new Set();
    for (const c of t.contacts) {
        if (GONE.test(c.name) || seen.has(c.name))
            continue;
        seen.add(c.name);
        out.push({ network: 'telegram', key: 'name:' + c.name, name: c.name, handle: null, url: null, email: null, company: null, phone: c.phone || null, relation: 'contact', since: c.at });
    }
    for (const c of t.chats) {
        if (c.type !== 'private' || GONE.test(c.name) || seen.has(c.name))
            continue;
        seen.add(c.name);
        out.push({ network: 'telegram', key: 'name:' + c.name, name: c.name, handle: null, url: null, email: null, company: null, phone: null, relation: 'chat', since: null });
    }
    return out;
}
async function telegramHtmlGroups(files) {
    const t = await tgHtml(files);
    if (!t)
        return [];
    const groups = [];
    for (const c of t.chats.filter((x) => x.type === 'group' && x.dir)) {
        const pages = find(files, new RegExp(`(^|/)chats/${c.dir}/messages\\d*\\.html$`));
        const names = new Set();
        let messages = 0;
        for (const p of pages) {
            const h = await p.text();
            messages += (h.match(/class="message default/g) ?? []).length;
            for (const m of h.matchAll(/<div class="from_name"[^>]*>([\s\S]*?)<\/div>/g)) {
                const n = htmlText(m[1]).replace(/ via @\w+$/, '');
                if (n && !GONE.test(n))
                    names.add(n);
            }
        }
        groups.push({ name: c.name, type: 'group', members: [...names].map((n) => ({ userId: 'name:' + n, name: n })), messages });
    }
    // you post in most of your groups: drop the name seen in the most groups (when it's in at least half of them)
    if (groups.length > 1) {
        const n = new Map();
        for (const g of groups)
            for (const m of g.members)
                n.set(m.name, (n.get(m.name) ?? 0) + 1);
        const [me, k] = [...n].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
        if (k >= groups.length / 2)
            for (const g of groups)
                g.members = g.members.filter((m) => m.name !== me);
    }
    return groups.sort((a, b) => b.members.length - a.members.length);
}
/** Every friend in the export, whichever network it's from. */
export async function friends(files) {
    return (await Promise.all([xFriends(files), facebookFriends(files), instagramFriends(files), linkedinFriends(files), telegramFriends(files)])).flat();
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
