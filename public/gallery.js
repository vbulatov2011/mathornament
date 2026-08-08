/* MathOrnament home page: community patterns (sortable, searchable) + featured presets.
 *
 * Sorting and clearing a search update the URL with history.pushState and re-fetch,
 * so the two sections never reload the whole page. The community and featured
 * sections load independently: if one fetch fails the other still renders.
 */

import { el, editorUrl, buildNav, patternCard } from '/site.js';

const PRESET_BASE = '/apps/symsim/gray_scott/';
const SORTS = [
    { key: 'new', label: 'Newest' },
    { key: 'likes', label: 'Most liked' },
];

const grid = document.getElementById('community');
const statusLine = document.getElementById('community-status');
const tabsHost = document.getElementById('sort-tabs');
const resultsBar = document.getElementById('results-bar');
const featuredGrid = document.getElementById('featured');
const featuredStatus = document.getElementById('featured-status');

// ── URL state ────────────────────────────────────────────────────────────────

function readState() {
    const p = new URLSearchParams(location.search);
    return {
        sort: p.get('sort') === 'likes' ? 'likes' : 'new',
        q: (p.get('q') || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    };
}

function urlFor(sort, q) {
    const p = new URLSearchParams();
    if (sort === 'likes') p.set('sort', sort);
    if (q) p.set('q', q);
    const query = p.toString();
    return query ? '/?' + query : '/';
}

function go(sort, q) {
    const next = urlFor(sort, q);
    if (next !== location.pathname + location.search) history.pushState({ sort, q }, '', next);
    render();
}

// ── small DOM helpers ────────────────────────────────────────────────────────

function setStatus(nodes, { quiet = false } = {}) {
    statusLine.textContent = '';
    statusLine.classList.toggle('sr-only', quiet);
    if (!nodes) {
        statusLine.hidden = true;
        return;
    }
    statusLine.hidden = false;
    for (const n of [].concat(nodes)) statusLine.append(n);
}

function actionButton(label, onClick) {
    const b = el('button', 'btn btn-quiet', label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
}

// Sorting, clearing a search and Back/Forward all change the query without a
// page load, so the shared nav's search box has to be pulled back in step —
// otherwise it keeps showing a term that is no longer being applied.
function syncNavSearch(q) {
    const box = document.querySelector('.nav-search');
    if (box && box !== document.activeElement && box.value !== q) box.value = q;
}

function skeletons(host, n) {
    host.textContent = '';
    host.setAttribute('aria-busy', 'true');
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
        const s = el('div', 'skel');
        s.setAttribute('aria-hidden', 'true');
        frag.appendChild(s);
    }
    host.appendChild(frag);
}

// ── sort tabs ────────────────────────────────────────────────────────────────

function buildTabs() {
    for (const s of SORTS) {
        const a = el('a', 'tab', s.label);
        a.href = urlFor(s.key, '');
        a.dataset.sort = s.key;
        a.addEventListener('click', ev => {
            // Leave modified clicks (new tab / new window) to the browser.
            if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) return;
            ev.preventDefault();
            go(s.key, readState().q);
        });
        tabsHost.appendChild(a);
    }
}

function syncTabs(sort, q) {
    for (const a of tabsHost.children) {
        const active = a.dataset.sort === sort;
        a.href = urlFor(a.dataset.sort, q);
        a.classList.toggle('is-active', active);
        if (active) a.setAttribute('aria-current', 'true');
        else a.removeAttribute('aria-current');
    }
}

// ── community patterns ───────────────────────────────────────────────────────

let loadToken = 0;

function showResultsBar(q, count) {
    resultsBar.textContent = '';
    if (!q) {
        resultsBar.hidden = true;
        return;
    }
    resultsBar.hidden = false;
    const text = el('span');
    text.append(
        el('strong', null, String(count)),
        document.createTextNode(count === 1 ? ' result for ' : ' results for '),
        el('strong', null, '“' + q + '”'),
    );
    resultsBar.append(text, actionButton('Clear search', () => go(readState().sort, '')));
}

