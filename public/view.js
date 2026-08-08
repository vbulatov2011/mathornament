/* MathOrnament — pattern page (/view/<id>).
 *
 * Live viewer (kiosk simulator in an iframe), metadata, fork/like/share actions,
 * a lazily loaded Parameters panel and the comment thread.
 *
 * Every piece of user text goes through textContent / el(), never innerHTML.
 */

import { el, editorUrl, timeAgo, getMe, avatar, toast, buildNav } from '/site.js';

// Workers Assets serves HTML at its extension-less path and 307-redirects
// "…_simple.html" here, so ask for the canonical URL directly: one fewer round
// trip per page load, and it is the path the CSP rule in /_headers is keyed to.
const VIEWER_PAGE = '/apps/symsim/gray_scott/embed';

/** Orbifold signature → IUC name, for the 17 wallpaper groups. */
const IUC_NAMES = {
    'O': 'p1', 'XX': 'pg', '**': 'pm', '*X': 'cm',
    '2222': 'p2', '22X': 'pgg', '22*': 'pmg', '*2222': 'pmm', '2*22': 'cmm',
    '333': 'p3', '*333': 'p3m1', '3*3': 'p31m',
    '442': 'p4', '*442': 'p4m', '4*2': 'p4g',
    '632': 'p6', '*632': 'p6m',
};

// ── small helpers ─────────────────────────────────────────────────────────────

const root = document.getElementById('view');

function patternId() {
    const m = location.pathname.match(/^\/view\/([A-Za-z0-9_-]{1,64})\/?$/);
    return m ? m[1] : '';
}

const ID = patternId();

const presetUrl = id => '/api/preset/' + encodeURIComponent(id);
const thumbUrl = id => '/api/preset/' + encodeURIComponent(id) + '.png';
const loginUrl = () => '/auth/login?next=' + encodeURIComponent(location.pathname + location.search);

function viewerUrl(id) {
    return VIEWER_PAGE + '#' + encodeURIComponent(JSON.stringify({ preset: presetUrl(id) }));
}

function count(n) {
    return Number(n || 0).toLocaleString();
}

function plural(n, word) {
    return count(n) + ' ' + word + (Number(n) === 1 ? '' : 's');
}

function link(href, cls, text) {
    const a = el('a', cls, text);
    a.href = href;
    return a;
}

function timeEl(iso) {
    const t = el('time', 'time-ago', timeAgo(iso) || '');
    if (iso) {
        t.dateTime = iso;
        const d = new Date(iso);
        if (!Number.isNaN(d.getTime())) t.title = d.toLocaleString();
    }
    return t;
}

function icon(glyph) {
    const s = el('span', null, glyph);
    s.setAttribute('aria-hidden', 'true');
    return s;
}

/**
 * avatar(), but decorative: the name is always rendered right beside it, so the
 * picture is hidden from screen readers instead of announcing the name twice.
 * A photo that fails to load (or is blocked by the image CSP) falls back to the
 * initial.
 */
function safeAvatar(user, big) {
    const node = avatar(user, big);
    if (node.tagName === 'IMG') {
        node.alt = '';
        node.addEventListener('error', () => {
            node.replaceWith(safeAvatar({ name: (user && user.name) || '' }, big));
        });
    } else {
        node.setAttribute('aria-hidden', 'true');
    }
    return node;
}

// ── page states ───────────────────────────────────────────────────────────────

/** The empty stage + "loading" line, matching the markup shipped in view.html. */
function showBoot() {
    root.textContent = '';
    const skeleton = el('div', 'view-stage');
    skeleton.setAttribute('aria-hidden', 'true');
    const boot = el('p', 'empty view-boot', 'Loading pattern…');
    boot.setAttribute('role', 'status');
    root.append(skeleton, boot);
}

function stateBox(heading, message, actionNode) {
    root.textContent = '';
    const box = el('div', 'state-box');
    box.append(el('h1', null, heading), el('p', 'empty', message));
    if (actionNode) box.appendChild(actionNode);
    root.appendChild(box);
}

