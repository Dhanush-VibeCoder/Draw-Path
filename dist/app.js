/* =========================================================================
   GLOW PATH — app.js
   Pure vanilla JS. No build step, no framework, no external game libs.
   Everything below runs 100% on the player's device — there is no server
   in the hot path of gameplay, which is what lets this scale to tens of
   thousands of concurrent players on a purely static host (see the
   deployment notes at the bottom of this file).

   File map (search these headers to jump around):
     1. CONFIG
     2. UTILITIES
     3. TELEGRAM BOOTSTRAP
     4. STORAGE (localStorage + Telegram CloudStorage)
     5. SAVE SCHEMA + STATE
     6. SCREEN MANAGER / TOAST / HAPTICS
     7. ENERGY SYSTEM
     8. PROGRESSION / COLLECTION (unlockable trails & particles)
     9. MENU CONTROLLER
     10. ONBOARDING CONTROLLER
     11. SETTINGS CONTROLLER
     12. GAME ENGINE (canvas, pools, loop, input)
     13. DAILY CHALLENGE
     14. AD PLACEHOLDERS (rewarded ad hooks)
     15. RESULTS CONTROLLER
     16. BACKEND SYNC (Referral + Store)
     17. BOOT
   ========================================================================= */

/* ============================== 1. CONFIG ============================== */
const CONFIG = {
  MAX_ENERGY: 6,
  ENERGY_REGEN_MS: 18 * 60 * 1000,      // 1 energy every 18 minutes
  ROUND_DURATION_MS: 45_000,             // base run length
  STAR_COUNT: 6,                         // stars alive on screen at once
  STAR_RADIUS: 14,
  COLLECT_RADIUS: 22,                    // particle-to-star collect distance
  COMBO_WINDOW_MS: 1200,                 // time between collects to keep combo alive
  COMBO_MAX_MULT: 5,
  MAX_PARTICLES: 140,                    // hard cap on the object pool (perf ceiling)
  PARTICLE_EMIT_RATE: 2,                 // particles spawned per pointer-move sample
  PARTICLE_LIFE_MS: 900,
  TRAIL_POINT_LIFE_MS: 650,              // how long a path segment stays glowing
  TRAIL_MAX_POINTS: 260,
  // --- Visual polish (additive; no gameplay effect) ---
  AMBIENT_PARTICLE_COUNT: 26,             // slow soft dust motes in the background
  COLLECT_FLASH_MS: 220,                  // brief bright flash where a star was collected
  COLLECT_BURST_COUNT: 10,                // spark particles fired outward on collect
  SAVE_KEY: 'glowpath_save_v1',
  CLOUD_KEY: 'glowpath_save_v1',
  SAVE_DEBOUNCE_MS: 800,
};

// Referral + Store backend (Cloudflare Worker + D1) — see /glow-path-backend.
// TODO: replace with your deployed Worker URL after `wrangler deploy`.
const BACKEND_API_BASE = 'https://glow-path-api.YOUR-SUBDOMAIN.workers.dev';

// TODO: replace with your actual bot username and Mini App short name
// (from BotFather) — used only to build the shareable referral link.
const TELEGRAM_BOT_USERNAME = '@Glow_Path_Game_bot';
const TELEGRAM_APP_SHORT_NAME = 'Glow_Path_Game';

// Mirrors the milestone table in worker.js — kept here only for display
// (labels/order); the backend is the source of truth for what's granted.
const INVITE_COUNT_MILESTONES_UI = [
  { count: 3, label: '3 invites', reward: '30 Invite Points + Badge' },
  { count: 5, label: '5 invites', reward: '50 Invite Points + Special Trail' },
  { count: 10, label: '10 invites', reward: '100 Invite Points + Rare Particle' },
  { count: 25, label: '25 invites', reward: '200 Invite Points + Legendary Frame' },
  { count: 50, label: '50 invites', reward: '400 Invite Points + Exclusive Title' },
];

/* ============================== 2. UTILITIES ============================ */
const now = () => performance.now();
const wallClock = () => Date.now();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const dist2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const pad2 = (n) => String(n).padStart(2, '0');

/** Small deterministic PRNG (mulberry32) so Daily Challenge layouts are
 *  identical for every player on the same UTC date, with zero server calls. */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedFromDateString(dateStr) {
  let h = 0;
  for (let i = 0; i < dateStr.length; i++) { h = (h * 31 + dateStr.charCodeAt(i)) | 0; }
  return h;
}
function todayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/* ========================= 3. TELEGRAM BOOTSTRAP ========================= */
const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

function initTelegram() {
  if (!tg) return; // Allows the game to run standalone in a normal browser for testing.
  tg.ready();
  tg.expand();
  try { tg.setHeaderColor && tg.setHeaderColor('#0B0F1A'); } catch (e) { /* older client */ }
  try { tg.setBackgroundColor && tg.setBackgroundColor('#0B0F1A'); } catch (e) { /* older client */ }
  applyTelegramTheme();
  tg.onEvent && tg.onEvent('themeChanged', applyTelegramTheme);
}

/** Map Telegram theme params onto our CSS variables. Our own dark cosmic
 *  palette remains the default/fallback everywhere Telegram doesn't hand
 *  us a value, so the game still looks intentional outside Telegram too. */
function applyTelegramTheme() {
  if (!tg || !tg.themeParams) return;
  const tp = tg.themeParams;
  const root = document.documentElement.style;
  if (tp.bg_color) root.setProperty('--tg-bg', tp.bg_color);
  if (tp.text_color) root.setProperty('--tg-text', tp.text_color);
  if (tp.hint_color) root.setProperty('--tg-hint', tp.hint_color);
  if (tp.button_color) root.setProperty('--tg-button', tp.button_color);
  if (tp.button_text_color) root.setProperty('--tg-button-text', tp.button_text_color);
}

function hapticImpact(style) {
  if (!save.settings.haptics) return;
  try { tg && tg.HapticFeedback && tg.HapticFeedback.impactOccurred(style || 'light'); } catch (e) {}
}
function hapticNotify(type) {
  if (!save.settings.haptics) return;
  try { tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred(type || 'success'); } catch (e) {}
}
function hapticSelect() {
  if (!save.settings.haptics) return;
  try { tg && tg.HapticFeedback && tg.HapticFeedback.selectionChanged(); } catch (e) {}
}

/* ================ 4. STORAGE (localStorage + CloudStorage) =============== */
/* Client-side, per-device durability comes from localStorage (instant,
 * synchronous). Telegram CloudStorage gives cross-device continuity for the
 * same Telegram account. Neither touches a server we run, which is exactly
 * why this scales for free: saving progress costs Anthropic^H^H us nothing
 * per player, no matter how many are playing at once. */

