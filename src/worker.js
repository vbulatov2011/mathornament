/**
 * MathOrnament — API for a Shadertoy-style site around the symsim Gray-Scott app.
 *
 * Pages (static assets, some rewritten here for OpenGraph tags):
 *   /                      gallery / browse
 *   /view/<id>             pattern page (viewer, metadata, fork, likes, comments)
 *   /user/<handle>         profile
 *   /new                   editor with a blank document
 *   /s/<id>                legacy short link -> /view/<id>
 *
 * API:
 *   GET  /api/me                       current user or null
 *   GET  /auth/login?next=/x           -> Google consent screen
 *   GET  /auth/callback                OAuth code exchange, sets session cookie
 *   POST /auth/logout                  clears session
 *   POST /api/share                    publish {title, desc, tags, visibility, parent, doc, thumb}
 *   GET  /api/list?sort=&q=&limit=     public patterns
 *   GET  /api/shader/<id>              metadata + stats (counts a view)
 *   POST /api/delete/<id>              delete own pattern
 *   POST /api/like/<id>                toggle like
 *   GET  /api/comments/<id>            comments, oldest first
 *   POST /api/comments/<id>            post a comment (sign-in required)
 *   GET  /api/user/<handle>            profile + that user's patterns
 *   GET  /api/preset/<id>[.json|.png]  raw document / thumbnail
 *
 * KV layout (binding PRESETS):
 *   preset:<id>            document bytes, metadata = summary (see makeSummary)
 *   thumb:<id>             PNG bytes
 *   pidx:<invTs>-<id>      public index, metadata = summary   (newest first by key order)
 *   uidx:<userId>:<invTs>-<id>  per-user index, metadata = summary
 *   stat:<id>              {views, likes, forks}
 *   like:<id>:<userId>     "1"
 *   cmt:<id>:<ts>-<cid>    {userId, name, picture, text, created}
 *   user:<userId>          {id, handle, name, picture, created}
 *   handle:<lowercase>     userId
 *   sess:<token>           userId          (30-day TTL)
 *   oauth:<state>          next path        (10-minute TTL)
 *   rate:<ip>:<bucket>     advisory share counter
 */

import { Buffer } from 'node:buffer';

const MAX_DOC_BYTES = 8 * 1024 * 1024;
const MAX_THUMB_B64 = 2 * 1024 * 1024;
const MAX_SHARES_PER_BUCKET = 8; // per 10 min per IP (advisory: KV is not atomic)
const MAX_COMMENTS_PER_BUCKET = 20;
const MAX_COMMENT_CHARS = 500; // fits KV's 1024-byte metadata cap with the author fields
const VIEW_EXACT_LIMIT = 200;  // count every view below this, then sample
const VIEW_SAMPLE = 20;
const LIST_LIMIT = 200;      // items returned to the browser
const MAX_INDEX_KEYS = 5000; // index keys scanned before sorting/filtering
const SESSION_TTL = 60 * 60 * 24 * 30;

const ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const VISIBILITIES = ['public', 'unlisted', 'private'];

// ── small helpers ─────────────────────────────────────────────────────────────

function makeId(len = 10) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let id = '';
  for (const b of bytes) id += ID_ALPHABET[b % ID_ALPHABET.length];
  return id;
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Strip angle brackets from every string in a stored document: some vendored UI
// paths assign param-derived strings via innerHTML. In JSON these characters
// only ever occur inside string literals, so a blanket strip is safe.
function sanitizeDocString(s) {
  return s.replace(/[<>]/g, '');
}

function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanTags(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(',');
  const out = [];
  for (const t of arr) {
    const tag = String(t).toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim().replace(/\s+/g, '-').slice(0, 24);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= 6) break;
  }
  return out;
}

function invTs(now) {
  return String(10 ** 13 - now).padStart(13, '0');
}

function idFromIndexKey(name) {
  return name.slice(name.lastIndexOf('-') + 1);
}