function renderNotFound() {
    document.title = 'Not found — MathOrnament';
    stateBox(
        'Pattern not found',
        'This pattern does not exist, was deleted, or is private.',
        link('/', 'btn btn-primary', 'Browse the gallery'),
    );
}

function renderError() {
    const retry = el('button', 'btn btn-primary', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => { showBoot(); load(); });
    stateBox('Could not load this pattern', 'The network request failed. Check your connection and try again.', retry);
}

// ── live viewer ───────────────────────────────────────────────────────────────

function buildStage(item) {
    const stage = el('div', 'view-stage');

    const note = el('div', 'stage-note', 'Starting the live simulation…');

    let poster = el('img', 'stage-poster');
    poster.src = thumbUrl(item.id);
    poster.alt = 'Still preview of ' + item.title;
    poster.addEventListener('error', () => { poster.remove(); poster = null; });

    function start() {
        const frame = el('iframe');
        frame.title = 'Live simulation of ' + item.title;
        frame.addEventListener('load', () => {
            // The document loads before the first frame is drawn; hold the still
            // image a moment longer so the swap is not a black flash.
            setTimeout(() => stage.classList.add('is-live'), 900);
        });
        stage.prepend(frame);

        // Only point the frame at the viewer once the stage has its real size.
        // The simulator sizes its GL targets once, at startup, so booting it in a
        // not-yet-laid-out frame leaves it rendering a flat colour.
        let waited = 0;
        (function whenSized() {
            if (frame.getBoundingClientRect().width > 32 || waited > 40) {
                frame.src = viewerUrl(item.id);
                return;
            }
            waited++;
            requestAnimationFrame(whenSized);
        })();
    }

    // Respect data-saver: a pattern document is several megabytes.
    const saveData = Boolean(navigator.connection && navigator.connection.saveData);
    if (saveData) {
        note.textContent = 'Data saver is on — the simulation is paused.';
        const startBtn = el('button', 'stage-start');
        startBtn.type = 'button';
        startBtn.setAttribute('aria-label', 'Run the live simulation of ' + item.title);
        startBtn.append(el('span', 'stage-start-icon', '▶'), el('span', 'stage-start-text', 'Run live simulation'));
        startBtn.addEventListener('click', () => {
            startBtn.remove();
            note.textContent = 'Starting the live simulation…';
            start();
        });
        if (poster) stage.appendChild(poster);
        stage.append(note, startBtn);
        return stage;
    }

    start();
    if (poster) stage.appendChild(poster);
    stage.appendChild(note);
    return stage;
}

// ── title block, stats, actions ───────────────────────────────────────────────

function buildByline(item) {
    const row = el('div', 'byline');
    const author = item.author || {};
    const name = author.name || 'anonymous';

    row.appendChild(safeAvatar({ name }));
    if (author.handle) {
        row.appendChild(link('/user/' + encodeURIComponent(author.handle), 'author', name));
    } else {
        row.appendChild(el('span', 'author', name));
    }

    if (item.created) {
        row.append(el('span', 'sep', '·'), timeEl(item.created));
    }
    if (item.visibility && item.visibility !== 'public') {
        row.appendChild(el('span', 'tag', item.visibility));
    }
    return row;
}

function buildStats(stats) {
    const list = el('ul', 'statline');
    const likeValue = el('b', null, count(stats.likes));

    const views = el('li');
    views.append(el('b', null, count(stats.views)), document.createTextNode(' views'));

    const likes = el('li');
    likes.append(likeValue, document.createTextNode(' likes'));

    const forks = el('li');
    forks.append(el('b', null, count(stats.forks)), document.createTextNode(' forks'));

    list.append(views, likes, forks);
    return { node: list, setLikes: n => { likeValue.textContent = count(n); } };
}

