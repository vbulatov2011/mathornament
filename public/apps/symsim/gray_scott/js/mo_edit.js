/**
 * mo_edit.js — MathOrnament editor page entry.
 *
 * 1. Sanitizes the URL hash before SymRenderer sees it: only a same-origin
 *    {preset} key survives. SymRenderer merges ALL hash keys into its options
 *    (including scriptUrl, which dynamic-imports arbitrary modules), and a
 *    malformed hash throws inside its constructor leaving a blank page.
 * 2. Starts the Gray-Scott wp app.
 * 3. Adds the MathOrnament overlay bar (gallery link + Share dialog).
 */

import { runGrayScottApp } from './mo_app.js';
import { presets }         from './presets_wp.js';

// ── Hash sanitization ─────────────────────────────────────────────────────────

let initialPresetUrl = null;
let forkParentId = '';

function sanitizeHash() {
    const raw = window.location.hash;
    if (!raw || raw.length < 2) return;
    let obj = null;
    try {
        obj = JSON.parse(decodeURIComponent(raw.substring(1)));
    } catch (e) {
        obj = null;
    }
    let clean = null;
    if (obj && typeof obj.preset === 'string') {
        try {
            const resolved = new URL(obj.preset, window.location.href);
            if (resolved.origin === window.location.origin) {
                clean = { preset: obj.preset };
                initialPresetUrl = resolved.href;
                if (typeof obj.fork === 'string' && /^[a-z0-9]{1,32}$/.test(obj.fork)) {
                    forkParentId = obj.fork;
                    clean.fork = obj.fork;
                }
            }
        } catch (e) { /* unparsable preset URL: drop it */ }
    }
    const wanted = clean
        ? '#' + encodeURIComponent(JSON.stringify(clean))
        : window.location.pathname + window.location.search;
    if (raw !== (clean ? wanted : '')) {
        history.replaceState(null, '', wanted);
    }
}

sanitizeHash();

// Track when the initial hash preset has actually been fetched and applied, so
// the Share button can't publish the default document with a blank thumbnail.
let initialPresetSettled = !initialPresetUrl;
if (initialPresetUrl) {
    const origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
        const reqUrl = typeof input === 'string' ? input : (input && input.url) || '';
        let matches = false;
        try {
            matches = new URL(reqUrl, window.location.href).href === initialPresetUrl;
        } catch (e) { /* not a URL we care about */ }
        const p = origFetch(input, init);
        if (matches) {
            window.fetch = origFetch;
            // Settle shortly after the fetch resolves — setDocumentData applies
            // params synchronously after response.json().
            p.then(() => setTimeout(() => { initialPresetSettled = true; }, 500),
                   () => { initialPresetSettled = true; });
        }
        return p;
    };
    // Never leave Share disabled forever if the preset request goes missing.
    setTimeout(() => { initialPresetSettled = true; }, 15000);
}

// ── Start the simulator ───────────────────────────────────────────────────────

/** Some phones/tablets have no WebGL2 at all. Say so instead of showing an
 *  empty page that looks like the site is broken. */
function webgl2Unavailable() {
    try {
        const probe = document.createElement('canvas').getContext('webgl2');
        if (probe) return null;
    } catch (e) { /* fall through */ }
    return 'This device or browser does not support WebGL2, which the pattern '
         + 'simulator needs. Try an up-to-date Chrome, Safari or Firefox, and '
         + 'check that hardware acceleration is enabled.';
}

function showFatal(message) {
    const box = document.createElement('div');
    box.className = 'mo-fatal';
    const h = document.createElement('h1');
    h.textContent = 'Cannot run the simulator here';
    const p = document.createElement('p');
    p.textContent = message;
    const back = document.createElement('a');
    back.className = 'mo-btn';
    back.href = '/';
    back.textContent = '◂ Back to the gallery';
    box.append(h, p, back);
    document.body.appendChild(box);
}

/* ── phone mode ───────────────────────────────────────────────────────────────
 * The vendored UI is a set of draggable floating windows sized for a desktop
 * (the toolbox alone is 482px, the sample browser 600px), and their headers are
 * mouse-only — unusable and overlapping on a phone. On a touch device with a
 * small screen we start the renderer in its "simple UI" mode (canvas straight
 * on <body>, filling the viewport, sample browser and settings hidden) and
 * drive the essentials from our own big-target bar. The marker attribute lets
 * the CSS below scope cleanly, and lets us force the mode on a desktop for
 * testing with ?phone=1.
 */