// KV metadata is capped at 1024 serialized bytes.
function fitMetadata(meta) {
  const enc = new TextEncoder();
  let m = { ...meta };
  for (let i = 0; i < 40; i++) {
    if (enc.encode(JSON.stringify(m)).length <= 900) return m;
    if (m.desc && m.desc.length > 0) { m.desc = m.desc.slice(0, Math.floor(m.desc.length * 0.6)); continue; }
    if (m.tags && m.tags.length) { m.tags = m.tags.slice(0, m.tags.length - 1); continue; }
    if (m.text && m.text.length > 16) { m.text = m.text.slice(0, Math.floor(m.text.length * 0.6)); continue; }
    if (m.title && m.title.length > 8) { m.title = m.title.slice(0, Math.floor(m.title.length * 0.7)); continue; }
    if (m.picture && m.picture.length > 0) { m.picture = ''; continue; }
    if (m.authorName && m.authorName.length > 4) { m.authorName = m.authorName.slice(0, 4); continue; }
    if (m.name && m.name.length > 4) { m.name = m.name.slice(0, 4); continue; }
    break;
  }
  // Last resort: keep only short, fixed-shape fields so the result is always
  // under the cap (the loop above can run out of things to shrink).
  const minimal = {};
  for (const k of ['authorId', 'authorHandle', 'created', 'visibility', 'parent', 'likes',
                   'pk', 'uk', 'userId', 'handle']) {
    if (m[k] !== undefined) minimal[k] = m[k];
  }
  minimal.title = String(m.title || 'untitled').slice(0, 60);
  minimal.authorName = String(m.authorName || '').slice(0, 40);
  minimal.name = String(m.name || '').slice(0, 40);
  minimal.text = String(m.text || '').slice(0, 200);
  minimal.desc = '';
  minimal.tags = [];
  for (const k of Object.keys(minimal)) if (minimal[k] === undefined || minimal[k] === '') delete minimal[k];
  return minimal;
}

function parseCookies(request) {
  const out = {};
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    let v = part.slice(i + 1).trim();
    // An unrelated cookie on this origin with a bad percent-escape must not
    // take down every session-aware endpoint.
    try { v = decodeURIComponent(v); } catch { /* keep the raw value */ }
    out[part.slice(0, i).trim()] = v;
  }
  return out;
}

function cookie(name, value, maxAge, secure) {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

async function getSessionUser(request, env) {
  const token = parseCookies(request).mo_sess;
  if (!token) return null;
  const userId = await env.PRESETS.get('sess:' + token);
  if (!userId) return null;
  const rec = await env.PRESETS.get('user:' + userId, 'json');
  return rec || null;
}

function requireSameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  return !origin || origin === url.origin;
}

// Never expose the internal user id (it embeds the Google account subject).
// Ownership is always decided server-side from the session.
function publicUser(u) {
  if (!u) return null;
  return { handle: u.handle, name: u.name, picture: u.picture || '', created: u.created };
}

function makeSummary({ title, desc, tags, authorId, authorName, authorHandle, created, visibility, parent, likes, pk, uk }) {
  return fitMetadata({
    title, desc, tags, authorId, authorName, authorHandle, created, visibility,
    parent: parent || '',
    likes: likes || 0,
    // Index key names, so counter updates and deletes touch small keys directly
    // instead of rewriting the multi-MB document or scanning the whole index.
    pk: pk || '',
    uk: uk || '',
  });
}

async function getStats(env, id) {
  const s = await env.PRESETS.get('stat:' + id, 'json');
  return { views: 0, likes: 0, forks: 0, ...(s || {}) };
}

async function bumpStat(env, id, field, delta) {
  try {
    const s = await getStats(env, id);
    s[field] = Math.max(0, (s[field] || 0) + delta);
    await env.PRESETS.put('stat:' + id, JSON.stringify(s));
    return s;
  } catch (e) {
    console.warn('stat write failed', e && e.message);
    return await getStats(env, id);
  }
}

// ── Google OAuth ──────────────────────────────────────────────────────────────

