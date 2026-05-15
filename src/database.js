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
  if (!shouldRecordSystemEvent(entry?.event)) return;

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

  await recordAirItem(client, normalized);
}

async function syncListenerQuestionCreated(config, user, question) {
  const client = getPool(config);
  if (!client || !user || !question) return;

  await withTransaction(client, async (tx) => {
    const telegramUserId = await upsertTelegramUser(tx, user);
    const orderId = question.paymentStatus === "waiting_payment"
      ? await upsertPaymentOrder(tx, telegramUserId, question)
      : null;
    await upsertListenerQuestion(tx, telegramUserId, orderId, question);
  });
}

async function syncListenerQuestionPaid(config, question, payment = {}) {
  const client = getPool(config);
  if (!client || !question) return;

  await withTransaction(client, async (tx) => {
    const row = await tx.query(
      `SELECT id, order_id
       FROM listener_questions
       WHERE external_question_id = $1
       LIMIT 1`,
      [question.id],
    );
    const listenerQuestion = row.rows[0];
    if (!listenerQuestion) return;

    if (listenerQuestion.order_id) {
      await tx.query(
        `UPDATE payment_orders
         SET status = 'paid',
             paid_at = coalesce(paid_at, $2),
             metadata = metadata || $3::jsonb
         WHERE id = $1`,
        [
          listenerQuestion.order_id,
          question.paidAt ? new Date(question.paidAt) : new Date(),
          JSON.stringify({ listenerQuestionExternalId: question.id }),
        ],
      );

      if (payment.telegramPaymentChargeId) {
        await tx.query(
          `INSERT INTO payments (
             order_id, provider, provider_charge_id, amount, currency, raw_payload
           )
           SELECT id, provider, $2, amount, currency, $3::jsonb
           FROM payment_orders
           WHERE id = $1
           ON CONFLICT (provider, provider_charge_id) DO NOTHING`,
          [
            listenerQuestion.order_id,
            String(payment.telegramPaymentChargeId),
            JSON.stringify(payment.rawPayload || {}),
          ],
        );
      }
    }

    await tx.query(
      `UPDATE listener_questions
       SET status = 'queued',
           queued_at = coalesce(queued_at, now())
       WHERE id = $1`,
      [listenerQuestion.id],
    );
  });
}

async function syncListenerQuestionStatus(config, question) {
  const client = getPool(config);
  if (!client || !question) return;

  const status = normalizeListenerQuestionStatus(question.status);
  await client.query(
    `UPDATE listener_questions
     SET status = $2,
         answer_text = nullif($3, ''),
         queued_at = CASE WHEN $2 = 'queued' THEN coalesce(queued_at, now()) ELSE queued_at END,
         finished_at = CASE WHEN $2 IN ('done', 'failed', 'rejected', 'refunded') THEN coalesce(finished_at, now()) ELSE finished_at END,
         error_message = nullif($4, '')
     WHERE external_question_id = $1`,
    [
      question.id,
      status,
      question.text || "",
      question.error || "",
    ],
  );
}

async function getPaymentSummary(config) {
  const client = getPool(config);
  if (!client) return null;

  const [orders, payments, questions] = await Promise.all([
    client.query(`SELECT count(*)::int AS total FROM payment_orders`),
    client.query(`SELECT count(*)::int AS total FROM payments`),
    client.query(`SELECT count(*)::int AS total FROM listener_questions`),
  ]);
  return {
    orders: orders.rows[0]?.total || 0,
    payments: payments.rows[0]?.total || 0,
    questions: questions.rows[0]?.total || 0,
  };
}