async function loadCommunity(sort, q) {
    const token = ++loadToken;
    skeletons(grid, 8);
    setStatus([document.createTextNode('Loading patterns…')], { quiet: true });

    let items;
    try {
        const params = new URLSearchParams({ sort });
        if (q) params.set('q', q);
        const resp = await fetch('/api/list?' + params.toString(), { credentials: 'same-origin' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        items = Array.isArray(data.items) ? data.items : [];
    } catch (e) {
        if (token !== loadToken) return;
        grid.textContent = '';
        grid.removeAttribute('aria-busy');
        resultsBar.hidden = true;
        setStatus([
            document.createTextNode('Could not load community patterns. Check your connection and try again.'),
            actionButton('Retry', () => loadCommunity(sort, q)),
        ]);
        return;
    }
    if (token !== loadToken) return;

    grid.textContent = '';
    grid.removeAttribute('aria-busy');
    showResultsBar(q, items.length);

    if (!items.length) {
        if (q) {
            // The results bar above already says "0 results for …" and offers
            // the clear-search button, so only add advice here.
            setStatus([document.createTextNode(
                'Try a shorter or different word — search matches titles, tags and author names.')]);
        } else {
            const link = el('a', 'btn btn-quiet', 'Create a new pattern');
            link.href = '/new';
            setStatus([
                document.createTextNode('Nothing published yet — open a featured preset below, tweak it, and hit Publish to be the first.'),
                link,
            ]);
        }
        return;
    }

    const frag = document.createDocumentFragment();
    for (const item of items) {
        if (item && item.id) frag.appendChild(patternCard(item));
    }
    grid.appendChild(frag);
    setStatus(null);
}

// ── featured presets ─────────────────────────────────────────────────────────

// Paths come from our own /featured.json; keep them relative so a bad entry
// can never point the editor at another origin.
function safeRelative(path) {
    const p = String(path || '');
    if (!p || p.startsWith('/') || p.includes('..') || p.includes('://')) return '';
    return p;
}

function pencilIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41'
                      + 'l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z');
    p.setAttribute('fill', 'currentColor');
    svg.appendChild(p);
    return svg;
}

function presetCard(item) {
    const preset = safeRelative(item && item.preset);
    if (!preset) return null;
    const label = String((item && (item.label || item.name)) || 'Preset');
    const thumb = safeRelative(item && item.thumb);
    const href = editorUrl(PRESET_BASE + preset);

    // The whole tile is a link, but the action gets its own visible button so
    // it is obvious these presets are starting points you can build from.
    const card = el('div', 'card preset-card');

    const a = el('a', 'preset-open');
    a.href = href;
    a.setAttribute('aria-label', 'Create a new pattern based on ' + label);

    const img = el('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = label + ' preset thumbnail';
    img.addEventListener('error', () => img.classList.add('broken'));
    if (thumb) img.src = PRESET_BASE + thumb;
    else img.classList.add('broken');

    const box = el('div', 'card-label');
    box.appendChild(el('div', 'card-title', label));
    box.appendChild(el('div', 'card-sub', 'Starting point'));
    a.append(img, box);

    // Quiet affordance rather than a full-width button: the whole tile already
    // opens the editor, so this only needs to *say* that it does.
    const action = el('a', 'preset-action');
    action.href = href;
    action.title = 'Create a new pattern based on ' + label;
    action.setAttribute('aria-label', 'Create a new pattern based on ' + label);
    action.appendChild(pencilIcon());

    card.append(a, action);
    return card;
}

async function loadFeatured() {
    skeletons(featuredGrid, 6);
    featuredStatus.hidden = false;
    featuredStatus.textContent = 'Loading presets…';
    featuredStatus.classList.add('sr-only');

    let items;
    try {
        const resp = await fetch('/featured.json');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        items = Array.isArray(data && data.items) ? data.items : [];
    } catch (e) {
        featuredGrid.textContent = '';
        featuredGrid.removeAttribute('aria-busy');
        featuredStatus.classList.remove('sr-only');
        featuredStatus.textContent = '';
        featuredStatus.append(
            document.createTextNode('Could not load the featured presets.'),
            actionButton('Retry', loadFeatured),
        );
        return;
    }

    featuredGrid.textContent = '';
    featuredGrid.removeAttribute('aria-busy');
    featuredStatus.classList.remove('sr-only');

    const frag = document.createDocumentFragment();
    let n = 0;
    for (const item of items) {
        const card = presetCard(item);
        if (card) { frag.appendChild(card); n++; }
    }
    if (!n) {
        featuredStatus.textContent = 'No featured presets are available right now.';
        return;
    }
    featuredGrid.appendChild(frag);
    featuredStatus.hidden = true;
    featuredStatus.textContent = '';
}

// ── boot ─────────────────────────────────────────────────────────────────────

function render() {
    const { sort, q } = readState();
    syncTabs(sort, q);
    syncNavSearch(q);
    loadCommunity(sort, q);
}

// A failed sign-in comes back as /?auth=failed|expired — say so instead of
// dropping the visitor on a silently signed-out home page.
function showAuthNotice() {
    const params = new URLSearchParams(location.search);
    const auth = params.get('auth');
    if (auth !== 'failed' && auth !== 'expired') return;

    const note = el('div', 'results-bar');
    note.setAttribute('role', 'status');
    note.append(el('span', null, auth === 'expired'
        ? 'That sign-in link expired. Please try again.'
        : "Sign-in didn't complete. Please try again."));
    const retry = el('a', 'btn btn-quiet', 'Sign in with Google');
    retry.href = '/auth/login?next=%2F';
    const dismiss = actionButton('Dismiss', () => {
        note.remove();
        params.delete('auth');
        const qs = params.toString();
        history.replaceState(null, '', qs ? '/?' + qs : '/');
    });
    note.append(retry, dismiss);
    document.getElementById('main').prepend(note);
}

buildTabs();
buildNav({ search: readState().q });
showAuthNotice();
render();
loadFeatured();

window.addEventListener('popstate', render);
