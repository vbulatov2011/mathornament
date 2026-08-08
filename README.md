# MathOrnament

> New here? **[GUIDE.md](GUIDE.md)** is the simple walkthrough: test locally, edit, deploy.

A Shadertoy-style site for **symmetric Gray-Scott reaction-diffusion patterns**, built on
[SymmHub / symsim](https://github.com/SymmHub/SymmHub) (MIT, by Vladimir Bulatov) and hosted on
Cloudflare Workers. Visitors open a pattern, tweak the live simulation in the browser (WebGL2),
and publish their variant at a short share link.

## Layout

- `public/` — static assets served by Cloudflare Workers Assets
  - `index.html`, `gallery.js`, `gallery.css` — the gallery (featured + community patterns)
  - `featured.json` — generated manifest of the 25 vendored wallpaper-group presets
  - `apps/symsim/gray_scott/` — vendored symsim app (wp variant), plus:
    - `edit.html` + `js/mo_edit.js` + `js/mo_app.js` + `css/mo_edit.css` — MathOrnament editor
      wrapper (hash sanitization, overlay bar, Share dialog)
  - `lib/` — vendored SymmHub library (unmodified)
  - `_headers` — CSP for the HTML pages
- `src/worker.js` — share API + `/s/<id>` short links
- `wrangler.jsonc` — Worker config (assets + KV binding `PRESETS`)

## Local patches to the vendored library

All four are reported upstream (verified against SymmHub `4f2d521`):
[#12 drawing](https://github.com/SymmHub/SymmHub/issues/12) ·
[#13 Android blank render](https://github.com/SymmHub/SymmHub/issues/13) ·
[#14 eyedropper](https://github.com/SymmHub/SymmHub/issues/14) ·
[#15 resize aspect ratio](https://github.com/SymmHub/SymmHub/issues/15).
If any is fixed upstream, drop our patch when refreshing `public/lib/`.

`public/lib/` is upstream SymmHub code, kept unmodified **except** for one patch, marked with
`MATHORNAMENT PATCH` comments in `public/lib/symhublib/PipelineManager.js`: it adds `getGroup()`
and `applySymmetry()`. `DrawingToolRenderer` calls both on the pattern object (unguarded in
`drawSegment_v1` and `pickValue`), but the PipelineManager refactor never exposed them, so every
drag with the pencil threw `mSimulation.getGroup is not a function` and painted nothing.
Re-apply this patch if you ever refresh the vendored library from upstream.

A second `MATHORNAMENT PATCH` lives in `public/lib/symhublib/webgl_utils.js`: `createFBO` now
downgrades `LINEAR` to `NEAREST` when the texture is 32-bit float and the device lacks
`OES_texture_float_linear`. Most Android GPUs lack it (desktop and iOS have it), and a float
texture set to `LINEAR` is *incomplete* — every sample reads zero, so the editor rendered a
blank canvas on Android with no error in the console. Only interpolation changes; the
simulation itself is untouched. Reproduce either way by hiding the extension:
`WebGL2RenderingContext.prototype.getExtension` returning null for that name makes a desktop
browser fail exactly like an Android phone.

A third `MATHORNAMENT PATCH` covers the eyedropper. `DrawingToolHandler` serves both the draw
and the pick tools but was never told which was active, so selecting the eyedropper only
changed the mouse cursor and it kept painting; `pickValue()` was reachable solely by
Ctrl+clicking. `SymRenderer` now passes `getToolName: () => mConfig.tools.toolName` when it
builds the handler (both tool branches), and the handler routes pointerdown to `onPick()` and
suppresses drag-drawing while the pick tool is selected.

Related upstream behaviour, not a bug we introduced: when a preset stores the brush's
`tools.drawing.params.symmetry` as `false`, strokes are not folded into the fundamental domain,
so they only land if drawn inside it. Turning **symmetry** on in the tools panel makes the brush
paint everywhere.

### Two rules for the embedded viewer (`embed.html` + `js/mo_embed.js`)

Both were learned the hard way — breaking either makes the viewer render a **flat magenta
rectangle** with no console error:

1. **Do not add children to `#canvasContainer`.** SymRenderer owns that element's layout; an
   extra child (the play button, originally) throws off its sizing. The play/pause control is
   attached to `<body>` for exactly this reason.
2. **Do not force `height: 100%` on the viewer's `html/body`,** and do not point the iframe at
   the viewer before the frame has a real width (`view.js` waits for it). The simulator sizes
   its GL targets once at startup, so booting it into a not-yet-laid-out frame leaves it
   rendering a flat colour.

The viewer only ever shows published documents (captured from the editor). Feeding it a raw
shipped preset *file* also renders flat — a pre-existing upstream limitation; featured presets
open in the editor, where they work.

### Full screen

Both bars carry a full-screen toggle. It expands `document.documentElement`, not the canvas —
the vendored toolbox button expands `#canvasContainer` alone, which leaves our fixed-position
bars outside the fullscreen subtree with no way to publish or exit. Uses `requestFullscreen`
with the `webkit` fallback that iPadOS needs, and hides itself where element fullscreen does not
exist (iPhone Safari). Entering fullscreen resizes the canvas, which is safe because of the
`onResize` patch above.

## Pages

`/` gallery (sort + search) · `/view/<id>` pattern page (live viewer, fork, likes, comments,
parameters) · `/user/<handle>` profile · `/new` editor · `/s/<id>` legacy short link (301s to
`/view/<id>`).

## Accounts

Google OAuth authorization-code flow, implemented in `src/worker.js`. `GOOGLE_CLIENT_ID` is a
var in `wrangler.jsonc`; `GOOGLE_CLIENT_SECRET` is a Worker secret. Until both are set,
`authConfigured` is false, `/auth/login` serves a short explainer, and the site stays fully
usable signed-out (browse, fork, publish anonymously). Setup steps: GUIDE.md section 5.

Session: `mo_sess` cookie (HttpOnly, SameSite=Lax, Secure over https) → `sess:<token>` in KV,
30-day TTL. The OAuth `state` is carried in a short-lived `mo_oauth` cookie so the callback is
bound to the browser that started the flow (without that binding an attacker can sign a victim
into the attacker's account).

## API

- `POST /api/share` — `{title, desc, tags, visibility, parent, doc, thumb}` → `{id, url}`; doc
  is the full symsim envelope `{name, appInfo:{fileFormatRelease:1}, params}` (~3 MB, the
  simulation buffer is embedded); thumb is a PNG data URL captured from the GL canvas.
- `GET /api/list?sort=new|likes&q=` — public patterns.
- `GET /api/shader/<id>?view=1` — metadata, stats, `isMine`, `likedByMe`, fork lineage.
- `GET|POST /api/comments/<id>`, `POST /api/like/<id>`, `POST /api/delete/<id>`.
- `GET /api/user/<handle>` — profile + that user's patterns.
- `GET /api/preset/<id>` (or `.json`) — stored document; `.png` — thumbnail.
- `GET /api/me`, `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout`.

Storage is Workers KV: `preset:<id>` (document bytes; metadata carries the summary),
`thumb:<id>` (PNG + visibility), `pidx:<invTs>-<id>` and `uidx:<userId>:<invTs>-<id>`
(gallery and profile indexes — inverted timestamps so lexicographic order is newest-first),
`stat:<id>`, `like:<id>:<userId>`, `cmt:<id>:<ts>-<cid>`, `user:<id>`, `handle:<name>`,
`sess:<token>`, `rate:<ip>:<bucket>`.

Visibility is `public` (listed) / `unlisted` (link only) / `private` (author only, enforced on
the document, the thumbnail, the pattern page's OG tags, and the comment thread). Publishing
anonymously downgrades `private` to `unlisted`, since without an account nobody — including
the author — could ever open it again.

KV has no atomic increment, so like counts are recomputed by counting `like:` keys (always
self-healing) and view counts are exact up to 200 then sampled, to stay under the per-key
write ceiling.

`scripts/migrate-index.sh` is a one-off, re-runnable migration from the pre-rewrite `idx:`
index to `pidx:`; it has already been applied to production.

**Plan note:** the share endpoint parses ~3 MB bodies and the free Workers plan's 10 ms CPU
limit and KV daily quotas (1000 writes / 1000 lists) are too tight for real traffic — deploy
on Workers Paid, or expect share failures under load. `/api/list` responses carry
`Cache-Control: max-age=30` to keep KV list calls off the hot path.

## Develop

```bash
npx wrangler dev        # local, simulated KV
```

## Deploy

```bash
npx wrangler login
npx wrangler kv namespace create PRESETS   # put the returned id into wrangler.jsonc
npx wrangler deploy
```

## Notes

- The vendored preset JSONs are ~2.8 MB each because symsim embeds the simulation grid
  (512×512×2 floats, base64) so patterns resume exactly where they were saved. Shares are the
  same format, hence KV rather than URL-encoded state.
- The editor wrapper whitelists the URL hash to `{preset}` (same-origin) before the symsim
  renderer parses it, because the renderer merges arbitrary hash keys into its options
  (including `scriptUrl`, which would dynamically import a module). CSP `script-src 'self'`
  and `application/json` content-type on stored presets provide defense in depth.
- To refresh `featured.json` after changing vendored presets, rerun the generator described in
  the git history (scans `presets/wp/*.json`).
