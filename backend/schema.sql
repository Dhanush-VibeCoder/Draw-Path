-- =============================================================================
-- GLOW PATH — Referral + Store System — D1 Schema
-- =============================================================================
-- Deploy with:
--   wrangler d1 execute glow-path-db --file=./schema.sql          (local)
--   wrangler d1 execute glow-path-db --remote --file=./schema.sql (production)
--
-- NOTE ON ADDED COLUMNS
-- The three tables below keep every column you specified, unchanged, in the
-- same place. A handful of extra columns are added to `users` — all boolean
-- (0/1) "already rewarded" flags plus a run counter. They exist purely so
-- the Worker can tell "has this milestone already been paid out?" without
-- an extra table scan, which is what makes the reward logic idempotent
-- (safe to call more than once) and keeps DB calls to a minimum. Nothing
-- about the columns you specified changes.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,       -- Telegram numeric user id, as a string
  referrer_id TEXT,                -- who invited this user (NULL for organic installs)
  total_stars INTEGER DEFAULT 0,   -- lifetime stars, mirrors the client's save.totalStars
  invite_points INTEGER DEFAULT 0, -- referral currency
  energy INTEGER DEFAULT 6,
  created_at INTEGER,

  -- --- additive bookkeeping (not in your original spec, see note above) ---
  runs_completed INTEGER DEFAULT 0,   -- lets us detect "this is their first run"
  reward_100k INTEGER DEFAULT 0,      -- 1 once this user's 100k-star inviter reward has been paid
  reward_300k INTEGER DEFAULT 0,      -- 1 once this user's 300k-star inviter reward has been paid
  reward_700k INTEGER DEFAULT 0,      -- 1 once this user's 700k-star inviter reward has been paid
  invite_milestone_3 INTEGER DEFAULT 0,   -- 1 once THIS user (as an inviter) claimed the 3-invite milestone
  invite_milestone_5 INTEGER DEFAULT 0,
  invite_milestone_10 INTEGER DEFAULT 0,
  invite_milestone_25 INTEGER DEFAULT 0,
  invite_milestone_50 INTEGER DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- referrals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS referrals (
  inviter_id TEXT,
  invitee_id TEXT,
  status TEXT DEFAULT 'pending',   -- 'pending' -> 'completed' (see worker.js for the rule)
  created_at INTEGER,
  PRIMARY KEY (inviter_id, invitee_id)
);

-- ---------------------------------------------------------------------------
-- user_cosmetics (ownership table — purchased AND earned items both live here)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_cosmetics (
  user_id TEXT,
  item_id TEXT,
  PRIMARY KEY (user_id, item_id)
);

-- ---------------------------------------------------------------------------
-- Helpful indexes — these are what keep milestone lookups (COUNT of
-- completed referrals per inviter) fast without needing a full table scan
-- as the referrals table grows.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_referrals_inviter_status ON referrals (inviter_id, status);
CREATE INDEX IF NOT EXISTS idx_users_referrer ON users (referrer_id);