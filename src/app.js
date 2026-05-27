const http = require("node:http");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { createFact, createFarewell, createGreeting, createListenerQuestion } = require("./ai/announcer");
const { pingDeepSeek } = require("./ai/deepseek");
const { pingElevenLabs } = require("./ai/elevenlabs");
const { getAiUsage } = require("./ai/usage");
const { readAdminConfig, writeAdminConfig } = require("./adminStore");
const { BroadcastStream } = require("./broadcast");
const { readAvailableFactLog, resetFactLog, setCursor } = require("./factLog");
const { readJson, sendFile, sendJson } = require("./http");
const {
  acceptQuestion,
  getListenerStatus,
  getQuestion,
  markQuestionPaid,
  readListenerStore,
  registerListener,
  resetListenerStore,
  setListenerName,
  updateQuestion,
} = require("./listenerStore");
const { getAudioType, listTracks, resolveInside } = require("./music");
const { readRecentSystemLogs, writeSystemLog } = require("./systemLog");
const {
  getPaymentSummary,
  recordBotStarTransaction,
  recordChannelReactionCount,
  runPaymentDbSelfTest,
} = require("./database");

const publicFiles = new Set(["/", "/index.html", "/styles.css", "/script.js", "/admin-login.html", "/admin.html", "/admin.js"]);
const staticTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
]);

const radioClients = new Set();
const adminClients = new Set();
const stationStartedAt = Date.now();
const voiceEvents = [];
let voiceEventSeq = 0;
let listenerQueue = Promise.resolve();
let listenerQueueVersion = 0;

