/* =============================================================================
   GLOW PATH — Referral + Store System — Cloudflare Worker
   =============================================================================
   Deploy with: wrangler deploy
   Requires (see wrangler.toml):
     - a D1 binding named DB (schema.sql applied to it)
     - a secret TELEGRAM_BOT_TOKEN (wrangler secret put TELEGRAM_BOT_TOKEN)
     - an env var ALLOWED_ORIGIN (your Cloudflare Pages game URL, for CORS)

   SECURITY MODEL (read this first)
   ---------------------------------------------------------------------------
   Every request must include Telegram's `initData` string — the raw value of
   `Telegram.WebApp.initData` on the client. The Worker verifies its HMAC
   signature against your bot token (per Telegram's documented scheme) and
   extracts the authenticated user id from *inside* that verified payload.
   A client-supplied "userId" field is never trusted for identity — without
   this, anyone could POST someone else's numeric id and grant themselves
   free stars, energy, or store items on another player's account. This is
   the single most important control in this file; nothing else here matters
   if it's skipped.

   FILE MAP
     1. CONFIG / CATALOG
     2. RESPONSE + CORS HELPERS
     3. TELEGRAM initData VERIFICATION
     4. D1 HELPERS
     5. ROUTE HANDLERS
     6. ROUTER (fetch entrypoint)
   ============================================================================= */

/* ============================== 1. CONFIG / CATALOG ========================= */

// Sanity cap on stars a single run can report. This is a heuristic, not a
// real anti-cheat system — true tamper-proofing would require the server to
// simulate gameplay itself, which is out of scope for a casual game. This
// just stops an obviously-tampered client from instantly maxing every
// referral milestone in one fake "run."
const MAX_STARS_PER_RUN = 5000;

// Minimum stars in a single run for a referral to count as "successful."
const SUCCESSFUL_REFERRAL_STAR_THRESHOLD = 30;

// Invitee total_stars thresholds that pay the INVITER a bonus.
const STAR_MILESTONES = [
  { flag: 'reward_100k', threshold: 100_000, energy: 3, points: 25, cosmetic: null },
  { flag: 'reward_300k', threshold: 300_000, energy: 5, points: 50, cosmetic: 'rare_trail_300k' },
  { flag: 'reward_700k', threshold: 700_000, energy: 5, points: 80, cosmetic: 'exclusive_frame_700k' },
];

// Successful-invite-count milestones for the INVITER.
const INVITE_COUNT_MILESTONES = [
  { flag: 'invite_milestone_3', count: 3, points: 30, cosmetic: 'badge_3_invites' },
  { flag: 'invite_milestone_5', count: 5, points: 50, cosmetic: 'trail_5_invites' },
  { flag: 'invite_milestone_10', count: 10, points: 100, cosmetic: 'particle_10_invites' },
  { flag: 'invite_milestone_25', count: 25, points: 200, cosmetic: 'frame_25_invites' },
  { flag: 'invite_milestone_50', count: 50, points: 400, cosmetic: 'title_50_invites' },
];

const FIRST_RUN_REWARD = { energy: 2, points: 10 };
const NEW_REFERRED_USER_ENERGY_BONUS = 2; // on top of the default 6
const STARTER_TRAIL_ITEM_ID = 'starter_trail_referral';

// Store catalog. This is intentionally static, in-code data — no DB call
// needed to know what's for sale, only to know what a given player owns.
// customize freely; the "Normal Items" examples below are illustrative.
const NORMAL_ITEMS = [
  { id: 'normal_trail_sunset', name: 'Sunset Trail', type: 'trail', costStars: 5000, costPoints: 15 },
  { id: 'normal_trail_ocean', name: 'Ocean Trail', type: 'trail', costStars: 8000, costPoints: 20 },
  { id: 'normal_particle_comet', name: 'Comet Particles', type: 'particle', costStars: 6000, costPoints: 18 },
];
const PREMIUM_ITEMS = [
  { id: 'premium_glow_trail', name: 'Premium Glow Trail', type: 'trail', costStars: 25_000, costPoints: 60 },
  { id: 'elite_particle_pack', name: 'Elite Particle Pack', type: 'particle', costStars: 40_000, costPoints: 90 },
  { id: 'legendary_frame', name: 'Legendary Frame', type: 'frame', costStars: 60_000, costPoints: 120 },
  { id: 'mythic_aura_trail', name: 'Mythic Aura + Trail', type: 'bundle', costStars: 100_000, costPoints: 200 },
];

