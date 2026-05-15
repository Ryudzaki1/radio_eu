const statusEl = document.querySelector("#adminStatus");
const stationNameInput = document.querySelector("#stationNameInput");
const commonPrompt = document.querySelector("#commonPrompt");
const activeHostSelect = document.querySelector("#activeHostSelect");
const hostNameInput = document.querySelector("#hostNameInput");
const greetingPrompt = document.querySelector("#greetingPrompt");
const factPrompt = document.querySelector("#factPrompt");
const listenerPrompt = document.querySelector("#listenerPrompt");
const farewellPrompt = document.querySelector("#farewellPrompt");
const saveButton = document.querySelector("#saveButton");
const voiceMusicLockButton = document.querySelector("#voiceMusicLockButton");
const voiceMusicLockStatus = document.querySelector("#voiceMusicLockStatus");
const voiceHostSelect = document.querySelector("#voiceHostSelect");
const refreshPromptsButton = document.querySelector("#refreshPromptsButton");
const testGreetingButton = document.querySelector("#testGreetingButton");
const testFactButton = document.querySelector("#testFactButton");
const testPaymentFlowButton = document.querySelector("#testPaymentFlowButton");
const adminAudio = document.querySelector("#adminAudio");
const testOutput = document.querySelector("#testOutput");
const topicList = document.querySelector("#topicList");
const topicNameInput = document.querySelector("#topicNameInput");
const subtopicList = document.querySelector("#subtopicList");
const addTopicButton = document.querySelector("#addTopicButton");
const addSubtopicButton = document.querySelector("#addSubtopicButton");
const deleteTopicButton = document.querySelector("#deleteTopicButton");
const saveTopicsButton = document.querySelector("#saveTopicsButton");
const startTopicCycleButton = document.querySelector("#startTopicCycleButton");
const stopTopicCycleButton = document.querySelector("#stopTopicCycleButton");
const topicCycleStatus = document.querySelector("#topicCycleStatus");
const topicCycleMinInput = document.querySelector("#topicCycleMinInput");
const topicCycleMaxInput = document.querySelector("#topicCycleMaxInput");
const topicCycleModeSelectedOnce = document.querySelector("#topicCycleModeSelectedOnce");
const topicCycleModeAllLoop = document.querySelector("#topicCycleModeAllLoop");
const topicCycleOrderTopicFirst = document.querySelector("#topicCycleOrderTopicFirst");
const topicCycleOrderSubtopicFirst = document.querySelector("#topicCycleOrderSubtopicFirst");
const archiveList = document.querySelector("#archiveList");
const audioLiveList = document.querySelector("#audioLiveList");
const audioPlayList = document.querySelector("#audioPlayList");
const liveUploadInput = document.querySelector("#liveUploadInput");
const playUploadInput = document.querySelector("#playUploadInput");
const airHistory = document.querySelector("#airHistory");
const stopBroadcastButton = document.querySelector("#stopBroadcastButton");
const refreshArchiveButton = document.querySelector("#refreshArchiveButton");
const clearArchiveButton = document.querySelector("#clearArchiveButton");
const refreshListenersButton = document.querySelector("#refreshListenersButton");
const resetListenersButton = document.querySelector("#resetListenersButton");
const listenerList = document.querySelector("#listenerList");
const queueGreetingButton = document.querySelector("#queueGreetingButton");
const queueFactButton = document.querySelector("#queueFactButton");
const queueFarewellButton = document.querySelector("#queueFarewellButton");
const queueSelectedTopicButton = document.querySelector("#queueSelectedTopicButton");

const voiceInputs = {
  model: document.querySelector("#voiceModel"),
  stability: document.querySelector("#stability"),
  similarityBoost: document.querySelector("#similarityBoost"),
  style: document.querySelector("#style"),
  speed: document.querySelector("#speed"),
  speakerBoost: document.querySelector("#speakerBoost"),
};

const audioMixInputs = {
  musicLevel: document.querySelector("#musicLevel"),
  voiceLevel: document.querySelector("#voiceLevel"),
  duckingRatio: document.querySelector("#duckingRatio"),
  preludeSeconds: document.querySelector("#voicePreludeSeconds"),
  duckFadeSeconds: document.querySelector("#duckFadeSeconds"),
  restoreFadeSeconds: document.querySelector("#restoreFadeSeconds"),
  postludeSeconds: document.querySelector("#voicePostludeSeconds"),
};

const sliderValueInputs = {
  stability: document.querySelector("#stabilityValue"),
  similarityBoost: document.querySelector("#similarityBoostValue"),
  style: document.querySelector("#styleValue"),
  speed: document.querySelector("#speedValue"),
  musicLevel: document.querySelector("#musicLevelValue"),
  voiceLevel: document.querySelector("#voiceLevelValue"),
  duckingRatio: document.querySelector("#duckingRatioValue"),
};

let currentConfig = null;
let factLog = { facts: [] };
let archiveItems = [];
let audioFiles = { liveTracks: [], playTracks: [], voiceArchive: [], counts: {} };
let listenerStore = { users: [], questions: [] };
let topicCycle = { active: false };
let selectedTopicIndex = 0;
let adminVoiceQueue = Promise.resolve();
let voiceMusicUnlocked = false;
let voiceMusicSnapshot = "";
let adminLogQueue = Promise.resolve();

const adminUiStorage = {
  tab: "ai-radio.adminTab",
  topicIndex: "ai-radio.adminTopicIndex",
};

document.querySelectorAll(".admin-tab").forEach((button) => {
  button.addEventListener("click", () => activateTab(button.dataset.tab, { persist: true }));
});

saveButton?.addEventListener("click", saveVoiceMusicSettings);
voiceMusicLockButton?.addEventListener("click", toggleVoiceMusicLock);
refreshPromptsButton?.addEventListener("click", refreshPrompts);
refreshArchiveButton?.addEventListener("click", refreshArchive);
clearArchiveButton?.addEventListener("click", clearArchive);
liveUploadInput?.addEventListener("change", () => uploadAudioFiles("live", liveUploadInput));
playUploadInput?.addEventListener("change", () => uploadAudioFiles("play", playUploadInput));
refreshListenersButton?.addEventListener("click", refreshListeners);
resetListenersButton?.addEventListener("click", resetListeners);
stopBroadcastButton?.addEventListener("click", toggleBroadcastPower);
queueGreetingButton?.addEventListener("click", () => enqueueBroadcastAction("/api/greeting", queueGreetingButton, "Приветствие"));
queueFactButton?.addEventListener("click", () => enqueueBroadcastAction("/api/fact", queueFactButton, "Следующая тема"));
queueFarewellButton?.addEventListener("click", () => enqueueBroadcastAction("/api/farewell", queueFarewellButton, "Прощание"));
queueSelectedTopicButton?.addEventListener("click", queueSelectedTopic);
startTopicCycleButton?.addEventListener("click", startTopicCycle);
stopTopicCycleButton?.addEventListener("click", stopTopicCycle);
testGreetingButton?.addEventListener("click", () => enqueueAdminVoiceTest("/api/greeting"));
testFactButton?.addEventListener("click", () => enqueueAdminVoiceTest("/api/fact"));
testPaymentFlowButton?.addEventListener("click", testPaymentFlow);
addTopicButton?.addEventListener("click", addTopic);
addSubtopicButton?.addEventListener("click", addSubtopic);
deleteTopicButton?.addEventListener("click", deleteSelectedTopic);
saveTopicsButton?.addEventListener("click", saveTopics);
initHelpTips();
initSyncedSliders();
initAdminActionLogging();
activeHostSelect?.addEventListener("change", () => {
  if (!currentConfig?.prompts) return;
  currentConfig.prompts.activeHostId = getActiveHostId();
  renderConfig(currentConfig);
});
voiceHostSelect?.addEventListener("change", () => {
  if (!currentConfig?.prompts) return;
  currentConfig.prompts.activeHostId = voiceHostSelect.value;
  if (activeHostSelect) activeHostSelect.value = voiceHostSelect.value;
});
topicNameInput?.addEventListener("input", () => {
  if (!currentConfig?.topics[selectedTopicIndex]) return;
  currentConfig.topics[selectedTopicIndex].name = topicNameInput.value;
  renderTopicList();
});