function buildLikeButton(item, user, authConfigured, setLikes) {
    const liked0 = Boolean(item.likedByMe);
    const n0 = (item.stats && item.stats.likes) || 0;

    const heart = icon(liked0 ? '♥' : '♡');
    const label = el('span', 'like-count', count(n0));

    if (!user) {
        const a = link(loginUrl(), 'btn btn-like');
        a.append(heart, label);
        a.setAttribute('aria-label', 'Sign in to like this pattern (' + plural(n0, 'like') + ')');
        if (!authConfigured) a.title = 'Sign-in is not configured on this site yet';
        return a;
    }

    const btn = el('button', 'btn btn-like' + (liked0 ? ' liked' : ''));
    btn.type = 'button';
    btn.append(heart, label);

    const apply = (liked, likes) => {
        btn.classList.toggle('liked', liked);
        btn.setAttribute('aria-pressed', String(liked));
        btn.setAttribute('aria-label', (liked ? 'Unlike this pattern' : 'Like this pattern')
            + ' (' + plural(likes, 'like') + ')');
        heart.textContent = liked ? '♥' : '♡';
        label.textContent = count(likes);
        setLikes(likes);
    };
    apply(liked0, n0);

    btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
            const r = await fetch('/api/like/' + encodeURIComponent(item.id), {
                method: 'POST',
                credentials: 'same-origin',
            });
            if (r.status === 401) { location.href = loginUrl(); return; }
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
            apply(Boolean(data.liked), data.likes);
        } catch (e) {
            toast('Could not save your like — try again.');
        } finally {
            btn.disabled = false;
        }
    });
    return btn;
}

async function copyLink() {
    const url = location.href;
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(url);
            toast('Link copied');
            return;
        }
        throw new Error('clipboard unavailable');
    } catch (e) {
        const ta = el('textarea', 'offscreen');
        ta.value = url;
        ta.setAttribute('readonly', '');
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
        ta.remove();
        toast(ok ? 'Link copied' : 'Could not copy — the link is in the address bar.');
    }
}

function buildActions(item, user, authConfigured, setLikes) {
    const row = el('div', 'actions');

    const fork = link(editorUrl(presetUrl(item.id), item.id), 'btn btn-primary');
    fork.append(icon('⑂'), el('span', null, 'Fork'));
    fork.title = 'Fork — open a copy in the editor; publishing it credits this pattern as the parent';

    const open = link(editorUrl(presetUrl(item.id)), 'btn', 'Open in editor');

    const copy = el('button', 'btn', 'Copy link');
    copy.type = 'button';
    copy.addEventListener('click', copyLink);

    row.append(fork, buildLikeButton(item, user, authConfigured, setLikes), open, copy);

    if (item.isMine) {
        const del = el('button', 'btn btn-danger', 'Delete');
        del.type = 'button';
        del.addEventListener('click', async () => {
            if (!confirm('Delete “' + item.title + '”? This cannot be undone.')) return;
            del.disabled = true;
            try {
                const r = await fetch('/api/delete/' + encodeURIComponent(item.id), {
                    method: 'POST',
                    credentials: 'same-origin',
                });
                const data = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
                location.href = '/';
            } catch (e) {
                toast(e.message || 'Could not delete this pattern.');
                del.disabled = false;
            }
        });
        const sep = el('span', 'action-sep');
        sep.setAttribute('aria-hidden', 'true');
        row.append(sep, del);
    }
    return row;
}