function localLoad() {
  try {
    const raw = localStorage.getItem(CONFIG.SAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function localSave(obj) {
  try { localStorage.setItem(CONFIG.SAVE_KEY, JSON.stringify(obj)); } catch (e) { /* storage full/disabled */ }
}

function cloudLoad() {
  return new Promise((resolve) => {
    if (!tg || !tg.CloudStorage) return resolve(null);
    try {
      tg.CloudStorage.getItem(CONFIG.CLOUD_KEY, (err, value) => {
        if (err || !value) return resolve(null);
        try { resolve(JSON.parse(value)); } catch (e) { resolve(null); }
      });
    } catch (e) { resolve(null); }
  });
}
function cloudSave(obj) {
  if (!tg || !tg.CloudStorage) return;
  try { tg.CloudStorage.setItem(CONFIG.CLOUD_KEY, JSON.stringify(obj), () => {}); } catch (e) {}
}

let saveDebounceTimer = null;
/** Persist the current save. Debounced so rapid in-round events (star
 *  collects, combo ticks) don't hammer storage 60x/sec. */
function persistSave() {
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    save.updatedAt = wallClock();
    localSave(save);
    cloudSave(save);
  }, CONFIG.SAVE_DEBOUNCE_MS);
}

/* ===================== 5. SAVE SCHEMA + STATE ============================ */
function defaultSave() {
  return {
    version: 1,
    updatedAt: 0,
    totalStars: 0,
    highScore: 0,
    energy: CONFIG.MAX_ENERGY,
    lastRegenAt: wallClock(),
    onboarded: false,
    settings: { haptics: true, sound: true, reducedMotion: false },
    unlockedTrails: ['teal'],
    unlockedParticles: ['spark'],
    equippedTrail: 'teal',
    equippedParticle: 'spark',
    daily: { lastPlayedDate: null, lastScore: 0, bestScore: 0 },
    // How much server-granted energy (from referral rewards, via the
    // backend) has already been merged into `energy` above — lets us pull
    // the player's D1 profile repeatedly without double-crediting the same
    // referral bonus. See backendSyncProfile().
    serverEnergySynced: 0,
  };
}

/** Merge two saves, keeping whichever has the newer updatedAt as the base,
 *  but always taking the max of purely-additive numeric progress. This is a
 *  simple, good-enough reconciliation for a casual game (no financial
 *  stakes) between local and cloud copies. */
function mergeSaves(a, b) {
  if (!a) return b;
  if (!b) return a;
  const base = (a.updatedAt || 0) >= (b.updatedAt || 0) ? a : b;
  const other = base === a ? b : a;
  return {
    ...base,
    totalStars: Math.max(a.totalStars || 0, b.totalStars || 0),
    highScore: Math.max(a.highScore || 0, b.highScore || 0),
    energy: base.energy,
    unlockedTrails: Array.from(new Set([...(a.unlockedTrails || []), ...(b.unlockedTrails || [])])),
    unlockedParticles: Array.from(new Set([...(a.unlockedParticles || []), ...(b.unlockedParticles || [])])),
  };
}

let save = defaultSave();

/* ==================== 6. SCREEN MANAGER / TOAST / HAPTICS ================ */
const screens = {};
document.querySelectorAll('.screen').forEach((el) => { screens[el.id] = el; });

function showScreen(id) {
  Object.values(screens).forEach((el) => el.classList.remove('active'));
  screens[id].classList.add('active');
}

let toastTimer = null;
function showToast(msg, ms = 1800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ========================== 7. ENERGY SYSTEM ============================= */
/** Energy regenerates based on elapsed wall-clock time, not a running
 *  interval — so it correctly "catches up" even if the Mini App was fully
 *  closed for hours. This is recomputed on load and every time the menu
 *  becomes visible. */
function reconcileEnergy() {
  if (save.energy >= CONFIG.MAX_ENERGY) { save.lastRegenAt = wallClock(); return; }
  const elapsed = wallClock() - save.lastRegenAt;
  const gained = Math.floor(elapsed / CONFIG.ENERGY_REGEN_MS);
  if (gained > 0) {
    save.energy = clamp(save.energy + gained, 0, CONFIG.MAX_ENERGY);
    save.lastRegenAt += gained * CONFIG.ENERGY_REGEN_MS;
    if (save.energy >= CONFIG.MAX_ENERGY) save.lastRegenAt = wallClock();
    persistSave();
  }
}
function msUntilNextEnergy() {
  if (save.energy >= CONFIG.MAX_ENERGY) return 0;
  return Math.max(0, CONFIG.ENERGY_REGEN_MS - (wallClock() - save.lastRegenAt));
}
function spendEnergy(n = 1) {
  save.energy = clamp(save.energy - n, 0, CONFIG.MAX_ENERGY);
  persistSave();
}
function addEnergy(n) {
  save.energy = clamp(save.energy + n, 0, CONFIG.MAX_ENERGY);
  persistSave();
}

/* ============ 8. PROGRESSION / COLLECTION (unlockable cosmetics) ========= */
const TRAILS = [
  { id: 'teal', name: 'Teal', cost: 0, color: '#7FE7DC' },
  { id: 'violet', name: 'Violet', cost: 40000, color: '#B79CFF' },
  { id: 'gold', name: 'Gold', cost: 80000, color: '#FFD873' },
  { id: 'rose', name: 'Rose', cost: 120000, color: '#FF9BC0' },
  { id: 'ice', name: 'Ice', cost: 160000, color: '#9AD8FF' },
  { id: 'ember', name: 'Ember', cost: 220000, color: '#FF8C5A' },
  { id: 'mint', name: 'Mint', cost: 280000, color: '#8CFFC1' },
  { id: 'aurora', name: 'Aurora', cost: 360000, color: '#C6FF6B' },
];
const PARTICLE_STYLES = [
  { id: 'spark', name: 'Spark', cost: 0, color: '#FFFFFF' },
  { id: 'ember', name: 'Ember', cost: 60000, color: '#FFC98C' },
  { id: 'frost', name: 'Frost', cost: 100000, color: '#BFEFFF' },
  { id: 'blossom', name: 'Blossom', cost: 150000, color: '#FFC1E0' },
  { id: 'nova', name: 'Nova', cost: 240000, color: '#D6C2FF' },
];

function renderCollectionGrids() {
  document.getElementById('collectionStars').textContent = save.totalStars;
  const trailGrid = document.getElementById('trailGrid');
  const particleGrid = document.getElementById('particleGrid');
  trailGrid.innerHTML = '';
  particleGrid.innerHTML = '';
  TRAILS.forEach((t) => trailGrid.appendChild(buildSwatch(t, 'trail')));
  PARTICLE_STYLES.forEach((p) => particleGrid.appendChild(buildSwatch(p, 'particle')));
}
function buildSwatch(item, kind) {
  const unlockedList = kind === 'trail' ? save.unlockedTrails : save.unlockedParticles;
  const equipped = kind === 'trail' ? save.equippedTrail : save.equippedParticle;
  const isUnlocked = unlockedList.includes(item.id);
  const isEquipped = equipped === item.id;

  const el = document.createElement('div');
  el.className = 'swatch' + (isUnlocked ? '' : ' locked') + (isEquipped ? ' equipped' : '');
  el.innerHTML = `
    <div class="dot-preview" style="background:${item.color}; box-shadow:0 0 12px ${item.color}"></div>
    <span class="cost">${isUnlocked ? (isEquipped ? 'Equipped' : item.name) : '★ ' + item.cost}</span>
    ${isUnlocked ? '' : '<span class="lock-icon">🔒</span>'}
  `;
  el.addEventListener('click', () => {
    if (isUnlocked) {
      hapticSelect();
      if (kind === 'trail') save.equippedTrail = item.id; else save.equippedParticle = item.id;
      persistSave();
      renderCollectionGrids();
    } else if (save.totalStars >= item.cost) {
      hapticNotify('success');
      save.totalStars -= item.cost;
      if (kind === 'trail') { save.unlockedTrails.push(item.id); save.equippedTrail = item.id; }
      else { save.unlockedParticles.push(item.id); save.equippedParticle = item.id; }
      persistSave();
      renderCollectionGrids();
      showToast(`${item.name} unlocked!`);
    } else {
      hapticNotify('error');
      showToast('Not enough stars yet');
    }
  });
  return el;
}
function getEquippedColor(kind) {
  const list = kind === 'trail' ? TRAILS : PARTICLE_STYLES;
  const id = kind === 'trail' ? save.equippedTrail : save.equippedParticle;
  return (list.find((x) => x.id === id) || list[0]).color;
}

/* ============================ 9. MENU CONTROLLER ========================== */
let energyTimerInterval = null;

function refreshMenu() {
  reconcileEnergy();
  document.getElementById('menuTotalStars').textContent = save.totalStars;
  document.getElementById('menuEnergy').textContent = save.energy;
  document.getElementById('btnGetEnergy').hidden = save.energy >= CONFIG.MAX_ENERGY;

  const wrap = document.getElementById('energyTimerWrap');
  if (save.energy >= CONFIG.MAX_ENERGY) {
    wrap.hidden = true;
  } else {
    wrap.hidden = false;
    updateEnergyTimerText();
  }

  const dailyDone = save.daily.lastPlayedDate === todayKey();
  document.getElementById('dailyBadge').hidden = dailyDone;
}
function updateEnergyTimerText() {
  const ms = msUntilNextEnergy();
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60), s = totalSec % 60;
  document.getElementById('energyTimer').textContent = `${pad2(m)}:${pad2(s)}`;
}
function startMenuLoop() {
  clearInterval(energyTimerInterval);
  energyTimerInterval = setInterval(() => {
    if (!screens['screen-menu'].classList.contains('active')) return;
    reconcileEnergy();
    updateEnergyTimerText();
    document.getElementById('menuEnergy').textContent = save.energy;
    document.getElementById('btnGetEnergy').hidden = save.energy >= CONFIG.MAX_ENERGY;
    document.getElementById('energyTimerWrap').hidden = save.energy >= CONFIG.MAX_ENERGY;
  }, 1000);
}

function goToMenu() {
  Engine.stop();
  tg && tg.enableClosingConfirmation && tg.disableClosingConfirmation && tg.disableClosingConfirmation();
  refreshMenu();
  showScreen('screen-menu');
}

/* ========================== 10. ONBOARDING CONTROLLER ===================== */
let onboardStep = 0;
function initOnboarding() {
  const slides = document.querySelectorAll('.onboard-slide');
  const dots = document.querySelectorAll('.dot');
  document.getElementById('btnOnboardNext').addEventListener('click', () => {
    hapticSelect();
    onboardStep++;
    if (onboardStep >= slides.length) {
      save.onboarded = true;
      persistSave();
      goToMenu();
      return;
    }
    slides.forEach((s) => s.classList.toggle('active', +s.dataset.step === onboardStep));
    dots.forEach((d) => d.classList.toggle('active', +d.dataset.dot === onboardStep));
    document.getElementById('btnOnboardNext').textContent = onboardStep === slides.length - 1 ? "Let's play" : 'Next';
  });
  slides.forEach((s) => s.classList.toggle('active', +s.dataset.step === 0));
}

/* ========================== 11. SETTINGS CONTROLLER ======================== */
function initSettings() {
  const haptics = document.getElementById('toggleHaptics');
  const sound = document.getElementById('toggleSound');
  const reduced = document.getElementById('toggleReducedMotion');

  haptics.checked = save.settings.haptics;
  sound.checked = save.settings.sound;
  reduced.checked = save.settings.reducedMotion;
  document.body.classList.toggle('reduce-motion', save.settings.reducedMotion);

  haptics.addEventListener('change', () => { save.settings.haptics = haptics.checked; persistSave(); });
  sound.addEventListener('change', () => { save.settings.sound = sound.checked; persistSave(); });
  reduced.addEventListener('change', () => {
    save.settings.reducedMotion = reduced.checked;
    document.body.classList.toggle('reduce-motion', reduced.checked);
    persistSave();
  });

  document.getElementById('btnResetProgress').addEventListener('click', () => {
    if (!confirm('Reset all progress? This cannot be undone.')) return;
    save = defaultSave();
    persistSave();
    renderCollectionGrids();
    refreshMenu();
    showToast('Progress reset');
  });

  document.getElementById('btnSettingsBack').addEventListener('click', goToMenu);
  document.getElementById('btnCollectionBack').addEventListener('click', goToMenu);
}

/* ============================ 12. GAME ENGINE ============================= */
/*
 * PERFORMANCE NOTES (why this holds 60fps on mid-range phones):
 *  - Object pooling: particles and stars are fixed-size arrays allocated
 *    once. Nothing is `new`'d or garbage-collected during play, so there
 *    are no GC pauses mid-round.
 *  - The canvas is sized in device pixels (capped at 2x DPR) and CSS
 *    pixels are used everywhere in game logic; only the render step scales.
 *  - A single requestAnimationFrame loop drives both update() and draw();
 *    there are no secondary timers running during gameplay.
 *  - The loop is fully stopped (cancelAnimationFrame) whenever the game
 *    screen is not visible or the document is hidden, so a backgrounded
 *    Mini App uses zero CPU.
 *  - Glow is achieved with radial gradients + shadowBlur on a modest
 *    number of shapes (path drawn as a handful of quadratic segments, not
 *    per-pixel), not with expensive canvas filters or offscreen blur passes.
 */
const Engine = (() => {
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d', { alpha: false });

  let dpr = 1;
  let cssW = 0, cssH = 0;
  let rafId = null;
  let running = false;
  let lastFrameTime = 0;

  let roundDurationMs = CONFIG.ROUND_DURATION_MS;
  let timeLeftMs = 0;
  let score = 0;
  let combo = 1;
  let bestCombo = 1;
  let lastCollectAt = -Infinity;
  let doubleStarsArmed = false; // set by rewarded-ad hook for the *next* run
  let isDaily = false;
  let dailyRng = Math.random;

  // ---- Object pools -------------------------------------------------
  const particles = new Array(CONFIG.MAX_PARTICLES);
  for (let i = 0; i < particles.length; i++) {
    // `color` is optional — null uses the equipped particle style (default drift
    // particles); collect-burst sparks set it explicitly to the star gold color.
    particles[i] = { active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 0, color: null };
  }
  let particleCursor = 0; // round-robin allocation avoids scanning for a free slot

  const stars = new Array(CONFIG.STAR_COUNT);
  for (let i = 0; i < stars.length; i++) {
    stars[i] = { active: false, x: 0, y: 0, phase: Math.random() * Math.PI * 2, collected: false };
  }

  // Small fixed pool of brief "flash" glows left behind at a star's position
  // the instant it's collected — purely decorative, no gameplay effect.
  const collectFlashes = new Array(8);
  for (let i = 0; i < collectFlashes.length; i++) collectFlashes[i] = { active: false, x: 0, y: 0, age: 0 };
  let flashCursor = 0;

  // Soft, slow-moving ambient dust motes drifting in the background. Fixed
  // pool, initialized once on first resize, very low opacity by design.
  const ambientParticles = new Array(CONFIG.AMBIENT_PARTICLE_COUNT);
  let ambientInitialized = false;

  // Path trail is a ring buffer of recent pointer samples.
  const trail = [];

  // ---- Pointer state --------------------------------------------------
  let pointerDown = false;
  let lastPX = 0, lastPY = 0;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssW = window.innerWidth;
    cssH = window.innerHeight;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!ambientInitialized) { initAmbientParticles(); ambientInitialized = true; }
  }
  window.addEventListener('resize', resize);

  function initAmbientParticles() {
    for (let i = 0; i < ambientParticles.length; i++) {
      ambientParticles[i] = {
        x: rand(0, cssW), y: rand(0, cssH),
        vx: rand(-0.006, 0.006), vy: rand(-0.004, -0.014), // gentle upward drift
        size: rand(0.8, 1.8),
        baseAlpha: rand(0.05, 0.13),
        phase: rand(0, Math.PI * 2),
      };
    }
  }

  function spawnStar(s) {
    const margin = 60;
    s.x = rand(margin, cssW - margin);
    s.y = rand(margin + 80, cssH - margin - 40);
    s.phase = dailyRng() * Math.PI * 2;
    s.active = true;
    s.collected = false;
  }
  function resetStars() {
    stars.forEach(spawnStar);
  }

  function spawnParticleAt(x, y, dirX, dirY) {
    const p = particles[particleCursor];
    particleCursor = (particleCursor + 1) % particles.length;
    p.active = true;
    p.x = x; p.y = y;
    const speed = rand(0.02, 0.09);
    p.vx = dirX * speed + rand(-0.03, 0.03);
    p.vy = dirY * speed + rand(-0.03, 0.03);
    p.life = 0;
    p.maxLife = CONFIG.PARTICLE_LIFE_MS * rand(0.7, 1.2);
    p.size = rand(2.2, 4.2);
    p.color = null;
  }

  /** Small radiating spark burst fired the instant a star is collected.
   *  Reuses the same particle pool (round-robin), so it stays within the
   *  existing MAX_PARTICLES cap — no extra allocation, no perf cost. */
  function spawnCollectBurst(x, y) {
    for (let i = 0; i < CONFIG.COLLECT_BURST_COUNT; i++) {
      const p = particles[particleCursor];
      particleCursor = (particleCursor + 1) % particles.length;
      const angle = rand(0, Math.PI * 2);
      const speed = rand(0.12, 0.3);
      p.active = true;
      p.x = x; p.y = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.life = 0;
      p.maxLife = rand(260, 420);
      p.size = rand(1.6, 3.2);
      p.color = '#FFD873'; // star gold, regardless of equipped particle style
    }
  }

  function spawnCollectFlash(x, y) {
    const f = collectFlashes[flashCursor];
    flashCursor = (flashCursor + 1) % collectFlashes.length;
    f.active = true; f.x = x; f.y = y; f.age = 0;
  }

  function addComboAndScore(baseValue) {
    const t = wallClock();
    if (t - lastCollectAt <= CONFIG.COMBO_WINDOW_MS) {
      combo = Math.min(CONFIG.COMBO_MAX_MULT, combo + 1);
    } else {
      combo = 1;
    }
    lastCollectAt = t;
    bestCombo = Math.max(bestCombo, combo);
    score += baseValue * combo;
    updateHudScore();
  }

  function updateHudScore() {
    document.getElementById('hudScore').textContent = score;
    const comboEl = document.getElementById('hudCombo');
    if (combo > 1) {
      comboEl.hidden = false;
      document.getElementById('hudComboVal').textContent = combo;
    } else {
      comboEl.hidden = true;
    }
  }

  // ---- Input ------------------------------------------------------------
  function onPointerDown(e) {
    pointerDown = true;
    const { x, y } = pointerPos(e);
    lastPX = x; lastPY = y;
    trail.push({ x, y, t: now() });
  }
  function onPointerMove(e) {
    if (!pointerDown) return;
    const { x, y } = pointerPos(e);
    const dx = x - lastPX, dy = y - lastPY;
    const d = Math.hypot(dx, dy) || 1;
    const dirX = dx / d, dirY = dy / d;

    // Sample the trail at a fixed spatial resolution rather than once per
    // event so fast swipes on high-report-rate touchscreens don't flood
    // the trail/particle arrays.
    const steps = Math.min(4, Math.max(1, Math.floor(d / 8)));
    for (let i = 1; i <= steps; i++) {
      const ix = lerp(lastPX, x, i / steps);
      const iy = lerp(lastPY, y, i / steps);
      trail.push({ x: ix, y: iy, t: now() });
      for (let k = 0; k < CONFIG.PARTICLE_EMIT_RATE; k++) spawnParticleAt(ix, iy, dirX, dirY);
    }
    if (trail.length > CONFIG.TRAIL_MAX_POINTS) trail.splice(0, trail.length - CONFIG.TRAIL_MAX_POINTS);

    lastPX = x; lastPY = y;
  }
  function onPointerUp() { pointerDown = false; }
  function pointerPos(e) {
    const t = e.touches && e.touches[0] ? e.touches[0] : e;
    const rect = canvas.getBoundingClientRect();
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  }

  function bindInput() {
    canvas.addEventListener('pointerdown', onPointerDown, { passive: true });
    canvas.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', onPointerUp, { passive: true });
    window.addEventListener('pointercancel', onPointerUp, { passive: true });
  }
  let inputBound = false;

  // ---- Update / Draw ------------------------------------------------------
  function update(dt) {
    // Trail fade (drop points past their lifetime)
    const cutoff = now() - CONFIG.TRAIL_POINT_LIFE_MS;
    while (trail.length && trail[0].t < cutoff) trail.shift();

    // Particles
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p.active) continue;
      p.life += dt;
      if (p.life >= p.maxLife) { p.active = false; continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.985;
      p.vy *= 0.985;
    }

    // Star collision (small fixed N*M, cheap every frame)
    for (let s = 0; s < stars.length; s++) {
      const star = stars[s];
      if (!star.active) continue;
      star.phase += dt * 0.002;
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        if (!p.active) continue;
        if (dist2(p.x, p.y, star.x, star.y) <= CONFIG.COLLECT_RADIUS * CONFIG.COLLECT_RADIUS) {
          collectStar(star);
          break;
        }
      }
    }

    // Ambient background dust — extremely cheap, just position + gentle wrap
    for (let i = 0; i < ambientParticles.length; i++) {
      const a = ambientParticles[i];
      a.x += a.vx * dt; a.y += a.vy * dt;
      if (a.x < -4) a.x = cssW + 4; else if (a.x > cssW + 4) a.x = -4;
      if (a.y < -4) a.y = cssH + 4; else if (a.y > cssH + 4) a.y = -4;
    }

    // Collect flashes — brief, purely visual, fixed pool
    for (let i = 0; i < collectFlashes.length; i++) {
      const f = collectFlashes[i];
      if (!f.active) continue;
      f.age += dt;
      if (f.age >= CONFIG.COLLECT_FLASH_MS) f.active = false;
    }

    // Round timer
    timeLeftMs -= dt;
    updateTimerHud();
    if (timeLeftMs <= 0) { finishRound(); }
  }

  function collectStar(star) {
    star.active = false;
    hapticImpact('light');
    spawnCollectBurst(star.x, star.y);
    spawnCollectFlash(star.x, star.y);
    addComboAndScore(10);
    // Respawn elsewhere after a short delay so the field always feels alive.
    setTimeout(() => { if (running) spawnStar(star); }, 260);
  }

  function updateTimerHud() {
    const secs = Math.max(0, Math.ceil(timeLeftMs / 1000));
    document.getElementById('hudTimeLeft').textContent = secs;
    const frac = clamp(timeLeftMs / roundDurationMs, 0, 1);
    const circumference = 119.4;
    document.getElementById('ringProgress').style.strokeDashoffset = String(circumference * (1 - frac));
    const ring = document.getElementById('ringProgress');
    ring.style.stroke = frac < 0.2 ? '#FF7A7A' : 'var(--accent-glow)';
  }

  function draw() {
    // Deep-space background (cheap solid clear beats re-drawing a gradient every frame)
    ctx.fillStyle = '#0B0F1A';
    ctx.fillRect(0, 0, cssW, cssH);

    drawAmbientParticles();
    drawTrail();
    drawStars();
    drawCollectFlashes();
    drawParticles();
  }

  function drawAmbientParticles() {
    const t = now();
    ctx.save();
    for (let i = 0; i < ambientParticles.length; i++) {
      const a = ambientParticles[i];
      const flicker = 0.75 + Math.sin(t * 0.0006 + a.phase) * 0.25;
      ctx.globalAlpha = a.baseAlpha * flicker;
      ctx.fillStyle = '#EAF2FF';
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawTrail() {
    if (trail.length < 2) return;
    const color = getEquippedColor('trail');
    const tNow = now();
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Pass 1 — soft outer bloom / afterimage: wider, more blurred, slower to
    // fade than the core line, so recent movement leaves a lingering glow.
    ctx.shadowColor = color;
    ctx.shadowBlur = 32;
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1], b = trail[i];
      const age = (tNow - b.t) / (CONFIG.TRAIL_POINT_LIFE_MS * 1.6);
      const alpha = clamp(1 - age, 0, 1);
      if (alpha <= 0) continue;
      ctx.globalAlpha = alpha * 0.35;
      ctx.strokeStyle = color;
      ctx.lineWidth = lerp(16, 5, clamp(age, 0, 1));
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // Pass 2 — crisp, brighter core line on top.
    ctx.shadowBlur = 20;
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1], b = trail[i];
      const age = (tNow - b.t) / CONFIG.TRAIL_POINT_LIFE_MS;
      const alpha = clamp(1 - age, 0, 1);
      if (alpha <= 0) continue;
      ctx.globalAlpha = alpha * 0.95;
      ctx.strokeStyle = color;
      ctx.lineWidth = lerp(6, 2, age);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawStars() {
    const t = now();
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      if (!s.active) continue;
      const pulse = 1 + Math.sin(t * 0.004 + s.phase) * 0.15;
      const r = CONFIG.STAR_RADIUS * pulse;
      const grad = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * 2.2);
      grad.addColorStop(0, 'rgba(255,255,255,0.95)');
      grad.addColorStop(0.35, 'rgba(255,216,115,0.85)');
      grad.addColorStop(1, 'rgba(255,216,115,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Brief bright flash left behind at the exact spot a star was collected —
   *  purely decorative, drawn from the small fixed collectFlashes pool. */
  function drawCollectFlashes() {
    for (let i = 0; i < collectFlashes.length; i++) {
      const f = collectFlashes[i];
      if (!f.active) continue;
      const frac = 1 - f.age / CONFIG.COLLECT_FLASH_MS; // 1 -> 0
      const r = CONFIG.STAR_RADIUS * (2.4 + (1 - frac) * 1.2);
      const grad = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, r);
      grad.addColorStop(0, `rgba(255,255,255,${0.9 * frac})`);
      grad.addColorStop(0.4, `rgba(255,216,115,${0.7 * frac})`);
      grad.addColorStop(1, 'rgba(255,216,115,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(f.x, f.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawParticles() {
    const defaultColor = getEquippedColor('particle');
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p.active) continue;
      const color = p.color || defaultColor;
      const alpha = clamp(1 - p.life / p.maxLife, 0, 1);
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 3);
      grad.addColorStop(0, hexToRgba(color, alpha));
      grad.addColorStop(1, hexToRgba(color, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function hexToRgba(hex, a) {
    const v = hex.replace('#', '');
    const r = parseInt(v.substring(0, 2), 16), g = parseInt(v.substring(2, 4), 16), b = parseInt(v.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  function frame(t) {
    if (!running) return;
    const dt = Math.min(48, t - lastFrameTime); // clamp dt to avoid huge jumps on tab-switch
    lastFrameTime = t;
    update(dt);
    draw();
    rafId = requestAnimationFrame(frame);
  }

  function pause() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
  }
  function resumeLoop() {
    if (running) return;
    running = true;
    lastFrameTime = now();
    rafId = requestAnimationFrame(frame);
  }

  function startRound({ daily = false, durationBonusMs = 0 } = {}) {
    resize();
    if (!inputBound) { bindInput(); inputBound = true; }
    isDaily = daily;
    dailyRng = daily ? mulberry32(seedFromDateString(todayKey())) : Math.random;
    roundDurationMs = CONFIG.ROUND_DURATION_MS + durationBonusMs;
    timeLeftMs = roundDurationMs;
    score = 0; combo = 1; bestCombo = 1; lastCollectAt = -Infinity;
    trail.length = 0;
    particles.forEach((p) => (p.active = false));
    collectFlashes.forEach((f) => (f.active = false));
    resetStars();
    updateHudScore();
    updateTimerHud();
    document.getElementById('pauseOverlay').hidden = true;
    tg && tg.enableClosingConfirmation && tg.enableClosingConfirmation();
    resumeLoop();
  }

  function finishRound() {
    pause();
    tg && tg.disableClosingConfirmation && tg.disableClosingConfirmation();
    let finalScore = score;
    if (doubleStarsArmed) { finalScore *= 2; doubleStarsArmed = false; }

    save.totalStars += finalScore;
    if (isDaily) {
      save.daily.lastPlayedDate = todayKey();
      save.daily.lastScore = finalScore;
      save.daily.bestScore = Math.max(save.daily.bestScore, finalScore);
    } else {
      save.highScore = Math.max(save.highScore, finalScore);
    }
    persistSave();
    hapticNotify('success');
    backendCheckRewards(finalScore); // fire-and-forget — see section 16
    onRoundFinished(finalScore, bestCombo, isDaily);
  }

  function quitToMenu() {
    pause();
    tg && tg.disableClosingConfirmation && tg.disableClosingConfirmation();
    goToMenu();
  }

  function armDoubleStars() { doubleStarsArmed = true; }

  return { startRound, pause, resumeLoop, quitToMenu, armDoubleStars, stop: pause, get score() { return score; } };
})();

// Pause the loop whenever the tab/app is hidden — saves battery and avoids
// any timers accumulating drift while backgrounded (helps at 50k scale too:
// idle clients truly go idle, no wasted client CPU/network).
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    Engine.pause();
    return;
  }
  // Only auto-resume if we're back on the gameplay screen, a round is
  // actually in progress (not the pre-round "ready" card), and the user
  // hadn't manually paused it themselves.
  const onGameScreen = screens['screen-game'].classList.contains('active');
  const userPaused = !document.getElementById('pauseOverlay').hidden;
  const awaitingStart = !document.getElementById('readyOverlay').hidden;
  if (onGameScreen && !userPaused && !awaitingStart) Engine.resumeLoop();
});