loadConfig();
activateTab(getInitialTab(), { persist: false });
window.setInterval(refreshTopicCycleStatus, 30_000);
window.setInterval(refreshAirHistory, 15_000);

function initHelpTips() {
  document.querySelectorAll(".help-tip[title]").forEach((tip) => {
    tip.dataset.tooltip = tip.getAttribute("title") || "";
    tip.setAttribute("tabindex", "0");
    tip.removeAttribute("title");
  });
}

function initSyncedSliders() {
  Object.entries(sliderValueInputs).forEach(([key, numberInput]) => {
    const rangeInput = getSliderInput(key);
    if (!rangeInput || !numberInput) return;

    rangeInput.addEventListener("input", () => {
      numberInput.value = formatSliderValue(rangeInput, rangeInput.value);
    });
    numberInput.addEventListener("input", () => {
      if (numberInput.value === "") return;
      rangeInput.value = formatSliderValue(rangeInput, numberInput.value);
    });
    numberInput.addEventListener("blur", () => setSyncedSliderValue(key, numberInput.value || rangeInput.value));
  });
}

function initAdminActionLogging() {
  document.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    logAdminAction("click", {
      target: target.id || target.textContent?.trim() || target.tagName,
      tab: getActiveTab(),
    });
  });
  document.addEventListener("change", (event) => {
    const target = event.target;
    if (!target?.matches?.("input, select, textarea")) return;
    logAdminAction("change", {
      target: target.id || target.name || target.tagName,
      value: summarizeInputValue(target),
      tab: getActiveTab(),
    });
  });
  window.addEventListener("error", (event) => {
    logAdminAction("js_error", {
      error: event.message,
      target: event.filename ? `${event.filename}:${event.lineno}` : null,
      tab: getActiveTab(),
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    logAdminAction("promise_error", {
      error: event.reason?.message || String(event.reason || "Unhandled promise rejection"),
      tab: getActiveTab(),
    });
  });
}

function logAdminAction(action, details = {}) {
  const payload = { action, ...details };
  adminLogQueue = adminLogQueue
    .catch(() => {})
    .then(() => fetch("/api/admin/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify(payload),
    }).catch(() => {}));
}

function getActiveTab() {
  return document.querySelector(".admin-tab.active")?.dataset.tab || null;
}

function summarizeInputValue(target) {
  if (target.type === "password") return "[hidden]";
  if (target.type === "checkbox" || target.type === "radio") return target.checked;
  return String(target.value || "").slice(0, 160);
}

function getSliderInput(key) {
  return voiceInputs[key] || audioMixInputs[key] || null;
}

function setSyncedSliderValue(key, value) {
  const rangeInput = getSliderInput(key);
  const numberInput = sliderValueInputs[key];
  if (!rangeInput) return;
  const formatted = formatSliderValue(rangeInput, value);
  rangeInput.value = formatted;
  if (numberInput) numberInput.value = formatted;
}

function getSyncedSliderNumber(key) {
  const rangeInput = getSliderInput(key);
  const numberInput = sliderValueInputs[key];
  const rawValue = numberInput?.value !== "" ? numberInput?.value : rangeInput?.value;
  const formatted = formatSliderValue(rangeInput, rawValue);
  if (numberInput && numberInput.value !== formatted) numberInput.value = formatted;
  if (rangeInput && rangeInput.value !== formatted) rangeInput.value = formatted;
  return Number(formatted);
}

function formatSliderValue(rangeInput, value) {
  if (!rangeInput) return "0";
  const min = Number(rangeInput.min);
  const max = Number(rangeInput.max);
  const step = rangeInput.step || "1";
  const fallback = Number(rangeInput.value) || min || 0;
  let number = Number(value);
  if (!Number.isFinite(number)) number = fallback;
  if (Number.isFinite(min)) number = Math.max(min, number);
  if (Number.isFinite(max)) number = Math.min(max, number);
  const decimals = step.includes(".") ? step.split(".")[1].length : 0;
  return number.toFixed(decimals);
}

async function loadConfig() {
  try {
    const [configResponse, logResponse, audioResponse, listenerResponse] = await Promise.all([
      fetch("/api/admin/config"),
      fetch("/api/admin/fact-log"),
      fetch("/api/admin/audio-files"),
      fetch("/api/admin/listeners"),
    ]);
    currentConfig = await configResponse.json();
    factLog = await logResponse.json();
    audioFiles = audioResponse.ok ? await audioResponse.json() : { liveTracks: [], playTracks: [], voiceArchive: [], counts: {} };
    archiveItems = audioFiles.voiceArchive || [];
    listenerStore = listenerResponse.ok ? await listenerResponse.json() : { users: [], questions: [] };
    renderConfig(currentConfig);
    renderAudioFiles();
    renderArchive();
    renderListeners();
    await refreshAirHistory();
    await refreshTopicCycleStatus();
    connectAdminEvents();
    setStatus("Настройки загружены");
  } catch (error) {
    setStatus(`Не удалось загрузить админку: ${error.message}`);
  }
}