function createServer(config) {
  const broadcast = new BroadcastStream(config);
  const topicCycle = createTopicCycleController(config, broadcast);
  broadcast.start();
  topicCycle.restore().catch((error) => {
    console.error(`Topic cycle restore failed: ${error.message}`);
  });
  setTimeout(() => {
    recoverPendingListenerVoices(config, broadcast).catch((error) => {
      console.error(`Listener voice recovery failed: ${error.message}`);
    });
  }, 2000);

  return http.createServer(async (request, response) => {
    try {
      const url = parseRequestUrl(request);
      if (!url) {
        await sendJson(response, 400, { error: "Bad request URL" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/login") {
        await handleAdminLogin(request, response, config);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/logout") {
        clearAdminSession(response);
        response.writeHead(303, { Location: "/admin-login.html" });
        response.end();
        return;
      }

      if (requiresAdmin(url.pathname) && !isAdminAuthorized(request, config)) {
        if ((request.method === "GET" || request.method === "HEAD") && isAdminPagePath(url.pathname)) {
          response.writeHead(303, { Location: "/admin-login.html" });
          response.end();
        } else {
          response.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8",
          });
          response.end(JSON.stringify({ error: "Admin auth required", loginUrl: "/admin-login.html" }));
        }
        return;
      }

      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/simsim") {
        await sendFile(request, response, path.join(config.rootDir, "admin.html"), staticTypes.get(".html"));
        return;
      }

      if (requiresListenerApi(url.pathname) && !isListenerApiAuthorized(request, config)) {
        await sendJson(response, 403, { error: "Listener API forbidden" });
        return;
      }

      if ((request.method === "GET" || request.method === "HEAD") && publicFiles.has(url.pathname)) {
        const filePath = url.pathname === "/" ? path.join(config.rootDir, "index.html") : path.join(config.rootDir, url.pathname);
        await sendFile(request, response, filePath, staticTypes.get(path.extname(filePath)) || "text/plain");
        return;
      }

      if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/assets/")) {
        const file = decodeURIComponent(url.pathname.slice("/assets/".length));
        const filePath = resolveInside(path.join(config.rootDir, "assets"), file);
        await sendFile(request, response, filePath, staticTypes.get(path.extname(filePath)) || "application/octet-stream");
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/radio/events") {
        openEventStream(request, response, radioClients);
        return;
      }

      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/stream") {
        if (request.method === "HEAD") {
          broadcast.writeHead(response);
          return;
        }
        broadcast.openClient(request, response);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/admin/events") {
        openEventStream(request, response, adminClients);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/tracks") {
        const liveTracks = await addTrackDurations(
          await listTracks(config.liveMusicDir, { urlPrefix: "/music/live" }),
          config.liveMusicDir,
          broadcast,
        );
        const playTracks = await addTrackDurations(
          await listTracks(config.playMusicDir, { urlPrefix: "/music/play" }),
          config.playMusicDir,
          broadcast,
        );
        await sendJson(response, 200, { tracks: liveTracks, liveTracks, playTracks });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/radio/config") {
        const admin = await readAdminConfig(config);
        await sendJson(response, 200, { audioMix: admin.audioMix, stationName: admin.stationName });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/radio/voice-queue") {
        await sendJson(response, 200, { items: await listRecentRadioVoices(config, url.searchParams.get("since")) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/radio/state") {
        await sendJson(response, 200, {
          stationStartedAt,
          serverNow: Date.now(),
          stream: broadcast.getStatus(),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/public-network/status") {
        if (!isListenerApiAuthorized(request, config)) {
          await sendJson(response, 403, { error: "Listener API forbidden" });
          return;
        }
        await sendJson(response, 200, await getPublicNetworkStatus(config));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/admin/config") {
        await sendJson(response, 200, await readAdminConfig(config));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/admin/fact-log") {
        await sendJson(response, 200, await getFactLogPayload(config));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/admin/topic-cycle") {
        await sendJson(response, 200, topicCycle.getStatus());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/topic-cycle/start") {
        const status = await topicCycle.start(await readJson(request).catch(() => ({})));
        await emitAdmin(config, "topic-cycle", status);
        await sendJson(response, 200, status);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/topic-cycle/stop") {
        const status = await topicCycle.stop();
        await emitAdmin(config, "topic-cycle", status);
        await sendJson(response, 200, status);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/admin/archive") {
        await sendJson(response, 200, { items: await listArchiveItems(config) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/admin/audio-files") {
        await sendJson(response, 200, await getAudioFilesPayload(config, broadcast, {
          voiceOffset: url.searchParams.get("voiceOffset"),
          voiceLimit: url.searchParams.get("voiceLimit"),
        }));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/admin/listeners") {
        await sendJson(response, 200, await readListenerStore(config));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/admin/system-log") {
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 200));
        await sendJson(response, 200, { items: await readRecentSystemLogs(config, limit) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/admin/ai-usage") {
        await sendJson(response, 200, await getAiUsage(config));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/log") {
        const body = await readJson(request).catch(() => ({}));
        await writeSystemLog(config, "admin_client_action", {
          action: body.action || null,
          target: body.target || null,
          value: body.value || null,
          tab: body.tab || null,
          error: body.error || null,
          details: body.details || null,
        });
        await sendJson(response, 200, { logged: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/music/insert") {
        const body = await readJson(request);
        const track = await findPlayableTrack(config, body.file);
        if (!track.ok) {
          await writeSystemLog(config, "api_play_insert_error", {
            file: body.file || null,
            error: track.error,
          });
          await sendJson(response, 400, {
            ok: false,
            file: body.file || null,
            stream: broadcast.getStatus(),
            error: track.error,
          });
          return;
        }

        const ok = broadcast.enqueueMusic(track.file);
        await writeSystemLog(config, ok ? "api_play_insert_ok" : "api_play_insert_error", {
          file: track.file,
          error: ok ? null : broadcast.lastMusicEnqueueError || "Track file is not available",
        });
        await sendJson(response, ok ? 200 : 400, {
          ok,
          file: track.file,
          stream: broadcast.getStatus(),
          error: ok ? null : broadcast.lastMusicEnqueueError || "Track file is not available",
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/music/sync") {
        const result = await broadcast.syncMusicFiles();
        await sendJson(response, 200, {
          synced: true,
          ...result,
          tracks: result.liveTracks,
          stream: broadcast.getStatus(),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/audio-files/upload") {
        const result = await uploadMusicFiles(config, request, url.searchParams.get("kind"));
        const sync = await broadcast.syncMusicFiles();
        await writeSystemLog(config, "admin_audio_files_uploaded", {
          kind: result.kind,
          files: result.files.map((file) => file.file),
          skipped: result.skipped,
        });
        await emitAdmin(config, "audio-files", await getAudioFilesPayload(config, broadcast));
        await sendJson(response, 200, { ...result, sync });
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/api/admin/audio-files") {
        const result = await deleteMusicFile(config, url.searchParams.get("kind"), url.searchParams.get("file"));
        const sync = await broadcast.syncMusicFiles();
        await writeSystemLog(config, "admin_audio_file_deleted", result);
        await emitAdmin(config, "audio-files", await getAudioFilesPayload(config, broadcast));
        await sendJson(response, 200, { ...result, sync });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/broadcast/stop") {
        const status = await topicCycle.pauseForBroadcastStop();
        const result = broadcast.stopBroadcast("admin_stop");
        await emitAdmin(config, "topic-cycle", status);
        await writeSystemLog(config, "admin_broadcast_stop", result);
        await sendJson(response, 200, { stopped: true, topicCycle: status, ...result });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/broadcast/restore") {
        const result = broadcast.restoreBroadcast("admin_restore");
        const topicCycleStatus = await topicCycle.resumeAfterBroadcastRestore();
        await emitAdmin(config, "topic-cycle", topicCycleStatus);
        await writeSystemLog(config, "admin_broadcast_restore", result);
        await sendJson(response, 200, { restored: true, topicCycle: topicCycleStatus, ...result });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/voice/replay-latest") {
        const body = await readJson(request).catch(() => ({}));
        const items = await listArchiveItems(config);
        const audio = items.find((item) => item.audioUrl);
        if (!audio) {
          await sendJson(response, 404, { ok: false, error: "No archived voice audio found" });
          return;
        }
        const event = {
          audioUrl: audio.audioUrl,
          archivePath: audio.relativePath,
          title: `Replay: ${audio.title}`,
          source: "admin-replay",
        };
        const preludeSeconds = Object.prototype.hasOwnProperty.call(body, "preludeSeconds")
          ? clampNumber(body.preludeSeconds, 0, 300)
          : undefined;
        const postludeSeconds = Object.prototype.hasOwnProperty.call(body, "postludeSeconds")
          ? clampNumber(body.postludeSeconds, 0, 30)
          : undefined;
        const ok = broadcast.enqueueVoice(event, {
          delayAfterMs: 0,
          preludeSeconds,
          postludeSeconds,
        });
        await emitRadio("voice", event);
        await writeSystemLog(config, "api_voice_replay_latest", {
          ok,
          audioUrl: audio.audioUrl,
          preludeSeconds: preludeSeconds ?? null,
          postludeSeconds: postludeSeconds ?? null,
        });
        await sendJson(response, ok ? 200 : 400, { ok, audio, stream: broadcast.getStatus() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/listeners/reset") {
        listenerQueueVersion += 1;
        listenerQueue = Promise.resolve();
        const clearedBroadcastItems = broadcast.clearQueue();
        await resetListenerStore(config);
        await emitAdmin(config, "listeners", await readListenerStore(config));
        await sendJson(response, 200, { reset: true, clearedBroadcastItems });
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/api/admin/archive") {
        const relativePath = url.searchParams.get("path");
        await deleteArchiveItem(config, relativePath);
        await emitFactState(config);
        await sendJson(response, 200, { deleted: true, items: await listArchiveItems(config) });
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/admin/config") {
        const body = await readJson(request);
        const admin = await writeAdminConfig(config, body);
        await writeSystemLog(config, "admin_config_saved", {
          stationName: admin.stationName,
          activeHostId: admin.prompts?.activeHostId || null,
          voiceModel: admin.voice?.model || null,
          voiceStability: admin.voice?.stability ?? null,
          voiceSimilarityBoost: admin.voice?.similarityBoost ?? null,
          voiceStyle: admin.voice?.style ?? null,
          voiceSpeed: admin.voice?.speed ?? null,
          speakerBoost: admin.voice?.speakerBoost ?? null,
          musicLevel: admin.audioMix?.musicLevel ?? null,
          voiceLevel: admin.audioMix?.voiceLevel ?? null,
          duckingRatio: admin.audioMix?.duckingRatio ?? null,
          preludeSeconds: admin.audioMix?.preludeSeconds ?? null,
          duckFadeSeconds: admin.audioMix?.duckFadeSeconds ?? null,
          restoreFadeSeconds: admin.audioMix?.restoreFadeSeconds ?? null,
          postludeSeconds: admin.audioMix?.postludeSeconds ?? null,
        });
        await emitAdmin(config, "config", admin);
        await sendJson(response, 200, admin);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/prompts/refresh") {
        const body = await readJson(request);
        const currentAdmin = await readAdminConfig(config);
        const admin = await writeAdminConfig(config, {
          ...body,
          prompts: {
            ...(body.prompts || {}),
            revision: Math.max(0, Math.floor(Number(currentAdmin.prompts?.revision) || 0)) + 1,
          },
        });
        await writeSystemLog(config, "admin_prompts_refreshed", {
          stationName: admin.stationName,
          activeHostId: admin.prompts?.activeHostId || null,
          promptRevision: admin.prompts?.revision ?? null,
          hostCount: admin.prompts?.hosts ? Object.keys(admin.prompts.hosts).length : 0,
        });
        await emitAdmin(config, "config", admin);
        await emitFactState(config);
        await sendJson(response, 200, { admin, reset: false });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/archive/clear") {
        await resetGeneratedAudio(config);
        await emitAdmin(config, "archive", { changed: true });
        await sendJson(response, 200, { cleared: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/tests/payment-flow") {
        const result = await runPaymentFlowSelfTest(config);
        await sendJson(response, result.ok ? 200 : 500, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/listeners/start") {
        const result = await registerListener(config, await readJson(request));
        await emitAdmin(config, "listeners", await readListenerStore(config));
        await sendJson(response, result.ok ? 200 : 409, { ...result, radioUrl: config.publicRadioUrl });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/listeners/status") {
        const result = await getListenerStatus(config, await readJson(request));
        await sendJson(response, result.ok ? 200 : 404, { ...result, radioUrl: config.publicRadioUrl });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/listeners/name") {
        const body = await readJson(request);
        const result = await setListenerName(config, body.telegramId, body.name);
        await emitAdmin(config, "listeners", await readListenerStore(config));
        await sendJson(response, result.ok ? 200 : 404, { ...result, radioUrl: config.publicRadioUrl });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/listeners/question") {
        const result = await acceptQuestion(config, await readJson(request));
        if (result.ok && !result.requiresPayment) enqueueListenerQuestion(config, broadcast, result.question);
        await emitAdmin(config, "listeners", await readListenerStore(config));
        await sendJson(response, result.ok ? 200 : 403, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/listeners/question/checkout") {
        const body = await readJson(request);
        const question = await getQuestion(config, body.questionId);
        const ok = Boolean(
          question
          && question.status === "waiting_payment"
          && question.telegramId === String(body.telegramId || "")
          && Number(question.priceStars) === Number(body.amountStars),
        );
        await sendJson(response, ok ? 200 : 409, {
          ok,
          reason: ok ? null : "invalid_question",
          question,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/listeners/question/paid") {
        const body = await readJson(request);
        const question = await getQuestion(config, body.questionId);
        if (!question || question.telegramId !== String(body.telegramId || "")) {
          await sendJson(response, 409, { ok: false, reason: "invalid_question" });
          return;
        }
        const result = await markQuestionPaid(config, body.questionId, {
          telegramPaymentChargeId: body.telegramPaymentChargeId,
          rawPayload: body.rawPayload,
        });
        if (result.ok && !result.alreadyPaid) enqueueListenerQuestion(config, broadcast, result.question);
        await emitAdmin(config, "listeners", await readListenerStore(config));
        await sendJson(response, result.ok ? 200 : 409, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/listeners/channel/reaction") {
        const result = await recordChannelReactionCount(config, await readJson(request));
        await sendJson(response, result.ok ? 200 : 409, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/listeners/stars/transaction") {
        const result = await recordBotStarTransaction(config, await readJson(request));
        await sendJson(response, result.ok ? 200 : 409, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/listeners/ai-usage") {
        await sendJson(response, 200, await getAiUsage(config));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/health/ai") {
        const [deepseek, elevenlabs] = await Promise.all([
          pingDeepSeek(config.deepseek),
          pingElevenLabs(config.elevenlabs),
        ]);
        await sendJson(response, deepseek.ok && elevenlabs.ok ? 200 : 207, { deepseek, elevenlabs });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/greeting") {
        const payload = await createGreeting(config);
        const event = { ...payload, title: "Приветствие", source: "admin" };
        await sendGeneratedVoice(response, config, broadcast, event, payload);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/fact") {
        const body = await readJson(request);
        const payload = await createFact(config, body);
        const event = { ...payload, title: "Тема эфира", source: "admin" };
        await sendGeneratedVoice(response, config, broadcast, event, payload);
        await emitFactState(config);
        await emitAdmin(config, "archive", { changed: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/farewell") {
        const payload = await createFarewell(config);
        const event = { ...payload, title: "Прощание", source: "admin" };
        await sendGeneratedVoice(response, config, broadcast, event, payload);
        return;
      }

      if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/music/")) {
        const file = decodeURIComponent(url.pathname.slice("/music/".length));
        const filePath = resolveInside(config.musicDir, file);
        await sendFile(request, response, filePath, getAudioType(filePath));
        return;
      }

      if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/cache/announcements/")) {
        const file = decodeURIComponent(url.pathname.slice("/cache/announcements/".length));
        const filePath = resolveInside(config.cacheDir, file);
        await sendFile(request, response, filePath, "audio/mpeg");
        return;
      }

      if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/archive/")) {
        const file = decodeURIComponent(url.pathname.slice("/archive/".length));
        const filePath = resolveInside(config.archiveDir, file);
        await sendFile(request, response, filePath, getAudioType(filePath));
        return;
      }

      await sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      console.error(error);
      writeSystemLog(config, "api_request_error", {
        method: request.method,
        url: request.url,
        error: error.message || "Server error",
      }).catch(() => {});
      if (!response.headersSent) {
        await sendJson(response, error.statusCode || 500, { error: error.message || "Server error" });
      } else {
        response.destroy();
      }
    }
  });
}

function parseRequestUrl(request) {
  try {
    return new URL(request.url || "/", "http://localhost");
  } catch {
    return null;
  }
}

function enqueueListenerQuestion(config, broadcast, question) {
  const queueVersion = listenerQueueVersion;
  listenerQueue = listenerQueue.then(
    () => processListenerQuestion(config, broadcast, question, queueVersion),
    () => processListenerQuestion(config, broadcast, question, queueVersion),
  );
}

async function runPaymentFlowSelfTest(config) {
  const tempListenerStorePath = path.join(
    path.dirname(config.listenerStorePath),
    `payment-flow-selftest-${Date.now()}.json`,
  );
  const tempConfig = {
    ...config,
    listenerStorePath: tempListenerStorePath,
    database: { ...config.database, enabled: false },
    listenerAccess: {
      allowedTelegramIds: [],
      allowedUsernames: [],
      unlimitedTelegramIds: [],
      unlimitedUsernames: [],
      adminTelegramIds: [],
      adminUsernames: [],
    },
  };
  try {
    await resetListenerStore(tempConfig);
    await registerListener(tempConfig, {
      telegramId: "900000001",
      username: "payment_test_user",
      name: "Тестовый слушатель",
    });
    const free = await acceptQuestion(tempConfig, {
      telegramId: "900000001",
      username: "payment_test_user",
      question: "Первый бесплатный вопрос",
    });
    const paidDraft = await acceptQuestion(tempConfig, {
      telegramId: "900000001",
      username: "payment_test_user",
      question: "Второй платный вопрос",
    });
    const paid = await markQuestionPaid(tempConfig, paidDraft.question.id, {
      telegramPaymentChargeId: "selftest-charge",
    });
    const db = await runPaymentDbSelfTest(config);
    const summary = await getPaymentSummary(config);

    return {
      ok: Boolean(
        free.ok
        && free.question.status === "queued"
        && paidDraft.ok
        && paidDraft.requiresPayment
        && paidDraft.question.status === "waiting_payment"
        && Number(paidDraft.question.priceStars) === config.listenerQuestionPriceStars
        && paid.ok
        && paid.question.status === "queued"
        && db.ok,
      ),
      freeQuestion: {
        status: free.question.status,
        remainingAfter: free.question.remainingAfter,
      },
      paidQuestion: {
        draftStatus: paidDraft.question.status,
        priceStars: paidDraft.question.priceStars,
        finalStatus: paid.question.status,
      },
      database: db,
      databaseSummary: summary,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    await fs.promises.rm(tempListenerStorePath, { force: true }).catch(() => {});
  }
}

function createTopicCycleController(config, broadcast) {
  let timer = null;
  let running = false;
  let pendingRun = null;
  let state = {
    active: false,
    mode: "all-loop",
    selectedTopicIndex: null,
    selectedTopicId: null,
    selectedTopicName: null,
    completionReason: null,
    order: "topic-first",
    minIntervalMs: 5 * 60_000,
    maxIntervalMs: 6 * 60_000,
    cursorTopicIndex: 0,
    cursorSubtopicIndex: 0,
    startedAt: null,
    nextRunAt: null,
    lastRun: null,
    lastError: null,
    runCount: 0,
  };

  return {
    restore,
    getStatus,
    start,
    stop,
    pauseForBroadcastStop,
    resumeAfterBroadcastRestore,
  };

  async function restore() {
    try {
      const saved = JSON.parse(await fs.promises.readFile(config.topicCycleStatePath, "utf8"));
      if (saved?.active) {
        state = normalizeTopicCycleState(saved);
        scheduleNext(5_000);
      }
    } catch {}
  }

  function getStatus() {
    return {
      ...state,
      running,
    };
  }

  async function start(input = {}) {
    clearTimer();
    pendingRun = null;
    const admin = await readAdminConfig(config);
    const mode = normalizeTopicCycleMode(input.mode);
    const requestedTopicId = normalizeTopicId(input.topicId);
    const requestedTopicIndex = Number.isFinite(Number(input.topicIndex))
      ? Math.max(0, Math.min(admin.topics.length - 1, Math.floor(Number(input.topicIndex))))
      : 0;
    const topicIndexById = requestedTopicId
      ? admin.topics.findIndex((topic) => topic.id === requestedTopicId)
      : -1;
    if (requestedTopicId && topicIndexById < 0) {
      const error = new Error(`Topic not found for cycle start: ${requestedTopicId}`);
      error.statusCode = 400;
      throw error;
    }
    const selectedTopicIndex = requestedTopicId ? topicIndexById : requestedTopicIndex;
    const selectedTopic = admin.topics[selectedTopicIndex] || admin.topics[0] || null;
    const subtopicIndex = Math.max(0, Math.floor(Number(input.subtopicIndex) || 0));
    const order = normalizeTopicCycleOrder(input.order);

    if (selectedTopic) {
      await setCursor(config, {
        topicIndex: selectedTopicIndex,
        subtopicIndex,
      });
    }

    state = normalizeTopicCycleState({
      ...state,
      active: true,
      mode,
      selectedTopicIndex,
      selectedTopicId: selectedTopic?.id || null,
      selectedTopicName: selectedTopic?.name || null,
      completionReason: null,
      order,
      minIntervalMs: input.minIntervalMs,
      maxIntervalMs: input.maxIntervalMs,
      cursorTopicIndex: selectedTopicIndex,
      cursorSubtopicIndex: subtopicIndex,
      startedAt: new Date().toISOString(),
      nextRunAt: null,
      lastError: null,
      runCount: state.runCount || 0,
    });
    await saveState();
    await writeSystemLog(config, "topic_cycle_started", {
      mode: state.mode,
      selectedTopicIndex: state.selectedTopicIndex,
      selectedTopicId: state.selectedTopicId,
      selectedTopicName: state.selectedTopicName,
      order: state.order,
      minIntervalMs: state.minIntervalMs,
      maxIntervalMs: state.maxIntervalMs,
    });
    scheduleNext(input.immediate === false ? randomInterval() : 1_000);
    return getStatus();
  }

  async function stop() {
    clearTimer();
    pendingRun = null;
    state = {
      ...state,
      active: false,
      nextRunAt: null,
      stoppedAt: new Date().toISOString(),
      completionReason: "manual_stop",
    };
    await saveState();
    await writeSystemLog(config, "topic_cycle_stopped", {
      runCount: state.runCount,
      mode: state.mode,
      reason: state.completionReason,
    });
    return getStatus();
  }

  async function pauseForBroadcastStop() {
    if (!state.active) return getStatus();
    clearTimer();
    pendingRun = null;
    state = {
      ...state,
      active: false,
      nextRunAt: null,
      stoppedAt: new Date().toISOString(),
      completionReason: "broadcast_stop",
    };
    await saveState();
    await writeSystemLog(config, "topic_cycle_paused_for_broadcast", {
      runCount: state.runCount,
      mode: state.mode,
      reason: state.completionReason,
    });
    return getStatus();
  }

  async function resumeAfterBroadcastRestore() {
    if (state.active || state.completionReason !== "broadcast_stop") return getStatus();
    pendingRun = null;
    state = {
      ...state,
      active: true,
      nextRunAt: null,
      stoppedAt: null,
      completionReason: null,
    };
    await saveState();
    await writeSystemLog(config, "topic_cycle_resumed_after_broadcast", {
      runCount: state.runCount,
      mode: state.mode,
      selectedTopicName: state.selectedTopicName,
      order: state.order,
    });
    scheduleNext(1_000);
    return getStatus();
  }

  function scheduleNext(delayMs = randomInterval()) {
    if (!state.active) return;
    clearTimer();
    const delay = Math.max(1_000, Math.round(delayMs));
    state.nextRunAt = new Date(Date.now() + delay).toISOString();
    saveState().catch(() => {});
    emitAdmin(config, "topic-cycle", getStatus()).catch(() => {});
    timer = setTimeout(() => {
      runOnce().catch((error) => {
        console.error(`Topic cycle run failed: ${error.message}`);
      });
    }, delay);
  }

  async function runOnce() {
    if (!state.active || running) return;
    running = true;
    try {
      await writeSystemLog(config, "topic_cycle_run_started", {
        mode: state.mode,
        selectedTopicId: state.selectedTopicId,
        selectedTopicName: state.selectedTopicName,
        order: state.order,
        cursorTopicIndex: state.cursorTopicIndex,
        cursorSubtopicIndex: state.cursorSubtopicIndex,
        runCount: state.runCount,
      });
      const admin = await readAdminConfig(config);
      if (state.mode === "selected-once" && !findSelectedTopic(admin)) {
        state = {
          ...state,
          active: false,
          nextRunAt: null,
          stoppedAt: new Date().toISOString(),
          completionReason: "selected_topic_missing",
        };
        await writeSystemLog(config, "topic_cycle_selected_topic_missing", {
          selectedTopicId: state.selectedTopicId,
          selectedTopicName: state.selectedTopicName,
          runCount: state.runCount,
        });
        return;
      }
      const attemptLimit = getTopicCycleAttemptLimit(admin);
      let queuedPayload = null;
      let queuedSelection = null;
      let lastAttemptError = null;

      for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
        const selection = selectTopicCycleItem(admin);
        if (!selection) break;
        const nextCursor = getAdvancedTopicCycleCursor(admin, selection);
        try {
          const payload = await withTimeout(createFact(config, {
            topic: selection.topic.name,
            subtopic: selection.subtopic,
          }), 180_000, "Topic cycle generation timed out");
          const title = payload.subtopic ? `${payload.topic}: ${payload.subtopic}` : "Тема эфира";
          const topicCycleRun = {
            id: `topic-cycle:${Date.now()}:${Math.random().toString(16).slice(2)}`,
            selection,
            nextCursor,
            payload,
          };
          const result = await enqueueGeneratedVoice(config, broadcast, {
            ...payload,
            title,
            source: "topic-cycle",
          }, payload, {
            onEnd: () => completeQueuedTopicCycleRun(topicCycleRun),
            onError: (error) => handleQueuedTopicCycleRunError(topicCycleRun, error),
          });

          if (result.statusCode >= 400) {
            state = { ...state, ...nextCursor };
            lastAttemptError = result.body.error || "Topic cycle audio was not queued";
            await writeSystemLog(config, "topic_cycle_fact_skipped", {
              topic: selection.topic.name,
              subtopic: selection.subtopic,
              reason: lastAttemptError,
              nextCursor,
            });
            if (isSelectedTopicLastSelection(admin, selection)) break;
            continue;
          }

          pendingRun = topicCycleRun;
          queuedPayload = payload;
          queuedSelection = selection;
          break;
        } catch (error) {
          state = { ...state, ...nextCursor };
          lastAttemptError = error.message;
          await writeSystemLog(config, "topic_cycle_fact_skipped", {
            topic: selection.topic.name,
            subtopic: selection.subtopic,
            reason: error.message,
            nextCursor,
          });
          if (isSelectedTopicLastSelection(admin, selection)) break;
        }
      }

      if (!queuedPayload || !queuedSelection) {
        if (state.mode === "selected-once") {
          state = {
            ...state,
            active: false,
            nextRunAt: null,
            stoppedAt: new Date().toISOString(),
            completionReason: "selected_topic_exhausted",
            lastError: lastAttemptError ? { at: new Date().toISOString(), message: lastAttemptError } : null,
          };
          await writeSystemLog(config, "topic_cycle_completed", {
            mode: state.mode,
            selectedTopicId: state.selectedTopicId,
            selectedTopicName: state.selectedTopicName,
            order: state.order,
            reason: state.completionReason,
            runCount: state.runCount,
          });
          return;
        }
        throw new Error(lastAttemptError || "No playable topic cycle audio is available");
      }

      await writeSystemLog(config, "topic_cycle_fact_queued", {
        at: new Date().toISOString(),
        topic: queuedPayload.topic,
        subtopic: queuedPayload.subtopic,
        queued: true,
      });
      await emitFactState(config);
      await emitAdmin(config, "archive", { changed: true });
    } catch (error) {
      state = {
        ...state,
        lastError: {
          at: new Date().toISOString(),
          message: error.message,
        },
      };
      await writeSystemLog(config, "topic_cycle_error", state.lastError);
    } finally {
      running = false;
      await saveState();
      await emitAdmin(config, "topic-cycle", getStatus());
      if (state.active && !pendingRun) scheduleNext();
    }
  }

  async function completeQueuedTopicCycleRun(run) {
    if (pendingRun !== run) return;
    pendingRun = null;
    const admin = await readAdminConfig(config);
    state = {
      ...state,
      ...run.nextCursor,
      lastRun: {
        at: new Date().toISOString(),
        topic: run.payload.topic,
        subtopic: run.payload.subtopic,
        queued: true,
        played: true,
      },
      lastError: null,
      runCount: Number(state.runCount || 0) + 1,
    };
    await writeSystemLog(config, "topic_cycle_fact_played", state.lastRun);
    if (isSelectedTopicLastSelection(admin, run.selection)) {
      state = {
        ...state,
        active: false,
        nextRunAt: null,
        stoppedAt: new Date().toISOString(),
        completionReason: "selected_topic_completed",
      };
      await writeSystemLog(config, "topic_cycle_completed", {
        mode: state.mode,
        selectedTopicId: state.selectedTopicId,
        selectedTopicName: state.selectedTopicName,
        order: state.order,
        lastTopic: run.payload.topic,
        lastSubtopic: run.payload.subtopic,
        runCount: state.runCount,
      });
    }
    await saveState();
    await emitAdmin(config, "topic-cycle", getStatus());
    if (state.active) scheduleNext();
  }

  async function handleQueuedTopicCycleRunError(run, error) {
    if (pendingRun !== run) return;
    pendingRun = null;
    clearTimer();
    const admin = await readAdminConfig(config);
    const message = error?.message || "Topic cycle voice playback failed";
    state = {
      ...state,
      ...run.nextCursor,
      lastError: {
        at: new Date().toISOString(),
        message,
      },
    };
    await writeSystemLog(config, "topic_cycle_fact_skipped", {
      topic: run.selection.topic.name,
      subtopic: run.selection.subtopic,
      reason: message,
      stage: "playback",
      nextCursor: {
        cursorTopicIndex: state.cursorTopicIndex,
        cursorSubtopicIndex: state.cursorSubtopicIndex,
      },
    });
    if (state.mode === "selected-once" && isSelectedTopicLastSelection(admin, run.selection)) {
      state = {
        ...state,
        active: false,
        nextRunAt: null,
        stoppedAt: new Date().toISOString(),
        completionReason: "selected_topic_exhausted",
      };
      await writeSystemLog(config, "topic_cycle_completed", {
        mode: state.mode,
        selectedTopicId: state.selectedTopicId,
        selectedTopicName: state.selectedTopicName,
        order: state.order,
        reason: state.completionReason,
        runCount: state.runCount,
      });
    }
    await saveState();
    await emitAdmin(config, "topic-cycle", getStatus());
    if (state.active) {
      queueMicrotask(() => {
        runOnce().catch((runError) => {
          console.error(`Topic cycle retry failed: ${runError.message}`);
        });
      });
    }
  }

  function randomInterval() {
    const min = state.minIntervalMs;
    const max = Math.max(min, state.maxIntervalMs);
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  function selectTopicCycleItem(admin) {
    const topics = Array.isArray(admin.topics) ? admin.topics : [];
    if (!topics.length) return null;

    if (state.mode === "selected-once") {
      const selected = findSelectedTopicEntry(admin);
      if (!selected) return null;
      const { topic, topicIndex } = selected;
      if (!topic?.subtopics?.length) return null;
      const subtopicIndex = Math.min(Math.max(0, Math.floor(Number(state.cursorSubtopicIndex) || 0)), topic.subtopics.length - 1);
      return { topic, topicIndex, subtopic: topic.subtopics[subtopicIndex], subtopicIndex };
    }

    const maxSubtopics = Math.max(...topics.map((topic) => topic.subtopics?.length || 0), 0);
    const guardLimit = Math.max(1, topics.length * Math.max(1, maxSubtopics) + topics.length);
    let topicIndex = clampTopicIndex(state.cursorTopicIndex, topics);
    let subtopicIndex = Math.max(0, Math.floor(Number(state.cursorSubtopicIndex) || 0));

    for (let guard = 0; guard < guardLimit; guard += 1) {
      const topic = topics[topicIndex];
      if (topic?.subtopics?.[subtopicIndex]) {
        return { topic, topicIndex, subtopic: topic.subtopics[subtopicIndex], subtopicIndex };
      }
      const next = getAdvancedTopicCycleCursor(admin, { topicIndex, subtopicIndex });
      topicIndex = next.cursorTopicIndex;
      subtopicIndex = next.cursorSubtopicIndex;
    }

    return null;
  }

  function getAdvancedTopicCycleCursor(admin, selection) {
    const topics = Array.isArray(admin.topics) ? admin.topics : [];
    if (!topics.length) return { cursorTopicIndex: 0, cursorSubtopicIndex: 0 };

    if (state.mode !== "all-loop" || state.order === "topic-first") {
      let topicIndex = clampTopicIndex(selection.topicIndex, topics);
      let subtopicIndex = Math.max(0, Math.floor(Number(selection.subtopicIndex) || 0)) + 1;
      const topic = topics[topicIndex];
      if (subtopicIndex >= (topic?.subtopics?.length || 0)) {
        subtopicIndex = 0;
        topicIndex = (topicIndex + 1) % topics.length;
      }
      return { cursorTopicIndex: topicIndex, cursorSubtopicIndex: subtopicIndex };
    }

    const startTopicIndex = resolveSelectedTopicIndex(admin, topics);
    const maxSubtopics = Math.max(...topics.map((topic) => topic.subtopics?.length || 0), 1);
    let topicIndex = (clampTopicIndex(selection.topicIndex, topics) + 1) % topics.length;
    let subtopicIndex = Math.max(0, Math.floor(Number(selection.subtopicIndex) || 0));
    if (topicIndex === startTopicIndex) {
      subtopicIndex = (subtopicIndex + 1) % maxSubtopics;
    }
    return { cursorTopicIndex: topicIndex, cursorSubtopicIndex: subtopicIndex };
  }

  function clampTopicIndex(value, topics) {
    return Math.max(0, Math.min(topics.length - 1, Math.floor(Number(value) || 0)));
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function isSelectedTopicLastSelection(admin, selection) {
    if (state.mode !== "selected-once") return false;
    const topic = findSelectedTopic(admin);
    if (!topic) return true;
    if (selection.topic.name !== topic.name) return true;
    return Number(selection.subtopicIndex) >= topic.subtopics.length - 1;
  }

  function getTopicCycleAttemptLimit(admin) {
    const topics = Array.isArray(admin.topics) ? admin.topics : [];
    if (state.mode === "selected-once") {
      return Math.max(1, findSelectedTopic(admin)?.subtopics?.length || 1);
    }
    return Math.max(1, topics.reduce((total, topic) => total + (topic.subtopics?.length || 0), 0));
  }

  function findSelectedTopic(admin) {
    return findSelectedTopicEntry(admin)?.topic || null;
  }

  function findSelectedTopicEntry(admin) {
    const topics = Array.isArray(admin.topics) ? admin.topics : [];
    const byId = state.selectedTopicId
      ? topics.findIndex((topic) => topic.id === state.selectedTopicId)
      : -1;
    if (byId >= 0) return { topic: topics[byId], topicIndex: byId };

    const byName = state.selectedTopicName
      ? topics.findIndex((topic) => topic.name === state.selectedTopicName)
      : -1;
    if (byName >= 0) return { topic: topics[byName], topicIndex: byName };

    return null;
  }

  function resolveSelectedTopicIndex(admin, topics) {
    return findSelectedTopicEntry(admin)?.topicIndex
      ?? clampTopicIndex(state.selectedTopicIndex, topics);
  }

  async function saveState() {
    await fs.promises.mkdir(path.dirname(config.topicCycleStatePath), { recursive: true });
    await fs.promises.writeFile(config.topicCycleStatePath, JSON.stringify(state, null, 2), "utf8");
  }
}

function normalizeTopicCycleState(input = {}) {
  const min = clampCycleNumber(input.minIntervalMs, 5 * 60_000, 60_000, 24 * 60 * 60_000);
  const max = clampCycleNumber(input.maxIntervalMs, 6 * 60_000, min, 24 * 60 * 60_000);
  return {
    active: Boolean(input.active),
    mode: normalizeTopicCycleMode(input.mode),
    selectedTopicIndex: Number.isFinite(Number(input.selectedTopicIndex)) ? Math.max(0, Math.floor(Number(input.selectedTopicIndex))) : null,
    selectedTopicId: normalizeTopicId(input.selectedTopicId),
    selectedTopicName: input.selectedTopicName ? String(input.selectedTopicName).slice(0, 160) : null,
    completionReason: input.completionReason || null,
    order: normalizeTopicCycleOrder(input.order),
    minIntervalMs: min,
    maxIntervalMs: max,
    cursorTopicIndex: Math.max(0, Math.floor(Number(input.cursorTopicIndex ?? input.selectedTopicIndex) || 0)),
    cursorSubtopicIndex: Math.max(0, Math.floor(Number(input.cursorSubtopicIndex) || 0)),
    startedAt: input.startedAt || null,
    stoppedAt: input.stoppedAt || null,
    nextRunAt: input.nextRunAt || null,
    lastRun: input.lastRun || null,
    lastError: input.lastError || null,
    runCount: Math.max(0, Math.floor(Number(input.runCount) || 0)),
  };
}

function normalizeTopicCycleMode(value) {
  return value === "selected-once" ? "selected-once" : "all-loop";
}

function normalizeTopicCycleOrder(value) {
  return value === "subtopic-first" ? "subtopic-first" : "topic-first";
}

function normalizeTopicId(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || null;
}

async function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function clampCycleNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

async function sendGeneratedVoice(response, config, broadcast, event, payload) {
  const result = await enqueueGeneratedVoice(config, broadcast, event, payload);
  await sendJson(response, result.statusCode, result.body);
}

async function enqueueGeneratedVoice(config, broadcast, event, payload, options = {}) {
  if (!payload.audioUrl) {
    const error = payload.audioError || "Voice audio was not created";
    await writeSystemLog(config, "voice_generation_failed", {
      title: event.title || null,
      source: event.source || null,
      kind: payload.kind || null,
      error,
    });
    return { statusCode: 502, body: { ...payload, queued: false, error } };
  }

  const queued = broadcast.enqueueVoice(event, options);
  if (!queued) {
    const error = "Generated audio could not be resolved for broadcast";
    await writeSystemLog(config, "voice_enqueue_failed", {
      title: event.title || null,
      source: event.source || null,
      audioUrl: payload.audioUrl,
      error,
    });
    return { statusCode: 500, body: { ...payload, queued: false, error } };
  }

  await emitRadio("voice", event);
  return { statusCode: 200, body: { ...payload, queued: true } };
}

async function processListenerQuestion(config, broadcast, question, queueVersion) {
  try {
    if (queueVersion !== listenerQueueVersion) return null;
    await updateQuestion(config, question.id, { status: "generating" });
    await emitAdmin(config, "listeners", await readListenerStore(config));

    const payload = await createListenerQuestion(config, question);
    if (queueVersion !== listenerQueueVersion) return null;
    const audioError = payload.audioError || "Voice audio was not created";
    if (!payload.audioUrl) {
      const updated = await updateQuestion(config, question.id, {
        status: "voice_error",
        text: payload.text,
        audioUrl: null,
        archivePath: payload.archivePath,
        error: audioError,
      });
      await writeSystemLog(config, "listener_voice_generation_failed", {
        questionId: question.id,
        userName: question.userName,
        error: audioError,
      });
      await emitAdmin(config, "listeners", await readListenerStore(config));
      return updated;
    }

    const updated = await updateQuestion(config, question.id, {
      status: "ready",
      text: payload.text,
      audioUrl: payload.audioUrl,
      archivePath: payload.archivePath,
      error: null,
    });
    await emitAdmin(config, "listeners", await readListenerStore(config));
    await emitAdmin(config, "archive", { changed: true });

    const event = {
      ...payload,
      source: "listener",
      listenerQuestionId: question.id,
      userName: question.userName,
      question: question.question,
      title: `${question.userName}: вопрос слушателя`,
    };
    enqueueListenerVoiceBroadcast(config, broadcast, question, event);
    await emitRadio("voice", event);
    return updated;
  } catch (error) {
    await updateQuestion(config, question.id, { status: "error", error: error.message });
    await emitAdmin(config, "listeners", await readListenerStore(config));
    return null;
  }
}

async function recoverPendingListenerVoices(config, broadcast) {
  const store = await readListenerStore(config);
  const pending = (store.questions || []).filter((question) => {
    return ["ready", "on_air"].includes(question.status) && question.audioUrl;
  });

  for (const question of pending) {
    const event = {
      text: question.text,
      audioUrl: question.audioUrl,
      archivePath: question.archivePath,
      source: "listener",
      listenerQuestionId: question.id,
      userName: question.userName,
      question: question.question,
      title: `${question.userName}: вопрос слушателя`,
    };
    enqueueListenerVoiceBroadcast(config, broadcast, question, event);
  }

  if (pending.length) {
    await emitAdmin(config, "listeners", await readListenerStore(config));
  }
}

function enqueueListenerVoiceBroadcast(config, broadcast, question, event) {
  writeSystemLog(config, "listener_voice_enqueue", {
    questionId: question.id,
    userName: question.userName,
    status: question.status,
  }).catch(() => {});
  broadcast.enqueueVoice(event, {
    onStart: async () => {
      await writeSystemLog(config, "listener_voice_on_air", {
        questionId: question.id,
        userName: question.userName,
      });
      await updateQuestion(config, question.id, { status: "on_air", error: null });
      await emitAdmin(config, "listeners", await readListenerStore(config));
    },
    onEnd: async () => {
      await writeSystemLog(config, "listener_voice_played", {
        questionId: question.id,
        userName: question.userName,
      });
      await updateQuestion(config, question.id, { status: "played", error: null });
      await emitAdmin(config, "listeners", await readListenerStore(config));
    },
    onError: async (error) => {
      await writeSystemLog(config, "listener_voice_error", {
        questionId: question.id,
        userName: question.userName,
        error: error.message,
      });
      await updateQuestion(config, question.id, { status: "ready", error: `broadcast: ${error.message}` });
      await emitAdmin(config, "listeners", await readListenerStore(config));
    },
  });
}

async function resetGeneratedAudio(config) {
  await Promise.all([
    fs.promises.rm(config.archiveDir, { recursive: true, force: true }),
    fs.promises.rm(config.cacheDir, { recursive: true, force: true }),
  ]);
  await Promise.all([
    fs.promises.mkdir(config.archiveDir, { recursive: true }),
    fs.promises.mkdir(config.cacheDir, { recursive: true }),
  ]);
  await resetFactLog(config);
}

function requiresAdmin(pathname) {
  return isAdminPagePath(pathname)
    || pathname === "/admin.js"
    || pathname === "/api/health/ai"
    || pathname.startsWith("/api/admin/")
    || pathname.startsWith("/archive/")
    || pathname.startsWith("/cache/announcements/")
    || pathname === "/api/greeting"
    || pathname === "/api/fact"
    || pathname === "/api/farewell";
}

function isAdminPagePath(pathname) {
  return pathname === "/admin.html" || pathname === "/simsim";
}

function isAdminAuthorized(request, config) {
  if (isAdminSessionAuthorized(request, config)) return true;

  const header = request.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return constantTimeEqual(username, config.admin.username) && constantTimeEqual(password, config.admin.password);
}

async function handleAdminLogin(request, response, config) {
  const body = await readForm(request);
  const username = body.get("username") || "";
  const password = body.get("password") || "";
  if (!constantTimeEqual(username, config.admin.username) || !constantTimeEqual(password, config.admin.password)) {
    clearAdminSession(response);
    response.writeHead(303, { Location: "/admin-login.html?error=1" });
    response.end();
    return;
  }

  response.writeHead(303, {
    "Set-Cookie": createAdminSessionCookie(config),
    Location: "/simsim",
  });
  response.end();
}

function createAdminSessionCookie(config) {
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ username: config.admin.username, expiresAt }), "utf8").toString("base64url");
  const signature = signAdminSession(payload, config);
  return `admin_session=${payload}.${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
}

function clearAdminSession(response) {
  response.setHeader("Set-Cookie", "admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

function isAdminSessionAuthorized(request, config) {
  const token = parseCookies(request.headers.cookie || "").admin_session;
  if (!token || !token.includes(".")) return false;
  const [payload, signature] = token.split(".", 2);
  if (!constantTimeEqual(signature, signAdminSession(payload, config))) return false;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return session.username === config.admin.username && Number(session.expiresAt) > Date.now();
  } catch {
    return false;
  }
}

function signAdminSession(payload, config) {
  return crypto
    .createHmac("sha256", `${config.admin.username}:${config.admin.password}`)
    .update(payload)
    .digest("base64url");
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies[name] = value;
  }
  return cookies;
}

function readForm(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      data += chunk;
      if (data.length > 10_000) {
        const error = new Error("Form is too large");
        error.statusCode = 413;
        reject(error);
        request.destroy();
      }
    });
    request.on("end", () => resolve(new URLSearchParams(data)));
    request.on("error", reject);
  });
}

function requiresListenerApi(pathname) {
  return pathname.startsWith("/api/listeners/");
}

function isListenerApiAuthorized(request, config) {
  const expected = config.listenerApiToken;
  if (!expected) return false;
  const provided = request.headers["x-radio-listener-token"];
  return constantTimeEqual(provided, expected);
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function openEventStream(request, response, clients) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
  });
  response.write("event: ready\ndata: {}\n\n");
  clients.add(response);
  request.on("close", () => clients.delete(response));
}

async function emitAdmin(config, event, data) {
  emitEvent(adminClients, event, data);
}

async function emitFactState(config) {
  await emitAdmin(config, "fact-log", await getFactLogPayload(config));
}

async function getFactLogPayload(config) {
  return {
    ...(await readAvailableFactLog(config, { prune: true })),
    activeVoiceId: config.elevenlabs.voiceId || null,
  };
}

async function emitRadio(event, data) {
  emitEvent(radioClients, event, event === "voice" ? rememberVoiceEvent(sanitizePublicVoiceEvent(data)) : data);
}

function emitEvent(clients, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

function rememberVoiceEvent(data) {
  const payload = {
    ...data,
    eventId: data.eventId || `voice:${Date.now()}:${voiceEventSeq += 1}`,
    emittedAt: data.emittedAt || new Date().toISOString(),
  };
  voiceEvents.push(payload);
  while (voiceEvents.length > 80) voiceEvents.shift();
  return payload;
}

function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listArchiveItems(config) {
  const files = await walkAudioFiles(config.archiveDir);
  return files
    .map((filePath) => {
      const relativePath = path.relative(config.archiveDir, filePath);
      const parts = relativePath.split(path.sep);
      const kind = parts[0] || "archive";
      const date = parts[1] || "";
      const topic = parts[2] || "";
      const subtopic = parts[3] || "";
      const fileName = path.basename(filePath);
      const titleParts = [labelKind(kind), cleanArchivePart(topic), cleanArchivePart(subtopic)].filter(Boolean);

      return {
        id: relativePath,
        kind,
        date,
        title: titleParts.join(" / ") || fileName,
        fileName,
        relativePath,
        audioUrl: `/archive/${relativePath.split(path.sep).map(encodeURIComponent).join("/")}`,
      };
    })
    .sort((a, b) => b.relativePath.localeCompare(a.relativePath, "ru", { numeric: true }));
}

async function getAudioFilesPayload(config, broadcast, options = {}) {
  const voiceOffset = clampArchiveOffset(options.voiceOffset);
  const voiceLimit = clampArchiveLimit(options.voiceLimit);
  const [liveTracks, playTracks, voiceArchivePage] = await Promise.all([
    addTrackDurations(
      await listTracks(config.liveMusicDir, { urlPrefix: "/music/live" }),
      config.liveMusicDir,
      broadcast,
    ),
    addTrackDurations(
      await listTracks(config.playMusicDir, { urlPrefix: "/music/play" }),
      config.playMusicDir,
      broadcast,
    ),
    listArchiveItemsPage(config, { offset: voiceOffset, limit: voiceLimit }),
  ]);

  return {
    liveTracks,
    playTracks,
    voiceArchive: voiceArchivePage.items,
    voiceArchivePage: {
      offset: voiceArchivePage.offset,
      limit: voiceArchivePage.limit,
      total: voiceArchivePage.total,
      hasMore: voiceArchivePage.hasMore,
    },
    counts: {
      live: liveTracks.length,
      play: playTracks.length,
      voice: voiceArchivePage.total,
    },
  };
}

async function listArchiveItemsPage(config, options = {}) {
  const items = await listArchiveItems(config);
  const offset = clampArchiveOffset(options.offset);
  const limit = clampArchiveLimit(options.limit);
  return {
    items: items.slice(offset, offset + limit),
    offset,
    limit,
    total: items.length,
    hasMore: offset + limit < items.length,
  };
}

function clampArchiveOffset(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function clampArchiveLimit(value) {
  return Math.max(1, Math.min(200, Math.floor(Number(value) || 80)));
}

async function listRecentRadioVoices(config, since) {
  const requestedSince = Date.parse(since || "");
  const cutoff = Number.isFinite(requestedSince)
    ? Math.max(requestedSince, Date.now() - 30 * 60_000)
    : Date.now() - 30 * 60_000;
  const memoryItems = voiceEvents.filter((item) => {
    const time = Date.parse(item.emittedAt || "");
    return Number.isFinite(time) && time >= cutoff;
  });

  const byId = new Map();
  for (const item of memoryItems) {
    byId.set(item.eventId, item);
  }

  return [...byId.values()]
    .sort((a, b) => Date.parse(a.emittedAt || "") - Date.parse(b.emittedAt || ""));
}

async function getPublicNetworkStatus(config) {
  const publicUrl = new URL(config.publicRadioUrl);
  const [dnsA, outboundIp] = await Promise.all([
    resolveDnsA(publicUrl.hostname),
    getOutboundPublicIp(),
  ]);
  return {
    ok: true,
    publicRadioUrl: config.publicRadioUrl,
    hostname: publicUrl.hostname,
    dnsA,
    publicIp: outboundIp,
    checkedAt: new Date().toISOString(),
  };
}

async function resolveDnsA(hostname) {
  try {
    return await dns.resolve4(hostname);
  } catch {
    return [];
  }
}

async function getOutboundPublicIp() {
  const urls = [
    "https://api.ipify.org",
    "https://ifconfig.me/ip",
  ];
  for (const url of urls) {
    try {
      const response = await fetchWithTimeout(url, {}, 8000);
      if (!response.ok) continue;
      const text = (await response.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return text;
    } catch {}
  }
  return "";
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sanitizePublicVoiceEvent(data = {}) {
  return {
    eventId: data.eventId,
    emittedAt: data.emittedAt,
    source: data.source || "voice",
    title: data.title || data.topic || "Диктор в эфире",
  };
}

async function walkAudioFiles(rootDir) {
  let entries = [];
  try {
    entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    const filePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkAudioFiles(filePath));
    } else if (entry.isFile() && [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"].includes(path.extname(entry.name).toLowerCase())) {
      files.push(filePath);
    }
  }
  return files;
}

async function deleteArchiveItem(config, relativePath) {
  if (!relativePath) {
    const error = new Error("Archive path is required");
    error.statusCode = 400;
    throw error;
  }

  const filePath = resolveInside(config.archiveDir, relativePath);
  if (![".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"].includes(path.extname(filePath).toLowerCase())) {
    const error = new Error("Only archive audio files can be deleted");
    error.statusCode = 400;
    throw error;
  }

  await fs.promises.rm(filePath, { force: true });
}

async function uploadMusicFiles(config, request, requestedKind) {
  const kind = normalizeMusicKind(requestedKind);
  const targetDir = kind === "live" ? config.liveMusicDir : config.playMusicDir;
  await fs.promises.mkdir(targetDir, { recursive: true });
  const saved = [];
  const skipped = [];
  const uploads = await streamMultipartFiles(request, targetDir, { maxBytes: 500 * 1024 * 1024 });

  for (const file of uploads) {
    if (file.skipReason) {
      skipped.push({ file: file.fileName, reason: file.skipReason });
      continue;
    }
    if (!file.bytes) {
      await fs.promises.rm(file.tempPath, { force: true }).catch(() => {});
      skipped.push({ file: file.fileName, reason: "Empty file" });
      continue;
    }

    const probe = await probeAudioFile(file.tempPath);
    if (!probe.ok) {
      await fs.promises.rm(file.tempPath, { force: true }).catch(() => {});
      skipped.push({ file: file.fileName, reason: "Invalid or unreadable audio file" });
      continue;
    }

    const safeName = await getAvailableMusicFileName(targetDir, sanitizeAudioFileName(file.fileName, file.extension));
    const targetPath = resolveInside(targetDir, safeName);
    await fs.promises.rename(file.tempPath, targetPath);
    saved.push({
      file: safeName,
      originalFile: file.fileName,
      bytes: file.bytes,
      durationSeconds: probe.durationSeconds,
    });
  }

  if (!saved.length) {
    const error = new Error(skipped[0]?.reason || "No audio files were saved");
    error.statusCode = 400;
    throw error;
  }

  return { ok: true, kind, files: saved, skipped };
}

async function deleteMusicFile(config, requestedKind, requestedFile) {
  const kind = normalizeMusicKind(requestedKind);
  const file = String(requestedFile || "").trim();
  if (!file) {
    const error = new Error("Audio file name is required");
    error.statusCode = 400;
    throw error;
  }
  if (!isSupportedAudioExtension(path.extname(file).toLowerCase())) {
    const error = new Error("Only audio files can be deleted");
    error.statusCode = 400;
    throw error;
  }

  const targetDir = kind === "live" ? config.liveMusicDir : config.playMusicDir;
  if (kind === "live") {
    const liveTracks = await listTracks(config.liveMusicDir, { urlPrefix: "/music/live" });
    if (liveTracks.length <= 1) {
      const error = new Error("At least one live music file must remain");
      error.statusCode = 409;
      throw error;
    }
  }
  const filePath = resolveInside(targetDir, file);
  await fs.promises.rm(filePath, { force: false });
  return { ok: true, kind, file };
}

function normalizeMusicKind(value) {
  const kind = String(value || "").trim().toLowerCase();
  if (kind === "live" || kind === "play") return kind;
  const error = new Error("Audio file kind must be live or play");
  error.statusCode = 400;
  throw error;
}

function isSupportedAudioExtension(extension) {
  return [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"].includes(String(extension || "").toLowerCase());
}

function sanitizeAudioFileName(fileName, fallbackExtension) {
  const originalBase = path.basename(String(fileName || ""));
  const extension = path.extname(originalBase).toLowerCase() || fallbackExtension || ".mp3";
  const rawName = path.basename(originalBase, path.extname(originalBase));
  const safeBase = rawName
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${safeBase || `audio-${Date.now()}`}${extension}`;
}

async function getAvailableMusicFileName(targetDir, fileName) {
  const extension = path.extname(fileName);
  const base = path.basename(fileName, extension);
  let candidate = fileName;
  for (let index = 2; index < 1000; index += 1) {
    try {
      await fs.promises.access(path.join(targetDir, candidate));
      candidate = `${base}-${index}${extension}`;
    } catch {
      return candidate;
    }
  }
  const error = new Error("Could not create unique file name");
  error.statusCode = 409;
  throw error;
}

async function streamMultipartFiles(request, targetDir, options = {}) {
  const contentType = request.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    const error = new Error("Multipart boundary is required");
    error.statusCode = 400;
    throw error;
  }
  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const boundaryMarker = Buffer.from(`\r\n--${boundaryMatch[1] || boundaryMatch[2]}`);
  const uploads = [];
  const tempPaths = [];
  let buffer = Buffer.alloc(0);
  let state = "boundary";
  let current = null;
  let totalBytes = 0;

  try {
    for await (const chunk of request) {
      totalBytes += chunk.length;
      if (totalBytes > (options.maxBytes || 50 * 1024 * 1024)) {
        const error = new Error("Request body is too large");
        error.statusCode = 413;
        throw error;
      }

      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (state === "boundary") {
          const boundaryIndex = buffer.indexOf(boundary);
          if (boundaryIndex === -1) {
            buffer = buffer.subarray(Math.max(0, buffer.length - boundary.length));
            break;
          }
          buffer = buffer.subarray(boundaryIndex + boundary.length);
          if (buffer.length < 2) break;
          if (buffer[0] === 45 && buffer[1] === 45) {
            state = "done";
            break;
          }
          if (buffer[0] === 13 && buffer[1] === 10) {
            buffer = buffer.subarray(2);
            state = "headers";
            continue;
          }
          break;
        }

        if (state === "headers") {
          const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"));
          if (headerEnd === -1) break;
          const headerText = buffer.subarray(0, headerEnd).toString("latin1");
          buffer = buffer.subarray(headerEnd + 4);
          current = await openMultipartUpload(targetDir, headerText);
          if (current?.tempPath) tempPaths.push(current.tempPath);
          state = "content";
          continue;
        }

        if (state === "content") {
          const boundaryIndex = buffer.indexOf(boundaryMarker);
          if (boundaryIndex === -1) {
            const safeLength = Math.max(0, buffer.length - boundaryMarker.length);
            if (!safeLength) break;
            await writeMultipartChunk(current, buffer.subarray(0, safeLength));
            buffer = buffer.subarray(safeLength);
            break;
          }

          await writeMultipartChunk(current, buffer.subarray(0, boundaryIndex));
          await closeMultipartUpload(current, uploads);
          current = null;
          buffer = buffer.subarray(boundaryIndex + 2);
          state = "boundary";
          continue;
        }

        break;
      }
    }

    if (state !== "done") {
      const error = new Error("Incomplete multipart body");
      error.statusCode = 400;
      throw error;
    }
    const files = uploads.filter((file) => file.fieldName === "files" || file.fieldName === "file");
    if (!files.length) {
      const error = new Error("Audio files are required");
      error.statusCode = 400;
      throw error;
    }
    return files;
  } catch (error) {
    if (current) await closeMultipartUpload(current, uploads).catch(() => {});
    await Promise.all(tempPaths.map((filePath) => fs.promises.rm(filePath, { force: true }).catch(() => {})));
    throw error;
  }
}

async function openMultipartUpload(targetDir, headerText) {
  const disposition = headerText.match(/content-disposition:[^\r\n]+/i)?.[0] || "";
  const dispositionParams = parseContentDispositionParams(disposition);
  const fieldName = dispositionParams.name || "";
  const filename = dispositionParams["filename*"] || dispositionParams.filename || "";
  if (fieldName !== "files" && fieldName !== "file") {
    return { fieldName, fileName: "", bytes: 0, skipReason: "Unsupported field" };
  }
  if (!filename) return { fieldName, fileName: "", bytes: 0, skipReason: "Missing file name" };

  const fileName = decodeMultipartFileName(filename, Boolean(dispositionParams["filename*"]));
  const extension = path.extname(fileName).toLowerCase();
  if (!isSupportedAudioExtension(extension)) {
    return { fieldName, fileName, extension, bytes: 0, skipReason: "Unsupported audio type" };
  }

  const tempPath = path.join(targetDir, `.upload-${crypto.randomUUID()}.tmp`);
  return {
    fieldName,
    fileName,
    extension,
    tempPath,
    handle: await fs.promises.open(tempPath, "wx"),
    bytes: 0,
  };
}

async function writeMultipartChunk(upload, chunk) {
  if (!upload || upload.skipReason || !chunk.length) return;
  await upload.handle.write(chunk);
  upload.bytes += chunk.length;
}

async function closeMultipartUpload(upload, uploads) {
  if (!upload) return;
  if (upload.handle) {
    await upload.handle.close();
    delete upload.handle;
  }
  uploads.push(upload);
}

async function probeAudioFile(filePath) {
  return new Promise((resolve) => {
    const probe = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    const timer = setTimeout(() => probe.kill("SIGKILL"), 5000);
    probe.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    probe.on("close", () => {
      clearTimeout(timer);
      const durationSeconds = Number.parseFloat(output);
      resolve({
        ok: Number.isFinite(durationSeconds) && durationSeconds > 0,
        durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0,
      });
    });
    probe.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, durationSeconds: 0 });
    });
  });
}

function parseContentDispositionParams(disposition) {
  const params = {};
  const parts = String(disposition || "").split(";");
  for (const part of parts.slice(1)) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim().toLowerCase();
    let value = part.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    params[key] = value;
  }
  return params;
}

function decodeMultipartFileName(value, encoded) {
  if (!encoded) return Buffer.from(value, "latin1").toString("utf8");
  const match = String(value).match(/^([^']*)'[^']*'(.*)$/);
  const charset = (match?.[1] || "utf-8").toLowerCase();
  const encodedName = match?.[2] || value;
  try {
    const decoded = decodeURIComponent(encodedName);
    return charset === "utf-8" || charset === "utf8"
      ? decoded
      : Buffer.from(decoded, "binary").toString("utf8");
  } catch {
    return Buffer.from(String(value), "latin1").toString("utf8");
  }
}

async function findPlayableTrack(config, file) {
  const requested = String(file || "").trim();
  if (!requested) {
    return { ok: false, error: "Track file is required" };
  }

  const tracks = await listTracks(config.playMusicDir, { urlPrefix: "/music/play" });
  const track = tracks.find((item) => item.file === requested);
  if (!track) {
    return { ok: false, error: "Track file is not available" };
  }

  return { ok: true, file: track.file };
}

function cleanArchivePart(value) {
  return String(value || "")
    .replace(/^\d+-/, "")
    .replace(/-/g, " ")
    .trim();
}

function labelKind(kind) {
  return {
    facts: "Факт",
    greeting: "Приветствие",
    farewell: "Прощание",
  }[kind] || kind;
}

async function addTrackDurations(tracks, musicDir, broadcast) {
  return Promise.all(tracks.map(async (track) => {
    try {
      const filePath = resolveInside(musicDir, track.file);
      const durationSeconds = await broadcast.probeDuration(filePath);
      return { ...track, durationSeconds };
    } catch {
      return { ...track, durationSeconds: 0 };
    }
  }));
}

module.exports = { createServer };