// "Legacy" items — these mirror the game's ORIGINAL, client-only trail and
// particle unlocks (the TRAILS/PARTICLE_STYLES arrays in app.js), so that
// buying one of those the normal way also deducts from — and is reflected
// in — the same authoritative server-side total_stars used by the Store.
// IDs are namespaced with trail_/particle_ prefixes because the original
// client-side lists both happen to use the id "ember" for two different
// items (a trail AND a particle style) — harmless locally since they're
// kept in separate arrays there, but would collide in this single
// item_id-keyed ownership table without the prefix. costPoints is 0 for
// all of these: the original mechanic was always stars-only.
// IMPORTANT: keep this list's ids/costs in sync with app.js if you ever
// change TRAILS or PARTICLE_STYLES there.
const LEGACY_ITEMS = [
  { id: 'trail_teal', name: 'Teal Trail (starter)', type: 'trail', costStars: 0, costPoints: 0 },
  { id: 'trail_violet', name: 'Violet Trail', type: 'trail', costStars: 40_000, costPoints: 0 },
  { id: 'trail_gold', name: 'Gold Trail', type: 'trail', costStars: 80_000, costPoints: 0 },
  { id: 'trail_rose', name: 'Rose Trail', type: 'trail', costStars: 120_000, costPoints: 0 },
  { id: 'trail_ice', name: 'Ice Trail', type: 'trail', costStars: 160_000, costPoints: 0 },
  { id: 'trail_ember', name: 'Ember Trail', type: 'trail', costStars: 220_000, costPoints: 0 },
  { id: 'trail_mint', name: 'Mint Trail', type: 'trail', costStars: 280_000, costPoints: 0 },
  { id: 'trail_aurora', name: 'Aurora Trail', type: 'trail', costStars: 360_000, costPoints: 0 },
  { id: 'particle_spark', name: 'Spark Particles (starter)', type: 'particle', costStars: 0, costPoints: 0 },
  { id: 'particle_ember', name: 'Ember Particles', type: 'particle', costStars: 60_000, costPoints: 0 },
  { id: 'particle_frost', name: 'Frost Particles', type: 'particle', costStars: 100_000, costPoints: 0 },
  { id: 'particle_blossom', name: 'Blossom Particles', type: 'particle', costStars: 150_000, costPoints: 0 },
  { id: 'particle_nova', name: 'Nova Particles', type: 'particle', costStars: 240_000, costPoints: 0 },
];

const ALL_ITEMS = [
  ...NORMAL_ITEMS.map((i) => ({ ...i, section: 'normal' })),
  ...PREMIUM_ITEMS.map((i) => ({ ...i, section: 'premium' })),
  ...LEGACY_ITEMS.map((i) => ({ ...i, section: 'legacy' })),
];

/* ========================= 2. RESPONSE + CORS HELPERS ======================= */

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data',
    'Access-Control-Max-Age': '86400',
  };
}
function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}
function ok(data, env) { return json({ ok: true, ...data }, 200, env); }
function fail(message, status, env) { return json({ ok: false, error: message }, status || 400, env); }

/* ==================== 3. TELEGRAM initData VERIFICATION ===================== */
/*
 * Implements Telegram's documented validation scheme:
 *   https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * secret_key = HMAC_SHA256("WebAppData", bot_token)
 * data_check_string = all fields except `hash`, sorted by key, "key=value"
 *                      joined with "\n"
 * expected_hash = HMAC_SHA256(secret_key, data_check_string), hex
 * Reject if expected_hash !== provided hash, or if auth_date is too old
 * (replay protection).
 */
const MAX_INIT_DATA_AGE_SECONDS = 24 * 60 * 60; // 24h

async function hmacSha256(keyBytes, message) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}
function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Returns the verified Telegram user object ({ id, ... }) on success, or
 *  null if the initData is missing, malformed, unsigned, expired, or forged. */
async function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  let params;
  try { params = new URLSearchParams(initData); } catch (e) { return null; }

  const providedHash = params.get('hash');
  if (!providedHash) return null;
  params.delete('hash');

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > MAX_INIT_DATA_AGE_SECONDS) return null;

  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = await hmacSha256(new TextEncoder().encode('WebAppData'), botToken);
  const expected = bytesToHex(await hmacSha256(secretKey, dataCheckString));
  if (expected !== providedHash) return null;

  const userRaw = params.get('user');
  if (!userRaw) return null;
  try {
    const user = JSON.parse(userRaw);
    if (!user || typeof user.id === 'undefined') return null;
    return user;
  } catch (e) {
    return null;
  }
}