function renderConfig(config) {
  stationNameInput.value = config.stationName;
  const host = getActiveHost(config);
  commonPrompt.value = config.prompts.common || "";
  renderHostSelect(config);
  renderVoiceHostSelect(config);
  hostNameInput.value = host.name || "";
  greetingPrompt.value = host.greeting || "";
  factPrompt.value = host.fact || "";
  listenerPrompt.value = host.listener || "";
  farewellPrompt.value = host.farewell || "";

  voiceInputs.model.value = config.voice.model || "eleven_multilingual_v2";
  setSyncedSliderValue("stability", config.voice.stability);
  setSyncedSliderValue("similarityBoost", config.voice.similarityBoost);
  setSyncedSliderValue("style", config.voice.style);
  setSyncedSliderValue("speed", config.voice.speed);
  voiceInputs.speakerBoost.checked = config.voice.speakerBoost;
  topicCycleMinInput.value = config.topicCycle?.minIntervalMinutes ?? 5;
  topicCycleMaxInput.value = config.topicCycle?.maxIntervalMinutes ?? 6;
  setTopicCycleOrder(config.topicCycle?.order || "topic-first");
  setSyncedSliderValue("musicLevel", config.audioMix?.musicLevel ?? 0.72);
  setSyncedSliderValue("voiceLevel", config.audioMix?.voiceLevel ?? 1);
  setSyncedSliderValue("duckingRatio", config.audioMix?.duckingRatio ?? 0.18);
  audioMixInputs.preludeSeconds.value = config.audioMix?.preludeSeconds ?? 0;
  audioMixInputs.duckFadeSeconds.value = config.audioMix?.duckFadeSeconds ?? 1.6;
  audioMixInputs.restoreFadeSeconds.value = config.audioMix?.restoreFadeSeconds ?? 1.4;
  audioMixInputs.postludeSeconds.value = config.audioMix?.postludeSeconds ?? 3;
  voiceMusicSnapshot = getVoiceMusicSnapshot();
  setVoiceMusicLock(true);

  const savedTopicIndex = Number(localStorage.getItem(adminUiStorage.topicIndex));
  const preferredTopicIndex = Number.isInteger(savedTopicIndex) ? savedTopicIndex : selectedTopicIndex;
  selectedTopicIndex = Math.max(0, Math.min(preferredTopicIndex, config.topics.length - 1));
  renderTopicList();
  renderTopicDetail();
}

function renderTopicList() {
  const voiced = getVoicedSets();
  topicList.innerHTML = "";
  currentConfig.topics.forEach((topic, index) => {
    const savedCount = topic.subtopics.filter((subtopic) => voiced.savedSubtopics.has(getPairKey(topic.name, subtopic))).length;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "topic-pill";
    button.classList.toggle("active", index === selectedTopicIndex);
    button.classList.toggle("partial", savedCount > 0 && savedCount < topic.subtopics.length);
    button.classList.toggle("complete", savedCount === topic.subtopics.length && topic.subtopics.length > 0);
    const number = document.createElement("span");
    number.className = "topic-number";
    number.textContent = String(index + 1).padStart(2, "0");

    const body = document.createElement("span");
    body.className = "topic-pill-body";

    const title = document.createElement("strong");
    title.textContent = topic.name || "Новая тема";

    const meta = document.createElement("small");
    meta.textContent = `${savedCount}/${topic.subtopics.length} mp3 сохранено`;

    body.append(title, meta);
    button.append(number, body);
    button.addEventListener("click", () => {
      selectedTopicIndex = index;
      localStorage.setItem(adminUiStorage.topicIndex, String(index));
      renderTopicList();
      renderTopicDetail();
    });
    topicList.append(button);
  });
}

function renderHostSelect(config) {
  if (!activeHostSelect) return;
  const hosts = config.prompts?.hosts || {};
  const activeHostId = config.prompts?.activeHostId || Object.keys(hosts)[0] || "sweetiefox";
  activeHostSelect.innerHTML = "";
  for (const [hostId, host] of Object.entries(hosts)) {
    const option = document.createElement("option");
    option.value = hostId;
    option.textContent = host.name || hostId;
    option.selected = hostId === activeHostId;
    activeHostSelect.append(option);
  }
}

function renderVoiceHostSelect(config) {
  if (!voiceHostSelect) return;
  const hosts = config.prompts?.hosts || {};
  const activeHostId = config.prompts?.activeHostId || Object.keys(hosts)[0] || "sweetiefox";
  voiceHostSelect.innerHTML = "";
  for (const [hostId, host] of Object.entries(hosts)) {
    const option = document.createElement("option");
    option.value = hostId;
    option.textContent = host.name || hostId;
    option.selected = hostId === activeHostId;
    voiceHostSelect.append(option);
  }
}

function getActiveHost(config = currentConfig) {
  const hosts = config?.prompts?.hosts || {};
  const hostId = config?.prompts?.activeHostId || Object.keys(hosts)[0] || "sweetiefox";
  return hosts[hostId] || hosts.sweetiefox || {};
}

function getActiveHostId() {
  return currentConfig?.prompts?.activeHostId || activeHostSelect?.value || "sweetiefox";
}

function renderTopicDetail() {
  const topic = currentConfig.topics[selectedTopicIndex];
  if (!topic) return;

  const voiced = getVoicedSets();
  topicNameInput.value = topic.name;
  subtopicList.innerHTML = "";

  topic.subtopics.forEach((subtopic, index) => {
    const key = getPairKey(topic.name, subtopic);
    const saved = voiced.savedSubtopics.has(key);
    const item = document.createElement("div");
    item.className = "subtopic-chip";
    item.classList.toggle("voiced", voiced.subtopics.has(key));
    item.classList.toggle("saved", saved);

    const number = document.createElement("span");
    number.className = "subtopic-number";
    number.textContent = String(index + 1).padStart(2, "0");

    const input = document.createElement("textarea");
    input.rows = getSubtopicTextareaRows(subtopic);
    input.value = subtopic;
    input.addEventListener("input", () => {
      topic.subtopics[index] = input.value;
      input.rows = getSubtopicTextareaRows(input.value);
    });

    const state = document.createElement("span");
    state.className = "subtopic-state";
    state.textContent = saved ? "mp3" : "новая";
    state.title = saved ? "Аудио уже сохранено. Повторный запуск возьмет архив без токенов." : "Аудио еще нет. Первый запуск создаст текст и голос.";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Удалить подтему");
    remove.addEventListener("click", () => {
      topic.subtopics.splice(index, 1);
      renderTopicDetail();
      renderTopicList();
    });

    item.append(number, input, state, remove);
    subtopicList.append(item);
  });
}

function getSubtopicTextareaRows(value) {
  const length = String(value || "").length;
  return Math.min(6, Math.max(2, Math.ceil(length / 90)));
}

function renderArchive() {
  if (!archiveList) return;
  archiveList.innerHTML = "";

  if (!archiveItems.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Аудио ведущего пока нет. Новые mp3 появятся после генерации приветствий, тем, прощаний или вопросов.";
    archiveList.append(empty);
    return;
  }

  archiveItems.forEach((item) => {
    const row = document.createElement("article");
    row.className = "archive-item";
    row.innerHTML = `
      <div class="archive-meta">
        <strong></strong>
        <span></span>
      </div>
      <audio controls preload="none"></audio>
    `;
    row.querySelector("strong").textContent = item.title;
    row.querySelector("span").textContent = `${item.date || "без даты"} · ${item.fileName}`;
    row.querySelector("audio").src = item.audioUrl;
    archiveList.append(row);
  });
}