function buildHead(item, user, authConfigured) {
    const head = el('section', 'view-head');
    const stats = item.stats || { views: 0, likes: 0, forks: 0 };

    head.appendChild(el('h1', 'view-title', item.title || 'untitled'));
    head.appendChild(buildByline(item));

    const statBlock = buildStats(stats);
    head.appendChild(statBlock.node);

    if (item.visibility === 'private') {
        head.appendChild(el('p', 'notice', 'This pattern is private — only you can open this page.'));
    } else if (item.visibility === 'unlisted') {
        head.appendChild(el('p', 'notice', 'This pattern is unlisted — it stays out of the gallery, but anyone with the link can see it.'));
    }

    head.appendChild(buildActions(item, user, authConfigured, statBlock.setLikes));

    if (item.parent) {
        const p = el('p', 'parent-note');
        p.appendChild(document.createTextNode('Forked from '));
        p.appendChild(link('/view/' + encodeURIComponent(item.parent), null, item.parentTitle || 'a pattern'));
        if (item.parentAuthor) p.appendChild(document.createTextNode(' by ' + item.parentAuthor));
        head.appendChild(p);
    }

    if (item.desc) head.appendChild(el('p', 'view-desc', item.desc));

    if (item.tags && item.tags.length) {
        const tags = el('nav', 'pill-row view-tags');
        tags.setAttribute('aria-label', 'Tags');
        for (const tag of item.tags) {
            tags.appendChild(link('/?q=' + encodeURIComponent(tag), 'tag', '#' + tag));
        }
        head.appendChild(tags);
    }
    return head;
}

// ── parameters panel (lazy: the document carries a multi-MB buffer) ───────────

function findHolder(node, key, depth) {
    if (!node || typeof node !== 'object' || depth > 8) return null;
    if (!Array.isArray(node) && node[key] && typeof node[key] === 'object') return node;
    const values = Array.isArray(node) ? node : Object.values(node);
    for (const v of values) {
        if (v && typeof v === 'object') {
            const hit = findHolder(v, key, depth + 1);
            if (hit) return hit;
        }
    }
    return null;
}

/** Find the GrayScottWorker's params inside a live-captured document. */
function findWorkerParams(node, depth) {
    if (depth > 12 || !node || typeof node !== 'object') return null;
    if (node.className === 'GrayScottWorker' && node.params && typeof node.params === 'object') {
        return node.params;
    }
    for (const key of Object.keys(node)) {
        const hit = findWorkerParams(node[key], depth + 1);
        if (hit) return hit;
    }
    return null;
}

function num(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    if (Number.isInteger(v)) return String(v);
    const s = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    return (s === '0' || s === '-0') ? v.toExponential(2) : s;
}

/** Pull a handful of readable values out of a stored pattern document. */
function readParams(doc) {
    const rows = [];
    const params = (doc && doc.params) || {};

    const sym = params.symmetry || {};
    const group = sym.group || {};
    const orbifold = group.params && typeof group.params.type === 'string' ? group.params.type : '';
    if (sym.groupType || orbifold) {
        rows.push({
            term: 'Symmetry',
            value: [sym.groupType, orbifold].filter(Boolean).join(' '),
            sub: IUC_NAMES[orbifold] ? '(' + IUC_NAMES[orbifold] + ')' : '',
        });
    }

    // Two shapes in the wild: the curated presets nest a `simParams` object,
    // while documents captured from the running editor put the same fields
    // directly on the GrayScottWorker entry of the pipeline's worker list.
    const holder = findHolder(params, 'simParams', 0);
    let sim = holder ? holder.simParams : null;
    if (!sim) sim = findWorkerParams(params, 0);

    if (holder && typeof holder.preset === 'string' && holder.preset) {
        rows.push({ term: 'Recipe', value: holder.preset });
    }

    if (sim) {
        const fields = [
            ['Feed', 'feedCoeff'],
            ['Kill', 'killCoeff'],
            ['Feed grad.', 'feedGradient', true],
            ['Kill grad.', 'killGradient', true],
            ['Steps/frame', 'stepsCount'],
            ['Time step', 'deltaT'],
        ];
        for (const [term, key, skipZero] of fields) {
            const v = num(sim[key]);
            if (v === null) continue;
            if (skipZero && sim[key] === 0) continue;
            rows.push({ term, value: v });
        }
        const buf = sim.buffer || {};
        if (typeof buf.width === 'number' && typeof buf.height === 'number') {
            rows.push({ term: 'Grid', value: buf.width + ' × ' + buf.height });
        }
    }

    if (holder && holder.simInit && typeof holder.simInit.initType === 'string') {
        rows.push({ term: 'Seeded by', value: holder.simInit.initType });
    }
    return rows;
}