/** Pulls initData from the JSON body (POST) or the X-Telegram-Init-Data
 *  header (GET, or POST fallback), verifies it, and returns the caller's
 *  authenticated Telegram user id as a string — never trust any userId
 *  the client puts in the body/query directly. */
async function authenticate(request, env, bodyInitData) {
  const initData = bodyInitData || request.headers.get('X-Telegram-Init-Data');
  const user = await verifyTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
  if (!user) return null;
  return String(user.id);
}

/* ============================== 4. D1 HELPERS ================================ */

/** Reads the fields we need for reward logic, or a set of safe defaults if
 *  the user row doesn't exist yet (it will be created on the next write via
 *  UPSERT — see recordRunAndRewards). Costs 1 SELECT. */
async function getUserForRewards(db, userId) {
  const row = await db.prepare(
    `SELECT user_id, referrer_id, total_stars, invite_points, energy, runs_completed,
            reward_100k, reward_300k, reward_700k
     FROM users WHERE user_id = ?`
  ).bind(userId).first();
  return row || {
    user_id: userId, referrer_id: null, total_stars: 0, invite_points: 0, energy: 6,
    runs_completed: 0, reward_100k: 0, reward_300k: 0, reward_700k: 0,
  };
}

/** Fetches just the inviter fields needed to compute milestone bonuses.
 *  Costs 1 SELECT — only called when a referrer_id is actually present. */
async function getInviterForMilestones(db, inviterId) {
  const row = await db.prepare(
    `SELECT user_id, energy, invite_points,
            invite_milestone_3, invite_milestone_5, invite_milestone_10,
            invite_milestone_25, invite_milestone_50
     FROM users WHERE user_id = ?`
  ).bind(inviterId).first();
  return row || {
    user_id: inviterId, energy: 6, invite_points: 0,
    invite_milestone_3: 0, invite_milestone_5: 0, invite_milestone_10: 0,
    invite_milestone_25: 0, invite_milestone_50: 0,
  };
}

/* ============================ 5. ROUTE HANDLERS =============================== */

/** POST /api/referral/start
 *  Body: { initData, referralCode? }  (referralCode is the raw `start_param`
 *  Telegram gives you, e.g. "ref123456789" — pass it through unmodified)
 *
 *  Also doubles as "ensure my user row exists," so the Mini App should call
 *  this once on every launch, referral code or not.
 *
 *  DB calls: 1 (new/organic user) to 3 (new user arriving via a valid
 *  referral link: users insert + referrals insert + starter-cosmetic insert).
 *  An existing user replaying a referral link costs exactly 1 call (the
 *  no-op insert) and grants nothing — this is the abuse guard: only a
 *  never-before-seen user_id can be attached to a referrer.
 */
async function handleReferralStart(request, env) {
  const body = await safeJson(request);
  const userId = await authenticate(request, env, body.initData);
  if (!userId) return fail('Unauthorized: invalid or missing Telegram initData', 401, env);

  const referralCode = typeof body.referralCode === 'string' ? body.referralCode.trim() : '';
  let referrerId = null;
  if (referralCode.startsWith('ref')) {
    const candidate = referralCode.slice(3);
    if (candidate && candidate !== userId) referrerId = candidate; // no self-referral
  }

  const now = Date.now();
  const startingEnergy = referrerId ? 6 + NEW_REFERRED_USER_ENERGY_BONUS : 6;

  const insertResult = await env.DB.prepare(
    `INSERT OR IGNORE INTO users (user_id, referrer_id, total_stars, invite_points, energy, created_at)
     VALUES (?, ?, 0, 0, ?, ?)`
  ).bind(userId, referrerId, startingEnergy, now).run();

  const isNewUser = insertResult.meta.changes === 1;

  if (isNewUser && referrerId) {
    // Two more writes, only for a genuinely new, validly-referred user.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO referrals (inviter_id, invitee_id, status, created_at) VALUES (?, ?, 'pending', ?)`
      ).bind(referrerId, userId, now),
      env.DB.prepare(
        `INSERT OR IGNORE INTO user_cosmetics (user_id, item_id) VALUES (?, ?)`
      ).bind(userId, STARTER_TRAIL_ITEM_ID),
    ]);
  }

  return ok({
    isNewUser,
    referred: isNewUser && !!referrerId,
    startingEnergy: isNewUser ? startingEnergy : undefined,
  }, env);
}

