/* MathOrnament — /user/<handle> profile page.
 *
 * Reads the handle out of the path, fetches /api/user/<handle>, and renders the
 * member header plus their patterns. When the viewer is the profile owner the
 * API also hands back unlisted and private patterns; those are marked here.
 * Every string goes through textContent / el(), so nothing user-supplied can
 * ever become markup.
 */

import { el, avatar, buildNav, patternCard, timeAgo } from '/site.js';

const HANDLE_RE = /^[A-Za-z0-9_-]{1,40}$/;

const page = document.getElementById('page');

// ── helpers ───────────────────────────────────────────────────────────────────

function handleFromPath() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length < 2 || parts[0] !== 'user') return '';
    let raw = parts[1];
    try { raw = decodeURIComponent(raw); } catch { /* keep the raw segment */ }
    return HANDLE_RE.test(raw) ? raw : '';
}

function plural(n, word) {
    return n === 1 ? word : word + 's';
}

/** Normalises the API's visibility field to one of the three known values. */
function visibilityOf(item) {
    const v = item && item.visibility;
    return v === 'unlisted' || v === 'private' ? v : 'public';
}

function fullDate(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '';
    return new Date(t).toLocaleDateString(undefined, {
        year: 'numeric', month: 'long', day: 'numeric',
    });
}

function sortNewestFirst(items) {
    return items.slice().sort((a, b) => {
        const ta = Date.parse(a && a.created) || 0;
        const tb = Date.parse(b && b.created) || 0;
        return tb - ta;
    });
}

/** avatar() from site.js, with a fallback if the remote profile photo 404s. */
function bigAvatar(user) {
    const node = avatar(user, true);
    if (node.tagName === 'IMG') {
        // The name is rendered right beside the photo, so announcing it twice
        // would only add noise for screen readers.
        node.alt = '';
        node.addEventListener('error', () => {
            const initial = ((user && user.name) || '?').trim().charAt(0).toUpperCase() || '?';
            node.replaceWith(el('div', 'avatar avatar-lg', initial));
        });
    }
    return node;
}

function show(...nodes) {
    page.textContent = '';
    page.removeAttribute('aria-busy');
    page.append(...nodes);
}

function linkBtn(text, href, cls) {
    const a = el('a', cls || 'btn', text);
    a.href = href;
    return a;
}

// ── whole-page states ─────────────────────────────────────────────────────────

function renderLoading() {
    page.setAttribute('aria-busy', 'true');
    page.textContent = '';
    const p = el('p', 'empty', 'Loading profile…');
    p.setAttribute('role', 'status');
    page.appendChild(p);
}

function renderNotFound(handle) {
    document.title = 'No such user — MathOrnament';
    const box = el('section', 'state');
    box.appendChild(el('h1', null, 'No such user'));
    box.appendChild(el('p', null, handle
        ? 'There is no member with the handle @' + handle + '. The profile may have been removed, or the link may be mistyped.'
        : 'That profile link is not valid.'));
    box.appendChild(linkBtn('Back to the gallery', '/', 'btn btn-primary'));
    show(box);
}

function renderError(retry) {
    document.title = 'Profile — MathOrnament';
    const box = el('section', 'state');
    box.appendChild(el('h1', null, 'Could not load this profile'));
    box.appendChild(el('p', null, 'Something went wrong reaching the server. Check your connection and try again.'));
    const row = el('div', 'pill-row');
    const again = el('button', 'btn btn-primary', 'Try again');
    again.type = 'button';
    again.addEventListener('click', retry);
    row.append(again, linkBtn('Back to the gallery', '/'));
    box.appendChild(row);
    show(box);
}

// ── profile ───────────────────────────────────────────────────────────────────