function buildParamsPanel(id) {
    const panel = el('details', 'card params-card');
    const summary = el('summary', null, 'Parameters');
    const body = el('div', 'params-body');
    body.appendChild(el('p', 'empty', 'Expand to load the simulation values.'));
    panel.append(summary, body);

    let loaded = false;

    async function loadParams() {
        if (loaded) return;
        loaded = true;
        body.textContent = '';
        body.appendChild(el('p', 'empty', 'Loading…'));
        try {
            const r = await fetch(presetUrl(id), { credentials: 'same-origin' });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            // The document holds a multi-megabyte base64 buffer: read the few
            // fields we show and let the rest go straight back to the collector.
            const rows = readParams(await r.json());
            body.textContent = '';
            if (!rows.length) {
                body.appendChild(el('p', 'empty', 'This document does not record readable simulation values.'));
                return;
            }
            const dl = el('dl', 'dl');
            for (const row of rows) {
                const wrap = el('div', 'dl-row');
                const dd = el('dd', null, row.value);
                if (row.sub) dd.append(document.createTextNode(' '), el('span', 'sub', row.sub));
                wrap.append(el('dt', null, row.term), dd);
                dl.appendChild(wrap);
            }
            body.appendChild(dl);
        } catch (e) {
            loaded = false;
            body.textContent = '';
            body.appendChild(el('p', 'empty', 'Could not load the parameters.'));
            const retry = el('button', 'btn', 'Retry');
            retry.type = 'button';
            retry.addEventListener('click', loadParams);
            body.appendChild(retry);
        }
    }

    panel.addEventListener('toggle', () => { if (panel.open) loadParams(); });
    return panel;
}

// ── comments ──────────────────────────────────────────────────────────────────

function commentEl(c) {
    const li = el('li', 'comment');
    const who = { name: c.name || 'someone', picture: c.picture || '' };
    const pic = safeAvatar(who);

    if (c.handle) {
        const wrap = link('/user/' + encodeURIComponent(c.handle), null);
        wrap.appendChild(pic);
        wrap.setAttribute('aria-hidden', 'true');
        wrap.tabIndex = -1;
        li.appendChild(wrap);
    } else {
        li.appendChild(pic);
    }

    const body = el('div', 'comment-body');
    const head = el('div', 'comment-head');
    head.appendChild(c.handle
        ? link('/user/' + encodeURIComponent(c.handle), 'comment-name', who.name)
        : el('span', 'comment-name', who.name));
    head.appendChild(timeEl(c.created));
    body.append(head, el('p', 'comment-text', c.text || ''));
    li.appendChild(body);
    return li;
}