/** POST /api/referral/check-rewards
 *  Body: { initData, starsEarnedThisRun, bonusOnly? }
 *  Call this once, right after a run ends (in addition to, not instead of,
 *  the existing local save — see the integration notes in README.md).
 *  `bonusOnly: true` is used for a bonus payout on top of an
 *  already-reported run (e.g. a "Double Stars" ad) — see the isBonusOnly
 *  comment below for exactly what that skips.
 *
 *  DB calls — see the full breakdown table in README.md; common cases:
 *    organic player, no referrer:            2 calls (1 read + 1 write)
 *    referred player, no milestone crossed:   up to 4 calls
 *    referred player, crossing a rare
 *    star/invite-count milestone:             up to ~7 calls (rare, one-time each)
 */
async function handleCheckRewards(request, env) {
  const body = await safeJson(request);
  const userId = await authenticate(request, env, body.initData);
  if (!userId) return fail('Unauthorized: invalid or missing Telegram initData', 401, env);

  let starsEarned = Number(body.starsEarnedThisRun);
  if (!Number.isFinite(starsEarned) || starsEarned < 0) return fail('Invalid starsEarnedThisRun', 400, env);
  starsEarned = Math.min(Math.floor(starsEarned), MAX_STARS_PER_RUN); // sanity clamp, see CONFIG note

  // bonusOnly: true means this call is reporting a *bonus* to an
  // already-reported run (currently: the "Double Stars" rewarded-ad payout,
  // sent as a second call for just the extra half). Star-total milestones
  // (100k/300k/700k) still apply — the player's total genuinely went up —
  // but this must NOT count as a second "run": no runs_completed increment,
  // no first-run reward, and no re-evaluating the successful-referral
  // (30-star) threshold, since that's tied to actual gameplay runs.
  const isBonusOnly = !!body.bonusOnly;

  const db = env.DB;
  const invitee = await getUserForRewards(db, userId); // 1 SELECT
  const isFirstRun = !isBonusOnly && invitee.runs_completed === 0;
  const newTotalStars = invitee.total_stars + starsEarned;
  const newRunsCompleted = isBonusOnly ? invitee.runs_completed : invitee.runs_completed + 1;

  const newlyCrossed = STAR_MILESTONES.filter((m) => !invitee[m.flag] && newTotalStars >= m.threshold);

  // --- Write 1: update the invitee's own row (always happens) -------------
  const flagUpdates = STAR_MILESTONES.map((m) =>
    newlyCrossed.includes(m) ? 1 : (invitee[m.flag] || 0)
  );
  await db.prepare(
    `INSERT INTO users (user_id, total_stars, runs_completed, reward_100k, reward_300k, reward_700k, energy, invite_points, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 6, 0, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       total_stars = excluded.total_stars,
       runs_completed = excluded.runs_completed,
       reward_100k = excluded.reward_100k,
       reward_300k = excluded.reward_300k,
       reward_700k = excluded.reward_700k`
  ).bind(userId, newTotalStars, newRunsCompleted, flagUpdates[0], flagUpdates[1], flagUpdates[2], Date.now()).run();

  const rewardsGranted = { inviter: null, milestones: [] };

  if (invitee.referrer_id) {
    const inviterId = invitee.referrer_id;

    // --- Conditional write: does this run make the referral "successful"? ---
    let justCompleted = false;
    if (!isBonusOnly && starsEarned >= SUCCESSFUL_REFERRAL_STAR_THRESHOLD) {
      const res = await db.prepare(
        `UPDATE referrals SET status = 'completed' WHERE invitee_id = ? AND inviter_id = ? AND status = 'pending'`
      ).bind(userId, inviterId).run();
      justCompleted = res.meta.changes === 1;
    }

    // --- Tally every inviter-side bonus this single call might trigger ---
    let bonusEnergy = 0, bonusPoints = 0;
    const cosmeticsToGrant = [];

    if (isFirstRun) { bonusEnergy += FIRST_RUN_REWARD.energy; bonusPoints += FIRST_RUN_REWARD.points; }
    for (const m of newlyCrossed) {
      bonusEnergy += m.energy; bonusPoints += m.points;
      if (m.cosmetic) cosmeticsToGrant.push(m.cosmetic);
    }

    let countMilestonesHit = [];
    if (justCompleted) {
      // 1 SELECT — only runs on the (rare) event a referral just flipped to completed.
      const countRow = await db.prepare(
        `SELECT COUNT(*) AS c FROM referrals WHERE inviter_id = ? AND status = 'completed'`
      ).bind(inviterId).first();
      const successfulInvites = countRow ? countRow.c : 0;

      const inviter = await getInviterForMilestones(db, inviterId); // 1 SELECT
      countMilestonesHit = INVITE_COUNT_MILESTONES.filter(
        (m) => !inviter[m.flag] && successfulInvites >= m.count
      );
      for (const m of countMilestonesHit) {
        bonusPoints += m.points;
        if (m.cosmetic) cosmeticsToGrant.push(m.cosmetic);
      }

      if (bonusEnergy || bonusPoints || countMilestonesHit.length) {
        const flagSets = countMilestonesHit.map((m) => `${m.flag} = 1`).join(', ');
        await db.prepare(
          `UPDATE users SET energy = energy + ?, invite_points = invite_points + ?${flagSets ? ', ' + flagSets : ''}
           WHERE user_id = ?`
        ).bind(bonusEnergy, bonusPoints, inviterId).run(); // 1 UPDATE
      }
    } else if (bonusEnergy || bonusPoints) {
      // First-run and/or star-threshold bonuses, no count-milestone involved.
      await db.prepare(
        `UPDATE users SET energy = energy + ?, invite_points = invite_points + ? WHERE user_id = ?`
      ).bind(bonusEnergy, bonusPoints, inviterId).run(); // 1 UPDATE
    }

    if (cosmeticsToGrant.length) {
      await db.batch(
        cosmeticsToGrant.map((itemId) =>
          db.prepare(`INSERT OR IGNORE INTO user_cosmetics (user_id, item_id) VALUES (?, ?)`).bind(inviterId, itemId)
        )
      ); // up to a few INSERTs, only on rare milestone crossings
    }

    if (bonusEnergy || bonusPoints || cosmeticsToGrant.length) {
      rewardsGranted.inviter = { userId: inviterId, energy: bonusEnergy, points: bonusPoints, cosmetics: cosmeticsToGrant };
    }
    rewardsGranted.milestones = [...newlyCrossed.map((m) => m.flag), ...countMilestonesHit.map((m) => m.flag)];
  }

  return ok({
    totalStars: newTotalStars,
    runsCompleted: newRunsCompleted,
    rewardsGranted,
  }, env);
}