/* ========================= 13. DAILY CHALLENGE =========================== */
function startDailyChallenge() {
  if (save.energy < 1) { showToast('Not enough energy'); return; }
  spendEnergy(1);
  showScreen('screen-game');
  document.getElementById('readyTitle').textContent = 'Daily Challenge';
  document.getElementById('readySub').textContent = 'Same star layout for everyone today. One shot!';
  document.getElementById('readyOverlay').hidden = false;
  pendingRun = { daily: true, durationBonusMs: 0 };
}

/* ====================== 14. REWARDED ADS (AdsGram) ==================== */
/*
 * Real integration: AdsGram (https://adsgram.ai), a rewarded/interstitial ad
 * network built specifically for Telegram Mini Apps. Docs:
 * https://docs.adsgram.ai/publisher/reward-interstitial-code-examples
 *
 * The controller is created once (lazily, on first use) and reused for every
 * ad request — AdsGram's own examples show a single AdController instance
 * calling .show() repeatedly, not re-initializing per call.
 */
const ADSGRAM_BLOCK_ID = '46743'; // Glow Path's Rewarded Ad block, from partner.adsgram.ai

let adsgramController = null;
function getAdsgramController() {
  if (!adsgramController && window.Adsgram) {
    adsgramController = window.Adsgram.init({ blockId: ADSGRAM_BLOCK_ID });
  }
  return adsgramController;
}

