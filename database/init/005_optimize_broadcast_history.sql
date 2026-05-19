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
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_broadcast_air_items_started ON broadcast_air_items (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_broadcast_air_items_type_started ON broadcast_air_items (item_type, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_broadcast_air_items_status ON broadcast_air_items (status, started_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'broadcast_air_items_set_updated_at'
  ) THEN
    CREATE TRIGGER broadcast_air_items_set_updated_at
    BEFORE UPDATE ON broadcast_air_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END;
$$;

DELETE FROM system_events
WHERE event IN (
  'topic_cycle_run_started',
  'live_interrupted_for_voice',
  'topic_cycle_fact_queued',
  'voice_audio_start',
  'voice_prelude_start',
  'voice_queued',
  'voice_segment_end',
  'live_music_start',
  'play_music_start',
  'play_queued',
  'music_synced',
  'voice_queue_cleared',
  'broadcast_stopped',
  'broadcast_restored',
  'transition_live_to_play',
  'transition_play_to_live',
  'transition_play_to_play'
);

WITH live_rows AS (
  SELECT
    event_key,
    id,
    title,
    source,
    source_file,
    topic,
    subtopic,
    started_at,
    lead(started_at) OVER (ORDER BY started_at, id) AS next_started_at,
    duration_seconds,
    position_seconds,
    metadata
  FROM broadcast_events
  WHERE event = 'live_music_start'
)
INSERT INTO broadcast_air_items (
  item_key, item_type, status, title, source, source_file, topic, subtopic,
  started_at, ended_at, duration_seconds, position_seconds, metadata
)
SELECT
  'live:' || event_key,
  'live_track',
  CASE WHEN next_started_at IS NULL THEN 'started' ELSE 'finished' END,
  coalesce(title, source_file, 'Live track'),
  source,
  source_file,
  topic,
  subtopic,
  started_at,
  next_started_at,
  CASE
    WHEN next_started_at IS NOT NULL THEN extract(epoch FROM next_started_at - started_at)::numeric(12, 3)
    ELSE duration_seconds
  END,
  position_seconds,
  metadata
FROM live_rows
ON CONFLICT (item_key) DO NOTHING;

WITH voice_starts AS (
  SELECT *
  FROM broadcast_events
  WHERE event = 'voice_audio_start'
),
voice_pairs AS (
  SELECT
    start_event.event_key,
    start_event.id,
    start_event.title,
    start_event.source,
    start_event.source_file,
    start_event.topic,
    start_event.subtopic,
    start_event.started_at,
    end_event.started_at AS ended_at,
    start_event.duration_seconds,
    start_event.position_seconds,
    start_event.metadata
  FROM voice_starts start_event
  LEFT JOIN LATERAL (
    SELECT ended.started_at
    FROM broadcast_events ended
    WHERE ended.event = 'voice_segment_end'
      AND ended.title = start_event.title
      AND ended.started_at >= start_event.started_at
    ORDER BY ended.started_at
    LIMIT 1
  ) end_event ON true
)
INSERT INTO broadcast_air_items (
  item_key, item_type, status, title, source, source_file, topic, subtopic,
  started_at, ended_at, duration_seconds, position_seconds, metadata
)
SELECT
  'voice:' || event_key,
  CASE WHEN source = 'listener' THEN 'listener_question' ELSE 'host_voice' END,
  CASE WHEN ended_at IS NULL THEN 'started' ELSE 'finished' END,
  coalesce(title, 'Voice'),
  source,
  source_file,
  topic,
  subtopic,
  started_at,
  ended_at,
  coalesce(duration_seconds, CASE WHEN ended_at IS NULL THEN NULL ELSE extract(epoch FROM ended_at - started_at)::numeric(12, 3) END),
  position_seconds,
  metadata
FROM voice_pairs
ON CONFLICT (item_key) DO NOTHING;
