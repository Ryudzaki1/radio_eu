CREATE TABLE IF NOT EXISTS music_vibes (
  id TEXT PRIMARY KEY,
  brand TEXT NOT NULL DEFAULT 'BAA Vibe',
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  display_order INTEGER NOT NULL DEFAULT 100,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS music_prompt_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vibe_id TEXT NOT NULL REFERENCES music_vibes(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('live', 'play', 'jingle', 'transition')),
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'elevenlabs' CHECK (provider IN ('elevenlabs', 'manual')),
  model TEXT NOT NULL DEFAULT 'music_v2',
  default_duration_seconds INTEGER CHECK (default_duration_seconds IS NULL OR default_duration_seconds > 0),
  energy INTEGER CHECK (energy IS NULL OR energy BETWEEN 1 AND 5),
  bpm_min INTEGER CHECK (bpm_min IS NULL OR bpm_min > 0),
  bpm_max INTEGER CHECK (bpm_max IS NULL OR bpm_max > 0),
  mood TEXT,
  instruments JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (bpm_min IS NULL OR bpm_max IS NULL OR bpm_min <= bpm_max)
);

CREATE TABLE IF NOT EXISTS music_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vibe_id TEXT NOT NULL REFERENCES music_vibes(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('live', 'play', 'jingle', 'transition')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'inactive', 'rejected', 'deleted')),
  provider TEXT NOT NULL DEFAULT 'manual' CHECK (provider IN ('elevenlabs', 'manual')),
  model TEXT,
  title TEXT NOT NULL,
  prompt TEXT,
  file_path TEXT NOT NULL UNIQUE,
  public_path TEXT,
  checksum TEXT,
  duration_seconds NUMERIC(12, 3),
  bpm INTEGER CHECK (bpm IS NULL OR bpm > 0),
  energy INTEGER CHECK (energy IS NULL OR energy BETWEEN 1 AND 5),
  mood TEXT,
  instruments JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS music_generation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vibe_id TEXT NOT NULL REFERENCES music_vibes(id) ON DELETE RESTRICT,
  prompt_template_id UUID REFERENCES music_prompt_templates(id) ON DELETE SET NULL,
  result_asset_id UUID REFERENCES music_assets(id) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK (role IN ('live', 'play', 'jingle', 'transition')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'generating', 'ready_for_review', 'approved', 'rejected', 'failed', 'cancelled')),
  provider TEXT NOT NULL DEFAULT 'elevenlabs' CHECK (provider IN ('elevenlabs')),
  model TEXT NOT NULL DEFAULT 'music_v2',
  prompt TEXT NOT NULL,
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  requested_by TEXT,
  cost_estimate NUMERIC(18, 6),
  currency TEXT,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS music_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  music_asset_id UUID REFERENCES music_assets(id) ON DELETE SET NULL,
  air_item_id UUID REFERENCES broadcast_air_items(id) ON DELETE SET NULL,
  event TEXT NOT NULL CHECK (event IN ('queued', 'started', 'finished', 'skipped', 'failed', 'cancelled')),
  role TEXT CHECK (role IN ('live', 'play', 'jingle', 'transition')),
  title TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds NUMERIC(12, 3),
  position_seconds NUMERIC(12, 3),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO music_vibes (id, brand, name, description, display_order, metadata)
VALUES (
  'chill',
  'BAA Vibe',
  'BAA Vibe Chill Radio',
  'First BAA Vibe stream focused on calm AI-generated chill music.',
  10,
  '{"defaultModel":"music_v2","defaultProvider":"elevenlabs"}'::jsonb
)
ON CONFLICT (id) DO UPDATE
SET brand = EXCLUDED.brand,
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    display_order = EXCLUDED.display_order,
    metadata = music_vibes.metadata || EXCLUDED.metadata,
    updated_at = now();

CREATE INDEX IF NOT EXISTS idx_music_prompt_templates_vibe_role ON music_prompt_templates (vibe_id, role, status);
CREATE INDEX IF NOT EXISTS idx_music_assets_vibe_role_status ON music_assets (vibe_id, role, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_music_assets_checksum ON music_assets (checksum);
CREATE INDEX IF NOT EXISTS idx_music_generation_jobs_status ON music_generation_jobs (status, queued_at, created_at);
CREATE INDEX IF NOT EXISTS idx_music_generation_jobs_vibe_role ON music_generation_jobs (vibe_id, role, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_music_usage_events_asset_created ON music_usage_events (music_asset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_music_usage_events_created ON music_usage_events (created_at DESC);

DROP TRIGGER IF EXISTS music_vibes_set_updated_at ON music_vibes;
CREATE TRIGGER music_vibes_set_updated_at
BEFORE UPDATE ON music_vibes
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS music_prompt_templates_set_updated_at ON music_prompt_templates;
CREATE TRIGGER music_prompt_templates_set_updated_at
BEFORE UPDATE ON music_prompt_templates
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS music_assets_set_updated_at ON music_assets;
CREATE TRIGGER music_assets_set_updated_at
BEFORE UPDATE ON music_assets
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS music_generation_jobs_set_updated_at ON music_generation_jobs;
CREATE TRIGGER music_generation_jobs_set_updated_at
BEFORE UPDATE ON music_generation_jobs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
