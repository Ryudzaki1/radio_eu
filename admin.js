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
const adminAudio = document.querySelector("#adminAudio");
const testOutput = document.querySelector("#testOutput");
const topicList = document.querySelector("#topicList");
const topicNameInput = document.querySelector("#topicNameInput");
const subtopicList = document.querySelector("#subtopicList");
const addTopicButton = document.querySelector("#addTopicButton");
const addSubtopicButton = document.querySelector("#addSubtopicButton");
const deleteTopicButton = document.querySelector("#deleteTopicButton");
const startTopicCycleButton = document.querySelector("#startTopicCycleButton");
const stopTopicCycleButton = document.querySelector("#stopTopicCycleButton");
const topicCycleStatus = document.querySelector("#topicCycleStatus");
const topicCycleMinInput = document.querySelector("#topicCycleMinInput");
const topicCycleMaxInput = document.querySelector("#topicCycleMaxInput");
const archiveList = document.querySelector("#archiveList");
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

let currentConfig = null;
let factLog = { facts: [] };
let archiveItems = [];
let listenerStore = { users: [], questions: [] };
let topicCycle = { active: false };
let selectedTopicIndex = 0;
let adminVoiceQueue = Promise.resolve();
let voiceMusicUnlocked = false;
let voiceMusicSnapshot = "";

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
refreshListenersButton?.addEventListener("click", refreshListeners);
resetListenersButton?.addEventListener("click", resetListeners);
queueGreetingButton?.addEventListener("click", () => enqueueBroadcastAction("/api/greeting", queueGreetingButton, "Приветствие"));
queueFactButton?.addEventListener("click", () => enqueueBroadcastAction("/api/fact", queueFactButton, "Следующая тема"));
queueFarewellButton?.addEventListener("click", () => enqueueBroadcastAction("/api/farewell", queueFarewellButton, "Прощание"));
queueSelectedTopicButton?.addEventListener("click", queueSelectedTopic);
startTopicCycleButton?.addEventListener("click", startTopicCycle);
stopTopicCycleButton?.addEventListener("click", stopTopicCycle);
testGreetingButton?.addEventListener("click", () => enqueueAdminVoiceTest("/api/greeting"));
testFactButton?.addEventListener("click", () => enqueueAdminVoiceTest("/api/fact"));
addTopicButton?.addEventListener("click", addTopic);
addSubtopicButton?.addEventListener("click", addSubtopic);
deleteTopicButton?.addEventListener("click", deleteSelectedTopic);
initHelpTips();
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

function initHelpTips() {
  document.querySelectorAll(".help-tip[title]").forEach((tip) => {
    tip.dataset.tooltip = tip.getAttribute("title") || "";
    tip.setAttribute("tabindex", "0");
    tip.removeAttribute("title");
  });
}