const forced = new URLSearchParams(location.search).get('phone');

/* Measuring the screen, NOT window.innerWidth. The vendored UI lays out windows
 * up to 600px wide, which makes the page wider than a phone; Android Chrome
 * then shrink-to-fits and reports an inflated innerWidth (601 on a 375px
 * device). Deciding "is this a phone" from that number is circular — it is
 * exactly the symptom this mode exists to cure — and it silently left real
 * Android phones on the desktop layout. screen.width/height and
 * documentElement.clientWidth are both immune to the page's own overflow. */
function shortEdgeCss() {
    const candidates = [];
    const de = document.documentElement;
    if (de && de.clientWidth && de.clientHeight) candidates.push(Math.min(de.clientWidth, de.clientHeight));
    if (window.screen && window.screen.width && window.screen.height) {
        const dpr = window.devicePixelRatio || 1;
        // screen.* is in CSS px on mobile, but be defensive about odd values.
        const s = Math.min(window.screen.width, window.screen.height);
        candidates.push(s > 2000 ? s / dpr : s);
    }
    if (!candidates.length) candidates.push(Math.min(window.innerWidth, window.innerHeight));
    return Math.min(...candidates);
}

// 560px on the short edge covers every phone in either orientation while
// leaving tablets (iPad mini is 744) on the full desktop editor, which fits
// them comfortably.
const IS_PHONE = forced === '1' || (forced !== '0'
    && (window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0)
    && shortEdgeCss() <= 560);

if (IS_PHONE) document.documentElement.setAttribute('data-mo-phone', '');

/* The vendored floating windows persist their size/position in localStorage and
 * restore it verbatim, with no check that it still fits. Anyone who once opened
 * the editor in a narrow window (or on a phone before this build) would keep a
 * canvas the size of a postage stamp forever. Drop geometry that cannot fit the
 * current viewport; leave anything plausible alone. */
function repairStoredWindowGeometry() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // A tab that has never been shown (opened in the background, or restored)
    // reports a 0x0 viewport. Every stored size would look "too big" and we
    // would wipe a layout the user had deliberately arranged.
    if (!vw || !vh) return;

    const keys = ['visualization_params', 'toolbox_params', 'samples_params',
                  'symrenderer_settings_window_params'];
    for (const key of keys) {
        let raw;
        try { raw = localStorage.getItem(key); } catch (e) { return; }
        if (!raw) continue;
        try {
            const g = JSON.parse(raw);
            const w = parseFloat(g.width);
            const h = parseFloat(g.height);
            const hasW = Number.isFinite(w);
            const hasH = Number.isFinite(h);
            const doesNotFit = (hasW && w > vw) || (hasH && h > vh);
            // …and the case this function exists for: geometry saved in a tiny
            // window, which fits any larger viewport and would otherwise be
            // restored forever as a postage-stamp canvas.
            const tooSmall = (hasW && (w < 200 || w < vw * 0.25))
                          || (hasH && (h < 150 || h < vh * 0.25));
            if (doesNotFit || tooSmall) localStorage.removeItem(key);
        } catch (e) {
            try { localStorage.removeItem(key); } catch (e2) { /* ignore */ }
        }
    }
}

if (!IS_PHONE) repairStoredWindowGeometry();

let ss = null;
const unsupported = webgl2Unavailable();
if (unsupported) {
    showFatal(unsupported);
} else {
    try {
        ss = runGrayScottApp({
            presets,
            presetsPath: 'presets/wp/',
            groupName: 'Wallpaper',
            rendererOpts: IS_PHONE ? { useSimpleUI: true } : {},
        });
    } catch (err) {
        console.error('gray_scott error:', err);
        showFatal('The simulator failed to start on this device: ' + (err && err.message));
    }
}

// ── Overlay UI ────────────────────────────────────────────────────────────────

const APP_NAME = 'SymRenderer.Group_WP.Gray-Scott.InversiveNavigator_v1';

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

