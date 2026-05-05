const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { createAnnouncement, createFact, createFarewell, createGreeting, createListenerQuestion } = require("./ai/announcer");
const { pingDeepSeek } = require("./ai/deepseek");
const { pingElevenLabs } = require("./ai/elevenlabs");
const { readAdminConfig, writeAdminConfig } = require("./adminStore");
const { BroadcastStream } = require("./broadcast");
const { readAvailableFactLog, resetFactLog } = require("./factLog");
const { readJson, sendFile, sendJson } = require("./http");
const { acceptQuestion, getListenerStatus, readListenerStore, registerListener, resetListenerStore, setListenerName, updateQuestion } = require("./listenerStore");
const { getAudioType, listTracks, resolveInside } = require("./music");
const { readRecentSystemLogs, writeSystemLog } = require("./systemLog");

const publicFiles = new Set(["/", "/index.html", "/styles.css", "/script.js", "/admin.html", "/admin.js"]);
const staticTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
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
  broadcast.start();
  setTimeout(() => {
    recoverPendingListenerVoices(config, broadcast).catch((error) => {
      console.error(`Listener voice recovery failed: ${error.message}`);
    });
  }, 2000);

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);

      if (requiresAdmin(url.pathname) && !isAdminAuthorized(request, config)) {
        response.writeHead(401, {
          "WWW-Authenticate": 'Basic realm="AI Chill Radio Admin"',
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end("Admin auth required");
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

      if (request.method === "GET" && url.pathname === "/api/admin/config") {
        await sendJson(response, 200, await readAdminConfig(config));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/admin/fact-log") {
        await sendJson(response, 200, await readAvailableFactLog(config, { prune: true }));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/admin/archive") {
        await sendJson(response, 200, { items: await listArchiveItems(config) });
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

      if (request.method === "POST" && url.pathname === "/api/admin/music/insert") {
        const body = await readJson(request);
        const ok = broadcast.enqueueMusic(body.file);
        await writeSystemLog(config, ok ? "api_play_insert_ok" : "api_play_insert_error", {
          file: body.file || null,
          error: ok ? null : broadcast.lastMusicEnqueueError || "Track file is not available",
        });
        await sendJson(response, ok ? 200 : 400, {
          ok,
          file: body.file || null,
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
        await readAvailableFactLog(config, { prune: true });
        await sendJson(response, 200, { deleted: true, items: await listArchiveItems(config) });
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/admin/config") {
        const body = await readJson(request);
        await sendJson(response, 200, await writeAdminConfig(config, body));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/prompts/refresh") {
        const body = await readJson(request);
        const admin = await writeAdminConfig(config, body);
        await resetFactLog(config);
        await sendJson(response, 200, { admin, reset: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/archive/clear") {
        await resetGeneratedAudio(config);
        await emitAdmin(config, "archive", { items: await listArchiveItems(config) });
        await sendJson(response, 200, { cleared: true });
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
        if (result.ok) enqueueListenerQuestion(config, broadcast, result.question);
        await emitAdmin(config, "listeners", await readListenerStore(config));
        await sendJson(response, result.ok ? 200 : 403, result);
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

      if (request.method === "POST" && url.pathname === "/api/announcement") {
        const body = await readJson(request);
        const payload = await createAnnouncement(config, body);
        const event = { ...payload, title: "Подводка к треку", source: "admin" };
        broadcast.enqueueVoice(event);
        await emitRadio("voice", event);
        await sendJson(response, 200, payload);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/greeting") {
        const payload = await createGreeting(config);
        const event = { ...payload, title: "Приветствие", source: "admin" };
        broadcast.enqueueVoice(event);
        await emitRadio("voice", event);
        await sendJson(response, 200, payload);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/fact") {
        const body = await readJson(request);
        const payload = await createFact(config, body);
        const event = { ...payload, title: "Тема эфира", source: "admin" };
        broadcast.enqueueVoice(event);
        await emitRadio("voice", event);
        await sendJson(response, 200, payload);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/farewell") {
        const payload = await createFarewell(config);
        const event = { ...payload, title: "Прощание", source: "admin" };
        broadcast.enqueueVoice(event);
        await emitRadio("voice", event);
        await sendJson(response, 200, payload);
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
      if (!response.headersSent) {
        await sendJson(response, error.statusCode || 500, { error: error.message || "Server error" });
      } else {
        response.destroy();
      }
    }
  });
}

function enqueueListenerQuestion(config, broadcast, question) {
  const queueVersion = listenerQueueVersion;
  listenerQueue = listenerQueue.then(
    () => processListenerQuestion(config, broadcast, question, queueVersion),
    () => processListenerQuestion(config, broadcast, question, queueVersion),
  );
}

async function processListenerQuestion(config, broadcast, question, queueVersion) {
  try {
    if (queueVersion !== listenerQueueVersion) return null;
    await updateQuestion(config, question.id, { status: "generating" });
    await emitAdmin(config, "listeners", await readListenerStore(config));

    const payload = await createListenerQuestion(config, question);
    if (queueVersion !== listenerQueueVersion) return null;
    const updated = await updateQuestion(config, question.id, {
      status: "ready",
      text: payload.text,
      audioUrl: payload.audioUrl,
      archivePath: payload.archivePath,
    });
    await emitAdmin(config, "listeners", await readListenerStore(config));
    await emitAdmin(config, "archive", { items: await listArchiveItems(config) });

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
  return pathname === "/admin.html"
    || pathname === "/admin.js"
    || pathname === "/api/health/ai"
    || pathname.startsWith("/api/admin/")
    || pathname.startsWith("/archive/")
    || pathname.startsWith("/cache/announcements/")
    || pathname === "/api/announcement"
    || pathname === "/api/greeting"
    || pathname === "/api/fact"
    || pathname === "/api/farewell";
}

function isAdminAuthorized(request, config) {
  const header = request.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return constantTimeEqual(username, config.admin.username) && constantTimeEqual(password, config.admin.password);
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