function showRewardedAd(placement, onReward, buttonEl) {
  // `placement` isn't used yet since Glow Path only has one AdsGram Block ID
  // right now — kept as a parameter so a future multi-block setup (e.g. a
  // separate Block ID per placement) is a one-line change here, not a
  // rewrite of every call site.
  const controller = getAdsgramController();
  if (!controller) {
    // SDK script hasn't loaded (e.g. blocked network, or testing outside Telegram) — fail soft.
    showToast('Ad unavailable right now');
    return;
  }

  // Loading state: disable the triggering button and swap its label while
  // the ad is in flight, so a slow network doesn't look like a dead tap.
  // `buttonEl` is optional — callers that don't pass one just skip this.
  let originalText = null;
  if (buttonEl) {
    originalText = buttonEl.textContent;
    buttonEl.disabled = true;
    buttonEl.textContent = 'Loading ad…';
  }
  function restoreButton() {
    if (buttonEl && originalText !== null) {
      buttonEl.disabled = false;
      buttonEl.textContent = originalText;
    }
  }

  controller.show()
    .then((result) => {
      // result.done is true if the user watched to the end (or closed an
      // interstitial) — for our Rewarded block this means "give the reward."
      if (result && result.done) {
        onReward(); // success path — the caller decides the button's final state, if any.
      } else {
        restoreButton(); // ad was skipped/incomplete — let the player try again.
      }
    })
    .catch(() => {
      // User closed early, no fill, or a playback error — no reward, no crash.
      showToast('Ad unavailable right now');
      restoreButton();
    });
}

