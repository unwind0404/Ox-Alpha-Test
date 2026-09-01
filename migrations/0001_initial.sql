-- Migration 0001: Initial schema for WB Review Bot
-- Источник: 2026-08-28-wb-basic-now-personal-later.md §3
-- Cloud deployment, basic token, D1 (SQLite via Cloudflare)

PRAGMA foreign_keys = ON;

-- =========================================================================
-- shops: магазины (один магазин = один WB-кабинет)
-- =========================================================================
CREATE TABLE IF NOT EXISTS shops (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  wb_account_key TEXT NOT NULL,
  token_ciphertext TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  token_key_version INTEGER NOT NULL DEFAULT 1,
  token_fingerprint TEXT NOT NULL UNIQUE,
  token_profile TEXT NOT NULL CHECK(token_profile IN ('basic', 'personal', 'service')),
  deployment_mode TEXT NOT NULL CHECK(deployment_mode IN ('cloud', 'self_managed')),
  mode TEXT NOT NULL DEFAULT 'drafts' CHECK(mode IN ('templates', 'drafts', 'llm')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
  last_sync_day_utc TEXT,
  next_sync_at INTEGER NOT NULL,
  token_expires_at INTEGER,
  disabled_reason TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

-- Index для поиска активных магазинов по времени синка
CREATE INDEX IF NOT EXISTS idx_shops_enabled_sync
  ON shops(enabled, next_sync_at)
  WHERE enabled = 1;

-- Index для поиска по token_fingerprint (при ротации)
-- уже UNIQUE в определении колонки

-- =========================================================================
-- reviews: отзывы с WB (idempotent upsert)
-- =========================================================================
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,                                    -- UUID v4, наш
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  wb_feedback_id TEXT NOT NULL,
  wb_created_at_ms INTEGER NOT NULL,
  rating INTEGER CHECK(rating BETWEEN 1 AND 5),
  user_name TEXT,
  product_name TEXT,
  product_nm_id INTEGER,
  text TEXT,
  pros TEXT,
  cons TEXT,
  photo_urls_json TEXT NOT NULL DEFAULT '[]',             -- JSON array
  video_url TEXT,
  received_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(shop_id, wb_feedback_id)
);

-- Index для аналитики (по дате создания на WB)
CREATE INDEX IF NOT EXISTS idx_reviews_shop_wb_created
  ON reviews(shop_id, wb_created_at_ms DESC);

-- =========================================================================
-- reply_jobs: задачи на обработку отзывов (state machine)
-- =========================================================================
CREATE TABLE IF NOT EXISTS reply_jobs (
  id TEXT PRIMARY KEY,                                    -- UUID
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN (
    'discovered', 'generating', 'draft_ready', 'ready_to_send',
    'sending', 'posted', 'retry_wait', 'reconcile_pending',
    'manual_review', 'rejected', 'waiting_llm_quota', 'dead'
  )),
  strategy TEXT NOT NULL CHECK(strategy IN ('templates', 'drafts', 'llm')),
  scheduled_send_at_ms INTEGER,
  queue_position INTEGER,
  schedule_revision INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status_reason_code TEXT,
  status_updated_at_ms INTEGER NOT NULL,
  posted_at_ms INTEGER,
  posted_reply_text TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(review_id)
);

-- Index для выборки ready_to_send с лимитом
CREATE INDEX IF NOT EXISTS idx_jobs_ready
  ON reply_jobs(shop_id, state, next_attempt_at_ms)
  WHERE state = 'ready_to_send';

-- Index для активных jobs магазина (не terminal)
CREATE INDEX IF NOT EXISTS idx_jobs_active_shop
  ON reply_jobs(shop_id, state, next_attempt_at_ms)
  WHERE state NOT IN ('posted', 'rejected', 'dead');

-- Index для UI очереди
CREATE INDEX IF NOT EXISTS idx_jobs_queue
  ON reply_jobs(shop_id, created_at_ms DESC)
  WHERE state NOT IN ('posted', 'rejected', 'dead');

-- =========================================================================
-- audit_events: журнал действий (для безопасника + debugging)
-- =========================================================================
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT,
  job_id TEXT,
  action TEXT NOT NULL,
  reason_code TEXT,
  detail TEXT,
  correlation_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created
  ON audit_events(created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_audit_shop
  ON audit_events(shop_id, created_at_ms DESC)
  WHERE shop_id IS NOT NULL;

-- =========================================================================
-- llm_daily_usage: квота LLM на день (UTC)
-- =========================================================================
CREATE TABLE IF NOT EXISTS llm_daily_usage (
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  day_utc TEXT NOT NULL,                                  -- 'YYYY-MM-DD'
  calls INTEGER NOT NULL DEFAULT 0,
  tokens_input INTEGER NOT NULL DEFAULT 0,
  tokens_output INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (shop_id, day_utc)
);