function renderAudioFiles() {
  renderMusicFileList(
    audioLiveList,
    audioFiles.liveTracks || [],
    "live",
    "Музыка эфира пока не загружена. Добавь mp3, wav, m4a, aac, ogg или flac.",
  );
  renderMusicFileList(
    audioPlayList,
    audioFiles.playTracks || [],
    "play",
    "Музыка для ручных Play-вставок пока не загружена.",
  );
}

function renderMusicFileList(container, tracks, kind, emptyText) {
  if (!container) return;
  container.innerHTML = "";

  if (!tracks.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = emptyText;
    container.append(empty);
    return;
  }

  tracks.forEach((track, index) => {
    const row = document.createElement("article");
    row.className = "audio-file-row";
    row.innerHTML = `
      <span class="audio-file-number"></span>
      <div class="archive-meta">
        <strong></strong>
        <span></span>
      </div>
      <audio controls preload="none"></audio>
      <button class="danger-button" type="button">Удалить</button>
    `;
    row.querySelector(".audio-file-number").textContent = String(index + 1).padStart(2, "0");
    row.querySelector("strong").textContent = track.title || track.file;
    row.querySelector(".archive-meta span").textContent = [
      track.file,
      track.durationSeconds ? formatDuration(track.durationSeconds) : "",
    ].filter(Boolean).join(" · ");
    row.querySelector("audio").src = track.url;
    row.querySelector("button").addEventListener("click", () => deleteMusicFile(kind, track));
    container.append(row);
  });
}

function addTopic() {
  currentConfig.topics.push({
    name: "Новая тема",
    subtopics: ["первая подтема"],
  });
  selectedTopicIndex = currentConfig.topics.length - 1;
  localStorage.setItem(adminUiStorage.topicIndex, String(selectedTopicIndex));
  renderTopicList();
  renderTopicDetail();
  setStatus("Новая тема добавлена. Нажмите «Сохранить темы», чтобы применить изменения.");
}

function addSubtopic() {
  const topic = currentConfig.topics[selectedTopicIndex];
  if (!topic) return;
  topic.subtopics.push("новая подтема");
  renderTopicDetail();
  renderTopicList();
  setStatus("Подтема добавлена. Нажмите «Сохранить темы», чтобы применить изменения.");
}

function deleteSelectedTopic() {
  if (currentConfig.topics.length <= 1) {
    setStatus("Нужна хотя бы одна тема");
    return;
  }

  const topic = currentConfig.topics[selectedTopicIndex];
  const confirmed = window.confirm(`Удалить выбранную тему из редактора?\n\n${topic?.name || "Без названия"}\n\nИзменение попадет на сервер после кнопки «Сохранить изменения тем».`);
  if (!confirmed) return;

  currentConfig.topics.splice(selectedTopicIndex, 1);
  selectedTopicIndex = Math.max(0, selectedTopicIndex - 1);
  localStorage.setItem(adminUiStorage.topicIndex, String(selectedTopicIndex));
  renderTopicList();
  renderTopicDetail();
  setStatus("Тема удалена из редактора. Нажмите «Сохранить темы», чтобы применить изменения.");
}

async function saveConfig() {
  setStatus("Сохраняю настройки");
  const response = await fetch("/api/admin/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(collectConfig()),
  });
  currentConfig = await response.json();
  renderConfig(currentConfig);
  setStatus(response.ok ? "Настройки сохранены" : "Ошибка сохранения");
  return { ok: response.ok, config: currentConfig };
}

async function saveTopics() {
  if (!currentConfig?.topics?.length) return;
  saveTopicsButton.disabled = true;
  setStatus("Сохраняю темы и подтемы");
  try {
    const result = await saveConfig();
    if (!result.ok) {
      setStatus(currentConfig?.error || "Не удалось сохранить темы");
      return;
    }
    await refreshFactLog();
    setStatus("Темы и подтемы сохранены");
  } catch (error) {
    setStatus(`Темы: ошибка сохранения - ${error.message}`);
  } finally {
    saveTopicsButton.disabled = false;
  }
}

async function saveVoiceMusicSettings() {
  if (!voiceMusicUnlocked) {
    setStatus("Сначала разблокируйте параметры Голос/Музыка");
    return;
  }

  const nextSnapshot = getVoiceMusicSnapshot();
  if (nextSnapshot !== voiceMusicSnapshot) {
    const confirmed = window.confirm("Применить изменения параметров голоса и музыки? Они сразу попадут в серверный конфиг и будут использованы для следующих выходов ведущего в эфир.");
    if (!confirmed) {
      restoreVoiceMusicFieldsFromSnapshot();
      setVoiceMusicLock(true);
      setStatus("Изменения не сохранены, показаны реальные параметры");
      return;
    }
  }

  await saveConfig();
  voiceMusicSnapshot = getVoiceMusicSnapshot();
  setVoiceMusicLock(true);
  setStatus("Параметры применены. Следующая речь ведущего возьмет новый голос и микс.");
}

function toggleVoiceMusicLock() {
  if (voiceMusicUnlocked) {
    if (getVoiceMusicSnapshot() !== voiceMusicSnapshot) {
      restoreVoiceMusicFieldsFromSnapshot();
      setStatus("Изменения не сохранены, показаны реальные параметры");
    }
    setVoiceMusicLock(true);
    return;
  }

  setVoiceMusicLock(false);
}

function setVoiceMusicLock(locked) {
  voiceMusicUnlocked = !locked;
  const fields = [
    voiceHostSelect,
    ...Object.values(voiceInputs),
    ...Object.values(audioMixInputs),
    ...Object.values(sliderValueInputs),
  ].filter(Boolean);
  fields.forEach((field) => {
    field.disabled = locked;
  });
  if (saveButton) saveButton.disabled = locked;
  if (voiceMusicLockButton) {
    voiceMusicLockButton.textContent = locked ? "🔒 Заблокировано" : "🔓 Разблокировано";
  }
  if (voiceMusicLockStatus) {
    voiceMusicLockStatus.textContent = locked
      ? "Параметры защищены от случайного изменения"
      : "Редактирование включено";
  }
}

function restoreVoiceMusicFieldsFromSnapshot() {
  if (!voiceMusicSnapshot) return;
  let snapshot;
  try {
    snapshot = JSON.parse(voiceMusicSnapshot);
  } catch {
    return;
  }

  if (currentConfig?.prompts) currentConfig.prompts.activeHostId = snapshot.activeHostId;
  if (voiceHostSelect) voiceHostSelect.value = snapshot.activeHostId;
  if (activeHostSelect) activeHostSelect.value = snapshot.activeHostId;
  if (voiceInputs.model) voiceInputs.model.value = snapshot.voice.model;
  setSyncedSliderValue("stability", snapshot.voice.stability);
  setSyncedSliderValue("similarityBoost", snapshot.voice.similarityBoost);
  setSyncedSliderValue("style", snapshot.voice.style);
  setSyncedSliderValue("speed", snapshot.voice.speed);
  voiceInputs.speakerBoost.checked = snapshot.voice.speakerBoost;
  setSyncedSliderValue("musicLevel", snapshot.audioMix.musicLevel);
  setSyncedSliderValue("voiceLevel", snapshot.audioMix.voiceLevel);
  setSyncedSliderValue("duckingRatio", snapshot.audioMix.duckingRatio);
  audioMixInputs.preludeSeconds.value = snapshot.audioMix.preludeSeconds;
  audioMixInputs.duckFadeSeconds.value = snapshot.audioMix.duckFadeSeconds;
  audioMixInputs.restoreFadeSeconds.value = snapshot.audioMix.restoreFadeSeconds;
  audioMixInputs.postludeSeconds.value = snapshot.audioMix.postludeSeconds;
}