/** GET /api/store/items
 *  Header: X-Telegram-Init-Data
 *  DB calls: 1 (owned item ids, via GROUP_CONCAT — a single-row read
 *  regardless of how many items the player owns).
 */
async function handleStoreItems(request, env) {
  const userId = await authenticate(request, env, null);
  if (!userId) return fail('Unauthorized: invalid or missing Telegram initData', 401, env);

  const row = await env.DB.prepare(
    `SELECT GROUP_CONCAT(item_id) AS owned FROM user_cosmetics WHERE user_id = ?`
  ).bind(userId).first();
  const ownedSet = new Set((row && row.owned ? row.owned.split(',') : []));

  const items = ALL_ITEMS.map((item) => ({ ...item, owned: ownedSet.has(item.id) }));
  return ok({ items }, env);
}

/** POST /api/store/buy
 *  Body: { initData, itemId }
 *  DB calls: 1 SELECT (balance + ownership, combined via LEFT JOIN) on
 *  every attempt; +1 atomic batched write (currency deduction + ownership
 *  insert) only when the purchase actually succeeds.
 */
async function handleStoreBuy(request, env) {
  const body = await safeJson(request);
  const userId = await authenticate(request, env, body.initData);
  if (!userId) return fail('Unauthorized: invalid or missing Telegram initData', 401, env);

  const itemId = body.itemId;
  const item = ALL_ITEMS.find((i) => i.id === itemId);
  if (!item) return fail('Unknown item', 404, env);

  // One combined read: current balances + whether this exact item is already owned.
  const row = await env.DB.prepare(
    `SELECT u.total_stars, u.invite_points, c.item_id AS owned
     FROM users u LEFT JOIN user_cosmetics c ON c.user_id = u.user_id AND c.item_id = ?
     WHERE u.user_id = ?`
  ).bind(itemId, userId).first();

  if (!row) return fail('User not found — call /api/referral/start first', 404, env);
  if (row.owned) return fail('Item already owned', 409, env);

  const isPremium = PREMIUM_ITEMS.some((i) => i.id === itemId);
  let starsCost = 0, pointsCost = 0;

  if (isPremium) {
    // Premium: both currencies required simultaneously.
    if (row.total_stars < item.costStars || row.invite_points < item.costPoints) {
      return fail('Insufficient balance', 402, env);
    }
    starsCost = item.costStars; pointsCost = item.costPoints;
  } else {
    // Normal: either currency alone covers it. Prefer stars if the player
    // can afford it with stars alone, otherwise fall back to points — but
    // only if the item actually has a points price. Without the > 0 guard,
    // a LEGACY_ITEMS entry (costPoints: 0, stars-only by design) would
    // incorrectly look "affordable for 0 points" to anyone, regardless of
    // their star balance.
    if (row.total_stars >= item.costStars) starsCost = item.costStars;
    else if (item.costPoints > 0 && row.invite_points >= item.costPoints) pointsCost = item.costPoints;
    else return fail('Insufficient balance', 402, env);
  }

  // Atomic: deduct currency AND grant ownership together, or neither.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET total_stars = total_stars - ?, invite_points = invite_points - ? WHERE user_id = ?`
    ).bind(starsCost, pointsCost, userId),
    env.DB.prepare(
      `INSERT INTO user_cosmetics (user_id, item_id) VALUES (?, ?)`
    ).bind(userId, itemId),
  ]);

  return ok({ purchased: itemId, starsSpent: starsCost, pointsSpent: pointsCost }, env);
}