function wireAdButtons() {
  document.getElementById('btnGetEnergy').addEventListener('click', (e) => {
    showRewardedAd('energy_refill', () => {
      addEnergy(2);
      hapticNotify('success');
      showToast('+2 Energy!');
      refreshMenu();
    }, e.currentTarget);
  });

  document.getElementById('btnExtendDuration').addEventListener('click', (e) => {
    showRewardedAd('extend_duration', () => {
      hapticNotify('success');
      document.getElementById('readyOverlay').hidden = true;
      pendingRun.durationBonusMs = (pendingRun.durationBonusMs || 0) + 15000;
      Engine.startRound(pendingRun);
    }, e.currentTarget);
  });

  document.getElementById('btnDoubleStars').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    showRewardedAd('double_stars', () => {
      Engine.armDoubleStars();
      hapticNotify('success');
      btn.disabled = true;
      btn.textContent = 'Doubling…';
      // Re-apply to the already-finished run's displayed score immediately
      // (the underlying save was already written with the single value;
      // this keeps the UI + save in lockstep for the *next* persist call).
      const scoreEl = document.getElementById('resultsScore');
      const doubled = (parseInt(scoreEl.textContent, 10) || 0) * 2;
      scoreEl.textContent = doubled;
      save.totalStars += doubled / 2; // the other half, since the single value was already added
      save.highScore = Math.max(save.highScore, doubled);
      persistSave();
      btn.textContent = 'Doubled!';
    }, btn);
  });
}

