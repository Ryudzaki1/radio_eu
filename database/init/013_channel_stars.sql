CREATE TABLE IF NOT EXISTS channel_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id BIGINT NOT NULL,
  channel_username TEXT,
  message_id BIGINT NOT NULL,
  title TEXT,
  message_text TEXT,
  posted_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, message_id)
);

CREATE TABLE IF NOT EXISTS channel_post_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  reaction_type TEXT NOT NULL CHECK (reaction_type IN ('paid', 'emoji', 'custom_emoji', 'unknown')),
  reaction_key TEXT NOT NULL,
  total_count INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  previous_count INTEGER NOT NULL DEFAULT 0 CHECK (previous_count >= 0),
  last_delta INTEGER NOT NULL DEFAULT 0,
  last_update_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, message_id, reaction_type, reaction_key)
);

CREATE TABLE IF NOT EXISTS channel_paid_reaction_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id BIGINT NOT NULL,
  channel_username TEXT,
  message_id BIGINT NOT NULL,
  paid_reaction_delta INTEGER NOT NULL CHECK (paid_reaction_delta > 0),
  paid_reaction_total INTEGER NOT NULL CHECK (paid_reaction_total >= 0),
  event_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bot_star_transactions (
  transaction_id TEXT PRIMARY KEY,
  amount INTEGER NOT NULL DEFAULT 0,
  nanostar_amount INTEGER,
  direction TEXT NOT NULL DEFAULT 'unknown',
  source_type TEXT,
  receiver_type TEXT,
  transaction_at TIMESTAMPTZ,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_channel_posts_message ON channel_posts (channel_id, message_id);
CREATE INDEX IF NOT EXISTS idx_channel_paid_reaction_events_created ON channel_paid_reaction_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_star_transactions_recorded ON bot_star_transactions (recorded_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'channel_posts_set_updated_at'
  ) THEN
    CREATE TRIGGER channel_posts_set_updated_at
    BEFORE UPDATE ON channel_posts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'channel_post_reactions_set_updated_at'
  ) THEN
    CREATE TRIGGER channel_post_reactions_set_updated_at
    BEFORE UPDATE ON channel_post_reactions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END;
$$;