async function runPaymentDbSelfTest(config) {
  const client = getPool(config);
  if (!client) return { ok: false, reason: "database_disabled" };

  const tx = await client.connect();
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const user = {
    telegramId: `-${suffix}`,
    username: "payment_selftest",
    name: "Payment selftest",
    role: "listener",
    unlimited: false,
    remaining: 0,
  };
  const question = {
    id: `selftest-${suffix}`,
    telegramId: user.telegramId,
    question: "Проверка цепочки оплаты",
    status: "waiting_payment",
    paymentStatus: "waiting_payment",
    priceStars: 50,
    createdAt: new Date().toISOString(),
  };

  try {
    await tx.query("BEGIN");
    const telegramUserId = await upsertTelegramUser(tx, user);
    const orderId = await upsertPaymentOrder(tx, telegramUserId, question);
    await upsertListenerQuestion(tx, telegramUserId, orderId, question);
    await tx.query(
      `UPDATE payment_orders
       SET status = 'paid', paid_at = now()
       WHERE id = $1`,
      [orderId],
    );
    await tx.query(
      `INSERT INTO payments (order_id, provider, provider_charge_id, amount, currency, raw_payload)
       VALUES ($1, 'telegram_stars', $2, 50, 'XTR', '{}'::jsonb)`,
      [orderId, `selftest-charge-${suffix}`],
    );
    await tx.query(
      `UPDATE listener_questions
       SET status = 'queued', queued_at = now()
       WHERE external_question_id = $1`,
      [question.id],
    );
    const result = await tx.query(
      `SELECT
         po.status AS order_status,
         p.provider_charge_id,
         lq.status AS question_status
       FROM listener_questions lq
       JOIN payment_orders po ON po.id = lq.order_id
       JOIN payments p ON p.order_id = po.id
       WHERE lq.external_question_id = $1`,
      [question.id],
    );
    await tx.query("ROLLBACK");
    return {
      ok: true,
      orderStatus: result.rows[0]?.order_status || null,
      questionStatus: result.rows[0]?.question_status || null,
      paymentRecorded: Boolean(result.rows[0]?.provider_charge_id),
    };
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => {});
    return { ok: false, reason: error.message };
  } finally {
    tx.release();
  }
}

async function withTransaction(client, task) {
  const tx = await client.connect();
  try {
    await tx.query("BEGIN");
    const result = await task(tx);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    tx.release();
  }
}

async function upsertTelegramUser(client, user) {
  const result = await client.query(
    `INSERT INTO telegram_users (
       telegram_id, username, first_name, role, free_questions_remaining
     )
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (telegram_id) DO UPDATE
     SET username = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         role = EXCLUDED.role,
         free_questions_remaining = EXCLUDED.free_questions_remaining
     RETURNING id`,
    [
      user.telegramId,
      user.username || null,
      user.name || null,
      user.role === "admin" ? "admin" : "listener",
      user.unlimited ? 0 : Math.max(0, Number(user.remaining) || 0),
    ],
  );
  return result.rows[0].id;
}

async function upsertPaymentOrder(client, telegramUserId, question) {
  const payload = buildQuestionPayload(question.id);
  const result = await client.query(
    `INSERT INTO payment_orders (
       telegram_user_id, provider, provider_payload, amount, currency, status, description, metadata
     )
     VALUES ($1, 'telegram_stars', $2, $3, 'XTR', 'pending', $4, $5::jsonb)
     ON CONFLICT (provider_payload) DO UPDATE
     SET telegram_user_id = EXCLUDED.telegram_user_id,
         amount = EXCLUDED.amount,
         currency = EXCLUDED.currency,
         status = CASE
           WHEN payment_orders.status = 'paid' THEN payment_orders.status
           ELSE EXCLUDED.status
         END,
         description = EXCLUDED.description,
         metadata = payment_orders.metadata || EXCLUDED.metadata
     RETURNING id`,
    [
      telegramUserId,
      payload,
      question.priceStars || 0,
      "Оплаченный вопрос диктору",
      JSON.stringify({
        externalQuestionId: question.id,
        telegramId: question.telegramId,
      }),
    ],
  );
  return result.rows[0].id;
}

