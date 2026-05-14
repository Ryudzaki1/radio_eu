const crypto = require("node:crypto");

let Pool;
try {
  ({ Pool } = require("pg"));
} catch {
  Pool = null;
}

let pool = null;
let poolKey = "";
let warnedUnavailable = false;

function getPool(config) {
  const database = config?.database;
  if (!database?.enabled || !database.password || !Pool) {
    if (database?.enabled && !Pool && !warnedUnavailable) {
      warnedUnavailable = true;
      console.warn("Postgres driver is not installed; database logging is disabled.");
    }
    return null;
  }

  const nextKey = JSON.stringify(database);
  if (pool && poolKey === nextKey) return pool;

  if (pool) pool.end().catch(() => {});
  poolKey = nextKey;
  pool = new Pool({
    host: database.host,
    port: database.port,
    database: database.database,
    user: database.user,
    password: database.password,
    ssl: database.ssl ? { rejectUnauthorized: false } : false,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
  });
  pool.on("error", (error) => {
    console.warn(`Postgres pool error: ${error.message}`);
  });
  return pool;
}

async function recordSystemEvent(config, entry) {
  const client = getPool(config);
  if (!client) return;

  await client.query(
    `INSERT INTO system_events (event, actor_type, actor_id, message, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.event,
      normalizeActorType(entry.actorType),
      entry.actorId ? String(entry.actorId) : null,
      entry.message || entry.title || null,
      JSON.stringify(entry),
      entry.ts ? new Date(entry.ts) : new Date(),
    ],
  );
}

async function recordBroadcastEvent(config, entry) {
  const normalized = normalizeBroadcastEvent(entry);
  if (!normalized) return;

  const client = getPool(config);
  if (!client) return;

  await client.query(
    `INSERT INTO broadcast_events (
       event_key, event, category, status, title, source, source_file, topic, subtopic,
       duration_seconds, position_seconds, started_at, ended_at, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (event_key) DO NOTHING`,
    [
      normalized.eventKey,
      normalized.event,
      normalized.category,
      normalized.status,
      normalized.title,
      normalized.source,
      normalized.sourceFile,
      normalized.topic,
      normalized.subtopic,
      normalized.durationSeconds,
      normalized.positionSeconds,
      normalized.startedAt,
      normalized.endedAt,
      JSON.stringify(normalized.metadata),
    ],
  );
}

function normalizeBroadcastEvent(entry) {
  const event = String(entry?.event || "");
  if (!event) return null;

  const category = getBroadcastCategory(event);
  if (!category) return null;

  const status = getBroadcastStatus(event);
  const title = entry.title || entry.trackTitle || entry.play || entry.live || entry.file || null;
  const sourceFile = entry.file || entry.play || entry.live || null;
  const createdAt = entry.ts ? new Date(entry.ts) : new Date();

  return {
    eventKey: buildEventKey({
      event,
      title,
      sourceFile,
      durationSeconds: finiteNumberOrNull(entry.durationSeconds),
      positionSeconds: finiteNumberOrNull(entry.positionSeconds),
      startedAt: createdAt,
    }),
    event,
    category,
    status,
    title,
    source: entry.source || null,
    sourceFile,
    topic: entry.topic || null,
    subtopic: entry.subtopic || null,
    durationSeconds: finiteNumberOrNull(entry.durationSeconds),
    positionSeconds: finiteNumberOrNull(entry.positionSeconds),
    startedAt: createdAt,
    endedAt: status === "ended" || status === "failed" || status === "cancelled" ? createdAt : null,
    metadata: entry,
  };
}

function buildEventKey(parts) {
  return crypto
    .createHash("sha256")
    .update([
      parts.event,
      parts.startedAt.toISOString(),
      parts.title || "",
      parts.sourceFile || "",
      parts.durationSeconds ?? "",
      parts.positionSeconds ?? "",
    ].join("|"))
    .digest("hex");
}

function getBroadcastCategory(event) {
  if (event === "live_music_start") return "live_music";
  if (event === "play_music_start" || event === "play_queued") return "play_music";
  if (event.startsWith("voice_")) return "voice";
  if (event.startsWith("transition_") || event === "music_synced") return "transition";
  if (event.includes("queue") || event.endsWith("_queued")) return "queue";
  if (event.startsWith("broadcast_") || event.startsWith("admin_broadcast_")) return "system";
  if (event === "topic_cycle_fact_queued") return "voice";
  return null;
}

function getBroadcastStatus(event) {
  if (event.endsWith("_queued")) return "queued";
  if (event.endsWith("_start") || event.startsWith("transition_")) return "started";
  if (event.endsWith("_end")) return "ended";
  if (event.endsWith("_error")) return "failed";
  if (event.includes("stopped") || event.includes("cleared")) return "cancelled";
  return "observed";
}

function normalizeActorType(value) {
  return ["system", "admin", "listener", "bot"].includes(value) ? value : "system";
}

function finiteNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

module.exports = {
  recordBroadcastEvent,
  recordSystemEvent,
};
