CREATE TABLE IF NOT EXISTS broadcast_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT UNIQUE,
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

CREATE INDEX IF NOT EXISTS idx_broadcast_events_started ON broadcast_events (started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_events_event_key ON broadcast_events (event_key);
CREATE INDEX IF NOT EXISTS idx_broadcast_events_category_started ON broadcast_events (category, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_broadcast_events_source_file_started ON broadcast_events (source_file, started_at DESC);