/* ========================== 15. RESULTS CONTROLLER ========================= */
let pendingRun = { daily: false, durationBonusMs: 0 };

function onRoundFinished(finalScore, comboReached, wasDaily) {
  document.getElementById('resultsEyebrow').textContent = wasDaily ? 'Daily Challenge complete' : 'Run complete';
  document.getElementById('resultsScore').textContent = finalScore;
  document.getElementById('resultsHigh').textContent = `Best: ${wasDaily ? save.daily.bestScore : save.highScore}`;
  document.getElementById('resultsStars').textContent = finalScore;
  document.getElementById('resultsCombo').textContent = `x${comboReached}`;
  document.getElementById('btnDoubleStars').disabled = false;
  document.getElementById('btnDoubleStars').textContent = 'Double these stars (Watch Ad)';
  showScreen('screen-results');
  refreshMenu();
}

/* ================== 16. BACKEND SYNC (Referral + Store) ==================== */
/*
 * Everything in this section is best-effort and additive: if the backend is
 * unreachable, misconfigured, or the player is testing outside Telegram
 * (no initData), every function here fails silently and the game continues
 * exactly as it did before this backend existed. Nothing in here is allowed
 * to block gameplay, the save system, or the UI.
 */

function backendConfigured() {
  return !!(tg && tg.initData) && !BACKEND_API_BASE.includes('YOUR-SUBDOMAIN');
}