function captureThumbnail(size = 512) {
    // First .layeredCanvas is the GL canvas (preserveDrawingBuffer: true);
    // the second is the overlay (grid/checkerboard) — deliberately excluded.
    const src = document.querySelector('#canvasContainer canvas.layeredCanvas');
    if (!src || !src.width || !src.height) return null;
    const side = Math.min(src.width, src.height);
    const sx = (src.width - side) / 2;
    const sy = (src.height - side) / 2;
    const out = document.createElement('canvas');
    out.width = size;
    out.height = size;
    const ctx = out.getContext('2d');
    ctx.drawImage(src, sx, sy, side, side, 0, 0, size, size);
    return out.toDataURL('image/png');
}

/* ── phone controls ───────────────────────────────────────────────────────────
 * The vendored toolbox stays in the DOM (SymRenderer keeps writing to its
 * buttons) but is hidden by CSS; our buttons forward to it with .click(),
 * which fires its onclick handler regardless of visibility.
 */

function toolbarButton(title) {
    return document.querySelector(`#canvasContainer input.imgbutton[title="${title}"]`)
        || document.querySelector(`input.imgbutton[title="${title}"]`);
}

function svgIcon(paths, filled) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of [].concat(paths)) {
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', d);
        p.setAttribute('fill', filled === false ? 'none' : 'currentColor');
        if (filled === false) {
            p.setAttribute('stroke', 'currentColor');
            p.setAttribute('stroke-width', '2');
            p.setAttribute('stroke-linecap', 'round');
            p.setAttribute('stroke-linejoin', 'round');
        }
        svg.appendChild(p);
    }
    return svg;
}

const ICON = {
    play:    'M8 5v14l11-7z',
    pause:   'M6 5h4v14H6zM14 5h4v14h-4z',
    restart: 'M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z',
    draw:    'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
    pan:     'M13 6v5h5V9l3 3-3 3v-2h-5v5h2l-3 3-3-3h2v-5H6v2l-3-3 3-3v2h5V6H9l3-3 3 3h-2z',
    seed:    'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 4a6 6 0 0 1 6 6 6 6 0 0 1-6 6z',
    pick:    'M17.7 3.3a2.5 2.5 0 0 0-3.5 0l-1.9 1.9-1-1-1.4 1.4 1 1L3 14.6V19h4.4l7.9-7.9 1 1 1.4-1.4-1-1 1.9-1.9a2.5 2.5 0 0 0 0-3.5zM6.6 17H5v-1.6l7.4-7.4 1.6 1.6z',
    expand:  'M4 9V4h5v2H6v3H4zm0 6h2v3h3v2H4v-5zm14 0h2v5h-5v-2h3v-3zM15 6V4h5v5h-2V6h-3z',
    shrink:  'M9 4h2v5H6V7h3V4zm4 0h2v3h3v2h-5V4zM6 15h5v5H9v-3H6v-2zm7 0h5v2h-3v3h-2v-5z',
};

/* ── full screen ──────────────────────────────────────────────────────────────
 * The vendored toolbox has its own full-screen button, but it expands only
 * #canvasContainer, which leaves our bars (fixed on <body>) outside the
 * fullscreen subtree — no way to publish or even exit from inside the app. We
 * expand the whole document instead, so the pattern and the controls go
 * together. On Android this also drops the browser chrome, which is most of
 * the win on a phone.
 */
function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function fullscreenSupported() {
    const el = document.documentElement;
    return Boolean(el.requestFullscreen || el.webkitRequestFullscreen);
}

function toggleFullscreen() {
    const el = document.documentElement;
    if (fullscreenElement()) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) exit.call(document);
        return;
    }
    const request = el.requestFullscreen || el.webkitRequestFullscreen;
    // navigationUI:'hide' is a hint; Safari ignores the options object entirely.
    if (request) {
        try {
            const r = request.call(el, { navigationUI: 'hide' });
            if (r && typeof r.catch === 'function') r.catch(() => request.call(el));
        } catch (e) {
            try { request.call(el); } catch (e2) { /* nothing more we can do */ }
        }
    }
}

/** Keep a button's icon/label in step with the actual fullscreen state. */
function bindFullscreenButton(btn, render) {
    render(Boolean(fullscreenElement()));
    const sync = () => render(Boolean(fullscreenElement()));
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
}

