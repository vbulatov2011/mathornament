/**
 * mo_embed.js — read-only viewer used by the <iframe> on pattern pages.
 *
 * Runs the same simulator as the editor with useSimpleUI (no sample browser,
 * no parameter GUI) and then removes the leftover toolbox, which in simple-UI
 * mode is appended straight into the canvas container and still carries
 * download/record/fullscreen buttons that make no sense in an embed.
 */

import { runGrayScottApp } from './mo_app.js';
import { presets }         from './presets_wp.js';

function presetFromHash() {
    const raw = window.location.hash;
    if (!raw || raw.length < 2) return null;
    let obj = null;
    try {
        obj = JSON.parse(decodeURIComponent(raw.substring(1)));
    } catch (e) {
        return null;
    }
    if (!obj || typeof obj.preset !== 'string') return null;
    try {
        // Same-origin only: SymRenderer would happily fetch anything here.
        const resolved = new URL(obj.preset, window.location.href);
        if (resolved.origin !== window.location.origin) return null;
    } catch (e) {
        return null;
    }
    return obj.preset;
}

// Replace the hash with a whitelisted version so no other key (scriptUrl!)
// reaches SymRenderer, which merges the whole hash object into its options.
function sanitizeHash() {
    const preset = presetFromHash();
    const wanted = preset
        ? '#' + encodeURIComponent(JSON.stringify({ preset }))
        : window.location.pathname + window.location.search;
    if (window.location.hash !== (preset ? wanted : '')) {
        history.replaceState(null, '', wanted);
    }
    return preset;
}

sanitizeHash();
// The vendored SymDocumentManager listens for hashchange and re-reads the raw
// fragment, so a later navigation has to be cleaned too. Capture phase runs
// before its listener.
window.addEventListener('hashchange', () => sanitizeHash(), true);

try {
    runGrayScottApp({
        presets,
        presetsPath: 'presets/wp/',
        groupName: 'Wallpaper',
        rendererOpts: { useSimpleUI: true },
    });
} catch (err) {
    console.error('embed viewer error:', err);
}

// A viewer needs one control, not symsim's whole toolbox (which also carries
// record/export/draw tools). Hide the toolbox and drive its Run button from a
// single play/pause control of our own.
//
// The vendored button is an <input type="image" class="imgbutton"> whose
// src/title flip between btn_play.svg/"Run" and btn_pause.svg/"Stop"
// (SymRenderer.js), so it is both the state source and the thing we click.

const PLAY_PATH  = 'M8 5.5v13l11-6.5z';
const PAUSE_PATH = 'M7.5 5.5h3.5v13H7.5zM13 5.5h3.5v13H13z';

function icon(path) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', path);
    p.setAttribute('fill', 'currentColor');
    svg.appendChild(p);
    return svg;
}

function findRunButton() {
    return [...document.querySelectorAll('#canvasContainer .imgbutton')]
        .find(b => /btn_play|btn_pause/.test(b.getAttribute('src') || ''));
}

function setUp(runBtn) {
    const box = runBtn.closest('#canvasContainer > *');
    if (box && box.tagName !== 'CANVAS') box.style.display = 'none';

    const btn = document.createElement('button');
    btn.className = 'mo-play';
    btn.type = 'button';

    const isRunning = () => /btn_pause/.test(runBtn.getAttribute('src') || '');

    function sync() {
        const running = isRunning();
        btn.textContent = '';
        btn.appendChild(icon(running ? PAUSE_PATH : PLAY_PATH));
        btn.setAttribute('aria-label', running ? 'Pause the simulation' : 'Play the simulation');
        btn.title = running ? 'Pause' : 'Play';
        btn.classList.toggle('is-playing', running);
    }

    btn.addEventListener('click', () => {
        runBtn.click();
        // The vendored handler swaps src/title synchronously.
        sync();
    });

    // Keep in sync if the app starts or stops the simulation on its own.
    new MutationObserver(sync).observe(runBtn, { attributes: true, attributeFilter: ['src', 'title'] });

    sync();
    // Deliberately attached to <body>, not #canvasContainer: SymRenderer sizes
    // and lays out that container itself, and an extra child there disturbs it.
    document.body.appendChild(btn);
}

let tries = 0;
const timer = setInterval(() => {
    const runBtn = findRunButton();
    if (runBtn) {
        clearInterval(timer);
        setUp(runBtn);
    } else if (++tries > 60) {
        clearInterval(timer);
    }
}, 100);

// Inside an <iframe> the app can start before the frame has its final size, and
// it sizes the GL canvas once at startup — leaving a canvas that renders a flat
// colour. SymRenderer re-measures on window resize, so kick it once layout has
// settled, and again whenever the frame is actually resized.
function nudgeResize() {
    window.dispatchEvent(new Event('resize'));
}

for (const delay of [120, 500, 1200]) setTimeout(nudgeResize, delay);
window.addEventListener('load', nudgeResize);
if (typeof ResizeObserver === 'function') {
    let last = 0;
    new ResizeObserver(() => {
        // Coalesce: the observer fires for every intermediate layout pass.
        clearTimeout(last);
        last = setTimeout(nudgeResize, 100);
    }).observe(document.documentElement);
}
