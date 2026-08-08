# MathOrnament — Simple Guide

*How to test, change, and publish this app. No prior Cloudflare experience needed.*

## What this is

MathOrnament is a website like "Shadertoy, but for symmetric patterns." It shows a gallery of
animated reaction-diffusion patterns. Anyone can open a pattern, watch it run, **fork** it into
the editor, tweak it, and publish their own version. Patterns have descriptions, tags, likes and
comments, and each person who signs in gets a profile page listing their patterns.

The pages:

| URL | What it is |
|---|---|
| `/` | gallery — community patterns (newest / most liked / search) plus featured starting points |
| `/view/<id>` | one pattern: live viewer, fork & like buttons, parameters, comments |
| `/user/<handle>` | someone's profile and their patterns |
| `/new` | the editor with a blank canvas |

The whole site is plain files — **there is no build step**. You edit a file, refresh the
browser, and see the change.

---

## 1. One-time setup on a new computer

Install **Node.js** (version 18 or newer) from <https://nodejs.org> — the "LTS" download.
That's the only thing to install. Every command below is run from inside this folder
(the one containing this file) in a terminal.

---

## 2. Test the app on your computer

Start the local test server:

```bash
npx wrangler dev
```

The first run downloads some tools and may ask "install wrangler?" — answer yes.
When it says `Ready on http://localhost:8787`, open **http://localhost:8787** in Chrome,
Firefox, or Safari.

Things to check:

1. The gallery page loads with pattern thumbnails.
2. Click a **featured preset** — the editor opens with the pattern running. Try the pencil
   tool to draw on it.
3. Click **Publish** (top right), give it a title, and publish. You land on the pattern page.
4. On that page click **Fork** — the editor reopens; publish again, and the new pattern
   should say "Forked from …".
5. Back on the gallery, both patterns appear under "Community patterns" (up to a minute).

Patterns published on your computer are stored only on your computer — they never touch the
real website. When you're done, press **Ctrl+C** in the terminal to stop the server.

---

## 3. Change things

| What you want to change | File(s) to edit |
|---|---|
| Colors, buttons, cards — the whole look | `public/site.css` |
| Top navigation bar, pattern cards, sign-in button | `public/site.js` |
| Gallery page | `public/index.html`, `public/gallery.js` |
| Pattern page (viewer, fork, likes, comments) | `public/view.html`, `public/view.js`, `public/view.css` |
| Profile page | `public/user.html`, `public/user.js`, `public/user.css` |
| The Publish dialog and editor top bar | `public/apps/symsim/gray_scott/js/mo_edit.js`, `css/mo_edit.css` |
| The embedded viewer used on pattern pages | `public/apps/symsim/gray_scott/js/mo_embed.js` |
| The server: sign-in, storage, all the API | `src/worker.js` |
| Which "Featured" presets appear | `public/featured.json` |