function getVoiceMusicSnapshot() {
  if (!currentConfig) return "";
  return JSON.stringify({
    activeHostId: getActiveHostId(),
    voice: {
      model: voiceInputs.model?.value || "eleven_multilingual_v2",
      stability: getSyncedSliderNumber("stability"),
      similarityBoost: getSyncedSliderNumber("similarityBoost"),
      style: getSyncedSliderNumber("style"),
      speed: getSyncedSliderNumber("speed"),
      speakerBoost: voiceInputs.speakerBoost.checked,
    },
    audioMix: {
      musicLevel: getSyncedSliderNumber("musicLevel"),
      voiceLevel: getSyncedSliderNumber("voiceLevel"),
      duckingRatio: getSyncedSliderNumber("duckingRatio"),
      preludeSeconds: Number(audioMixInputs.preludeSeconds.value),
      duckFadeSeconds: Number(audioMixInputs.duckFadeSeconds.value),
      restoreFadeSeconds: Number(audioMixInputs.restoreFadeSeconds.value),
      postludeSeconds: Number(audioMixInputs.postludeSeconds.value),
    },
  });
}

async function refreshPrompts() {
  const confirmed = window.confirm("Обновить промпты ведущего и общий промпт? Сохраненные mp3 останутся в архиве. Новые правила применятся к следующим генерациям, а уже сохраненные подтемы будут воспроизводиться из архива, пока ты их не удалишь.");
  if (!confirmed) return;

  refreshPromptsButton.disabled = true;
  setStatus("Обновляю промпты");

  try {
    const response = await fetch("/api/admin/prompts/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectConfig()),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Prompt refresh failed");

    currentConfig = payload.admin;
    renderConfig(currentConfig);
    await Promise.all([refreshFactLog(), refreshArchive()]);
    setStatus("Промпты обновлены. Архив и отметки сохраненных mp3 не удалены.");
  } catch (error) {
    setStatus(`Не удалось обновить промпты: ${error.message}`);
  } finally {
    refreshPromptsButton.disabled = false;
  }
}

function collectConfig() {
  return {
    stationName: stationNameInput.value,
    topics: currentConfig.topics.map((topic) => ({
      name: topic.name.trim(),
      subtopics: topic.subtopics.map((item) => item.trim()).filter(Boolean),
    })).filter((topic) => topic.name && topic.subtopics.length),
    prompts: {
      ...currentConfig.prompts,
      common: commonPrompt.value,
      activeHostId: getActiveHostId(),
      hosts: {
        ...(currentConfig.prompts?.hosts || {}),
        [getActiveHostId()]: {
          ...getActiveHost(currentConfig),
          name: hostNameInput.value,
          greeting: greetingPrompt.value,
          fact: factPrompt.value,
          listener: listenerPrompt.value,
          farewell: farewellPrompt.value,
        },
      },
    },
    voice: {
      model: voiceInputs.model?.value || "eleven_multilingual_v2",
      stability: getSyncedSliderNumber("stability"),
      similarityBoost: getSyncedSliderNumber("similarityBoost"),
      style: getSyncedSliderNumber("style"),
      speed: getSyncedSliderNumber("speed"),
      speakerBoost: voiceInputs.speakerBoost.checked,
    },
    factPolicy: currentConfig.factPolicy,
    topicCycle: {
      minIntervalMinutes: Number(topicCycleMinInput.value) || 5,
      maxIntervalMinutes: Number(topicCycleMaxInput.value) || 6,
      order: getTopicCycleOrder(),
    },
    audioMix: {
      musicLevel: getSyncedSliderNumber("musicLevel"),
      voiceLevel: getSyncedSliderNumber("voiceLevel"),
      duckingRatio: getSyncedSliderNumber("duckingRatio"),
      preludeSeconds: Number(audioMixInputs.preludeSeconds.value),
      duckFadeSeconds: Number(audioMixInputs.duckFadeSeconds.value),
      restoreFadeSeconds: Number(audioMixInputs.restoreFadeSeconds.value),
      postludeSeconds: Number(audioMixInputs.postludeSeconds.value),
    },
  };
}

async function enqueueBroadcastAction(url, button, label, body = undefined) {
  if (button) button.disabled = true;
  setStatus(`${label}: готовлю и ставлю в очередь эфира`);

  try {
    await saveConfig();
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Не удалось поставить в эфир");

    renderBroadcastResult(label, payload);
    await Promise.all([refreshFactLog(), refreshArchive()]);
    setStatus(`${label}: добавлено в очередь диктора`);
  } catch (error) {
    setStatus(`${label}: ошибка - ${error.message}`);
  } finally {
    if (button) button.disabled = false;
  }
}

function queueSelectedTopic() {
  const topic = currentConfig?.topics?.[selectedTopicIndex];
  if (!topic) {
    setStatus("Выберите тему");
    return;
  }

  const voiced = getVoicedSets();
  const subtopic = topic.subtopics.find((item) => !voiced.subtopics.has(getPairKey(topic.name, item)))
    || topic.subtopics[0];

  if (!subtopic) {
    setStatus("У выбранной темы нет подтем");
    return;
  }

  const saved = voiced.savedSubtopics.has(getPairKey(topic.name, subtopic));
  const confirmed = window.confirm(`Поставить в эфир подтему?\n\nТема: ${topic.name}\nПодтема: ${subtopic}\n\n${saved ? "mp3 уже сохранен, токены не тратятся." : "mp3 еще нет, при генерации будут потрачены токены."}`);
  if (!confirmed) return;

  enqueueBroadcastAction("/api/fact", queueSelectedTopicButton, `${topic.name}: ${subtopic}`, {
    topic: topic.name,
    subtopic,
  });
}

