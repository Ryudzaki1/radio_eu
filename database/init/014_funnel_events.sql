CREATE TABLE IF NOT EXISTS funnel_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'listener' CHECK (actor_type IN ('listener', 'admin', 'bot', 'channel', 'system')),
  telegram_id BIGINT,
  username TEXT,
  question_id TEXT,
  source TEXT,
  amount INTEGER,
  currency TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_funnel_events_event_created ON funnel_events (event, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_funnel_events_telegram_created ON funnel_events (telegram_id, created_at DESC);