async function loadConfig() {
  try {
    const [configResponse, logResponse, archiveResponse, listenerResponse] = await Promise.all([
      fetch("/api/admin/config"),
      fetch("/api/admin/fact-log"),
      fetch("/api/admin/archive"),
      fetch("/api/admin/listeners"),
    ]);
    currentConfig = await configResponse.json();
    factLog = await logResponse.json();
    archiveItems = archiveResponse.ok ? (await archiveResponse.json()).items || [] : [];
    listenerStore = listenerResponse.ok ? await listenerResponse.json() : { users: [], questions: [] };
    renderConfig(currentConfig);
    renderArchive();
    renderListeners();
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
  voiceInputs.stability.value = config.voice.stability;
  voiceInputs.similarityBoost.value = config.voice.similarityBoost;
  voiceInputs.style.value = config.voice.style;
  voiceInputs.speed.value = config.voice.speed;
  voiceInputs.speakerBoost.checked = config.voice.speakerBoost;
  topicCycleMinInput.value = config.topicCycle?.minIntervalMinutes ?? 5;
  topicCycleMaxInput.value = config.topicCycle?.maxIntervalMinutes ?? 6;
  audioMixInputs.musicLevel.value = config.audioMix?.musicLevel ?? 0.72;
  audioMixInputs.voiceLevel.value = config.audioMix?.voiceLevel ?? 1;
  audioMixInputs.duckingRatio.value = config.audioMix?.duckingRatio ?? 0.18;
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
    button.innerHTML = `<span>${String(index + 1).padStart(2, "0")}</span><strong></strong><small>${savedCount}/${topic.subtopics.length} mp3 сохранено</small>`;
    button.querySelector("strong").textContent = topic.name || "Новая тема";
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

    const input = document.createElement("input");
    input.type = "text";
    input.value = subtopic;
    input.addEventListener("input", () => {
      topic.subtopics[index] = input.value;
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

    item.append(input, state, remove);
    subtopicList.append(item);
  });
}

function renderArchive() {
  if (!archiveList) return;
  archiveList.innerHTML = "";

  if (!archiveItems.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Архив пока пустой. Новые mp3 появятся после генерации приветствий, фактов или прощаний.";
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
      <button class="danger-button" type="button">Удалить</button>
    `;
    row.querySelector("strong").textContent = item.title;
    row.querySelector("span").textContent = `${item.date || "без даты"} · ${item.fileName}`;
    row.querySelector("audio").src = item.audioUrl;
    row.querySelector("button").addEventListener("click", () => deleteArchiveItem(item));
    archiveList.append(row);
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
}

function addSubtopic() {
  const topic = currentConfig.topics[selectedTopicIndex];
  if (!topic) return;
  topic.subtopics.push("новая подтема");
  renderTopicDetail();
  renderTopicList();
}

function deleteSelectedTopic() {
  if (currentConfig.topics.length <= 1) {
    setStatus("Нужна хотя бы одна тема");
    return;
  }

  currentConfig.topics.splice(selectedTopicIndex, 1);
  selectedTopicIndex = Math.max(0, selectedTopicIndex - 1);
  localStorage.setItem(adminUiStorage.topicIndex, String(selectedTopicIndex));
  renderTopicList();
  renderTopicDetail();
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
  voiceInputs.stability.value = snapshot.voice.stability;
  voiceInputs.similarityBoost.value = snapshot.voice.similarityBoost;
  voiceInputs.style.value = snapshot.voice.style;
  voiceInputs.speed.value = snapshot.voice.speed;
  voiceInputs.speakerBoost.checked = snapshot.voice.speakerBoost;
  audioMixInputs.musicLevel.value = snapshot.audioMix.musicLevel;
  audioMixInputs.voiceLevel.value = snapshot.audioMix.voiceLevel;
  audioMixInputs.duckingRatio.value = snapshot.audioMix.duckingRatio;
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
      stability: Number(voiceInputs.stability.value),
      similarityBoost: Number(voiceInputs.similarityBoost.value),
      style: Number(voiceInputs.style.value),
      speed: Number(voiceInputs.speed.value),
      speakerBoost: voiceInputs.speakerBoost.checked,
    },
    audioMix: {
      musicLevel: Number(audioMixInputs.musicLevel.value),
      voiceLevel: Number(audioMixInputs.voiceLevel.value),
      duckingRatio: Number(audioMixInputs.duckingRatio.value),
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
      stability: Number(voiceInputs.stability.value),
      similarityBoost: Number(voiceInputs.similarityBoost.value),
      style: Number(voiceInputs.style.value),
      speed: Number(voiceInputs.speed.value),
      speakerBoost: voiceInputs.speakerBoost.checked,
    },
    factPolicy: currentConfig.factPolicy,
    topicCycle: {
      minIntervalMinutes: Number(topicCycleMinInput.value) || 5,
      maxIntervalMinutes: Number(topicCycleMaxInput.value) || 6,
    },
    audioMix: {
      musicLevel: Number(audioMixInputs.musicLevel.value),
      voiceLevel: Number(audioMixInputs.voiceLevel.value),
      duckingRatio: Number(audioMixInputs.duckingRatio.value),
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

  enqueueBroadcastAction("/api/fact", queueSelectedTopicButton, `${topic.name}: ${subtopic}`, {
    topic: topic.name,
    subtopic,
  });
}

async function startTopicCycle() {
  const topic = currentConfig?.topics?.[selectedTopicIndex];
  if (!topic) {
    setStatus("Выберите тему для автоэфира");
    return;
  }

  startTopicCycleButton.disabled = true;
  setStatus(`Запускаю автоэфир темы: ${topic.name}`);
  try {
    await saveConfig();
    const response = await fetch("/api/admin/topic-cycle/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topicIndex: selectedTopicIndex,
        subtopicIndex: 0,
        minIntervalMs: Math.max(1, Number(topicCycleMinInput.value) || 5) * 60 * 1000,
        maxIntervalMs: Math.max(Number(topicCycleMinInput.value) || 5, Number(topicCycleMaxInput.value) || 6) * 60 * 1000,
        immediate: true,
      }),
    });
    topicCycle = await response.json();
    if (!response.ok) throw new Error(topicCycle.error || "Не удалось запустить автоэфир");
    renderTopicCycleStatus();
    setStatus(`Автоэфир тем запущен: диктор будет выходить каждые ${topicCycleMinInput.value}-${topicCycleMaxInput.value} минут`);
  } catch (error) {
    setStatus(`Автоэфир тем: ошибка - ${error.message}`);
  } finally {
    startTopicCycleButton.disabled = false;
  }
}

async function stopTopicCycle() {
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
  if (!topicCycle?.active) {
    topicCycleStatus.textContent = "Остановлен";
    stopTopicCycleButton.disabled = true;
    return;
  }

  stopTopicCycleButton.disabled = false;
  const next = topicCycle.nextRunAt ? formatDateTime(topicCycle.nextRunAt) : "скоро";
  const last = topicCycle.lastRun?.topic
    ? `Последняя: ${topicCycle.lastRun.topic} / ${topicCycle.lastRun.subtopic}`
    : "Первый выход готовится";
  const error = topicCycle.lastError ? ` Ошибка: ${topicCycle.lastError.message}` : "";
  topicCycleStatus.textContent = `Работает. Следующий выход: ${next}. ${last}.${error}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "скоро";
  return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
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
  const response = await fetch("/api/admin/archive");
  const payload = await response.json();
  archiveItems = payload.items || [];
  renderArchive();
  setStatus("Архив обновлен");
}

async function clearArchive() {
  const confirmed = window.confirm("Удалить все архивы аудио? Это удалит mp3 приветствий, фактов, прощаний и слушательских вопросов.");
  if (!confirmed) return;
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
      row.querySelector("b").textContent = question.status;
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