function profileHeader(user, items, isMe) {
    const head = el('section', 'profile-head');
    head.appendChild(bigAvatar(user));

    const id = el('div', 'profile-id');
    id.appendChild(el('h1', 'profile-name', user.name || '@' + user.handle));

    const handleLine = el('p', 'profile-handle');
    handleLine.appendChild(el('span', null, '@' + user.handle));
    if (isMe) handleLine.appendChild(el('span', 'tag', 'this is you'));
    id.appendChild(handleLine);

    const facts = el('ul', 'profile-facts');

    const count = el('li');
    count.append(el('strong', null, String(items.length)), ' ' + plural(items.length, 'pattern'));
    facts.appendChild(count);

    const likes = items.reduce((n, it) => n + (Number(it.likes) || 0), 0);
    if (likes > 0) {
        const li = el('li');
        li.append(el('strong', null, String(likes)), ' ' + plural(likes, 'like') + ' received');
        facts.appendChild(li);
    }

    const since = fullDate(user.created);
    if (since) {
        const li = el('li');
        const t = el('time', null, since);
        t.dateTime = user.created;
        const ago = timeAgo(user.created);
        if (ago) t.title = 'Joined ' + ago;
        li.append('Member since ', t);
        facts.appendChild(li);
    }

    id.appendChild(facts);
    head.appendChild(id);

    if (isMe) {
        const actions = el('div', 'profile-actions');
        actions.appendChild(linkBtn('Create a new pattern', '/new', 'btn btn-primary'));
        head.appendChild(actions);
    }
    return head;
}

function patternsSection(user, items, isMe) {
    const section = el('section');

    const hidden = items.filter(it => visibilityOf(it) !== 'public');
    const counts = { public: 0, unlisted: 0, private: 0 };
    for (const it of items) counts[visibilityOf(it)] += 1;

    const head = el('div', 'section-head');
    head.appendChild(el('h2', null, 'Patterns'));

    let sub = '';
    if (!items.length) {
        sub = isMe ? 'Nothing published from this account yet.' : 'Nothing published yet.';
    } else if (isMe && hidden.length) {
        sub = ['public', 'unlisted', 'private']
            .filter(v => counts[v] > 0)
            .map(v => counts[v] + ' ' + v)
            .join(' · ');
    } else {
        sub = 'Newest first — open any pattern to run it live and remix it.';
    }
    head.appendChild(el('p', 'section-sub', sub));
    section.appendChild(head);

    if (isMe && hidden.length) {
        section.appendChild(el('p', 'notice',
            'Unlisted and private patterns are listed here with a chip and a dashed border. '
            + 'Only you can see them on this page — visitors see your public patterns only.'));
    }

    if (!items.length) {
        section.appendChild(emptyState(user, isMe));
        return section;
    }

    const grid = el('div', 'grid');
    for (const item of items) {
        const card = patternCard(item);
        if (visibilityOf(item) !== 'public') card.classList.add('card-hidden');
        grid.appendChild(card);
    }
    section.appendChild(grid);
    return section;
}

function emptyState(user, isMe) {
    const box = el('div', 'empty-box');
    if (isMe) {
        box.appendChild(el('p', null, 'No patterns yet.'));
        box.appendChild(el('p', null,
            'Open the editor, tune the reaction until it looks right, then hit Share to publish it here.'));
        box.appendChild(linkBtn('Create a new pattern', '/new', 'btn btn-primary'));
    } else {
        box.appendChild(el('p', null, 'No patterns yet.'));
        box.appendChild(el('p', null,
            (user.name || '@' + user.handle) + ' has not published anything public.'));
        box.appendChild(linkBtn('Browse the gallery', '/'));
    }
    return box;
}

function renderProfile(data) {
    const user = data.user;
    const isMe = Boolean(data.isMe);
    const items = sortNewestFirst(Array.isArray(data.items) ? data.items : []);

    document.title = (user.name || user.handle) + ' (@' + user.handle + ') — MathOrnament';

    show(profileHeader(user, items, isMe), patternsSection(user, items, isMe));
}

// ── boot ──────────────────────────────────────────────────────────────────────

async function load() {
    const handle = handleFromPath();
    if (!handle) {
        renderNotFound('');
        return;
    }

    renderLoading();

    let resp;
    try {
        resp = await fetch('/api/user/' + encodeURIComponent(handle), { credentials: 'same-origin' });
    } catch {
        renderError(load);
        return;
    }

    if (resp.status === 404) {
        renderNotFound(handle);
        return;
    }
    if (!resp.ok) {
        renderError(load);
        return;
    }

    let data;
    try {
        data = await resp.json();
    } catch {
        renderError(load);
        return;
    }

    if (!data || !data.user || !data.user.handle) {
        renderNotFound(handle);
        return;
    }
    renderProfile(data);
}

buildNav({});
load();
