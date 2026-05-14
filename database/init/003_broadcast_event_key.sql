ALTER TABLE broadcast_events
  ADD COLUMN IF NOT EXISTS event_key TEXT;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY
        event,
        started_at,
        coalesce(title, ''),
        coalesce(source_file, ''),
        coalesce(duration_seconds, -1),
        coalesce(position_seconds, -1)
      ORDER BY created_at, id
    ) AS row_number
  FROM broadcast_events
)
DELETE FROM broadcast_events
USING ranked
WHERE broadcast_events.id = ranked.id
  AND ranked.row_number > 1;

UPDATE broadcast_events
SET event_key = encode(digest(
  concat_ws('|',
    event,
    started_at::text,
    coalesce(title, ''),
    coalesce(source_file, ''),
    coalesce(duration_seconds::text, ''),
    coalesce(position_seconds::text, '')
  ),
  'sha256'
), 'hex')
WHERE event_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_events_event_key ON broadcast_events (event_key);