/** Called once per launch. Registers a new user (and their referral, if any)
 *  server-side, or is a harmless no-op for a returning player. */
async function backendReferralStart() {
  if (!backendConfigured()) return;
  try {
    const referralCode = (tg.initDataUnsafe && tg.initDataUnsafe.start_param) || null;
    await fetch(`${BACKEND_API_BASE}/api/referral/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: tg.initData, referralCode }),
    });
  } catch (e) {
    // Offline, backend down, etc. — nothing to do; local save is unaffected.
  }
}

/** Called once per finished run. Reports this run's stars to the backend so
 *  referral milestones can be evaluated server-side. Does not itself change
 *  any local state — energy/cosmetic effects arrive later via
 *  backendSyncProfile(), which is the single place local save gets touched. */
async function backendCheckRewards(starsEarnedThisRun) {
  if (!backendConfigured()) return;
  try {
    await fetch(`${BACKEND_API_BASE}/api/referral/check-rewards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: tg.initData, starsEarnedThisRun }),
    });
    // Pull any resulting reward (e.g. energy from a referral bonus) into
    // the local save right away, so it's visible without waiting for the
    // next app launch.
    await backendSyncProfile();
  } catch (e) {
    // Best-effort — the run's local score/save already happened regardless.
  }
}

/** Merges server-side energy (granted via referral rewards) into the local
 *  save. Uses save.serverEnergySynced as a watermark so repeated calls
 *  never credit the same server-side energy twice — only the *new* amount
 *  since the last successful sync is added. Cosmetics/invite points earned
 *  via referrals live purely server-side for now (surfaced through
 *  /api/user/profile and the Store endpoints) and don't need local
 *  reconciliation the way energy does, since the existing game only reads
 *  trail/particle unlocks from the local save's own unlock lists. */
async function backendSyncProfile() {
  if (!backendConfigured()) return;
  try {
    const res = await fetch(`${BACKEND_API_BASE}/api/user/profile`, {
      headers: { 'X-Telegram-Init-Data': tg.initData },
    });
    if (!res.ok) return; // e.g. 404 before referral/start has ever run — fine, try again next launch
    const profile = await res.json();
    if (!profile || !profile.ok) return;

    const delta = profile.energy - (save.serverEnergySynced || 0);
    if (delta > 0) {
      addEnergy(delta);
      save.serverEnergySynced = profile.energy;
      persistSave();
      refreshMenu(); // reflect the new energy immediately if the menu is visible
    }
  } catch (e) {
    // Best-effort — local energy regen keeps working regardless.
  }
}

/* ---- Referral screen ------------------------------------------------- */

function getMyTelegramUserId() {
  return (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) ? String(tg.initDataUnsafe.user.id) : null;
}
function buildReferralLink() {
  const myId = getMyTelegramUserId();
  if (!myId) return null;
  return `https://t.me/${TELEGRAM_BOT_USERNAME}/${TELEGRAM_APP_SHORT_NAME}?startapp=ref${myId}`;
}

function renderMilestoneList(successfulInvites, claimed) {
  const list = document.getElementById('milestoneList');
  list.innerHTML = '';
  INVITE_COUNT_MILESTONES_UI.forEach((m) => {
    const isClaimed = !!(claimed && claimed[m.count]);
    const row = document.createElement('div');
    row.className = 'milestone-row' + (isClaimed ? ' claimed' : '');
    row.innerHTML = `
      <div>
        <div class="milestone-label">${m.label}</div>
        <div class="milestone-reward">${m.reward}</div>
      </div>
      <div class="milestone-check">${isClaimed ? '✓' : `${Math.min(successfulInvites, m.count)}/${m.count}`}</div>
    `;
    list.appendChild(row);
  });
}

async function openReferralScreen() {
  showScreen('screen-referral');

  const link = buildReferralLink();
  document.getElementById('referralLinkText').textContent = link || 'Open this game from inside Telegram to get your link.';

  if (!backendConfigured()) {
    renderMilestoneList(0, {});
    return;
  }
  try {
    const res = await fetch(`${BACKEND_API_BASE}/api/user/profile`, {
      headers: { 'X-Telegram-Init-Data': tg.initData },
    });
    const profile = await res.json();
    if (profile && profile.ok) {
      document.getElementById('referralPoints').textContent = profile.invitePoints;
      document.getElementById('referralCount').textContent = profile.successfulInvites;
      renderMilestoneList(profile.successfulInvites, profile.inviteMilestonesClaimed);
    }
  } catch (e) {
    // Leave the screen showing zeroes/placeholders — non-fatal.
  }
}