/** GET /api/user/profile
 *  Header: X-Telegram-Init-Data
 *  DB calls: 1 (a single query with a correlated subquery pulls owned
 *  cosmetics alongside the user row — no second round trip).
 */
async function handleUserProfile(request, env) {
  const userId = await authenticate(request, env, null);
  if (!userId) return fail('Unauthorized: invalid or missing Telegram initData', 401, env);

  // Single query — the two correlated subqueries (owned cosmetics,
  // successful-invite count) ride along with the main row read, so this
  // stays at 1 DB call even though the Referral screen now needs more data.
  const row = await env.DB.prepare(
    `SELECT u.total_stars, u.invite_points, u.energy, u.runs_completed, u.referrer_id,
            u.invite_milestone_3, u.invite_milestone_5, u.invite_milestone_10,
            u.invite_milestone_25, u.invite_milestone_50,
            (SELECT GROUP_CONCAT(item_id) FROM user_cosmetics WHERE user_id = u.user_id) AS owned,
            (SELECT COUNT(*) FROM referrals WHERE inviter_id = u.user_id AND status = 'completed') AS successful_invites
     FROM users u WHERE u.user_id = ?`
  ).bind(userId).first();

  if (!row) return fail('User not found — call /api/referral/start first', 404, env);

  return ok({
    totalStars: row.total_stars,
    invitePoints: row.invite_points,
    energy: row.energy,
    runsCompleted: row.runs_completed,
    referredBy: row.referrer_id || null,
    ownedCosmetics: row.owned ? row.owned.split(',') : [],
    successfulInvites: row.successful_invites || 0,
    inviteMilestonesClaimed: {
      3: !!row.invite_milestone_3,
      5: !!row.invite_milestone_5,
      10: !!row.invite_milestone_10,
      25: !!row.invite_milestone_25,
      50: !!row.invite_milestone_50,
    },
  }, env);
}

/* ================================ Utilities ================================== */

async function safeJson(request) {
  try { return await request.json(); } catch (e) { return {}; }
}

/* ============================ 6. ROUTER (fetch entrypoint) ==================== */

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/referral/start' && request.method === 'POST') {
        return await handleReferralStart(request, env);
      }
      if (url.pathname === '/api/referral/check-rewards' && request.method === 'POST') {
        return await handleCheckRewards(request, env);
      }
      if (url.pathname === '/api/store/items' && request.method === 'GET') {
        return await handleStoreItems(request, env);
      }
      if (url.pathname === '/api/store/buy' && request.method === 'POST') {
        return await handleStoreBuy(request, env);
      }
      if (url.pathname === '/api/user/profile' && request.method === 'GET') {
        return await handleUserProfile(request, env);
      }
      return fail('Not found', 404, env);
    } catch (err) {
      // Never leak internals to the client; log for yourself via `wrangler tail`.
      console.error('Unhandled error:', err && err.stack ? err.stack : err);
      return fail('Internal error', 500, env);
    }
  },
};