function phoneButton(label, iconKey, onClick) {
    const b = el('button', 'mo-pbtn');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.appendChild(svgIcon(ICON[iconKey]));
    b.addEventListener('click', onClick);
    return b;
}

function buildPhoneUI() {
    const top = el('div', 'mo-ptop');
    const back = el('a', 'mo-pbtn mo-pback', '◂');
    back.href = '/';
    back.title = 'Back to the gallery';
    back.setAttribute('aria-label', 'Back to the gallery');
    const spacer = el('span', 'mo-pspacer');

    const full = phoneButton('Full screen', 'expand', toggleFullscreen);
    bindFullscreenButton(full, on => {
        full.textContent = '';
        full.appendChild(svgIcon(on ? ICON.shrink : ICON.expand));
        full.title = on ? 'Leave full screen' : 'Full screen';
        full.setAttribute('aria-label', full.title);
    });
    if (!fullscreenSupported()) full.hidden = true;   // iPhone Safari has no element fullscreen

    const publish = el('button', 'mo-pbtn mo-ppublish', 'Publish');
    publish.type = 'button';
    publish.disabled = true;
    publish.addEventListener('click', openShareDialog);
    top.append(back, spacer, full, publish);

    const bar = el('div', 'mo-pbar');

    const play = phoneButton('Play or pause', 'play', () => {
        const btn = toolbarButton('Run') || toolbarButton('Stop');
        if (btn) btn.click();
        setTimeout(syncPlay, 60);
    });
    const restart = phoneButton('Restart the animation', 'restart', () => {
        const btn = toolbarButton('Restart');
        if (btn) btn.click();
    });
    const seed = phoneButton('Start over with a new random seed', 'seed', () => {
        const btn = toolbarButton('initialize');
        if (btn) btn.click();
    });

    const tools = [];
    function selectTool(name, button) {
        const btn = toolbarButton(name);
        if (btn) btn.click();
        for (const t of tools) t.classList.toggle('is-active', t === button);
    }
    const drawBtn = phoneButton('Draw on the pattern', 'draw', () => selectTool('draw', drawBtn));
    const panBtn = phoneButton('Move and zoom', 'pan', () => selectTool('move', panBtn));
    const pickBtn = phoneButton('Pick a colour from the pattern', 'pick',
        () => selectTool('pick', pickBtn));
    tools.push(drawBtn, panBtn, pickBtn);

    bar.append(play, restart, seed, el('span', 'mo-pdivider'), panBtn, drawBtn, pickBtn);
    document.body.append(top, bar);

    function syncPlay() {
        // The vendored Run button flips its title to 'Stop' while running.
        const running = Boolean(toolbarButton('Stop'));
        play.textContent = '';
        play.appendChild(svgIcon(running ? ICON.pause : ICON.play));
        play.title = running ? 'Pause' : 'Play';
        play.setAttribute('aria-label', play.title);
    }

    // The toolbox only exists once the renderer has started.
    const ready = setInterval(() => {
        if (!toolbarButton('Run') && !toolbarButton('Stop')) return;
        clearInterval(ready);
        syncPlay();
        selectTool('move', panBtn);
    }, 120);
    setInterval(syncPlay, 1000);

    const poll = setInterval(() => {
        if (shareReady()) {
            publish.disabled = false;
            clearInterval(poll);
        }
    }, 250);
}

/* Android only delivers a continuous pointermove stream once the element opts
 * out of native gestures; without this a drag scrolls/zooms the page and the
 * drawing tool never sees the movement.
 *
 * Opting out also kills the browser's pinch-zoom, and the simulator only zooms
 * on wheel events (it has no multi-touch support at all), so we translate a
 * two-finger pinch into the wheel events it already understands. Our listeners
 * run in the capture phase and stop propagation while two fingers are down, so
 * the app never sees the second finger as a stray stroke. */
function enableTouchDrawing() {
    const tries = setInterval(() => {
        const canvases = document.querySelectorAll('#canvasContainer canvas.layeredCanvas');
        if (!canvases.length) return;
        clearInterval(tries);
        for (const c of canvases) {
            c.style.touchAction = 'none';
            c.addEventListener('contextmenu', ev => ev.preventDefault());
        }
        attachPinchZoom(canvases[canvases.length - 1]); // the overlay canvas
    }, 120);
    setTimeout(() => clearInterval(tries), 8000);
}