async function upsertListenerQuestion(client, telegramUserId, orderId, question) {
  await client.query(
    `INSERT INTO listener_questions (
       telegram_user_id, order_id, external_question_id, question_text, status, created_at, queued_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (external_question_id) DO UPDATE
     SET telegram_user_id = EXCLUDED.telegram_user_id,
         order_id = coalesce(listener_questions.order_id, EXCLUDED.order_id),
         question_text = EXCLUDED.question_text,
         status = EXCLUDED.status,
         queued_at = coalesce(listener_questions.queued_at, EXCLUDED.queued_at)`,
    [
      telegramUserId,
      orderId,
      question.id,
      question.question,
      normalizeListenerQuestionStatus(question.status),
      question.createdAt ? new Date(question.createdAt) : new Date(),
      question.status === "queued" ? new Date() : null,
    ],
  );
}

function buildQuestionPayload(questionId) {
  return `question:${questionId}`;
}

function normalizeListenerQuestionStatus(status) {
  switch (status) {
    case "waiting_payment":
      return "waiting_payment";
    case "queued":
    case "ready":
      return "queued";
    case "generating":
      return "generating";
    case "on_air":
      return "on_air";
    case "played":
      return "done";
    case "error":
      return "failed";
    default:
      return "draft";
  }
}

async function recordAirItem(client, event, broadcastEventId) {
  if (event.event === "live_music_start") {
    await finishOpenAirItems(client, "host_voice", event.startedAt, ["started"]);
    await finishOpenAirItems(client, "listener_question", event.startedAt, ["started"]);
    await finishOpenAirItems(client, "live_track", event.startedAt, ["started"]);
    await insertAirItem(client, {
      itemKey: `live:${event.eventKey}`,
      itemType: "live_track",
      status: "started",
      title: event.title || event.sourceFile || "Live track",
      source: event.source,
      sourceFile: event.sourceFile,
      topic: event.topic,
      subtopic: event.subtopic,
      startedAt: event.startedAt,
      endedAt: null,
      durationSeconds: event.durationSeconds,
      positionSeconds: event.positionSeconds,
      broadcastEventId,
      metadata: event.metadata,
    });
    return;
  }

  if (event.event === "play_music_start") {
    await finishOpenAirItems(client, "host_voice", event.startedAt, ["started"]);
    await finishOpenAirItems(client, "listener_question", event.startedAt, ["started"]);
    await finishOpenAirItems(client, "play_track", event.startedAt, ["started"]);
    await insertAirItem(client, {
      itemKey: `play:${event.eventKey}`,
      itemType: "play_track",
      status: "started",
      title: event.title || event.sourceFile || "Play track",
      source: event.source,
      sourceFile: event.sourceFile,
      topic: event.topic,
      subtopic: event.subtopic,
      startedAt: event.startedAt,
      endedAt: null,
      durationSeconds: event.durationSeconds,
      positionSeconds: event.positionSeconds,
      broadcastEventId,
      metadata: event.metadata,
    });
    return;
  }

  if (event.event === "voice_audio_start") {
    await insertAirItem(client, {
      itemKey: `voice:${event.eventKey}`,
      itemType: event.source === "listener" ? "listener_question" : "host_voice",
      status: "started",
      title: event.title || "Voice",
      source: event.source,
      sourceFile: event.sourceFile,
      topic: event.topic,
      subtopic: event.subtopic,
      startedAt: event.startedAt,
      endedAt: null,
      durationSeconds: event.durationSeconds,
      positionSeconds: event.positionSeconds,
      broadcastEventId,
      metadata: event.metadata,
    });
    return;
  }

  if (event.event === "voice_segment_end" || event.event === "voice_segment_error") {
    const status = event.event === "voice_segment_error" ? "failed" : "finished";
    const updated = await client.query(
      `UPDATE broadcast_air_items
       SET status = $1,
           ended_at = $2,
           duration_seconds = coalesce(duration_seconds, extract(epoch FROM $2 - started_at)::numeric(12, 3)),
           metadata = metadata || $3::jsonb,
           broadcast_event_id = coalesce(broadcast_event_id, $4)
       WHERE id = (
         SELECT id
         FROM broadcast_air_items
         WHERE item_type IN ('host_voice', 'listener_question')
           AND status = 'started'
           AND title = $5
           AND started_at <= $2
         ORDER BY started_at DESC
         LIMIT 1
       )`,
      [status, event.startedAt, JSON.stringify({ endEvent: event.metadata }), broadcastEventId, event.title],
    );
    if (updated.rowCount > 0) return;

    await insertAirItem(client, {
      itemKey: `voice-end:${event.eventKey}`,
      itemType: event.source === "listener" ? "listener_question" : "host_voice",
      status,
      title: event.title || "Voice",
      source: event.source,
      sourceFile: event.sourceFile,
      topic: event.topic,
      subtopic: event.subtopic,
      startedAt: event.startedAt,
      endedAt: event.startedAt,
      durationSeconds: event.durationSeconds,
      positionSeconds: event.positionSeconds,
      broadcastEventId,
      metadata: event.metadata,
    });
    return;
  }

  if (event.event === "broadcast_stopped" || event.event === "admin_broadcast_stop") {
    await finishOpenAirItems(client, "live_track", event.startedAt, ["started"]);
    await finishOpenAirItems(client, "play_track", event.startedAt, ["started"]);
    await insertAirItem(client, {
      itemKey: `system:${event.eventKey}`,
      itemType: "system",
      status: "cancelled",
      title: "Эфир остановлен",
      source: event.source,
      startedAt: event.startedAt,
      endedAt: event.startedAt,
      broadcastEventId,
      metadata: event.metadata,
    });
    return;
  }

  if (event.event === "broadcast_restored" || event.event === "admin_broadcast_restore") {
    await insertAirItem(client, {
      itemKey: `system:${event.eventKey}`,
      itemType: "system",
      status: "finished",
      title: "Эфир восстановлен",
      source: event.source,
      startedAt: event.startedAt,
      endedAt: event.startedAt,
      broadcastEventId,
      metadata: event.metadata,
    });
  }
}

