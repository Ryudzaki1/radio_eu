ALTER TABLE broadcast_air_items
  DROP COLUMN IF EXISTS broadcast_event_id;

DROP TABLE IF EXISTS broadcast_events;