function buildComments(id, user, authConfigured) {
    const section = el('section', 'view-comments');
    section.setAttribute('aria-labelledby', 'comments-heading');

    const headBox = el('div', 'section-head');
    const heading = el('h2', null, 'Comments');
    heading.id = 'comments-heading';
    headBox.appendChild(heading);
    section.appendChild(headBox);

    const list = el('ol', 'comment-list');
    let total = 0;
    const setCount = n => { total = n; heading.textContent = n ? 'Comments (' + count(n) + ')' : 'Comments'; };

    // A comment can be posted before the existing thread has arrived; track
    // those so the fetched list neither reorders, duplicates nor un-counts them.
    let loaded = false;
    const postedEarly = new Set();

    // Composer
    if (user) {
        const form = el('form', 'composer');
        const label = el('label', 'composer-label', 'Add a comment');
        label.htmlFor = 'comment-text';
        const ta = el('textarea', 'input');
        ta.id = 'comment-text';
        ta.name = 'text';
        ta.maxLength = 1000;
        ta.rows = 3;
        ta.placeholder = 'What do you see in this pattern?';
        const rowBox = el('div', 'composer-row');
        const hint = el('span', 'composer-hint', 'Be kind. Up to 1000 characters.');
        const post = el('button', 'btn btn-primary', 'Post comment');
        post.type = 'submit';
        rowBox.append(hint, post);
        form.append(label, ta, rowBox);

        const submit = async () => {
            const text = ta.value.trim();
            if (!text) { toast('Write something first.'); ta.focus(); return; }
            post.disabled = true;
            try {
                const r = await fetch('/api/comments/' + encodeURIComponent(id), {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text }),
                });
                const data = await r.json().catch(() => ({}));
                if (r.status === 401) { location.href = loginUrl(); return; }
                if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
                const empty = list.parentNode && list.parentNode.querySelector('.comments-empty');
                if (empty) empty.remove();
                const posted = data.comment
                    || { name: user.name, handle: user.handle, picture: user.picture, text, created: new Date().toISOString() };
                list.appendChild(commentEl(posted));
                if (!loaded) postedEarly.add(posted.key || '');
                ta.value = '';
                setCount(total + 1);
                toast('Comment posted');
            } catch (e) {
                toast(e.message || 'Could not post your comment.');
            } finally {
                post.disabled = false;
            }
        };

        form.addEventListener('submit', ev => { ev.preventDefault(); submit(); });
        ta.addEventListener('keydown', ev => {
            if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') { ev.preventDefault(); submit(); }
        });
        section.appendChild(form);
    } else {
        const prompt = el('div', 'card signin-prompt');
        prompt.appendChild(el('p', null, 'Sign in to join the conversation.'));
        const a = link(loginUrl(), 'btn btn-primary', 'Sign in with Google');
        if (!authConfigured) a.title = 'Sign-in is not configured on this site yet';
        prompt.appendChild(a);
        section.appendChild(prompt);
    }

    section.appendChild(list);

    (async () => {
        const placeholder = el('p', 'empty comments-empty', 'Loading comments…');
        section.appendChild(placeholder);
        try {
            const r = await fetch('/api/comments/' + encodeURIComponent(id), { credentials: 'same-origin' });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const data = await r.json();
            const items = (Array.isArray(data.items) ? data.items : [])
                .filter(c => c && !postedEarly.has(c.key));
            loaded = true;
            // prepend, so a comment posted while this request was in flight
            // stays at the bottom of the thread where the author left it.
            const batch = document.createDocumentFragment();
            for (const c of items) batch.appendChild(commentEl(c));
            list.prepend(batch);
            setCount(items.length + postedEarly.size);
            if (items.length || postedEarly.size) placeholder.remove();
            else placeholder.textContent = 'No comments yet.';
        } catch (e) {
            loaded = true;
            placeholder.textContent = 'Could not load the comments.';
        }
    })();

    return section;
}

// ── assembly ──────────────────────────────────────────────────────────────────

function render(item, user, authConfigured) {
    root.textContent = '';
    root.appendChild(buildStage(item));

    const body = el('div', 'view-body');
    body.appendChild(buildHead(item, user, authConfigured));

    const aside = el('aside', 'view-aside');
    aside.setAttribute('aria-label', 'Simulation parameters');
    aside.appendChild(buildParamsPanel(item.id));
    body.appendChild(aside);

    body.appendChild(buildComments(item.id, user, authConfigured));
    root.appendChild(body);
}

let viewCounted = false;

async function load() {
    let item;
    let session = { user: null, authConfigured: false };
    try {
        const [resp, me] = await Promise.all([
            fetch('/api/shader/' + encodeURIComponent(ID) + (viewCounted ? '' : '?view=1'),
                { credentials: 'same-origin' }),
            getMe(),
        ]);
        session = me || session;
        if (resp.ok) viewCounted = true;
        if (resp.status === 404 || resp.status === 403) { renderNotFound(); return; }
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        item = await resp.json();
    } catch (e) {
        renderError();
        return;
    }
    if (!item || !item.id) { renderNotFound(); return; }
    if (!item.title) item.title = 'untitled';
    render(item, session.user, session.authConfigured);
}

buildNav();

// view.html ships the boot markup, so the first paint needs no work here.
if (!ID) renderNotFound();
else load();
