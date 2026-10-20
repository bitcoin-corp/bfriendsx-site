/**
 * @bwalletx/flick: FLICK OFF archive readers, shared by the websites (bmintx.com/flick-off/*) and the bWalletX
 * in-wallet Mint. Give it the files of a platform's data export (from a picked folder, a dropped zip, or a
 * phone upload) and it says what's inside, what it costs at cost price, and what can be imported.
 *
 * PURE: no DOM, no network, no keys. Files are read lazily: only small text files (metadata) are opened;
 * video/photo bytes are never read here, only their sizes. Signing and minting happen in the wallet.
 */
/** House rate used across bMintX / bChatX scripts. */
export const SAT_PER_KB = 100;
/** Cost price in satoshis to write `bytes` on chain at `satPerKb`. */
export const costSats = (bytes, satPerKb = SAT_PER_KB) => Math.ceil((bytes / 1000) * satPerKb);
// ── helpers ───────────────────────────────────────────────────────────────────
/** X archive data files: `window.YTD.tweets.part0 = [ ... ]` → the array. */
export function ytd(js) {
    if (!js)
        return [];
    const i = js.indexOf('[');
    if (i < 0)
        return [];
    try {
        return JSON.parse(js.slice(i));
    }
    catch {
        return [];
    }
}
/** RFC 4180 CSV (quoted fields may hold commas, quotes and newlines). */
export function csv(text) {
    const rows = [];
    let row = [], f = '', q = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    f += '"';
                    i++;
                }
                else
                    q = false;
            }
            else
                f += c;
        }
        else if (c === '"')
            q = true;
        else if (c === ',') {
            row.push(f);
            f = '';
        }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n')
                i++;
            row.push(f);
            rows.push(row);
            row = [];
            f = '';
        }
        else
            f += c;
    }
    if (f || row.length) {
        row.push(f);
        rows.push(row);
    }
    return rows.filter((r) => r.some((x) => x !== ''));
}
const find = (files, re) => files.find((f) => re.test(f.path));
const unescapeHtml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
/** Which platform's export this is, or null. */
export function detect(files) {
    if (find(files, /(^|\/)data\/tweets?\.js$/))
        return 'x';
    if (files.some((f) => /youtube/i.test(f.path) && (VIDEO.test(f.path) || /video metadata\//i.test(f.path))))
        return 'youtube';
    return null;
}
/** Post text with t.co links expanded and media t.co links removed. */
export function xText(t) {
    let s = t.full_text ?? t.text ?? '';
    for (const u of t.entities?.urls ?? [])
        if (u.url && u.expanded_url)
            s = s.split(u.url).join(u.expanded_url);
    for (const m of [...(t.entities?.media ?? []), ...(t.extended_entities?.media ?? [])])
        if (m.url)
            s = s.split(m.url).join('');
    return unescapeHtml(s).replace(/[ \t]+\n/g, '\n').trim();
}
/** Bytes per post on chain besides its text and inline media (inputs, change, MAP, AIP, origin fields). */
export const X_POST_OVERHEAD = 610;
export async function planX(files) {
    const read = async (...names) => {
        for (const n of names) {
            const f = find(files, new RegExp(`(^|/)data/${n}\\.js$`));
            if (f)
                return f.text();
        }
        return null;
    };
    const [tweetsJs, accountJs, followerJs, followingJs, dmJs] = await Promise.all([
        read('tweets', 'tweet'), read('account'), read('follower'), read('following'), read('direct-messages', 'direct-message'),
    ]);
    if (!tweetsJs)
        throw new Error('No data/tweets.js: this is not an X archive.');
    const acct = ytd(accountJs)[0]?.account ?? {};
    const username = acct.username ?? 'unknown', accountId = acct.accountId ?? '';
    const byPost = new Map();
    for (const f of files) {
        const m = /data\/tweets?_media\/(\d+)-([^/]+)$/.exec(f.path);
        if (m)
            byPost.set(m[1], [...(byPost.get(m[1]) ?? []), { name: m[1] + '-' + m[2], bytes: f.size }]);
    }
    const posts = [];
    const skipped = { retweets: 0, empty: 0 };
    for (const row of ytd(tweetsJs)) {
        const t = row.tweet ?? row;
        const id = t.id_str ?? t.id;
        if (!id)
            continue;
        if (t.retweeted || /^RT @\w+:/.test(t.full_text ?? t.text ?? '')) {
            skipped.retweets++;
            continue;
        }
        const text = xText(t), media = byPost.get(id) ?? [];
        const at = t.created_at ? new Date(t.created_at) : null;
        if ((!text && !media.length) || !at || isNaN(at.getTime())) {
            skipped.empty++;
            continue;
        }
        const self = !!t.in_reply_to_status_id_str && !!accountId && t.in_reply_to_user_id_str === accountId;
        const other = !!t.in_reply_to_status_id_str && !self && !!t.in_reply_to_screen_name;
        posts.push({
            id, text, at: at.toISOString(), url: `https://x.com/${username}/status/${id}`,
            parentId: self ? t.in_reply_to_status_id_str : null,
            replyUrl: other ? `https://x.com/${t.in_reply_to_screen_name}/status/${t.in_reply_to_status_id_str}` : null,
            media,
        });
    }
    posts.sort((a, b) => a.at.localeCompare(b.at)); // oldest first: a thread's parent is signed before its replies
    const enc = new TextEncoder();
    const textBytes = posts.reduce((a, p) => a + X_POST_OVERHEAD + enc.encode(p.text).length, 0);
    const mediaBytes = posts.reduce((a, p) => a + p.media.reduce((x, m) => x + m.bytes, 0), 0);
    const text = costSats(textBytes), media = costSats(mediaBytes);
    return {
        platform: 'x', username, accountId, posts, skipped,
        mediaFiles: posts.reduce((a, p) => a + p.media.length, 0),
        followers: ytd(followerJs).length, following: ytd(followingJs).length,
        dms: ytd(dmJs).reduce((a, c) => a + (c.dmConversation?.messages?.length ?? 0), 0),
        cost: { text, media, total: text + media },
    };
}
// ── YouTube (Google Takeout) ──────────────────────────────────────────────────
export const VIDEO = /\.(mp4|mov|m4v|webm|mkv|avi|flv|3gp|wmv|mpg|mpeg)$/i;
/** Bytes per video besides the file: title, description, date, MAP fields, signature. */
export const YT_META_BYTES = 1000;
/** Takeout's video metadata CSV → records keyed by normalised title. Column names vary between Takeout versions. */
export function youtubeMetadata(text) {
    const rows = csv(text);
    const m = new Map();
    if (rows.length < 2)
        return m;
    const h = rows[0].map((x) => x.toLowerCase());
    const col = (...keys) => h.findIndex((x) => keys.some((k) => x.includes(k)));
    const ti = col('video title', 'title'), di = col('publish timestamp', 'create timestamp', 'timestamp', 'date'), de = col('description'), pr = col('privacy');
    for (const r of rows.slice(1)) {
        const title = r[ti];
        if (!title)
            continue;
        m.set(norm(title), { title, date: di >= 0 ? r[di] : '', desc: de >= 0 ? r[de] : '', privacy: pr >= 0 ? r[pr] : '' });
    }
    return m;
}
export async function planYouTube(files) {
    const metaFile = find(files, /video metadata\/.*videos?\.csv$/i) ?? find(files, /youtube.*\/videos\.csv$/i);
    const m = metaFile ? youtubeMetadata(await metaFile.text()) : new Map();
    const videos = files.filter((f) => VIDEO.test(f.path) && /youtube/i.test(f.path)).map((f) => {
        const base = f.path.split('/').pop().replace(VIDEO, '');
        const hit = m.get(norm(base)) ?? [...m.values()].find((x) => norm(x.title).startsWith(norm(base).slice(0, 40)));
        const d = hit?.date ? new Date(hit.date) : null;
        return {
            path: f.path, title: hit?.title ?? base, description: hit?.desc ?? '',
            at: d && !isNaN(d.getTime()) ? d.toISOString() : null, privacy: hit?.privacy ?? '',
            bytes: f.size, cost: costSats(f.size + YT_META_BYTES),
        };
    }).sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
    return {
        platform: 'youtube', videos, hasMetadata: !!metaFile,
        bytes: videos.reduce((a, v) => a + v.bytes, 0), cost: videos.reduce((a, v) => a + v.cost, 0),
    };
}
/** Detect the platform and plan it in one go. */
export async function plan(files) {
    const p = detect(files);
    if (p === 'x')
        return planX(files);
    if (p === 'youtube')
        return planYouTube(files);
    throw new Error('Not an export we can read yet. Supported: X (Twitter) archive, YouTube via Google Takeout. For friends lists (Facebook, Instagram, LinkedIn, X) use friends().');
}
export * from './friends.js';
