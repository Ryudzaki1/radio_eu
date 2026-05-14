CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS telegram_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  role TEXT NOT NULL DEFAULT 'listener' CHECK (role IN ('listener', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  free_questions_remaining INTEGER NOT NULL DEFAULT 0 CHECK (free_questions_remaining >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id UUID REFERENCES telegram_users(id) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK (provider IN ('telegram_stars', 'ton', 'usdt')),
  provider_payload TEXT NOT NULL UNIQUE,
  amount NUMERIC(18, 6) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'pending', 'paid', 'failed', 'refunded', 'expired')),
  description TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES payment_orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('telegram_stars', 'ton', 'usdt')),
  provider_charge_id TEXT,
  amount NUMERIC(18, 6) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_charge_id)
);

CREATE TABLE IF NOT EXISTS listener_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id UUID REFERENCES telegram_users(id) ON DELETE SET NULL,
  order_id UUID REFERENCES payment_orders(id) ON DELETE SET NULL,
  question_text TEXT NOT NULL,
  answer_text TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'waiting_payment', 'paid', 'queued', 'generating', 'on_air', 'done', 'failed', 'rejected', 'refunded')),
  priority INTEGER NOT NULL DEFAULT 100,
  audio_asset_id UUID,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  queued_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audio_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('topic_fact', 'listener_question', 'greeting', 'farewell', 'test')),
  host_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source_text TEXT,
  file_path TEXT NOT NULL UNIQUE,
  duration_seconds NUMERIC(10, 3),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE listener_questions
  ADD CONSTRAINT listener_questions_audio_asset_id_fkey
  FOREIGN KEY (audio_asset_id) REFERENCES audio_assets(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS broadcast_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type TEXT NOT NULL CHECK (job_type IN ('voice', 'play_music', 'topic_fact', 'listener_question', 'system')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'locked', 'running', 'done', 'failed', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 100,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider IN ('deepseek', 'elevenlabs')),
  operation TEXT NOT NULL,
  related_question_id UUID REFERENCES listener_questions(id) ON DELETE SET NULL,
  related_audio_asset_id UUID REFERENCES audio_assets(id) ON DELETE SET NULL,
  units NUMERIC(18, 6),
  cost_estimate NUMERIC(18, 6),
  currency TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'system' CHECK (actor_type IN ('system', 'admin', 'listener', 'bot')),
  actor_id TEXT,
  message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS broadcast_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT NOT NULL UNIQUE,
  event TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'system' CHECK (category IN ('live_music', 'play_music', 'voice', 'transition', 'queue', 'system')),
  status TEXT NOT NULL DEFAULT 'observed' CHECK (status IN ('queued', 'started', 'ended', 'failed', 'cancelled', 'observed')),
  title TEXT,
  source TEXT,
  source_file TEXT,
  topic TEXT,
  subtopic TEXT,
  duration_seconds NUMERIC(12, 3),
  position_seconds NUMERIC(12, 3),
  listener_question_id UUID REFERENCES listener_questions(id) ON DELETE SET NULL,
  audio_asset_id UUID REFERENCES audio_assets(id) ON DELETE SET NULL,
  broadcast_job_id UUID REFERENCES broadcast_jobs(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS broadcast_air_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_key TEXT NOT NULL UNIQUE,
  item_type TEXT NOT NULL CHECK (item_type IN ('live_track', 'play_track', 'host_voice', 'listener_question', 'system')),
  status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'finished', 'failed', 'cancelled')),
  title TEXT NOT NULL,
  source TEXT,
  source_file TEXT,
  topic TEXT,
  subtopic TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  duration_seconds NUMERIC(12, 3),
  position_seconds NUMERIC(12, 3),
  listener_question_id UUID REFERENCES listener_questions(id) ON DELETE SET NULL,
  audio_asset_id UUID REFERENCES audio_assets(id) ON DELETE SET NULL,
  broadcast_event_id UUID REFERENCES broadcast_events(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_user_status ON payment_orders (telegram_user_id, status);
CREATE INDEX IF NOT EXISTS idx_listener_questions_status_priority ON listener_questions (status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_broadcast_jobs_ready ON broadcast_jobs (status, scheduled_at, priority);
CREATE INDEX IF NOT EXISTS idx_audio_assets_kind_host ON audio_assets (kind, host_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_provider_created ON ai_usage_events (provider, created_at);
CREATE INDEX IF NOT EXISTS idx_system_events_event_created ON system_events (event, created_at);
CREATE INDEX IF NOT EXISTS idx_broadcast_events_started ON broadcast_events (started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_events_event_key ON broadcast_events (event_key);
CREATE INDEX IF NOT EXISTS idx_broadcast_events_category_started ON broadcast_events (category, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_broadcast_events_source_file_started ON broadcast_events (source_file, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_broadcast_air_items_started ON broadcast_air_items (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_broadcast_air_items_type_started ON broadcast_air_items (item_type, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_broadcast_air_items_status ON broadcast_air_items (status, started_at DESC);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER telegram_users_set_updated_at
BEFORE UPDATE ON telegram_users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER payment_orders_set_updated_at
BEFORE UPDATE ON payment_orders
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER listener_questions_set_updated_at
BEFORE UPDATE ON listener_questions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER broadcast_jobs_set_updated_at
BEFORE UPDATE ON broadcast_jobs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER broadcast_air_items_set_updated_at
BEFORE UPDATE ON broadcast_air_items
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
