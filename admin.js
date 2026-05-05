const statusEl = document.querySelector("#adminStatus");
const stationNameInput = document.querySelector("#stationNameInput");
const greetingPrompt = document.querySelector("#greetingPrompt");
const factPrompt = document.querySelector("#factPrompt");
const listenerPrompt = document.querySelector("#listenerPrompt");
const farewellPrompt = document.querySelector("#farewellPrompt");
const announcementPrompt = document.querySelector("#announcementPrompt");
const saveButton = document.querySelector("#saveButton");
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
const archiveList = document.querySelector("#archiveList");
const refreshArchiveButton = document.querySelector("#refreshArchiveButton");
const clearArchiveButton = document.querySelector("#clearArchiveButton");
const refreshListenersButton = document.querySelector("#refreshListenersButton");
const resetListenersButton = document.querySelector("#resetListenersButton");
const listenerList = document.querySelector("#listenerList");
const queueGreetingButton = document.querySelector("#queueGreetingButton");
const queueFactButton = document.querySelector("#queueFactButton");
const queueFarewellButton = document.querySelector("#queueFarewellButton");
const queueAnnouncementButton = document.querySelector("#queueAnnouncementButton");
const queueSelectedTopicButton = document.querySelector("#queueSelectedTopicButton");
const announcementTrackTitle = document.querySelector("#announcementTrackTitle");

const voiceInputs = {
  stability: document.querySelector("#stability"),
  similarityBoost: document.querySelector("#similarityBoost"),
  style: document.querySelector("#style"),
  speed: document.querySelector("#speed"),
  speakerBoost: document.querySelector("#speakerBoost"),
};

const factPolicyInputs = {
  archiveAfterTotal: document.querySelector("#archiveAfterTotal"),
  useArchiveWhenReady: document.querySelector("#useArchiveWhenReady"),
};

const audioMixInputs = {
  musicLevel: document.querySelector("#musicLevel"),
  voiceLevel: document.querySelector("#voiceLevel"),
  duckingRatio: document.querySelector("#duckingRatio"),
};

let currentConfig = null;
let factLog = { facts: [] };
let archiveItems = [];
let listenerStore = { users: [], questions: [] };
let selectedTopicIndex = 0;
let adminVoiceQueue = Promise.resolve();

const adminUiStorage = {
  tab: "ai-radio.adminTab",
  topicIndex: "ai-radio.adminTopicIndex",
};

document.querySelectorAll(".admin-tab").forEach((button) => {
  button.addEventListener("click", () => activateTab(button.dataset.tab, { persist: true }));
});

saveButton?.addEventListener("click", saveConfig);
refreshPromptsButton?.addEventListener("click", refreshPrompts);
refreshArchiveButton?.addEventListener("click", refreshArchive);
clearArchiveButton?.addEventListener("click", clearArchive);
refreshListenersButton?.addEventListener("click", refreshListeners);
resetListenersButton?.addEventListener("click", resetListeners);
queueGreetingButton?.addEventListener("click", () => enqueueBroadcastAction("/api/greeting", queueGreetingButton, "Приветствие"));
queueFactButton?.addEventListener("click", () => enqueueBroadcastAction("/api/fact", queueFactButton, "Следующая тема"));
queueFarewellButton?.addEventListener("click", () => enqueueBroadcastAction("/api/farewell", queueFarewellButton, "Прощание"));
queueAnnouncementButton?.addEventListener("click", () => enqueueBroadcastAction("/api/announcement", queueAnnouncementButton, "Подводка", {
  trackTitle: announcementTrackTitle?.value || "",
}));
queueSelectedTopicButton?.addEventListener("click", queueSelectedTopic);
testGreetingButton?.addEventListener("click", () => enqueueAdminVoiceTest("/api/greeting"));
testFactButton?.addEventListener("click", () => enqueueAdminVoiceTest("/api/fact"));
addTopicButton?.addEventListener("click", addTopic);
addSubtopicButton?.addEventListener("click", addSubtopic);
deleteTopicButton?.addEventListener("click", deleteSelectedTopic);
topicNameInput?.addEventListener("input", () => {
  if (!currentConfig?.topics[selectedTopicIndex]) return;
  currentConfig.topics[selectedTopicIndex].name = topicNameInput.value;
  renderTopicList();
});

loadConfig();
activateTab(getInitialTab(), { persist: false });

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
    connectAdminEvents();
    setStatus("Настройки загружены");
  } catch (error) {
    setStatus(`Не удалось загрузить админку: ${error.message}`);
  }
}

