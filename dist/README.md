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

  # Glow Path — Referral + Store Backend

A Cloudflare Worker + D1 backend, additive to the existing static game. It
does **not** replace or touch any file in the main `glow-path/` folder —
drawing, particles, scoring, and the existing client-side energy/save
system are untouched. This is a separate service the Mini App calls.

## Files

```
schema.sql     – D1 tables (your 3 tables + a few idempotency-tracking columns)
worker.js      – the full Worker: auth, all 5 endpoints, reward logic
wrangler.toml  – deploy config
```

## Deploy

```bash
cd glow-path-backend
wrangler login
wrangler d1 create glow-path-db
# copy the printed database_id into wrangler.toml's [[d1_databases]] block
wrangler d1 execute glow-path-db --remote --file=./schema.sql
wrangler secret put TELEGRAM_BOT_TOKEN
# paste your bot's token from BotFather when prompted
wrangler deploy
```

Wrangler prints your Worker's URL when it deploys — that's the base URL for
every endpoint below (e.g. `https://glow-path-api.<subdomain>.workers.dev`).

Also set `ALLOWED_ORIGIN` in `wrangler.toml` to your actual deployed game
URL once you know it, instead of `"*"`.

---

## Security model — read before wiring this into the client

Every request must include Telegram's `initData` — the raw string from
`Telegram.WebApp.initData` on the client. The Worker verifies its signature
against your bot token server-side and pulls the authenticated user id out
of the *verified* payload. **No endpoint trusts a client-supplied user id**
— this is what stops someone from calling the API with someone else's
numeric Telegram id and granting themselves free rewards on that account.

- POST requests: put it in the JSON body as `initData`.
- GET requests: put it in the `X-Telegram-Init-Data` header.

---

## Endpoints — how to call each one from the Mini App

### 1. `POST /api/referral/start`
Call this once on **every app launch** (not just when there's a referral
code) — it doubles as "make sure my user row exists."

```javascript
const startParam = tg?.initDataUnsafe?.start_param || null; // e.g. "ref123456789"

await fetch('https://glow-path-api.<subdomain>.workers.dev/api/referral/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    initData: tg.initData,
    referralCode: startParam,
  }),
});
```

### 2. `POST /api/referral/check-rewards`
Call this once, right after a run ends — alongside (not instead of) the
existing local `persistSave()` call in `app.js`.

```javascript
await fetch('https://glow-path-api.<subdomain>.workers.dev/api/referral/check-rewards', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    initData: tg.initData,
    starsEarnedThisRun: finalScore, // the same value already used locally
  }),
});
```

### 3. `GET /api/store/items`
```javascript
const res = await fetch('https://glow-path-api.<subdomain>.workers.dev/api/store/items', {
  headers: { 'X-Telegram-Init-Data': tg.initData },
});
const { items } = await res.json();
// items: [{ id, name, type, costStars, costPoints, section, owned }, ...]
```

### 4. `POST /api/store/buy`
```javascript
const res = await fetch('https://glow-path-api.<subdomain>.workers.dev/api/store/buy', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    initData: tg.initData,
    itemId: 'premium_glow_trail',
  }),
});
const result = await res.json();
// { ok: true, purchased, starsSpent, pointsSpent }  or  { ok: false, error }
```

### 5. `GET /api/user/profile`
```javascript
const res = await fetch('https://glow-path-api.<subdomain>.workers.dev/api/user/profile', {
  headers: { 'X-Telegram-Init-Data': tg.initData },
});
const profile = await res.json();
// { totalStars, invitePoints, energy, runsCompleted, referredBy, ownedCosmetics }
```

---

## DB call count per action

| Action | Typical DB calls | Notes |
|---|---|---|
| `/referral/start` — organic user, first launch | 1 | one `INSERT OR IGNORE` |
| `/referral/start` — existing user relaunching | 1 | no-op insert, abuse guard |
| `/referral/start` — new user via valid referral link | 3 | user insert + referral insert + starter-cosmetic insert (last two batched together) |
| `/referral/check-rewards` — organic player | 2 | 1 read + 1 write |
| `/referral/check-rewards` — referred player, no milestone crossed | up to 4 | +1 read (inviter row lookup only if star≥30 attempted) +1 conditional referral-status update |
| `/referral/check-rewards` — crossing a star or invite-count milestone | up to ~7 | rare, one-time per threshold: adds 1 COUNT query + 1 cosmetic batch insert |
| `/store/items` | 1 | owned-item ids pulled via a single `GROUP_CONCAT` |
| `/store/buy` — success | 2 | 1 combined balance+ownership read + 1 atomic batched write |
| `/store/buy` — rejected (already owned / insufficient funds) | 1 | fails after the read, no write |
| `/user/profile` | 1 | one query, correlated subquery pulls owned cosmetics inline |

The common cases (organic player finishing a run, checking the store,
loading their profile) are all 1–2 calls. The more expensive paths only
fire on genuinely rare events — crossing a star threshold or an invite-count
milestone happens at most a handful of times per player, ever.

---

## Important design note: two energy systems currently exist, unmerged

The existing client (`app.js`) has its own energy system entirely in
`localStorage`/CloudStorage (6 max, +1 every 18 minutes) — untouched by this
backend, as required. This new D1 `users.energy` column is a **separate**
ledger that only referral bonuses write to.

**These are not automatically synced.** Right now, a referral energy bonus
lands in D1 but won't show up in the game's own energy counter unless you
add a small reconciliation step — e.g., on boot, after calling
`/api/referral/start`, fetch `/api/user/profile` and add any *new* server
energy (tracked via a small "last synced" value in the local save) into the
client's `save.energy`. I didn't make this change since it touches
`app.js`, and you asked me not to alter existing mechanics without it being
explicit — happy to wire it in as a follow-up if you want the two systems
merged rather than running in parallel.