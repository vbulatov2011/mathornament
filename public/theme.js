/* Applies the saved theme before first paint.
 *
 * Loaded as a plain blocking <script> in <head> — deliberately not a module
 * (modules are deferred, which would paint the wrong theme first) and not
 * inline (the site CSP is script-src 'self'). */
(function () {
    var THEME_KEY = 'mo-theme';
    var saved = null;
    try {
        saved = localStorage.getItem(THEME_KEY);
    } catch (e) { /* private mode: fall back to the OS setting */ }

    if (saved === 'light' || saved === 'dark') {
        document.documentElement.setAttribute('data-theme', saved);
    }

    // Shared with site.js so both agree on the key and the allowed values.
    window.__moTheme = {
        key: THEME_KEY,
        get: function () {
            try {
                var v = localStorage.getItem(THEME_KEY);
                return (v === 'light' || v === 'dark') ? v : 'system';
            } catch (e) {
                return 'system';
            }
        },
        set: function (mode) {
            if (mode === 'light' || mode === 'dark') {
                document.documentElement.setAttribute('data-theme', mode);
            } else {
                document.documentElement.removeAttribute('data-theme');
            }
            try {
                if (mode === 'system') localStorage.removeItem(THEME_KEY);
                else localStorage.setItem(THEME_KEY, mode);
            } catch (e) { /* nothing to persist to */ }
        },
    };
})();