async function insertAirItem(client, item) {
  await client.query(
    `INSERT INTO broadcast_air_items (
       item_key, item_type, status, title, source, source_file, topic, subtopic,
       started_at, ended_at, duration_seconds, position_seconds, broadcast_event_id, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (item_key) DO UPDATE
     SET status = EXCLUDED.status,
         ended_at = coalesce(EXCLUDED.ended_at, broadcast_air_items.ended_at),
         duration_seconds = coalesce(EXCLUDED.duration_seconds, broadcast_air_items.duration_seconds),
         metadata = broadcast_air_items.metadata || EXCLUDED.metadata,
         updated_at = now()`,
    [
      item.itemKey,
      item.itemType,
      item.status,
      item.title,
      item.source || null,
      item.sourceFile || null,
      item.topic || null,
      item.subtopic || null,
      item.startedAt,
      item.endedAt || null,
      item.durationSeconds || null,
      item.positionSeconds || null,
      item.broadcastEventId || null,
      JSON.stringify(item.metadata || {}),
    ],
  );
}

async function finishOpenAirItems(client, itemType, endedAt, statuses) {
  await client.query(
    `UPDATE broadcast_air_items
     SET status = 'finished',
         ended_at = $1,
         duration_seconds = coalesce(duration_seconds, extract(epoch FROM $1 - started_at)::numeric(12, 3))
     WHERE item_type = $2
       AND status = ANY($3::text[])
       AND started_at <= $1
       AND ended_at IS NULL`,
    [endedAt, itemType, statuses],
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

function shouldRecordSystemEvent(event) {
  const name = String(event || "");
  if (!name) return false;
  if (name.startsWith("admin_")) return true;
  if (name.startsWith("api_")) return true;
  if (name.startsWith("listener_")) return true;
  if (name === "topic_cycle_started" || name === "topic_cycle_stopped" || name === "topic_cycle_completed" || name === "topic_cycle_error") return true;
  if (name === "voice_generation_failed" || name === "voice_enqueue_failed") return true;
  if (name === "music_insert_failed") return true;
  return false;
}

function finiteNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

module.exports = {
  getPaymentSummary,
  recordBroadcastEvent,
  recordSystemEvent,
  runPaymentDbSelfTest,
  syncListenerQuestionCreated,
  syncListenerQuestionPaid,
  syncListenerQuestionStatus,
};
