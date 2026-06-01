(() => {
const audio = document.querySelector("#audio");
const statusText = document.querySelector("#status");
const nowTitle = document.querySelector("#nowTitle");
const nowMeta = document.querySelector("#nowMeta");
const playButton = document.querySelector("#playButton");
const volume = document.querySelector("#volume");
const tracksEl = document.querySelector("#tracks");
const liveTracksEl = document.querySelector("#liveTracks");
const playTracksEl = document.querySelector("#playTracks");
const announcerText = document.querySelector("#announcerText");
const voiceStatus = document.querySelector("#voiceStatus");
const musicProgress = document.querySelector("#musicProgress");
const progressKind = document.querySelector("#progressKind");
const progressTitle = document.querySelector("#progressTitle");
const progressFill = document.querySelector("#progressFill");
const progressElapsed = document.querySelector("#progressElapsed");
const progressRemaining = document.querySelector("#progressRemaining");
const hostScene = document.querySelector("#hostScene");
const hostImage = document.querySelector("#hostImage");
const hostMood = document.querySelector("#hostMood");
const hostTrackTitle = document.querySelector("#hostTrackTitle");
const stopBroadcastButton = document.querySelector("#stopBroadcastButton");
const themeToggle = document.querySelector("#themeToggle");
const isAdminPage = Boolean(document.querySelector(".admin-app"));
const isPublicPage = Boolean(document.querySelector(".public-app"));

const storage = {
  volume: "ai-radio.liveVolume",
  theme: "ai-radio.theme",
};

let streamStarted = false;
let statusTimer = 0;
let stalledTimer = 0;
let reconnecting = false;
let latestStreamState = {};
let latestStateReceivedAt = 0;
let lastHostTrackKey = "";
let hostTransitionTimer = 0;

const hostTalkFrames = [
  "/assets/host-mouth-closed.webp",
  "/assets/host-talk-loop-01.webp",
  "/assets/host-talk-loop-02.webp",
  "/assets/host-talk-loop-03.webp",
  "/assets/host-talk-loop-04.webp",
  "/assets/host-talk-loop-05.webp",
  "/assets/host-talk-loop-06.webp",
  "/assets/host-talk-loop-07.webp",
  "/assets/host-talk-loop-08.webp",
  "/assets/host-talk-loop-09.webp",
  "/assets/host-talk-loop-10.webp",
  "/assets/host-talk-loop-11.webp",
  "/assets/host-talk-loop-12.webp",
];
const hostClosedFrame = hostTalkFrames[0];
const hostTalkLoops = hostTalkFrames.slice(1);
let hostIsTalking = false;

applySavedTheme();
if (isAdminPage) preloadHostFrames();

themeToggle?.addEventListener("click", () => {
  const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(nextTheme);
});

if (volume && audio) {
  volume.value = localStorage.getItem(storage.volume) || volume.value || "0.72";
  audio.volume = Number(volume.value);
  volume.addEventListener("input", () => {
    const next = Number(volume.value);
    localStorage.setItem(storage.volume, String(next));
    audio.volume = Number.isFinite(next) ? next : 0.72;
  });
}

playButton?.addEventListener("click", async () => {
  if (!audio) return;

  if (audio.paused) {
    await startLiveStream();
  } else {
    audio.pause();
    setStatus("Пауза эфира");
  }
});

audio?.addEventListener("play", () => {
  if (playButton) playButton.textContent = "⏸";
  window.clearTimeout(stalledTimer);
  setStatus("Live-поток в эфире");
});

["playing", "canplay", "progress", "timeupdate"].forEach((eventName) => {
  audio?.addEventListener(eventName, () => {
    window.clearTimeout(stalledTimer);
  });
});

audio?.addEventListener("pause", () => {
  if (playButton) playButton.textContent = "▶";
});

audio?.addEventListener("waiting", () => {
  setStatus("Буферизация live-потока");
});

audio?.addEventListener("stalled", () => {
  window.clearTimeout(stalledTimer);
  if (!streamStarted || audio.paused) return;
  setStatus("Буферизация live-потока");
  stalledTimer = window.setTimeout(() => {
    if (!streamStarted || audio.paused || audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
    setStatus("Поток не отвечает, переподключаюсь");
    reconnectLiveStream();
  }, 6000);
});

audio?.addEventListener("error", () => {
  if (latestStreamState.mode === "stopped") {
    stopLocalPlayback("Эфир остановлен");
    return;
  }
  setStatus("Ошибка потока, переподключаюсь");
  if (streamStarted) {
    window.setTimeout(reconnectLiveStream, 1200);
  }
});

audio?.addEventListener("ended", () => {
  if (latestStreamState.mode === "stopped") {
    stopLocalPlayback("Эфир остановлен");
    return;
  }
  setStatus("Live-поток завершился, переподключаюсь");
  if (streamStarted) {
    window.setTimeout(reconnectLiveStream, 600);
  }
});

if (isAdminPage) loadTracks();
loadRadioState();
if (isAdminPage) connectRadioStateEvents();
window.setInterval(loadRadioState, isPublicPage ? 15_000 : 5_000);
window.setInterval(() => {
  if (document.hidden && isPublicPage) return;
  renderMusicProgress();
}, isPublicPage ? 2_000 : 1_000);

window.addEventListener("broadcast-power-changed", (event) => {
  const isStopped = Boolean(event.detail?.stopped);
  latestStreamState.mode = isStopped ? "stopped" : "restarting";
  updateBroadcastPowerButton(latestStreamState.mode);
  if (isStopped) {
    stopLocalPlayback("Эфир остановлен");
  } else {
    setStatus("Эфир восстанавливается");
    loadRadioState();
  }
});

async function startLiveStream() {
  if (latestStreamState.mode === "stopped") {
    stopLocalPlayback("Эфир остановлен. Восстановите эфир в ЛК админа.");
    return;
  }
  streamStarted = true;
  ensureStreamSource();
  setStatus("Подключаюсь к live-потоку");
  try {
    await audio.play();
  } catch {
    setStatus("Нажмите Play, чтобы браузер разрешил звук");
  }
}

async function reconnectLiveStream() {
  if (!audio || reconnecting) return;
  reconnecting = true;
  const shouldPlay = streamStarted && !audio.paused;
  const volumeValue = audio.volume;

  try {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    audio.src = `/stream?t=${Date.now()}`;
    audio.volume = volumeValue;

    if (streamStarted || shouldPlay) {
      await audio.play().catch(() => setStatus("Нажмите Play для переподключения"));
    }
  } finally {
    reconnecting = false;
  }
}

function ensureStreamSource() {
  if (audio && !audio.getAttribute("src")) {
    audio.src = `/stream?t=${Date.now()}`;
  }
}

async function loadTracks() {
  if (!tracksEl && !liveTracksEl && !playTracksEl) return;

  try {
    const response = await fetch("/api/tracks", { cache: "no-store" });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    const liveTracks = payload.liveTracks || payload.tracks || [];
    const playTracks = payload.playTracks || [];

    if (tracksEl) renderTracks(tracksEl, liveTracks, { action: false, empty: "Папка music/live пока пустая" });
    if (liveTracksEl) renderTracks(liveTracksEl, liveTracks, { action: false, empty: "Папка music/live пока пустая" });
    if (playTracksEl) renderTracks(playTracksEl, playTracks, { action: true, empty: "Папка music/play пока пустая" });
  } catch (error) {
    renderTrackError(tracksEl || liveTracksEl || playTracksEl, error);
  }
}

function renderTrackError(target, error) {
  if (!target) return;
  target.innerHTML = "";
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = `Не удалось загрузить музыку: ${error.message}`;
  target.append(empty);
}

async function loadRadioState() {
  try {
    const response = await fetch("/api/radio/state", { cache: "no-store" });
    if (!response.ok) throw new Error(await response.text());
    const state = await response.json();
    renderRadioState(state.stream || {}, state.serverNow);
  } catch {
    setStatus(streamStarted ? "Проверяю доступность потока" : "Эфир ожидает Play");
  }
}

function renderRadioState(stream, serverNow = Date.now()) {
  latestStreamState = stream || {};
  latestStateReceivedAt = Date.now();
  latestStreamState.serverNow = Number(serverNow) || Date.now();
  const mode = stream.mode || "music";
  const title = stream.title || "Единый радиопоток";
  const queueLength = Number(stream.queueLength) || 0;
  const musicQueueLength = Number(stream.musicQueueLength) || 0;
  const listeners = Number(stream.listeners) || 0;

  updateBroadcastPowerButton(mode);
  if (mode === "stopped") {
    stopLocalPlayback("Эфир остановлен");
    if (nowTitle) nowTitle.textContent = "Эфир остановлен";
    if (nowMeta) nowMeta.textContent = "Поток отключен. Нажмите «Восстановить эфир», чтобы начать заново.";
    if (voiceStatus) voiceStatus.textContent = "Эфир остановлен администратором";
    renderQueuedTrackState();
    updateHostScene(stream, mode, "Эфир остановлен");
    renderMusicProgress();
    return;
  }

  if (nowTitle) nowTitle.textContent = title;
  if (nowMeta) {
    nowMeta.textContent = mode === "voice"
      ? "Диктор сейчас в эфире, музыка приглушена на сервере"
      : `Слушателей онлайн: ${listeners}. Очередь диктора: ${queueLength}. Play-вставок: ${musicQueueLength}`;
  }
  if (voiceStatus) {
    voiceStatus.textContent = mode === "voice"
      ? "Диктор говорит в общем потоке"
      : queueLength > 0
        ? `В очереди диктора: ${queueLength}`
        : "Очередь диктора пуста";
  }
  if (mode === "voice_prelude" || mode === "voice_ducking") {
    const countdown = formatCountdown(stream.voiceStartsInMs);
    if (nowMeta) nowMeta.textContent = `Live before voice. Voice starts in: ${countdown}`;
    if (voiceStatus) voiceStatus.textContent = `Live pause before voice: ${countdown}`;
  }
  if (announcerText && mode !== "voice") {
    announcerText.textContent = "Дикторские включения приходят в этот же live-поток. Отдельный голосовой плеер на странице не используется.";
  }
  renderQueuedTrackState();
  updateHostScene(stream, mode, title);
  renderMusicProgress();
}

function updateHostScene(stream, mode, title) {
  if (!hostScene) return;

  const isStopped = mode === "stopped";
  const isSpeaking = mode === "voice" && Math.max(0, Number(stream.voiceStartsInMs) || 0) <= 0;
  const isVoiceMode = isSpeaking || mode === "voice_prelude" || mode === "voice_ducking";
  const isOrderedMusic = mode === "play_music" || stream.currentPlay || stream.currentMusic?.kind === "play";
  const music = stream.currentMusic || stream.currentPlay || {};
  const trackTitle = music.title || title || "Live radio";
  const trackKey = `${music.kind || mode}:${music.file || trackTitle}`;
  const hasTrackChange = Boolean(lastHostTrackKey && trackKey && trackKey !== lastHostTrackKey && !isVoiceMode);

  hostScene.classList.toggle("is-speaking", isSpeaking);
  hostScene.classList.toggle("is-listening", !isVoiceMode);
  hostScene.classList.toggle("is-play-insert", Boolean(isOrderedMusic));
  hostScene.classList.toggle("is-voice-waiting", mode === "voice_prelude" || mode === "voice_ducking");
  setHostTalking(isSpeaking);

  if (hostMood) {
    hostMood.textContent = isStopped
      ? "OFF AIR"
      : isVoiceMode
      ? "ON AIR VOICE"
      : isOrderedMusic
        ? "PLAY INSERT"
        : "CHILL MODE";
  }
  if (hostTrackTitle) hostTrackTitle.textContent = trackTitle;

  if (hasTrackChange) {
    hostScene.classList.add("is-switching");
    window.clearTimeout(hostTransitionTimer);
    hostTransitionTimer = window.setTimeout(() => {
      hostScene.classList.remove("is-switching");
    }, 2400);
  }

  if (trackKey) lastHostTrackKey = trackKey;
}

function setHostTalking(isTalking) {
  if (!hostImage) return;
  if (isPublicPage) {
    hostIsTalking = false;
    hostImage.src = hostClosedFrame;
    return;
  }

  if (!isTalking) {
    if (!hostIsTalking) return;
    hostIsTalking = false;
    hostImage.src = hostClosedFrame;
    return;
  }

  if (hostIsTalking) return;
  hostIsTalking = true;
  const loop = hostTalkLoops[Math.floor(Math.random() * hostTalkLoops.length)] || hostTalkLoops[0];
  hostImage.src = loop;
}

function updateBroadcastPowerButton(mode) {
  if (!stopBroadcastButton) return;
  const isStopped = mode === "stopped";
  stopBroadcastButton.dataset.broadcastStopped = isStopped ? "true" : "false";
  stopBroadcastButton.textContent = isStopped ? "Восстановить эфир" : "Остановить эфир";
  stopBroadcastButton.classList.toggle("danger-button", !isStopped);
  stopBroadcastButton.classList.toggle("primary-action", isStopped);
}

function stopLocalPlayback(message) {
  streamStarted = false;
  window.clearTimeout(stalledTimer);
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  if (playButton) playButton.textContent = "▶";
  setStatus(message);
}

function preloadHostFrames() {
  for (const frame of hostTalkFrames) {
    const image = new Image();
    image.src = frame;
  }
}

function renderTracks(container, tracks, options = {}) {
  container.innerHTML = "";
  if (!tracks.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = options.empty || "Папка музыки пока пустая";
    container.append(empty);
    return;
  }

  tracks.forEach((track, index) => {
    const item = document.createElement("div");
    item.className = "track passive-track";
    item.dataset.file = track.file;
    item.innerHTML = isAdminPage && options.action
      ? `<span>${String(index + 1).padStart(2, "0")}</span><strong></strong><small></small><em class="track-queue-badge"></em><button class="track-action" type="button">Вставить в эфир</button>`
      : `<span>${String(index + 1).padStart(2, "0")}</span><strong></strong><small></small>`;
    item.querySelector("strong").textContent = track.title;
    item.querySelector("small").textContent = track.durationSeconds
      ? `${formatDuration(track.durationSeconds)} · ${track.file}`
      : track.file;
    item.querySelector(".track-action")?.addEventListener("click", () => insertTrack(track, item));
    container.append(item);
  });
  renderQueuedTrackState();
}

async function insertTrack(track, item) {
  const button = item.querySelector(".track-action");
  if (button) button.disabled = true;
  setStatus(`Ставлю Play-вставку: ${track.title}`);
  try {
    const response = await fetch("/api/admin/music/insert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: track.file }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Track insert failed");
    setStatus(`Play-вставка поставлена в очередь: ${track.title}`);
    await loadRadioState();
  } catch (error) {
    setStatus(`Не удалось поставить трек: ${error.message}`);
  } finally {
    if (button) button.disabled = false;
    renderQueuedTrackState();
  }
}

function renderQueuedTrackState() {
  if (!playTracksEl) return;
  const queued = Array.isArray(latestStreamState.musicQueue) ? latestStreamState.musicQueue : [];
  const current = latestStreamState.currentPlay || null;
  const positions = new Map();
  for (const [index, item] of queued.entries()) {
    if (!positions.has(item.file)) positions.set(item.file, index + 1);
  }

  playTracksEl.querySelectorAll(".track").forEach((row) => {
    const file = row.dataset.file || "";
    const position = positions.get(file) || 0;
    const isCurrent = current?.file === file;
    const isQueued = position > 0;
    row.classList.toggle("queued", isQueued);
    row.classList.toggle("on-air", isCurrent);
    row.classList.toggle("active", isQueued || isCurrent);

    const button = row.querySelector(".track-action");
    if (button) {
      button.disabled = isQueued || isCurrent;
      button.textContent = isCurrent ? "Играет" : isQueued ? "Уже в очереди" : "Вставить в эфир";
    }

    const badge = row.querySelector(".track-queue-badge");
    if (badge) {
      badge.textContent = isCurrent ? "играет сейчас" : isQueued ? `очередь #${position}` : "";
    }
  });
}

function connectRadioStateEvents() {
  if (!("EventSource" in window)) return;

  const events = new EventSource("/api/radio/events");
  events.addEventListener("voice", (event) => {
    const payload = JSON.parse(event.data);
    if (announcerText) announcerText.textContent = payload.text || "Диктор добавлен в эфир";
    if (voiceStatus) voiceStatus.textContent = payload.source === "listener"
      ? `Вопрос слушателя: ${payload.userName || "слушатель"}`
      : "Админское включение";
  });
  events.addEventListener("error", () => {
    window.clearTimeout(statusTimer);
    statusTimer = window.setTimeout(loadRadioState, 1000);
  });
}

function setStatus(text) {
  if (statusText) statusText.textContent = text;
}

function renderMusicProgress() {
  if (!musicProgress) return;

  const mode = latestStreamState.mode || "music";
  const music = latestStreamState.currentMusic || null;
  const isVoiceMode = mode === "voice" || mode === "voice_prelude" || mode === "voice_ducking";
  const isStopped = mode === "stopped";

  if (isStopped || !music || !music.durationSeconds) {
    musicProgress.classList.add("is-empty");
    musicProgress.classList.toggle("is-voice", isVoiceMode);
    if (isStopped) {
      if (progressKind) progressKind.textContent = "Эфир";
      if (progressTitle) progressTitle.textContent = "Остановлен";
      if (progressFill) progressFill.style.width = "0%";
      if (progressElapsed) progressElapsed.textContent = "0:00";
      if (progressRemaining) progressRemaining.textContent = "-0:00";
      return;
    }
    if (progressKind) progressKind.textContent = isVoiceMode ? "Диктор" : "Музыка";
    if (progressTitle) progressTitle.textContent = isVoiceMode ? "Live-подложка готовится" : "Ожидаем данные трека";
    if (progressFill) progressFill.style.width = "0%";
    if (progressElapsed) progressElapsed.textContent = "0:00";
    if (progressRemaining) progressRemaining.textContent = "-0:00";
    return;
  }

  const elapsedSinceState = latestStateReceivedAt ? Math.max(0, (Date.now() - latestStateReceivedAt) / 1000) : 0;
  const duration = Math.max(0, Number(music.durationSeconds) || 0);
  const position = Math.min(duration, Math.max(0, (Number(music.positionSeconds) || 0) + elapsedSinceState));
  const progress = duration > 0 ? Math.min(1, position / duration) : 0;
  const kind = music.kind === "play" ? "Play-вставка" : isVoiceMode ? "Live под диктором" : "Live-трек";

  musicProgress.classList.remove("is-empty");
  musicProgress.classList.toggle("is-voice", isVoiceMode);
  if (progressKind) progressKind.textContent = kind;
  if (progressTitle) progressTitle.textContent = music.title || "Музыка";
  if (progressFill) progressFill.style.width = `${Math.round(progress * 1000) / 10}%`;
  if (progressElapsed) progressElapsed.textContent = formatDuration(position);
  if (progressRemaining) progressRemaining.textContent = `-${formatDuration(Math.max(0, duration - position))}`;
}

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatDuration(value) {
  const totalSeconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function applySavedTheme() {
  const saved = localStorage.getItem(storage.theme);
  const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
  applyTheme(saved === "dark" || saved === "light" ? saved : systemDark ? "dark" : "light", false);
}

function applyTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  if (persist) localStorage.setItem(storage.theme, theme);
  if (!themeToggle) return;

  const isDark = theme === "dark";
  themeToggle.textContent = isDark ? "☀" : "☾";
  themeToggle.setAttribute("aria-label", isDark ? "Включить светлую тему" : "Включить темную тему");
  themeToggle.title = isDark ? "Светлая тема" : "Темная тема";
}
})();