/** Scale the view about its centre. Uses the navigator's transform directly:
 *  the vendored wheel handler routes through an AnimatedPointer that only
 *  advances while the animation loop is running, so it does nothing on a
 *  paused pattern — which is most of the time on a phone. */
function zoomBy(factor) {
    const nav = ss && ss.moNavigator;
    const t = nav && typeof nav.getCanvasTransform === 'function' && nav.getCanvasTransform();
    if (!t || typeof t.setZoom !== 'function' || typeof t.getZoom !== 'function') return false;
    const current = t.getZoom()[0];
    if (!Number.isFinite(current)) return false;
    const next = Math.min(500, Math.max(0.05, current * factor));
    if (next === current) return false;
    t.setZoom(next);
    try { ss.getScriptAPI().render(); } catch (e) { /* repaint is best-effort */ }
    return true;
}

function attachPinchZoom(target) {
    const active = new Map();
    let lastDist = 0;

    const dist = () => {
        const [a, b] = [...active.values()];
        return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const mid = () => {
        const [a, b] = [...active.values()];
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };

    // Our own synthetic events must not re-enter these handlers.
    let synthetic = false;

    target.addEventListener('pointerdown', ev => {
        if (synthetic || ev.pointerType !== 'touch') return;
        active.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (active.size === 2) {
            lastDist = dist();
            // End the stroke the FIRST finger started before we take over, so
            // a pinch does not leave a stray line behind.
            const firstId = [...active.keys()][0];
            const firstPos = active.get(firstId);
            synthetic = true;
            target.dispatchEvent(new PointerEvent('pointerup', {
                pointerId: firstId, pointerType: 'touch', bubbles: true, cancelable: true,
                clientX: firstPos.x, clientY: firstPos.y,
            }));
            synthetic = false;
            ev.stopPropagation();
        }
    }, true);

    target.addEventListener('pointermove', ev => {
        if (!active.has(ev.pointerId)) return;
        active.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (active.size !== 2) return;
        ev.stopPropagation();
        ev.preventDefault();

        const d = dist();
        if (!lastDist || !d) { lastDist = d; return; }
        const ratio = d / lastDist;
        if (Math.abs(ratio - 1) < 0.01) return;
        lastDist = d;

        zoomBy(ratio);
    }, true);

    const release = ev => {
        if (synthetic || !active.has(ev.pointerId)) return;
        if (active.size === 2) ev.stopPropagation();
        active.delete(ev.pointerId);
        lastDist = 0;
    };
    target.addEventListener('pointerup', release, true);
    target.addEventListener('pointercancel', release, true);
}

function shareReady() {
    const canvas = document.querySelector('#canvasContainer canvas.layeredCanvas');
    return Boolean(canvas && canvas.width && initialPresetSettled);
}

// Current signed-in user (null when signed out or auth isn't configured).
let me = null;
const meReady = fetch('/api/me', { credentials: 'same-origin' })
    .then(r => r.json())
    .then(d => { me = d.user || null; return d; })
    .catch(() => ({ user: null, authConfigured: false }));

function buildBar() {
    const bar = el('div', 'mo-bar');
    const home = el('a', 'mo-btn mo-home', '◂ Gallery');
    home.href = '/';
    home.title = 'Back to the MathOrnament gallery';

    const brand = el('span', 'mo-brand', forkParentId ? 'Forking a pattern' : 'MathOrnament');

    const parentLink = el('a', 'mo-btn', 'View original');
    if (forkParentId) {
        parentLink.href = '/view/' + forkParentId;
        parentLink.title = 'Open the pattern this one was forked from';
    }

    // iPad and other tablets keep the full desktop UI, so the full-screen
    // control lives here too — it expands the document, taking the vendored
    // panels and this bar along with the canvas.
    const full = el('button', 'mo-btn mo-full');
    full.type = 'button';
    full.addEventListener('click', toggleFullscreen);
    bindFullscreenButton(full, on => {
        full.textContent = '';
        full.appendChild(svgIcon(on ? ICON.shrink : ICON.expand));
        full.title = on ? 'Leave full screen' : 'Full screen';
        full.setAttribute('aria-label', full.title);
    });
    if (!fullscreenSupported()) full.hidden = true;

    const share = el('button', 'mo-btn mo-share', 'Publish');
    share.title = 'Publish this pattern and get a link';
    share.disabled = true;
    share.addEventListener('click', openShareDialog);

    bar.append(home, brand);
    if (forkParentId) bar.appendChild(parentLink);
    bar.append(full, share);
    document.body.appendChild(bar);

    const poll = setInterval(() => {
        if (shareReady()) {
            share.disabled = false;
            share.title = 'Publish this pattern and get a link';
            clearInterval(poll);
        }
    }, 250);
    share.title = 'Waiting for the pattern to finish loading…';
}

let dialog = null;
// Remembered across dialog opens: without this, reopening Publish after a
// successful publish silently creates a second copy and loses the first link.
let published = null;

function showPublished(box, link) {
    box.append(el('p', 'mo-status', 'This pattern is published:'));
    const row = el('div', 'mo-result');
    const linkIn = el('input', 'mo-input mo-link');
    linkIn.readOnly = true;
    linkIn.value = link;
    const copy = el('button', 'mo-btn', 'Copy');
    copy.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(link);
        } catch (e) {
            linkIn.select();
            document.execCommand('copy');
        }
        copy.textContent = 'Copied!';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
    });
    const open = el('a', 'mo-btn mo-publish', 'Open pattern page');
    open.href = link;
    row.append(linkIn, copy, open);
    box.appendChild(row);

    const again = el('button', 'mo-btn mo-secondary', 'Publish again as a new pattern');
    again.addEventListener('click', () => {
        published = null;
        dialog.remove();
        dialog = null;
        openShareDialog();
    });
    box.appendChild(again);
}