async function startTopicCycle() {
  const topic = currentConfig?.topics?.[selectedTopicIndex];
  const mode = getTopicCycleMode();
  if (!topic && mode === "selected-once") {
    setStatus("Выберите тему для автоэфира");
    return;
  }
  const order = getTopicCycleOrder() === "subtopic-first" ? "по слоям подтем" : "тема целиком";
  const message = mode === "selected-once"
    ? `Запустить автоэфир только для темы "${topic.name}"?\n\nПосле последней подтемы автоэфир остановится.`
    : `Запустить автоэфир всех тем по кругу?\n\nСтарт: ${topic?.name || "первая тема"}.\nПорядок: ${order}.`;
  if (!window.confirm(message)) return;

  startTopicCycleButton.disabled = true;
  setStatus(mode === "selected-once" ? `Запускаю выбранную тему: ${topic.name}` : "Запускаю все темы по кругу");
  try {
    await saveConfig();
    const response = await fetch("/api/admin/topic-cycle/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        topicIndex: selectedTopicIndex,
        subtopicIndex: 0,
        order: getTopicCycleOrder(),
        minIntervalMs: Math.max(1, Number(topicCycleMinInput.value) || 5) * 60 * 1000,
        maxIntervalMs: Math.max(Number(topicCycleMinInput.value) || 5, Number(topicCycleMaxInput.value) || 6) * 60 * 1000,
        immediate: true,
      }),
    });
    topicCycle = await response.json();
    if (!response.ok) throw new Error(topicCycle.error || "Не удалось запустить автоэфир");
    renderTopicCycleStatus();
    setStatus(mode === "selected-once"
      ? `Запущена только тема "${topic.name}". После последней подтемы автоэфир остановится.`
      : `Запущены все темы по кругу: новые темы будут подхвачены автоматически.`);
  } catch (error) {
    setStatus(`Автоэфир тем: ошибка - ${error.message}`);
  } finally {
    startTopicCycleButton.disabled = false;
  }
}

function getTopicCycleMode() {
  return topicCycleModeAllLoop?.checked ? "all-loop" : "selected-once";
}

function getTopicCycleOrder() {
  return topicCycleOrderSubtopicFirst?.checked ? "subtopic-first" : "topic-first";
}

function setTopicCycleOrder(order) {
  const normalized = order === "subtopic-first" ? "subtopic-first" : "topic-first";
  if (topicCycleOrderSubtopicFirst) topicCycleOrderSubtopicFirst.checked = normalized === "subtopic-first";
  if (topicCycleOrderTopicFirst) topicCycleOrderTopicFirst.checked = normalized !== "subtopic-first";
}

async function stopTopicCycle() {
  if (!window.confirm("Остановить автоэфир тем?\n\nНовые подтемы больше не будут ставиться в очередь автоматически.")) return;
  stopTopicCycleButton.disabled = true;
  setStatus("Останавливаю автоэфир тем");
  try {
    const response = await fetch("/api/admin/topic-cycle/stop", { method: "POST" });
    topicCycle = await response.json();
    if (!response.ok) throw new Error(topicCycle.error || "Не удалось остановить автоэфир");
    renderTopicCycleStatus();
    setStatus("Автоэфир тем остановлен");
  } catch (error) {
    setStatus(`Автоэфир тем: ошибка - ${error.message}`);
  } finally {
    stopTopicCycleButton.disabled = false;
  }
}

async function refreshTopicCycleStatus() {
  try {
    const response = await fetch("/api/admin/topic-cycle");
    topicCycle = response.ok ? await response.json() : { active: false };
  } catch {
    topicCycle = { active: false };
  }
  renderTopicCycleStatus();
}

