/* MathOrnament — shared helpers: nav bar, session, formatting, cards. */

export function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
}

export function editorUrl(presetUrl, forkId) {
    const hash = { preset: presetUrl };
    if (forkId) hash.fork = forkId;
    return '/apps/symsim/gray_scott/edit#' + encodeURIComponent(JSON.stringify(hash));
}

export function timeAgo(iso) {
    if (!iso) return '';
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return '';
    const secs = Math.max(0, (Date.now() - then) / 1000);
    const steps = [
        [60, 'second', 1],
        [3600, 'minute', 60],
        [86400, 'hour', 3600],
        [2592000, 'day', 86400],
        [31536000, 'month', 2592000],
        [Infinity, 'year', 31536000],
    ];
    for (const [limit, unit, div] of steps) {
        if (secs < limit) {
            const n = Math.floor(secs / div);
            if (unit === 'second' && n < 30) return 'just now';
            return n + ' ' + unit + (n === 1 ? '' : 's') + ' ago';
        }
    }
    return '';
}

let mePromise = null;
export function getMe() {
    if (!mePromise) {
        mePromise = fetch('/api/me', { credentials: 'same-origin' })
            .then(r => r.json())
            .catch(() => ({ user: null, authConfigured: false }));
    }
    return mePromise;
}

export function avatar(user, big) {
    const cls = 'avatar' + (big ? ' avatar-lg' : '');
    const initial = ((user && user.name) || '?').trim().charAt(0).toUpperCase() || '?';
    if (user && user.picture) {
        const img = el('img', cls);
        img.src = user.picture;
        img.alt = user.name || '';
        img.referrerPolicy = 'no-referrer';
        // Google avatars are third-party URLs and the site CSP is img-src 'self',
        // so they are blocked on pages that carry it. A blocked load still fires
        // `error`, so swap in the initial-letter tile instead of leaving the
        // browser's broken-image box (with the alt text spilling out) in the nav.
        img.addEventListener('error', () => {
            const fallback = el('div', cls, initial);
            if (img.parentNode) img.parentNode.replaceChild(fallback, img);
        }, { once: true });
        return img;
    }
    return el('div', cls, initial);
}

/* ── theme selector ──────────────────────────────────────────────────────────
 * Cycles System → Light → Dark. "System" is the default and means: follow the
 * OS. theme.js owns the storage and the data-theme attribute so the choice is
 * already applied before first paint. */

const THEME_MODES = [
    { mode: 'system', icon: '◐', label: 'Theme: follow system' },
    { mode: 'light',  icon: '☀', label: 'Theme: light' },
    { mode: 'dark',   icon: '☾', label: 'Theme: dark' },
];

export function themeToggle() {
    const api = window.__moTheme;
    const btn = el('button', 'btn theme-toggle');
    btn.type = 'button';

    function paint() {
        const current = api ? api.get() : 'system';
        const entry = THEME_MODES.find(m => m.mode === current) || THEME_MODES[0];
        btn.textContent = entry.icon;
        btn.title = entry.label + ' (click to change)';
        btn.setAttribute('aria-label', entry.label + '. Click to change.');
    }

    btn.addEventListener('click', () => {
        if (!api) return;
        const i = THEME_MODES.findIndex(m => m.mode === api.get());
        api.set(THEME_MODES[(i + 1) % THEME_MODES.length].mode);
        paint();
    });

    paint();
    return btn;
}

export function toast(message) {
    const t = el('div', 'toast', message);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
}

/** Renders the shared top bar into #nav. */
export async function buildNav({ search = '' } = {}) {
    const host = document.getElementById('nav');
    if (!host) return;
    host.className = 'nav';
    const inner = el('div', 'nav-inner');

    const brand = el('a', 'nav-brand', 'MathOrnament');
    brand.href = '/';

    const searchBox = el('input', 'nav-search');
    searchBox.type = 'search';
    searchBox.placeholder = 'Search patterns, tags, people…';
    searchBox.value = search;
    searchBox.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') {
            const q = searchBox.value.trim();
            location.href = q ? '/?q=' + encodeURIComponent(q) : '/';
        }
    });

    const browse = el('a', 'nav-link', 'Browse');
    browse.href = '/';
    const create = el('a', 'nav-link', 'New');
    create.href = '/new';

    inner.append(brand, searchBox, el('span', 'nav-spacer'), browse, create);

    const slot = el('div', 'nav-user');
    slot.appendChild(themeToggle());
    inner.appendChild(slot);
    host.appendChild(inner);

    const { user, authConfigured } = await getMe();
    if (user) {
        const link = el('a', 'nav-link', user.name);
        link.href = '/user/' + user.handle;
        const pic = avatar(user);
        const picLink = el('a');
        picLink.href = '/user/' + user.handle;
        picLink.appendChild(pic);
        const out = el('button', 'btn', 'Sign out');
        out.addEventListener('click', async () => {
            await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
            location.reload();
        });
        slot.append(picLink, link, out);
    } else {
        const inBtn = el('a', 'btn btn-primary', 'Sign in with Google');
        inBtn.href = '/auth/login?next=' + encodeURIComponent(location.pathname + location.search);
        if (!authConfigured) inBtn.title = 'Sign-in is not configured on this site yet';
        slot.append(inBtn);
    }
}

/** Card for one pattern, used by the gallery and profile pages. */
export function patternCard(item) {
    const a = el('a', 'card');
    a.href = '/view/' + item.id;

    const img = el('img');
    img.loading = 'lazy';
    img.src = '/api/preset/' + item.id + '.png';
    img.alt = item.title;
    img.addEventListener('error', () => img.classList.add('broken'));

    const label = el('div', 'card-label');
    label.appendChild(el('div', 'card-title', item.title));

    const sub = el('div', 'card-sub');
    const who = item.author && item.author.name ? item.author.name : 'anonymous';
    sub.appendChild(el('span', null, 'by ' + who));

    const stats = el('div', 'card-stats');
    if (item.likes) stats.appendChild(el('span', null, '♥ ' + item.likes));
    if (item.visibility && item.visibility !== 'public') {
        stats.appendChild(el('span', null, item.visibility));
    }
    sub.appendChild(stats);

    label.appendChild(sub);
    a.append(img, label);
    return a;
}
