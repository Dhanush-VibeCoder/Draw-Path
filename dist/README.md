# Glow Path — Telegram Mini App

A relaxing finger-drawing game: draw a glowing path, guide soft light
particles along it, and collect floating stars before your energy runs out.

Pure HTML + CSS + vanilla JavaScript. No build step, no framework, no
required backend.

## Files

```
index.html   – markup for every screen (menu, game, results, settings, etc.)
style.css    – design tokens + all screen/HUD styling
app.js       – Telegram bootstrap, save system, energy, progression,
               game engine (canvas, object pools, input, loop), ad hooks
_headers     – Cloudflare Pages / Netlify static caching headers
vercel.json  – Vercel static caching headers
netlify.toml – Netlify static caching headers
```

Open `index.html` directly in a browser to test outside Telegram — the code
detects the absence of `window.Telegram.WebApp` and simply skips Telegram-only
calls, so the game is fully playable standalone during development.

---

## 1. Deploying for free

The whole game is static — three files. Any static host works. Push this
folder to a GitHub repo first; all three platforms below deploy straight
from it.

### Option A — Cloudflare Pages (recommended)

1. Push this folder to a GitHub repository.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
3. Pick the repo. Build settings: **no build command**, output directory `/`
   (or whatever folder contains `index.html`).
4. Deploy. You'll get a `https://<project>.pages.dev` URL — that's your Mini
   App URL.
5. (Optional) Attach a custom domain for free under the same project's
   **Custom domains** tab.

Cloudflare Pages serves everything from its global edge network by default,
which is exactly what makes it the best free fit for a spiky, global
Telegram audience — see the scaling notes below.

### Option B — Vercel

1. Push to GitHub.
2. Vercel dashboard → **Add New → Project** → import the repo.
3. Framework preset: **Other** (no build step needed). Leave build command
   empty, output directory `/`.
4. Deploy. `vercel.json` in this repo already sets long-lived caching on the
   static assets.

### Option C — Netlify

1. Push to GitHub.
2. Netlify → **Add new site → Import an existing project**.
3. Build command: empty. Publish directory: `/`.
4. Deploy — `netlify.toml` handles caching headers automatically.

### Option D — GitHub Pages (fallback)

1. Push to GitHub.
2. Repo → **Settings → Pages → Deploy from branch** → pick `main` and `/root`.
3. Your game is live at `https://<user>.github.io/<repo>/`.
   (No custom headers file support, but the game runs identically — GitHub
   Pages' own CDN caching is good enough for this workload.)

### Registering the Mini App with BotFather

1. Message **@BotFather** → `/newapp` (or `/myapps` → your bot → **Edit Web
   App URL** if it already exists).
2. Paste your deployed HTTPS URL (from any option above).
3. Open your bot, tap the menu button / the app's link — Telegram loads the
   Mini App inside its in-app WebView, which is what makes
   `window.Telegram.WebApp` available.

---

## 2. Why this architecture holds up at 50,000 concurrent users

**The game is ~99% client-side.** Every frame of gameplay — path drawing,
particle simulation, star collision, scoring, combos, the energy countdown —
runs entirely inside each player's own WebView using `requestAnimationFrame`.
There is no gameplay tick, physics step, or scoring calculation that ever
touches a server. That means:

- **No server-side compute scales with concurrent *players*, only with
  concurrent *page loads*.** Loading `index.html` + `style.css` + `app.js`
  (a few hundred KB total, mostly the one-time Telegram SDK script) is the
  only network activity gameplay requires, and it's pure static file
  serving — exactly what CDN edge networks are built to do at massive
  scale for free.
- **Cloudflare Pages / Vercel / Netlify / GitHub Pages all front their free
  tiers with a global CDN.** A static asset request is served from an edge
  node near the player, not from a single origin server, so 50,000
  simultaneous sessions look like 50,000 independent cache hits spread
  across a global network rather than 50,000 requests hitting one machine.
- **Progress persistence never round-trips to a server we run.**
  `localStorage` is synchronous and local to the device; Telegram
  `CloudStorage` is Telegram's own infrastructure (not ours) and is used
  only for small, infrequent key/value syncs (debounced, see
  `CONFIG.SAVE_DEBOUNCE_MS`), never per-frame.
- **No WebSockets, no polling loop, no persistent connection per player.**
  There's nothing analogous to a game server holding 50,000 open
  connections — each session is a self-contained static page.
- **If you ever add a leaderboard,** keep it serverless and edge-based (e.g.
  a Cloudflare Worker + KV/D1, or a Vercel Edge Function) and treat it as
  fire-and-forget: submit a score on round end, read a top-N list on the
  results/menu screen. Both operations are infrequent per player (a couple
  of calls per multi-minute session, not per frame), so even a generous
  free tier on serverless compute comfortably covers tens of thousands of
  daily players. Never put matchmaking, physics, or anti-cheat validation
  that needs to run per-frame on a server — that's the pattern that doesn't
  scale for free.

## 3. Performance optimizations already in the code

- **Object pooling for particles and stars** (`Engine`'s `particles` and
  `stars` arrays in `app.js`): fixed-size arrays allocated once at startup,
  reused via round-robin (`particleCursor`) instead of `push`/`splice`, so
  gameplay never triggers garbage collection pauses.
- **Hard particle cap** (`CONFIG.MAX_PARTICLES`) — visual density stays
  pleasant on a flagship phone and never runs away on a low-end one.
- **Spatial sampling of pointer input** (`onPointerMove`) — fast swipes on
  120Hz+ touch digitizers are resampled to a fixed pixel step instead of
  emitting a particle per raw touch event, which would otherwise scale
  particle spawn rate with hardware sampling rate rather than gameplay.
- **DPR capped at 2x** for the canvas backing store — an actual 3x/4x
  device pixel ratio would triple/quadruple pixel fill cost for a glow
  effect that a player can't visually resolve anyway.
- **Single `requestAnimationFrame` loop**, `dt`-clamped to 48ms so an
  alt-tab or a dropped frame can't cause a physics/animation "jump."
- **Loop fully paused** (`cancelAnimationFrame`) on `visibilitychange` and
  whenever the game screen isn't active — a backgrounded Mini App uses 0%
  CPU instead of animating an invisible canvas.
- **Debounced saves** (`persistSave`, `CONFIG.SAVE_DEBOUNCE_MS`) — rapid
  star collects during a combo don't each trigger a `localStorage` write.
- **Glow via radial gradients + moderate `shadowBlur`** on a small number
  of primitives (trail segments, particles, stars), not per-pixel canvas
  filters or offscreen blur passes, which are the usual source of dropped
  frames in "glowy" canvas games on mid-range Android hardware.
- **`touch-action: none` + `overscroll-behavior: none`** on the canvas and
  body prevent the browser's own scroll/zoom gesture handling from
  competing with the game's pointer handling (a common source of jank and
  of accidental page scroll while drawing).

## 4. Where to plug in real integrations later

- **Rewarded ads**: every offer (`+2 Energy`, `Double Stars`,
  `+15s Path Duration`) routes through one function, `showRewardedAd()` in
  `app.js`, marked `// TODO: Connect rewarded ad network here`. Swap its body
  for your chosen SDK's show-ad call (many Telegram-focused ad networks
  exist — Adsgram and similar are common choices) and every call site keeps
  working unchanged.
- **Leaderboard / analytics**: add calls from `onRoundFinished()` and
  `Engine.finishRound()` — keep them fire-and-forget (`fetch(...).catch(() =>
  {})`) so a slow or failed network call never blocks or stalls gameplay.