Leave `public/lib/` and the other files under `public/apps/` alone — that is the pattern
simulator itself, copied unmodified from the open-source [SymmHub](https://github.com/SymmHub/SymmHub)
project. Keeping it untouched makes it easy to update later.

While `npx wrangler dev` is running, saved edits are picked up automatically —
just refresh the browser.

---

## 4. Publish to the internet (deploy)

**First time only** — connect to the Cloudflare account (a browser window opens; log in there):

```bash
npx wrangler login
```

Then run the deploy script (it creates the storage space and publishes the site):

```bash
./deploy.sh
```

At the end it prints the live address, something like
`https://mathornament.<account-name>.workers.dev` — that's the public site.

**Every time after that**, publishing your latest edits is one command:

```bash
npx wrangler deploy
```

Deploys take about half a minute. There is no downtime — the old version is replaced
seamlessly.

---

## 5. Google sign-in — already set up ✅

Sign-in is **live**. Click "Sign in with Google" on the site and it works. Signing in adds your
name to the patterns you publish, gives you a profile page, and lets you like and comment.
The site still works fine for signed-out visitors: they can browse, open, fork and publish.

What is already in place (you don't need to redo any of it):

- Google Cloud project `psyched-myth-504604-f8` with a published OAuth consent screen.
- An OAuth client whose redirect URIs are
  `https://mathornament.mathornament.workers.dev/auth/callback` and
  `http://localhost:8787/auth/callback`.
- `GOOGLE_CLIENT_ID` in `wrangler.jsonc`, and `GOOGLE_CLIENT_SECRET` stored as a Cloudflare
  secret (it is *not* in any file in this folder).
- `.dev.vars` for local testing — it holds the same two values, is ignored by git, and must
  never be shared or committed.

**Keep the secret safe.** If it ever leaks, go to
<https://console.cloud.google.com/apis/credentials>, open the OAuth client, click
**Reset secret**, then run `npx wrangler secret put GOOGLE_CLIENT_SECRET`, paste the new one,
and `npx wrangler deploy`. Nothing else needs to change.

### Only if you ever start over from a new Google account

You need a Google account. Everything below happens once, in Google's website.

1. Open <https://console.cloud.google.com/> and sign in.
2. Top-left project dropdown → **New project**. Name it `mathornament` → **Create**, then make
   sure that project is selected.
3. In the search bar type **OAuth consent screen** and open it.
   - User type: **External** → **Create**.
   - App name: `MathOrnament`. Pick your email for both support and developer contact.
   - Save through the remaining steps (scopes and test users can stay empty).
   - On the summary page click **Publish app** so anyone can sign in, not just you.
     (If you skip this, only accounts you add as "test users" can sign in.)
4. Search for **Credentials** → **Create credentials** → **OAuth client ID**.
   - Application type: **Web application**. Name: `MathOrnament web`.
   - Under **Authorised redirect URIs** click **Add URI** and add both of these, exactly:
     - `https://mathornament.mathornament.workers.dev/auth/callback`
     - `http://localhost:8787/auth/callback`
   - **Create**. Google shows a **Client ID** and a **Client secret** — keep the tab open.
5. Back in a terminal in this folder, put the client ID into `wrangler.jsonc`, in the `vars`
   section (replace the empty string):

   ```jsonc
   "vars": { "GOOGLE_CLIENT_ID": "1234567890-abcdefg.apps.googleusercontent.com" }
   ```

6. Store the secret (it is never written into a file — this sends it straight to Cloudflare):

   ```bash
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```

   Paste the client secret when it asks, and press Enter.

7. Publish:

   ```bash
   npx wrangler deploy
   ```

Visit the site and click **Sign in with Google** — you should come back signed in, with your
name in the top bar linking to your new profile page.

**To test sign-in locally too**, create a file named `.dev.vars` in this folder (it is for your
computer only — never commit or share it):

```
GOOGLE_CLIENT_ID=1234567890-abcdefg.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-secret-here
```

If sign-in fails, the usual cause is the redirect URI: it must match the site address
character-for-character, including `https://` and the `/auth/callback` ending.

**If you add a custom domain later**, add `https://yourdomain/auth/callback` to the same
"Authorised redirect URIs" list in the Google console — sign-in will fail on the new domain
until you do.

---

## 6. Good to know

- **Watch live activity** on the real site (visitors, errors):

  ```bash
  npx wrangler tail
  ```

- **Where things live:** everything is in Cloudflare "KV" storage, visible in the dashboard
  under *Storage & Databases* → *KV* → the `PRESETS` namespace. Keys are prefixed by what they
  are: `preset:` (the pattern), `thumb:` (its picture), `pidx:`/`uidx:` (gallery and profile
  listings), `stat:` (views/likes/forks), `cmt:` (comments), `like:`, `user:`, `sess:`
  (login sessions). Signed-in authors can delete their own patterns from the pattern page;
  to remove one by hand, delete its `preset:`, `thumb:`, `stat:`, `pidx:` and `uidx:` keys.

- **Cost:** the free Cloudflare plan is fine for trying it out, but each published share is
  ~3 MB and the free plan has tight daily limits. If the site gets real visitors, switch to
  the **Workers Paid** plan ($5/month) in the dashboard — no code changes needed.

- **What is Cloudflare here?** It hosts the files *and* runs a tiny program
  (`src/worker.js`) that saves and serves shared patterns. Both are deployed together by
  `npx wrangler deploy`.

## 7. If something goes wrong

- **"You are not authenticated"** → run `npx wrangler login` again.
- **"Address already in use" when testing** → another test server is running; close the
  other terminal or run `npx wrangler dev --port 8788` and use that address.
- **A pattern link shows "Pattern not found"** → it was deleted, set to private by someone
  else, or the link is mistyped.
- **"Sign in with Google" shows a setup page** → section 5 hasn't been done yet.
- **Sign-in bounces back signed out** → the redirect URI in Google's console doesn't exactly
  match the site address (see the end of section 5).
- **Deployed site broken after an edit** → deploy again from a known-good copy of the
  folder; nothing on Cloudflare is harmed by re-deploying.