function openShareDialog() {
    if (dialog) dialog.remove();

    if (published) {
        dialog = el('div', 'mo-dialog-backdrop');
        const box = el('div', 'mo-dialog');
        const close = el('button', 'mo-dialog-close', '×');
        close.addEventListener('click', () => { dialog.remove(); dialog = null; });
        dialog.addEventListener('click', ev => {
            if (ev.target === dialog) { dialog.remove(); dialog = null; }
        });
        box.append(close, el('h2', null, 'Already published'));
        showPublished(box, published);
        dialog.appendChild(box);
        document.body.appendChild(dialog);
        return;
    }

    // Freeze state at click time.
    let doc = null;
    let thumb = null;
    let err = null;
    try {
        const api = ss && ss.getScriptAPI();
        if (!api) throw new Error('simulator not running');
        doc = {
            name: 'untitled',
            appInfo: { appName: APP_NAME, fileFormatRelease: 1 },
            params: api.getParams(),
        };
    } catch (e) {
        err = e;
    }
    try {
        thumb = captureThumbnail();
    } catch (e) {
        thumb = null; // a failed thumbnail must not block publishing
    }

    let publishing = false;
    dialog = el('div', 'mo-dialog-backdrop');
    const box = el('div', 'mo-dialog');
    const h = el('h2', null, forkParentId ? 'Publish your fork' : 'Publish this pattern');
    const close = el('button', 'mo-dialog-close', '×');
    const dismiss = () => {
        if (publishing) return; // closing mid-publish would orphan the link
        document.removeEventListener('keydown', onKey, true);
        dialog.remove();
        dialog = null;
    };
    function onKey(ev) { if (ev.key === 'Escape') dismiss(); }
    close.addEventListener('click', dismiss);
    // Tapping the dimmed area is how a sheet is dismissed on a phone; without
    // it the only target is a ~25px glyph covering the whole UI.
    dialog.addEventListener('click', ev => { if (ev.target === dialog) dismiss(); });
    document.addEventListener('keydown', onKey, true);
    box.append(close, h);

    if (err || !doc) {
        box.append(el('p', 'mo-err', 'Could not capture the current state: ' + (err && err.message)));
        dialog.appendChild(box);
        document.body.appendChild(dialog);
        return;
    }

    if (thumb) {
        const img = el('img', 'mo-thumb-preview');
        img.src = thumb;
        img.alt = 'pattern preview';
        box.appendChild(img);
    }

    const titleIn = el('input', 'mo-input');
    titleIn.placeholder = 'Title';
    titleIn.maxLength = 120;

    const descIn = el('textarea', 'mo-input mo-textarea');
    descIn.placeholder = 'Description (optional)';
    descIn.maxLength = 400;

    const tagsIn = el('input', 'mo-input');
    tagsIn.placeholder = 'Tags, comma separated (optional)';
    tagsIn.maxLength = 120;

    const visRow = el('div', 'mo-row');
    const visSel = el('select', 'mo-input mo-select');
    for (const [value, label] of [
        ['public', 'Public — listed in the gallery'],
        ['unlisted', 'Unlisted — only people with the link'],
        ['private', 'Private — only you'],
    ]) {
        const opt = el('option', null, label);
        opt.value = value;
        visSel.appendChild(opt);
    }
    visRow.appendChild(visSel);

    // Attribution line: signed-in users get their profile name; otherwise the
    // pattern is published anonymously (private needs an account to be useful).
    const who = el('p', 'mo-who');
    const signIn = el('a', 'mo-btn', 'Sign in with Google');
    signIn.href = '/auth/login?next=' + encodeURIComponent(location.pathname + location.hash);

    meReady.then(({ authConfigured }) => {
        who.textContent = '';
        if (me) {
            who.textContent = 'Publishing as ' + me.name + '.';
            return;
        }
        // "Private" means "only its author", which needs an account — without
        // one the pattern would be unreachable by everyone, including you.
        const priv = visSel.querySelector('option[value="private"]');
        if (priv) {
            priv.disabled = true;
            priv.textContent = 'Private — sign in to use this';
            if (visSel.value === 'private') visSel.value = 'public';
        }
        who.textContent = authConfigured
            ? 'Publishing anonymously. '
            : 'Publishing anonymously (sign-in is not set up on this site yet).';
        if (authConfigured) who.appendChild(signIn);
    });

    const publish = el('button', 'mo-btn mo-publish', 'Publish');
    const status = el('p', 'mo-status', '');
    const result = el('div', 'mo-result');

    publish.addEventListener('click', async () => {
        publish.disabled = true;
        publishing = true;
        close.classList.add('mo-disabled');
        status.textContent = 'Publishing…';
        try {
            const resp = await fetch('/api/share', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: titleIn.value.trim() || 'untitled',
                    desc: descIn.value.trim(),
                    tags: tagsIn.value,
                    visibility: visSel.value,
                    parent: forkParentId,
                    doc,
                    thumb,
                }),
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
            const link = new URL(data.url, window.location.origin).href;
            status.textContent = visSel.value === 'private'
                ? 'Published privately — only you can open this link:'
                : 'Published! Anyone with this link can open and remix it (it can take a minute to appear in the gallery):';
            result.textContent = '';
            const linkIn = el('input', 'mo-input mo-link');
            linkIn.readOnly = true;
            linkIn.value = link;
            const copy = el('button', 'mo-btn', 'Copy');
            copy.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(link);
                    copy.textContent = 'Copied!';
                } catch (e) {
                    linkIn.select();
                    document.execCommand('copy');
                    copy.textContent = 'Copied!';
                }
                setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
            });
            const open = el('a', 'mo-btn mo-publish', 'Open pattern page');
            open.href = link;
            result.append(linkIn, copy, open);
            // The document is published; re-publishing would just create a duplicate.
            published = link;
            publish.textContent = 'Published';
            titleIn.disabled = descIn.disabled = tagsIn.disabled = visSel.disabled = true;
        } catch (e) {
            status.textContent = 'Publish failed: ' + e.message;
            publish.disabled = false;
        } finally {
            publishing = false;
            close.classList.remove('mo-disabled');
        }
    });

    box.append(titleIn, descIn, tagsIn, visRow, who, publish, status, result);
    dialog.appendChild(box);
    document.body.appendChild(dialog);
    titleIn.focus();
}

if (!unsupported && IS_PHONE) {
    buildPhoneUI();
    enableTouchDrawing();
} else if (!unsupported) {
    buildBar();
}