function renderTopicCycleStatus() {
  if (!topicCycleStatus) return;
  if (topicCycleModeAllLoop && topicCycleModeSelectedOnce && topicCycle?.mode) {
    topicCycleModeAllLoop.checked = topicCycle.mode === "all-loop";
    topicCycleModeSelectedOnce.checked = topicCycle.mode !== "all-loop";
  }
  if (topicCycle?.order) setTopicCycleOrder(topicCycle.order);
  if (!topicCycle?.active) {
    topicCycleStatus.textContent = topicCycle?.completionReason === "selected_topic_completed"
      ? "Остановлен: выбранная тема полностью озвучена"
      : "Остановлен";
    if (startTopicCycleButton) {
      startTopicCycleButton.hidden = false;
      startTopicCycleButton.disabled = false;
    }
    if (stopTopicCycleButton) {
      stopTopicCycleButton.hidden = true;
      stopTopicCycleButton.disabled = true;
    }
    return;
  }

  if (startTopicCycleButton) {
    startTopicCycleButton.hidden = true;
    startTopicCycleButton.disabled = true;
  }
  if (stopTopicCycleButton) {
    stopTopicCycleButton.hidden = false;
    stopTopicCycleButton.disabled = false;
  }
  const next = topicCycle.nextRunAt ? formatDateTime(topicCycle.nextRunAt) : "скоро";
  const mode = topicCycle.mode === "selected-once"
    ? `Только тема: ${topicCycle.selectedTopicName || "выбранная"}`
    : "Все темы по кругу";
  const order = topicCycle.order === "subtopic-first" ? "по слоям подтем" : "тема целиком";
  const last = topicCycle.lastRun?.topic
    ? `Последняя: ${topicCycle.lastRun.topic} / ${topicCycle.lastRun.subtopic}`
    : "Первый выход готовится";
  const error = topicCycle.lastError ? ` Ошибка: ${topicCycle.lastError.message}` : "";
  topicCycleStatus.textContent = `Работает. ${mode}. Порядок: ${order}. Следующий выход: ${next}. ${last}.${error}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "скоро";
  return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(value) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function renderBroadcastResult(label, payload) {
  if (testOutput) {
    const topicLabel = payload.subtopic ? `${payload.topic} / ${payload.subtopic}` : payload.topic;
    testOutput.textContent = `${topicLabel || label}: ${payload.text || payload.error || "добавлено в эфир"}`;
  }
  if (adminAudio && payload.audioUrl) {
    adminAudio.src = payload.audioUrl;
  }
}

function enqueueAdminVoiceTest(url) {
  testGreetingButton.disabled = true;
  testFactButton.disabled = true;
  setStatus("Добавлено в очередь диктора");
  adminVoiceQueue = adminVoiceQueue
    .then(() => runTest(url))
    .catch((error) => setStatus(error.message || "Ошибка генерации"))
    .finally(() => {
      testGreetingButton.disabled = false;
      testFactButton.disabled = false;
    });
}

async function testPaymentFlow() {
  if (!testPaymentFlowButton || !testOutput) return;
  testPaymentFlowButton.disabled = true;
  testOutput.textContent = "Проверяю внутреннюю цепочку оплаты вопроса...";
  try {
    const response = await fetch("/api/admin/tests/payment-flow", { method: "POST" });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || payload.database?.reason || "Тест не прошел");
    testOutput.textContent = [
      `Бесплатный вопрос: ${payload.freeQuestion.status}`,
      `Платный черновик: ${payload.paidQuestion.draftStatus} за ${payload.paidQuestion.priceStars} Stars`,
      `После оплаты: ${payload.paidQuestion.finalStatus}`,
      `БД: order=${payload.database.orderStatus}, payment=${payload.database.paymentRecorded ? "ok" : "missing"}, question=${payload.database.questionStatus}`,
    ].join(" · ");
  } catch (error) {
    testOutput.textContent = `Тест оплаты: ошибка - ${error.message}`;
  } finally {
    testPaymentFlowButton.disabled = false;
  }
}

async function runTest(url) {
  await saveConfig();
  setStatus("Генерирую тест");
  const response = await fetch(url, { method: "POST" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Аудио диктора не создано");
  const source = payload.source ? ` [${payload.source}]` : "";
  const label = payload.subtopic ? `${payload.topic} / ${payload.subtopic}` : payload.topic;
  testOutput.textContent = label ? `${label}${source}: ${payload.text}` : (payload.text || payload.error || "");
  if (payload.audioUrl) {
    adminAudio.src = payload.audioUrl;
  }
  await Promise.all([refreshFactLog(), refreshArchive()]);
  setStatus(payload.audioUrl ? "Добавлено в эфир" : "Текст готов, аудио не создано");
}

async function refreshFactLog() {
  const response = await fetch("/api/admin/fact-log");
  factLog = await response.json();
  renderTopicList();
  renderTopicDetail();
}

async function refreshArchive() {
  const response = await fetch("/api/admin/audio-files");
  const payload = await response.json();
  if (!response.ok) {
    setStatus(payload.error || "Не удалось обновить аудио файлы");
    return;
  }
  audioFiles = payload;
  archiveItems = payload.voiceArchive || [];
  renderAudioFiles();
  renderArchive();
  setStatus("Аудио файлы обновлены");
}

async function uploadAudioFiles(kind, input) {
  const files = Array.from(input?.files || []);
  if (!files.length) return;

  const label = kind === "live" ? "музыку эфира" : "Play-вставки";
  setStatus(`Загружаю ${label}: ${files.length} файл(ов)`);
  try {
    const form = new FormData();
    files.forEach((file) => form.append("files", file, file.name));
    const response = await fetch(`/api/admin/audio-files/upload?kind=${encodeURIComponent(kind)}`, {
      method: "POST",
      body: form,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Не удалось загрузить аудио");
    await refreshArchive();
    const skipped = payload.skipped?.length ? `, пропущено: ${payload.skipped.length}` : "";
    setStatus(`Загружено: ${payload.files?.length || 0}${skipped}`);
  } catch (error) {
    setStatus(`Загрузка аудио: ошибка - ${error.message}`);
  } finally {
    if (input) input.value = "";
  }
}

async function deleteMusicFile(kind, track) {
  const label = kind === "live" ? "музыку эфира" : "Play-вставку";
  const confirmed = window.confirm(`Удалить ${label}?\n\n${track.file}`);
  if (!confirmed) return;

  try {
    const response = await fetch(`/api/admin/audio-files?kind=${encodeURIComponent(kind)}&file=${encodeURIComponent(track.file)}`, {
      method: "DELETE",
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Не удалось удалить аудио");
    await refreshArchive();
    setStatus("Аудио файл удален");
  } catch (error) {
    setStatus(`Удаление аудио: ошибка - ${error.message}`);
  }
}

async function refreshAirHistory() {
  if (!airHistory) return;
  try {
    const response = await fetch("/api/admin/system-log?limit=80", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Не удалось загрузить историю эфира");
    renderAirHistory(payload.items || []);
  } catch (error) {
    airHistory.innerHTML = "";
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = `История эфира недоступна: ${error.message}`;
    airHistory.append(empty);
  }
}

function renderAirHistory(items) {
  const visibleEvents = new Set([
    "voice_audio_start",
    "voice_segment_end",
    "voice_queued",
    "play_queued",
    "play_music_start",
    "music_synced",
    "broadcast_reset",
    "broadcast_stopped",
    "broadcast_restored",
    "admin_broadcast_reset",
    "admin_broadcast_stop",
    "admin_broadcast_restore",
    "topic_cycle_fact_queued",
    "topic_cycle_error",
  ]);
  const rows = items
    .filter((item) => visibleEvents.has(item.event))
    .slice(-18)
    .reverse();

  airHistory.innerHTML = "";
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "История воспроизведения пока пустая";
    airHistory.append(empty);
    return;
  }

  rows.forEach((item) => {
    const row = document.createElement("div");
    row.className = "air-history-item";
    const title = getAirHistoryTitle(item);
    row.innerHTML = `<time></time><strong></strong><span></span>`;
    row.querySelector("time").textContent = formatDateTime(item.ts);
    row.querySelector("strong").textContent = title;
    row.querySelector("span").textContent = getAirHistoryMeta(item);
    airHistory.append(row);
  });
}

function getAirHistoryTitle(item) {
  return {
    voice_audio_start: "Диктор начал говорить",
    voice_segment_end: "Диктор закончил",
    voice_queued: "Голос добавлен в очередь",
    play_queued: "Play-вставка добавлена",
    play_music_start: "Play-вставка в эфире",
    music_synced: "Музыка синхронизирована",
    broadcast_reset: "Эфир сброшен",
    broadcast_stopped: "Эфир остановлен",
    broadcast_restored: "Эфир восстановлен",
    admin_broadcast_reset: "Админ сбросил эфир",
    admin_broadcast_stop: "Админ остановил эфир",
    admin_broadcast_restore: "Админ восстановил эфир",
    topic_cycle_fact_queued: "Тема поставлена в эфир",
    topic_cycle_error: "Ошибка автоэфира",
  }[item.event] || item.event;
}

function getAirHistoryMeta(item) {
  return item.title
    || [item.topic, item.subtopic].filter(Boolean).join(" / ")
    || item.file
    || item.error
    || item.reason
    || "";
}

async function toggleBroadcastPower() {
  const isStopped = stopBroadcastButton?.dataset.broadcastStopped === "true";
  const confirmed = window.confirm(isStopped
    ? "Восстановить эфир? Очереди будут пустыми, музыка начнется с начала плейлиста."
    : "Остановить эфир? Активные подключения к потоку будут закрыты, очереди будут очищены.");
  if (!confirmed) return;

  stopBroadcastButton.disabled = true;
  setStatus(isStopped ? "Восстанавливаю эфир" : "Останавливаю эфир");
  try {
    const endpoint = isStopped ? "/api/admin/broadcast/restore" : "/api/admin/broadcast/stop";
    const response = await fetch(endpoint, { method: "POST" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || (isStopped ? "Не удалось восстановить эфир" : "Не удалось остановить эфир"));
    setBroadcastButtonStopped(!isStopped);
    window.dispatchEvent(new CustomEvent("broadcast-power-changed", { detail: { stopped: !isStopped } }));
    await Promise.all([refreshAirHistory(), refreshTopicCycleStatus()]);
    setStatus(isStopped ? "Эфир восстановлен" : "Эфир остановлен");
  } catch (error) {
    setStatus(`${isStopped ? "Восстановление" : "Остановка"} эфира: ошибка - ${error.message}`);
  } finally {
    stopBroadcastButton.disabled = false;
  }
}

function setBroadcastButtonStopped(isStopped) {
  if (!stopBroadcastButton) return;
  stopBroadcastButton.dataset.broadcastStopped = isStopped ? "true" : "false";
  stopBroadcastButton.textContent = isStopped ? "Восстановить эфир" : "Остановить эфир";
  stopBroadcastButton.classList.toggle("danger-button", !isStopped);
  stopBroadcastButton.classList.toggle("primary-action", isStopped);
}

async function clearArchive() {
  const confirmed = window.confirm("Удалить все архивы аудио? Это удалит mp3 приветствий, фактов, прощаний и слушательских вопросов.");
  if (!confirmed) return;
  const typed = window.prompt("Для подтверждения введите: УДАЛИТЬ");
  if (typed !== "УДАЛИТЬ") {
    setStatus("Очистка архива отменена");
    return;
  }
  const response = await fetch("/api/admin/archive/clear", { method: "POST" });
  if (!response.ok) {
    setStatus("Не удалось очистить архив");
    return;
  }
  archiveItems = [];
  factLog = { cursor: { topicIndex: 0, subtopicIndex: 0 }, facts: [] };
  renderArchive();
  renderTopicList();
  renderTopicDetail();
  setStatus("Все архивы аудио удалены");
}

async function refreshListeners() {
  const response = await fetch("/api/admin/listeners");
  listenerStore = await response.json();
  renderListeners();
  setStatus("Слушатели обновлены");
}

async function resetListeners() {
  const confirmed = window.confirm("Сбросить всех Telegram-пользователей и вопросы? После этого первые 9 слушателей должны заново нажать /start.");
  if (!confirmed) return;

  const response = await fetch("/api/admin/listeners/reset", { method: "POST" });
  const payload = await response.json();
  if (!response.ok) {
    setStatus(payload.error || "Не удалось сбросить Telegram-пользователей");
    return;
  }
  listenerStore = { users: [], questions: [] };
  renderListeners();
  setStatus("Telegram-пользователи и вопросы сброшены");
}

function renderListeners() {
  if (!listenerList) return;
  listenerList.innerHTML = "";
  const users = listenerStore.users || [];
  const questions = listenerStore.questions || [];

  if (!users.length && !questions.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Слушателей пока нет. Первые 9 пользователей Telegram-бота появятся здесь после /start.";
    listenerList.append(empty);
    return;
  }

  users.forEach((user) => {
    const userBlock = document.createElement("article");
    userBlock.className = "listener-item";
    const userQuestions = questions.filter((question) => question.telegramId === user.telegramId);
    userBlock.innerHTML = `
      <div class="archive-meta">
        <strong></strong>
        <span></span>
      </div>
      <div class="listener-questions"></div>
    `;
    userBlock.querySelector("strong").textContent = user.name || "Имя ожидается";
    userBlock.querySelector("span").textContent = `${user.role === "admin" ? "Админ" : "Слушатель"} · Осталось вопросов: ${user.unlimited ? "безлимит" : user.remaining}`;
    const list = userBlock.querySelector(".listener-questions");
    userQuestions.slice().reverse().forEach((question) => {
      const row = document.createElement("div");
      row.className = "listener-question";
      row.innerHTML = `<b></b><small></small><p></p>`;
      const paymentLabel = question.paymentStatus === "paid"
        ? " · оплачено"
        : question.paymentStatus === "waiting_payment"
          ? ` · ожидает оплату ${question.priceStars || 0} Stars`
          : "";
      row.querySelector("b").textContent = `${question.status}${paymentLabel}`;
      row.querySelector("small").textContent = question.question;
      row.querySelector("p").textContent = question.text || question.error || "Ответ еще готовится";
      list.append(row);
    });
    listenerList.append(userBlock);
  });
}

function connectAdminEvents() {
  if (!("EventSource" in window) || window.__adminEventsConnected) return;
  window.__adminEventsConnected = true;
  const events = new EventSource("/api/admin/events");
  events.addEventListener("listeners", (event) => {
    listenerStore = JSON.parse(event.data);
    renderListeners();
  });
  events.addEventListener("archive", (event) => {
    archiveItems = JSON.parse(event.data).items || [];
    renderArchive();
  });
  events.addEventListener("audio-files", (event) => {
    audioFiles = JSON.parse(event.data);
    archiveItems = audioFiles.voiceArchive || [];
    renderAudioFiles();
    renderArchive();
  });
  events.addEventListener("config", (event) => {
    currentConfig = JSON.parse(event.data);
    renderConfig(currentConfig);
  });
  events.addEventListener("fact-log", (event) => {
    factLog = JSON.parse(event.data);
    renderTopicList();
    renderTopicDetail();
  });
  events.addEventListener("topic-cycle", (event) => {
    topicCycle = JSON.parse(event.data);
    renderTopicCycleStatus();
  });
}

async function deleteArchiveItem(item) {
  const confirmed = window.confirm(`Удалить аудио из архива?\n\n${item.title}`);
  if (!confirmed) return;

  const response = await fetch(`/api/admin/archive?path=${encodeURIComponent(item.relativePath)}`, {
    method: "DELETE",
  });
  const payload = await response.json();
  if (!response.ok) {
    setStatus(payload.error || "Не удалось удалить аудио");
    return;
  }

  archiveItems = payload.items || [];
  await refreshFactLog();
  renderArchive();
  setStatus("Аудио удалено из архива");
}

function getVoicedSets() {
  const subtopics = new Set();
  const savedSubtopics = new Set();
  const topics = new Set();
  const activeHostId = getActiveHostId();
  for (const fact of factLog.facts || []) {
    const factHostId = fact.hostId || "sweetiefox";
    if (factHostId !== activeHostId) continue;
    if (fact.topic) topics.add(fact.topic);
    if (fact.topic && fact.subtopic) subtopics.add(getPairKey(fact.topic, fact.subtopic));
    if (fact.topic && fact.subtopic && fact.audioUrl) savedSubtopics.add(getPairKey(fact.topic, fact.subtopic));
  }
  return { topics, subtopics, savedSubtopics };
}

function getPairKey(topic, subtopic) {
  return `${topic}|||${subtopic}`;
}

function getInitialTab() {
  const fromHash = window.location.hash ? window.location.hash.slice(1) : "";
  const saved = localStorage.getItem(adminUiStorage.tab);
  const available = new Set(Array.from(document.querySelectorAll(".admin-tab")).map((button) => button.dataset.tab));
  if (available.has(fromHash)) return fromHash;
  if (available.has(saved)) return saved;
  return "air";
}

function activateTab(name, options = {}) {
  const available = new Set(Array.from(document.querySelectorAll(".admin-tab")).map((button) => button.dataset.tab));
  const nextName = available.has(name) ? name : "air";

  document.querySelectorAll(".admin-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === nextName);
  });
  document.querySelectorAll(".admin-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === nextName);
  });

  if (options.persist) {
    localStorage.setItem(adminUiStorage.tab, nextName);
    if (window.location.hash.slice(1) !== nextName) {
      history.replaceState(null, "", `#${nextName}`);
    }
  }

  if (nextName === "archive") {
    refreshArchive();
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}