function authConfigured(env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

// Worker-rendered pages don't load /site.css, so they carry a tiny copy of the
// palette. `color-scheme` plus a dark media query keeps them matching the OS.
const PAGE_STYLE = `<style>
:root { color-scheme: light dark; --pg-bg:#f6f7fa; --pg-fg:#131a26; --pg-link:#1552c9; }
@media (prefers-color-scheme: dark) {
  :root { --pg-bg:#0b0e14; --pg-fg:#dbe4f5; --pg-link:#7fb4ff; }
}
body { background: var(--pg-bg); color: var(--pg-fg); font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
       display: grid; place-items: center; min-height: 100vh; margin: 0; }
a { color: var(--pg-link); }
code { background: color-mix(in srgb, var(--pg-fg) 10%, transparent); padding: 1px 5px; border-radius: 4px; }
</style>`;

function safePath(p) {
  return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') ? p : '/';
}

function notConfiguredPage(origin, next = '/') {
  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>Sign-in not set up yet</title>${PAGE_STYLE}</head>
<body>
<div style="max-width:560px;padding:24px;line-height:1.6">
<h1 style="font-size:22px">Google sign-in isn't configured yet</h1>
<p>The site works without an account — you can browse, open, fork and publish patterns.
Accounts add profiles and comments.</p>
<p>To turn sign-in on, the site owner needs to create a Google OAuth client and set
<code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>. Step-by-step instructions are in
<code>GUIDE.md</code> in the project folder.</p>
<p><a href="${escapeHtml(origin + safePath(next))}">Go back</a></p>
</div></body></html>`;
  return new Response(html, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function handleLogin(request, env, url) {
  const safeNext = safePath(url.searchParams.get('next'));
  if (!authConfigured(env)) return notConfiguredPage(url.origin, safeNext);

  // The state lives in a short-lived cookie, not in KV: it binds the callback
  // to the browser that started the flow (without that binding an attacker can
  // hand a victim their own callback URL and sign the victim into the
  // attacker's account), and it keeps /auth/login from being an
  // unauthenticated KV write that anyone could hammer.
  const state = makeId(24);
  const payload = state + '|' + safeNext;

  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  auth.searchParams.set('redirect_uri', url.origin + '/auth/callback');
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', 'openid email profile');
  auth.searchParams.set('state', state);
  auth.searchParams.set('prompt', 'select_account');

  return new Response(null, {
    status: 302,
    headers: {
      Location: auth.toString(),
      'Set-Cookie': cookie('mo_oauth', payload, 600, url.protocol === 'https:'),
      'Cache-Control': 'no-store',
    },
  });
}

function decodeJwtPayload(idToken) {
  const part = idToken.split('.')[1];
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

// KV has no compare-and-set, so claim the handle then read it back: if another
// sign-in won the race we would otherwise silently take over their profile URL.
async function claimHandle(env, base, userId) {
  const root = String(base || 'user').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20) || 'user';
  for (let i = 0; i < 12; i++) {
    const candidate = i === 0 ? root : (i < 10 ? root + i : root + makeId(4));
    const taken = await env.PRESETS.get('handle:' + candidate);
    if (taken && taken !== userId) continue;
    await env.PRESETS.put('handle:' + candidate, userId);
    const confirmed = await env.PRESETS.get('handle:' + candidate);
    if (confirmed === userId) return candidate;
  }
  const fallback = root.slice(0, 12) + makeId(6);
  await env.PRESETS.put('handle:' + fallback, userId);
  return fallback;
}

async function handleAuthCallback(request, env, url) {
  if (!authConfigured(env)) return notConfiguredPage(url.origin);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const clearOAuth = cookie('mo_oauth', '', 0, url.protocol === 'https:');
  const bail = reason => new Response(null, {
    status: 302,
    headers: { Location: url.origin + '/?auth=' + reason, 'Set-Cookie': clearOAuth, 'Cache-Control': 'no-store' },
  });
  if (!code || !state) return bail('failed');

  // The state must match the cookie this browser got from /auth/login.
  const stashed = parseCookies(request).mo_oauth || '';
  const sep = stashed.indexOf('|');
  const stashedState = sep === -1 ? stashed : stashed.slice(0, sep);
  const next = sep === -1 ? '/' : stashed.slice(sep + 1);
  if (!stashedState || stashedState !== state) return bail('expired');

  // The token endpoint is authenticated by our client secret over TLS, so the
  // id_token it returns can be trusted without re-verifying its signature.
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: url.origin + '/auth/callback',
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenResp.ok) {
    console.warn('token exchange failed with status', tokenResp.status);
    return bail('failed');
  }
  const tokens = await tokenResp.json();
  if (!tokens.id_token) return bail('failed');

  let claims;
  try {
    claims = decodeJwtPayload(tokens.id_token);
  } catch (e) {
    return bail('failed');
  }
  const issuers = ['https://accounts.google.com', 'accounts.google.com'];
  if (!claims.sub || claims.aud !== env.GOOGLE_CLIENT_ID || !issuers.includes(claims.iss)) {
    return bail('failed');
  }
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return bail('failed');

  const userId = 'g' + claims.sub;
  let user = await env.PRESETS.get('user:' + userId, 'json');
  if (!user) {
    const handle = await claimHandle(env, claims.name || (claims.email || '').split('@')[0], userId);
    user = {
      id: userId,
      handle,
      name: cleanText(claims.name || handle, 60) || handle,
      picture: typeof claims.picture === 'string' && claims.picture.startsWith('https://')
        ? claims.picture.slice(0, 300) : '',
      created: new Date().toISOString(),
    };
    await env.PRESETS.put('user:' + userId, JSON.stringify(user));
  }

  const token = makeId(32);
  await env.PRESETS.put('sess:' + token, userId, { expirationTtl: SESSION_TTL });

  const secure = url.protocol === 'https:';
  const headers = new Headers({ Location: url.origin + safePath(next), 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', cookie('mo_sess', token, SESSION_TTL, secure));
  headers.append('Set-Cookie', clearOAuth);
  return new Response(null, { status: 302, headers });
}

async function handleLogout(request, env, url) {
  if (!requireSameOrigin(request, url)) return json({ error: 'forbidden' }, 403);
  const token = parseCookies(request).mo_sess;
  if (token) await env.PRESETS.delete('sess:' + token).catch(() => {});
  return new Response(null, {
    status: 204,
    headers: { 'Set-Cookie': cookie('mo_sess', '', 0, url.protocol === 'https:') },
  });
}

// ── publishing ────────────────────────────────────────────────────────────────

async function handleShare(request, env, url) {
  if (!requireSameOrigin(request, url)) {
    return json({ error: 'Cross-origin publishing is not allowed.' }, 403);
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = Math.floor(Date.now() / 600000);
  const rateKey = 'rate:' + ip + ':' + bucket;
  let count = 0;
  try { count = parseInt((await env.PRESETS.get(rateKey)) || '0', 10); } catch { /* advisory */ }
  if (count >= MAX_SHARES_PER_BUCKET) {
    return json({ error: 'You are publishing very fast — try again in a few minutes.' }, 429);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body.' }, 400); }

  const doc = body.doc;
  if (!doc || typeof doc !== 'object' || !doc.params || typeof doc.params !== 'object') {
    return json({ error: 'Missing preset document.' }, 400);
  }
  // The symsim loader needs this envelope; without it presets silently fail.
  if (!doc.appInfo || !doc.appInfo.fileFormatRelease) {
    return json({ error: 'Preset document missing appInfo.fileFormatRelease.' }, 400);
  }

  const user = await getSessionUser(request, env);
  if (env.REQUIRE_LOGIN === 'true' && !user) {
    return json({ error: 'Sign in to publish.' }, 401);
  }

  const title = cleanText(body.title, 120) || 'untitled';
  const desc = cleanText(body.desc, 400);
  const tags = cleanTags(body.tags);
  let visibility = VISIBILITIES.includes(body.visibility) ? body.visibility : 'public';
  // "Private" means "only its author" — without an account there is no author,
  // so the pattern would be unreachable by everyone, forever. Fall back to
  // unlisted (link-only), which is what an anonymous user actually wants.
  if (visibility === 'private' && !user) visibility = 'unlisted';
  let parent = /^[a-z0-9]{1,32}$/.test(String(body.parent || '')) ? String(body.parent) : '';
  const created = new Date().toISOString();

  doc.name = title;
  const docStr = sanitizeDocString(JSON.stringify(doc));
  const docBytes = new TextEncoder().encode(docStr);
  if (docBytes.length > MAX_DOC_BYTES) return json({ error: 'Preset too large.' }, 413);

  let thumbBytes = null;
  if (typeof body.thumb === 'string' && body.thumb.startsWith('data:image/png;base64,')) {
    const b64 = body.thumb.slice('data:image/png;base64,'.length);
    if (b64.length <= MAX_THUMB_B64) {
      try {
        const decoded = Buffer.from(b64, 'base64');
        if (decoded.length >= 16 && PNG_MAGIC.every((v, i) => decoded[i] === v)) thumbBytes = decoded;
      } catch { /* keep null */ }
    }
  }

  // Only credit a fork to a parent that actually exists, otherwise anyone can
  // conjure stat: keys and inflate arbitrary fork counts.
  if (parent) {
    const p = await env.PRESETS.getWithMetadata('preset:' + parent, 'stream').catch(() => null);
    if (p && p.value) p.value.cancel().catch(() => {});
    else parent = '';
  }

  const id = makeId();
  const stamp = invTs(Date.now());
  const summary = makeSummary({
    title, desc, tags,
    authorId: user ? user.id : '',
    authorName: user ? user.name : 'anonymous',
    authorHandle: user ? user.handle : '',
    created, visibility, parent, likes: 0,
    pk: visibility === 'public' ? 'pidx:' + stamp + '-' + id : '',
    uk: user ? 'uidx:' + user.id + ':' + stamp + '-' + id : '',
  });

  await env.PRESETS.put('preset:' + id, docBytes.buffer, { metadata: summary });
  try {
    if (summary.pk) await env.PRESETS.put(summary.pk, '1', { metadata: summary });
    if (summary.uk) await env.PRESETS.put(summary.uk, '1', { metadata: summary });
    if (thumbBytes) {
      // Carry visibility on the thumbnail too: the image is the pattern, so it
      // needs the same gate without a second lookup on every request.
      await env.PRESETS.put('thumb:' + id, thumbBytes.buffer.slice(
        thumbBytes.byteOffset, thumbBytes.byteOffset + thumbBytes.byteLength),
        { metadata: { visibility, authorId: summary.authorId || '' } });
    }
    await env.PRESETS.put('stat:' + id, JSON.stringify({ views: 0, likes: 0, forks: 0 }));
    if (parent) await bumpStat(env, parent, 'forks', 1);
    await env.PRESETS.put(rateKey, String(count + 1), { expirationTtl: 1200 });
  } catch (e) {
    // The document itself is stored; index/thumb/stat writes are best-effort
    // (KV rejects >1 write/sec to the same key and enforces daily quotas).
    console.warn('share bookkeeping write failed:', e && e.message);
  }

  return json({ id, url: '/view/' + id });
}

// ── reads ─────────────────────────────────────────────────────────────────────

function summaryToItem(id, m, stats) {
  return {
    id,
    title: (m && m.title) || 'untitled',
    desc: (m && m.desc) || '',
    tags: (m && m.tags) || [],
    author: {
      name: (m && m.authorName) || 'anonymous',
      handle: (m && m.authorHandle) || '',
    },
    created: (m && m.created) || '',
    visibility: (m && m.visibility) || 'public',
    parent: (m && m.parent) || '',
    likes: (m && m.likes) || 0,
    ...(stats ? { stats } : {}),
  };
}

// Walk an index prefix across KV pages. Sorting and searching happen over the
// whole set, so results never silently drop the tail.
async function listIndex(env, prefix, max = MAX_INDEX_KEYS) {
  const keys = [];
  let cursor;
  do {
    const page = await env.PRESETS.list({ prefix, limit: 1000, cursor });
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && keys.length < max);
  return keys.slice(0, max);
}

async function handleList(env, url) {
  const sort = url.searchParams.get('sort') === 'likes' ? 'likes' : 'new';
  const q = (url.searchParams.get('q') || '').toLowerCase().slice(0, 60);
  const keys = await listIndex(env, 'pidx:');
  let items = keys.map(k => summaryToItem(idFromIndexKey(k.name), k.metadata));
  if (q) {
    items = items.filter(it =>
      it.title.toLowerCase().includes(q) ||
      it.author.name.toLowerCase().includes(q) ||
      it.tags.some(t => t.includes(q)));
  }
  if (sort === 'likes') items.sort((a, b) => (b.likes - a.likes) || (a.created < b.created ? 1 : -1));
  const total = items.length;
  items = items.slice(0, LIST_LIMIT);
  // Short shared cache keeps gallery traffic off the KV list quota.
  return json({ items, sort, total }, 200, { 'Cache-Control': 'public, max-age=30' });
}

async function handleShaderMeta(request, env, id, countView) {
  const entry = await env.PRESETS.getWithMetadata('preset:' + id, 'stream');
  if (!entry || !entry.value) return json({ error: 'not found' }, 404);
  entry.value.cancel().catch(() => {});
  const m = entry.metadata || {};

  const user = await getSessionUser(request, env);
  const isMine = Boolean(user && m.authorId && user.id === m.authorId);
  if (m.visibility === 'private' && !isMine) return json({ error: 'not found' }, 404);

  let stats = await getStats(env, id);
  if (countView) {
    // Exact while a pattern is quiet, sampled once it is popular: a KV write
    // per pageview would hit the per-key write ceiling and the daily quota.
    if (stats.views < VIEW_EXACT_LIMIT) {
      stats = await bumpStat(env, id, 'views', 1);
    } else if (Math.random() < 1 / VIEW_SAMPLE) {
      stats = await bumpStat(env, id, 'views', VIEW_SAMPLE);
    }
  }

  const item = summaryToItem(id, m, stats);
  item.isMine = isMine;
  item.likedByMe = Boolean(user && (await env.PRESETS.get(`like:${id}:${user.id}`)));

  if (item.parent) {
    const p = await env.PRESETS.getWithMetadata('preset:' + item.parent, 'stream').catch(() => null);
    if (p && p.value) {
      p.value.cancel().catch(() => {});
      item.parentTitle = (p.metadata && p.metadata.title) || 'a pattern';
      item.parentAuthor = (p.metadata && p.metadata.authorName) || '';
    }
  }
  return json(item);
}

// Private content must never be stored by a shared cache, and the response
// varies with the session cookie.
function assetCacheHeaders(visibility) {
  return visibility === 'private'
    ? { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }
    : { 'Cache-Control': 'public, max-age=31536000, immutable' };
}

async function isOwner(request, env, authorId) {
  if (!authorId) return false;
  const user = await getSessionUser(request, env);
  return Boolean(user && user.id === authorId);
}

async function handlePreset(request, env, idPart) {
  const isPng = idPart.endsWith('.png');
  const id = idPart.replace(/\.png$/, '').replace(/\.json$/, '');

  if (isPng) {
    const entry = await env.PRESETS.getWithMetadata('thumb:' + id, 'stream');
    if (!entry || !entry.value) return new Response('not found', { status: 404 });
    const meta = entry.metadata || {};
    if (meta.visibility === 'private' && !(await isOwner(request, env, meta.authorId))) {
      entry.value.cancel().catch(() => {});
      return new Response('not found', { status: 404 });
    }
    return new Response(entry.value, {
      headers: {
        'Content-Type': 'image/png',
        'X-Content-Type-Options': 'nosniff',
        ...assetCacheHeaders(meta.visibility),
      },
    });
  }

  const entry = await env.PRESETS.getWithMetadata('preset:' + id, 'stream');
  if (!entry || !entry.value) return json({ error: 'not found' }, 404);
  const meta = entry.metadata || {};
  if (meta.visibility === 'private' && !(await isOwner(request, env, meta.authorId))) {
    entry.value.cancel().catch(() => {});
    return json({ error: 'not found' }, 404);
  }
  return new Response(entry.value, {
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      ...assetCacheHeaders(meta.visibility),
    },
  });
}

async function handleUserProfile(request, env, handle) {
  const userId = await env.PRESETS.get('handle:' + handle.toLowerCase());
  if (!userId) return json({ error: 'not found' }, 404);
  const user = await env.PRESETS.get('user:' + userId, 'json');
  if (!user) return json({ error: 'not found' }, 404);

  const me = await getSessionUser(request, env);
  const isMe = Boolean(me && me.id === userId);

  const keys = await listIndex(env, 'uidx:' + userId + ':');
  const items = keys
    .map(k => summaryToItem(idFromIndexKey(k.name), k.metadata))
    .filter(it => isMe || it.visibility === 'public')
    .slice(0, LIST_LIMIT);

  return json({ user: publicUser(user), items, isMe });
}

// ── likes, comments, delete ───────────────────────────────────────────────────

async function handleLike(request, env, url, id) {
  if (!requireSameOrigin(request, url)) return json({ error: 'forbidden' }, 403);
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Sign in to like patterns.' }, 401);

  const entry = await env.PRESETS.getWithMetadata('preset:' + id, 'stream');
  if (!entry || !entry.value) return json({ error: 'not found' }, 404);
  entry.value.cancel().catch(() => {});

  // A delete that lands between the lookup above and the writes below would
  // otherwise resurrect the index key as a ghost gallery card.
  if (await env.PRESETS.get('del:' + id)) return json({ error: 'not found' }, 404);

  const likeKey = `like:${id}:${user.id}`;
  const existing = await env.PRESETS.get(likeKey);
  let liked;
  if (existing) {
    await env.PRESETS.delete(likeKey);
    liked = false;
  } else {
    await env.PRESETS.put(likeKey, '1');
    liked = true;
  }

  // Count the like keys rather than incrementing a counter: KV has no atomic
  // increment, so a read-modify-write loses concurrent likes permanently.
  // Counting is self-healing — it is always the truth.
  let likeCount = 0;
  let cursor;
  do {
    const page = await env.PRESETS.list({ prefix: `like:${id}:`, limit: 1000, cursor });
    likeCount += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const stats = await getStats(env, id);
  stats.likes = likeCount;
  await env.PRESETS.put('stat:' + id, JSON.stringify(stats)).catch(e =>
    console.warn('like stat write failed', e && e.message));

  // Mirror the count onto the small index keys so "most liked" sorting works
  // without reading every pattern's stats (the document itself is left alone).
  const m = entry.metadata || {};
  const updated = { ...m, likes: stats.likes };
  for (const key of [m.pk, m.uk]) {
    if (!key) continue;
    try {
      await env.PRESETS.put(key, '1', { metadata: updated });
    } catch (e) {
      console.warn('like metadata mirror failed', e && e.message);
    }
  }

  return json({ liked, likes: stats.likes });
}

// A comment thread is as visible as the pattern it belongs to.
async function commentGate(request, env, id) {
  const entry = await env.PRESETS.getWithMetadata('preset:' + id, 'stream');
  if (!entry || !entry.value) return { ok: false };
  entry.value.cancel().catch(() => {});
  const m = entry.metadata || {};
  if (m.visibility === 'private' && !(await isOwner(request, env, m.authorId))) return { ok: false };
  return { ok: true, meta: m };
}

async function handleGetComments(request, env, id) {
  const gate = await commentGate(request, env, id);
  if (!gate.ok) return json({ error: 'not found' }, 404);
  const list = await env.PRESETS.list({ prefix: 'cmt:' + id + ':', limit: 300 });
  const items = list.keys.map(k => {
    const { userId, ...rest } = k.metadata || {};
    return { key: k.name, ...rest };
  });
  return json({ items }, 200, { 'Cache-Control': 'no-store' });
}

async function handlePostComment(request, env, url, id) {
  if (!requireSameOrigin(request, url)) return json({ error: 'forbidden' }, 403);
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Sign in to comment.' }, 401);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateKey = `crate:${ip}:${Math.floor(Date.now() / 600000)}`;
  const count = parseInt((await env.PRESETS.get(rateKey)) || '0', 10);
  if (count >= MAX_COMMENTS_PER_BUCKET) return json({ error: 'Too many comments — slow down.' }, 429);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body.' }, 400); }
  // The whole comment lives in KV metadata (so listing a thread costs one
  // operation), and that metadata is capped — keep the limit at what always
  // fits rather than silently truncating what the author typed.
  const raw = cleanText(body.text, MAX_COMMENT_CHARS + 1);
  if (!raw) return json({ error: 'Comment is empty.' }, 400);
  if (raw.length > MAX_COMMENT_CHARS) {
    return json({ error: `Comments are limited to ${MAX_COMMENT_CHARS} characters.` }, 400);
  }
  const text = raw;

  const gate = await commentGate(request, env, id);
  if (!gate.ok) return json({ error: 'not found' }, 404);

  const created = new Date().toISOString();
  const meta = {
    userId: user.id,
    name: user.name,
    handle: user.handle,
    picture: user.picture || '',
    text,
    created,
  };
  // Ascending timestamp key: KV lists lexicographically, so comments come back
  // oldest-first the way a comment thread reads.
  const key = `cmt:${id}:${String(Date.now()).padStart(14, '0')}-${makeId(6)}`;
  const stored = fitMetadata(meta);
  await env.PRESETS.put(key, '1', { metadata: stored });
  await env.PRESETS.put(rateKey, String(count + 1), { expirationTtl: 1200 }).catch(() => {});

  // Echo what was actually stored, so the thread never shows text that is not
  // there on reload.
  const { userId, ...visible } = stored;
  return json({ ok: true, comment: { key, ...visible } });
}

async function handleDelete(request, env, url, id) {
  if (!requireSameOrigin(request, url)) return json({ error: 'forbidden' }, 403);
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Sign in first.' }, 401);

  const entry = await env.PRESETS.getWithMetadata('preset:' + id, 'stream');
  if (!entry || !entry.value) return json({ error: 'not found' }, 404);
  entry.value.cancel().catch(() => {});
  const m = entry.metadata || {};
  if (!m.authorId || m.authorId !== user.id) return json({ error: 'Not your pattern.' }, 403);

  // Tombstone first, so a like landing mid-delete cannot recreate the index.
  await env.PRESETS.put('del:' + id, '1', { expirationTtl: 3600 }).catch(() => {});

  for (const key of ['preset:' + id, 'thumb:' + id, 'stat:' + id, m.pk, m.uk]) {
    if (key) await env.PRESETS.delete(key).catch(() => {});
  }
  // Dependents: the comment thread would otherwise stay publicly readable.
  for (const prefix of [`like:${id}:`, `cmt:${id}:`]) {
    let cursor;
    do {
      const page = await env.PRESETS.list({ prefix, limit: 1000, cursor }).catch(() => null);
      if (!page) break;
      for (const k of page.keys) await env.PRESETS.delete(k.name).catch(() => {});
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
  return json({ ok: true });
}

// ── HTML pages ────────────────────────────────────────────────────────────────

class MetaRewriter {
  constructor(map) { this.map = map; }
  element(el) {
    const key = el.getAttribute('data-mo');
    const value = this.map[key];
    if (value === undefined) return;
    if (el.tagName === 'title') el.setInnerContent(value);
    else el.setAttribute('content', value);
  }
}

// Workers Assets serves an HTML file at its extension-less path: with the
// default html_handling ("auto-trailing-slash") a request for "/view.html" is
// answered with a 307 to "/view", and the ASSETS binding applies the same
// rules — so fetching the file name here would hand the browser a redirect
// instead of the page. Ask for the pretty path, keeping the file name as a
// fallback in case html_handling is ever turned off.
// Pages rendered by the Worker bypass the static-asset _headers file, so they
// carry their own policy. Google profile pictures are served from lh3 —
// everything else must be same-origin.
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https://lh3.googleusercontent.com; connect-src 'self'; " +
  "frame-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

function pageHeaders(extra = {}) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': PAGE_CSP,
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

async function fetchPage(env, origin, name) {
  const pretty = await env.ASSETS.fetch(new URL('/' + name, origin));
  if (pretty.ok) return pretty;
  if (pretty.body) pretty.body.cancel().catch(() => {});
  return env.ASSETS.fetch(new URL('/' + name + '.html', origin));
}

async function renderViewPage(request, env, url, id) {
  const asset = await fetchPage(env, url.origin, 'view');
  if (!asset.ok) return asset;

  const entry = await env.PRESETS.getWithMetadata('preset:' + id, 'stream').catch(() => null);
  if (!entry || !entry.value) {
    return new Response(await notFoundHtml(url.origin), { status: 404, headers: pageHeaders() });
  }
  entry.value.cancel().catch(() => {});
  const m = entry.metadata || {};
  // The OG tags carry the title and description, so this page needs the same
  // visibility gate the JSON API applies — crawlers and link unfurlers read it.
  if (m.visibility === 'private' && !(await isOwner(request, env, m.authorId))) {
    return new Response(await notFoundHtml(url.origin), { status: 404, headers: pageHeaders() });
  }
  const title = m.title || 'untitled';
  const author = m.authorName || 'anonymous';
  const map = {
    title: `${title} — MathOrnament`,
    'og:title': title,
    'og:description': m.desc || `Symmetric reaction-diffusion pattern by ${author}. Open it live and remix it.`,
    'og:image': `${url.origin}/api/preset/${id}.png`,
    'og:url': `${url.origin}/view/${id}`,
  };
  const extra = m.visibility === 'public' ? {} : { 'X-Robots-Tag': 'noindex' };
  return new HTMLRewriter()
    .on('[data-mo]', new MetaRewriter(map))
    .transform(new Response(asset.body, { status: 200, headers: pageHeaders(extra) }));
}

async function notFoundHtml(origin) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Not found — MathOrnament</title>${PAGE_STYLE}</head>
<body>
<div style="text-align:center"><h1>Pattern not found</h1>
<p>This link doesn't exist, was deleted, or is private.</p>
<p><a href="${escapeHtml(origin)}/">Back to the gallery</a></p></div></body></html>`;
}

async function serveAsset(env, url, name) {
  const resp = await fetchPage(env, url.origin, name);
  return new Response(resp.body, { status: resp.status, headers: pageHeaders() });
}

// ── router ────────────────────────────────────────────────────────────────────

const SHADER_ID = '[A-Za-z0-9_-]{1,64}';

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;
  const isRead = method === 'GET' || method === 'HEAD';

  // auth
  if (path === '/auth/login' && isRead) return handleLogin(request, env, url);
  if (path === '/auth/callback' && isRead) return handleAuthCallback(request, env, url);
  if (path === '/auth/logout' && method === 'POST') return handleLogout(request, env, url);

  if (path === '/api/me' && isRead) {
    const user = await getSessionUser(request, env);
    return json({ user: publicUser(user), authConfigured: authConfigured(env) });
  }

  // publishing + reads
  if (path === '/api/share' && method === 'POST') return handleShare(request, env, url);
  if (path === '/api/list' && isRead) return handleList(env, url);

  let m;
  if ((m = path.match(new RegExp(`^/api/shader/(${SHADER_ID})$`))) && isRead) {
    return handleShaderMeta(request, env, m[1], url.searchParams.get('view') === '1');
  }
  if ((m = path.match(new RegExp(`^/api/preset/(${SHADER_ID}(?:\\.json|\\.png)?)$`))) && isRead) {
    return handlePreset(request, env, m[1]);
  }
  if ((m = path.match(new RegExp(`^/api/user/([A-Za-z0-9_-]{1,40})$`))) && isRead) {
    return handleUserProfile(request, env, m[1]);
  }
  if ((m = path.match(new RegExp(`^/api/like/(${SHADER_ID})$`))) && method === 'POST') {
    return handleLike(request, env, url, m[1]);
  }
  if ((m = path.match(new RegExp(`^/api/comments/(${SHADER_ID})$`)))) {
    if (isRead) return handleGetComments(request, env, m[1]);
    if (method === 'POST') return handlePostComment(request, env, url, m[1]);
  }
  if ((m = path.match(new RegExp(`^/api/delete/(${SHADER_ID})$`))) && method === 'POST') {
    return handleDelete(request, env, url, m[1]);
  }

  // pages
  if ((m = path.match(new RegExp(`^/view/(${SHADER_ID})$`))) && isRead) {
    return renderViewPage(request, env, url, m[1]);
  }
  if ((m = path.match(new RegExp(`^/s/(${SHADER_ID})$`))) && isRead) {
    return Response.redirect(url.origin + '/view/' + m[1], 301);
  }
  if ((m = path.match(/^\/user\/([A-Za-z0-9_-]{1,40})$/)) && isRead) {
    return serveAsset(env, url, 'user');
  }
  if (path === '/new' && isRead) {
    return Response.redirect(url.origin + '/apps/symsim/gray_scott/edit', 302);
  }

  if (path.startsWith('/api/') || path.startsWith('/auth/')) return json({ error: 'not found' }, 404);
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (e) {
      console.error('worker error:', e && e.stack);
      return json({ error: 'internal error' }, 500);
    }
  },
};