function renderConfig(config) {
  stationNameInput.value = config.stationName;
  greetingPrompt.value = config.prompts.greeting;
  factPrompt.value = config.prompts.fact;
  listenerPrompt.value = config.prompts.listener || "";
  farewellPrompt.value = config.prompts.farewell;
  announcementPrompt.value = config.prompts.announcement;

  voiceInputs.stability.value = config.voice.stability;
  voiceInputs.similarityBoost.value = config.voice.similarityBoost;
  voiceInputs.style.value = config.voice.style;
  voiceInputs.speed.value = config.voice.speed;
  voiceInputs.speakerBoost.checked = config.voice.speakerBoost;
  factPolicyInputs.archiveAfterTotal.value = config.factPolicy.archiveAfterTotal;
  factPolicyInputs.useArchiveWhenReady.checked = config.factPolicy.useArchiveWhenReady;
  audioMixInputs.musicLevel.value = config.audioMix?.musicLevel ?? 0.72;
  audioMixInputs.voiceLevel.value = config.audioMix?.voiceLevel ?? 1;
  audioMixInputs.duckingRatio.value = config.audioMix?.duckingRatio ?? 0.18;

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
    const voicedCount = topic.subtopics.filter((subtopic) => voiced.subtopics.has(getPairKey(topic.name, subtopic))).length;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "topic-pill";
    button.classList.toggle("active", index === selectedTopicIndex);
    button.classList.toggle("partial", voicedCount > 0 && voicedCount < topic.subtopics.length);
    button.classList.toggle("complete", voicedCount === topic.subtopics.length && topic.subtopics.length > 0);
    button.innerHTML = `<span>${String(index + 1).padStart(2, "0")}</span><strong></strong><small>${voicedCount}/${topic.subtopics.length} озвучено</small>`;
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

function renderTopicDetail() {
  const topic = currentConfig.topics[selectedTopicIndex];
  if (!topic) return;

  const voiced = getVoicedSets();
  topicNameInput.value = topic.name;
  subtopicList.innerHTML = "";

  topic.subtopics.forEach((subtopic, index) => {
    const item = document.createElement("div");
    item.className = "subtopic-chip";
    item.classList.toggle("voiced", voiced.subtopics.has(getPairKey(topic.name, subtopic)));

    const input = document.createElement("input");
    input.type = "text";
    input.value = subtopic;
    input.addEventListener("input", () => {
      topic.subtopics[index] = input.value;
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Удалить подтему");
    remove.addEventListener("click", () => {
      topic.subtopics.splice(index, 1);
      renderTopicDetail();
      renderTopicList();
    });

    item.append(input, remove);
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

async function refreshPrompts() {
  refreshPromptsButton.disabled = true;
  setStatus("Обновляю промпты и сбрасываю очередь фактов");

  try {
    const response = await fetch("/api/admin/prompts/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectConfig()),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Prompt refresh failed");

    currentConfig = payload.admin;
    factLog = { cursor: { topicIndex: 0, subtopicIndex: 0 }, facts: [] };
    renderConfig(currentConfig);
    await Promise.all([refreshFactLog(), refreshArchive()]);
    setStatus("Промпты обновлены. Архив не удален, очередь фактов сброшена.");
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
      greeting: greetingPrompt.value,
      fact: factPrompt.value,
      listener: listenerPrompt.value,
      farewell: farewellPrompt.value,
      announcement: announcementPrompt.value,
    },
    voice: {
      stability: Number(voiceInputs.stability.value),
      similarityBoost: Number(voiceInputs.similarityBoost.value),
      style: Number(voiceInputs.style.value),
      speed: Number(voiceInputs.speed.value),
      speakerBoost: voiceInputs.speakerBoost.checked,
    },
    factPolicy: {
      archiveAfterTotal: Number(factPolicyInputs.archiveAfterTotal.value),
      useArchiveWhenReady: factPolicyInputs.useArchiveWhenReady.checked,
    },
    audioMix: {
      musicLevel: Number(audioMixInputs.musicLevel.value),
      voiceLevel: Number(audioMixInputs.voiceLevel.value),
      duckingRatio: Number(audioMixInputs.duckingRatio.value),
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
  const topics = new Set();
  for (const fact of factLog.facts || []) {
    if (fact.topic) topics.add(fact.topic);
    if (fact.topic && fact.subtopic) subtopics.add(getPairKey(fact.topic, fact.subtopic));
  }
  return { topics, subtopics };
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