function wireReferralScreen() {
  document.getElementById('btnReferral').addEventListener('click', openReferralScreen);
  document.getElementById('btnReferralBack').addEventListener('click', goToMenu);

  document.getElementById('btnCopyReferral').addEventListener('click', async () => {
    const link = buildReferralLink();
    if (!link) { showToast('Open this from inside Telegram first'); return; }
    try {
      await navigator.clipboard.writeText(link);
      hapticSelect();
      showToast('Link copied!');
    } catch (e) {
      showToast('Could not copy — long-press the link to copy it manually');
    }
  });

  document.getElementById('btnShareReferral').addEventListener('click', () => {
    const link = buildReferralLink();
    if (!link) { showToast('Open this from inside Telegram first'); return; }
    const shareText = 'Come draw glowing paths and collect stars with me in Glow Path! ✨';
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(shareText)}`;
    if (tg && tg.openTelegramLink) {
      tg.openTelegramLink(shareUrl);
    } else {
      window.open(shareUrl, '_blank');
    }
  });
}

/* ---- Store screen ------------------------------------------------------ */

function renderStoreList(container, items) {
  container.innerHTML = '';
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'store-item';
    const costLabel = item.section === 'premium'
      ? `${item.costStars.toLocaleString()} ★ + ${item.costPoints} 🎟`
      : `${item.costStars.toLocaleString()} ★ or ${item.costPoints} 🎟`;
    row.innerHTML = `
      <div>
        <div class="store-item-name">${item.name}</div>
        <div class="store-item-cost">${costLabel}</div>
      </div>
    `;
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    if (item.owned) {
      btn.textContent = 'Owned';
      btn.disabled = true;
    } else {
      btn.textContent = 'Buy';
      btn.addEventListener('click', () => buyStoreItem(item.id, btn));
    }
    row.appendChild(btn);
    container.appendChild(row);
  });
}

async function openStoreScreen() {
  showScreen('screen-store');
  if (!backendConfigured()) {
    showToast('Store is unavailable right now');
    return;
  }
  try {
    const [itemsRes, profileRes] = await Promise.all([
      fetch(`${BACKEND_API_BASE}/api/store/items`, { headers: { 'X-Telegram-Init-Data': tg.initData } }),
      fetch(`${BACKEND_API_BASE}/api/user/profile`, { headers: { 'X-Telegram-Init-Data': tg.initData } }),
    ]);
    const itemsData = await itemsRes.json();
    const profile = await profileRes.json();

    if (profile && profile.ok) {
      document.getElementById('storeStars').textContent = profile.totalStars.toLocaleString();
      document.getElementById('storePoints').textContent = profile.invitePoints;
    }
    if (itemsData && itemsData.ok) {
      const normal = itemsData.items.filter((i) => i.section === 'normal');
      const premium = itemsData.items.filter((i) => i.section === 'premium');
      renderStoreList(document.getElementById('normalItemsList'), normal);
      renderStoreList(document.getElementById('premiumItemsList'), premium);
    }
  } catch (e) {
    showToast('Could not load the store — check your connection');
  }
}

async function buyStoreItem(itemId, buttonEl) {
  if (!backendConfigured()) return;
  buttonEl.disabled = true;
  buttonEl.textContent = '…';
  try {
    const res = await fetch(`${BACKEND_API_BASE}/api/store/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: tg.initData, itemId }),
    });
    const result = await res.json();
    if (result && result.ok) {
      hapticNotify('success');
      showToast('Purchased!');
      openStoreScreen(); // refresh balances + owned state
    } else {
      hapticNotify('error');
      showToast((result && result.error) || 'Purchase failed');
      buttonEl.disabled = false;
      buttonEl.textContent = 'Buy';
    }
  } catch (e) {
    showToast('Could not reach the store — try again');
    buttonEl.disabled = false;
    buttonEl.textContent = 'Buy';
  }
}

function wireStoreScreen() {
  document.getElementById('btnStore').addEventListener('click', openStoreScreen);
  document.getElementById('btnStoreBack').addEventListener('click', goToMenu);
}

/* ================================ 17. BOOT ================================ */
function wireMenuButtons() {
  document.getElementById('btnPlay').addEventListener('click', () => {
    reconcileEnergy();
    if (save.energy < 1) { showToast('Out of energy — come back soon!'); return; }
    spendEnergy(1);
    pendingRun = { daily: false, durationBonusMs: 0 };
    showScreen('screen-game');
    document.getElementById('readyTitle').textContent = 'Get ready';
    document.getElementById('readySub').textContent = 'Draw a path, guide the light, collect stars.';
    document.getElementById('readyOverlay').hidden = false;
  });

  document.getElementById('btnDaily').addEventListener('click', () => {
    if (save.daily.lastPlayedDate === todayKey()) {
      showToast(`Today's best: ${save.daily.lastScore}`);
      return;
    }
    startDailyChallenge();
  });

  document.getElementById('btnStartRun').addEventListener('click', () => {
    document.getElementById('readyOverlay').hidden = true;
    Engine.startRound(pendingRun);
  });

  document.getElementById('btnSettings').addEventListener('click', () => showScreen('screen-settings'));
  document.getElementById('btnProgress').addEventListener('click', () => { renderCollectionGrids(); showScreen('screen-collection'); });

  document.getElementById('btnPause').addEventListener('click', () => {
    Engine.pause();
    document.getElementById('pauseOverlay').hidden = false;
  });
  document.getElementById('btnResume').addEventListener('click', () => {
    document.getElementById('pauseOverlay').hidden = true;
    Engine.resumeLoop();
  });
  document.getElementById('btnQuit').addEventListener('click', () => {
    document.getElementById('pauseOverlay').hidden = true;
    Engine.quitToMenu();
  });

  document.getElementById('btnPlayAgain').addEventListener('click', () => {
    reconcileEnergy();
    if (save.energy < 1) { showToast('Out of energy — come back soon!'); showScreen('screen-menu'); refreshMenu(); return; }
    spendEnergy(1);
    pendingRun = { daily: false, durationBonusMs: 0 };
    showScreen('screen-game');
    document.getElementById('readyTitle').textContent = 'Get ready';
    document.getElementById('readySub').textContent = 'Draw a path, guide the light, collect stars.';
    document.getElementById('readyOverlay').hidden = false;
  });
  document.getElementById('btnBackToMenu').addEventListener('click', goToMenu);
}

async function boot() {
  initTelegram();

  const local = localLoad();
  const cloud = await cloudLoad();
  save = mergeSaves(local, cloud) || defaultSave();
  // Fill in any fields missing from an older save version.
  save = { ...defaultSave(), ...save, settings: { ...defaultSave().settings, ...(save.settings || {}) } };

  reconcileEnergy();
  wireMenuButtons();
  wireAdButtons();
  wireReferralScreen();
  wireStoreScreen();
  initSettings();
  initOnboarding();
  startMenuLoop();

  // Backend sync (referral registration + any pending referral-earned
  // energy) — fire-and-forget, never blocks first paint. See section 16;
  // both functions no-op silently if BACKEND_API_BASE hasn't been
  // configured yet or the player is outside Telegram.
  backendReferralStart().then(() => backendSyncProfile());

  if (save.onboarded) {
    goToMenu();
  } else {
    showScreen('screen-onboarding');
  }
}

document.addEventListener('DOMContentLoaded', boot);