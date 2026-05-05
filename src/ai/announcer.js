const fs = require("node:fs");
const path = require("node:path");
const { fallbackScript, generateFact, generateFarewell, generateGreeting, generateListenerAnswer, generateScript } = require("./deepseek");
const { synthesize } = require("./elevenlabs");
const { readAdminConfig } = require("../adminStore");
const { addFactLogEntry, advanceCursor, getArchivedFacts, getRecentFacts, readAvailableFactLog } = require("../factLog");

let factQueue = Promise.resolve();

async function createAnnouncement(config, input) {
  const admin = await readAdminConfig(config);
  const trackTitle = String(input?.trackTitle || "следующий трек").slice(0, 160);
  const text = await generateScript(config.deepseek, trackTitle, input, admin).catch((error) => {
    console.warn(`DeepSeek fallback: ${error.message}`);
    return fallbackScript(trackTitle);
  });

  const audio = await synthesize(config.elevenlabs, config.cacheDir, text, { kind: "announcement", voice: admin.voice }).catch((error) => {
    console.warn(`ElevenLabs fallback: ${error.message}`);
    return null;
  });

  return { text, audioUrl: audio?.audioUrl || null };
}

async function createGreeting(config) {
  const admin = await readAdminConfig(config);
  const text = await generateGreeting(config.deepseek, admin).catch((error) => {
    console.warn(`DeepSeek greeting fallback: ${error.message}`);
    return "Добро пожаловать на AI Chill Radio. Проверяем голос диктора и запускаем локальный эфир.";
  });

  return createArchivedVoice(config, {
    kind: "greeting",
    theme: "hello",
    text,
  });
}

async function createFarewell(config) {
  const admin = await readAdminConfig(config);
  const text = await generateFarewell(config.deepseek, admin).catch((error) => {
    console.warn(`DeepSeek farewell fallback: ${error.message}`);
    return "Спасибо, что были на волне AI Chill Radio. До встречи в следующем спокойном эфире.";
  });

  return createArchivedVoice(config, {
    kind: "farewell",
    theme: "bye",
    text,
  });
}

async function createFact(config, input = {}) {
  const run = () => createFactUnlocked(config, input);
  factQueue = factQueue.then(run, run);
  return factQueue;
}

async function createFactUnlocked(config, input = {}) {
  const admin = await readAdminConfig(config);
  const log = await readAvailableFactLog(config, { prune: true });
  const archived = getArchivedFacts(log, config.elevenlabs.voiceId);

  if (admin.factPolicy.useArchiveWhenReady && archived.length >= admin.factPolicy.archiveAfterTotal) {
    const item = archived[Math.floor(Math.random() * archived.length)];
    return {
      text: item.text,
      audioUrl: item.audioUrl,
      archived: true,
      archivePath: item.archivePath,
      theme: item.topic,
      topic: item.topic,
      subtopic: item.subtopic,
      kind: "facts",
      voiceId: item.voiceId,
      source: "archive",
    };
  }

  const selection = input.topic && input.subtopic
    ? resolveRequestedSelection(admin, input)
    : await advanceCursor(config, admin);
  const topicName = selection.topic.name;
  const subtopicName = selection.subtopic;
  const recentFacts = getRecentFacts(log, topicName, subtopicName, 8);

  const text = await generateFact(config.deepseek, topicName, subtopicName, admin, recentFacts).catch((error) => {
    console.warn(`DeepSeek fact fallback: ${error.message}`);
    return `Факт на тему ${topicName}, ${subtopicName}: иногда самые спокойные наблюдения оказываются самыми запоминающимися.`;
  });

  const payload = await createArchivedVoice(config, {
    kind: "facts",
    topic: topicName,
    topicIndex: selection.topicIndex,
    subtopic: subtopicName,
    subtopicIndex: selection.subtopicIndex,
    text,
  });
  await addFactLogEntry(config, payload);
  return { ...payload, source: "generated" };
}

async function createListenerQuestion(config, input) {
  const admin = await readAdminConfig(config);
  const userName = String(input.userName || "Слушатель").slice(0, 80);
  const question = String(input.question || "").slice(0, 1200);
  const text = await generateListenerAnswer(config.deepseek, userName, question, admin).catch((error) => {
    console.warn(`DeepSeek listener fallback: ${error.message}`);
    return `${userName} прислал такой вопрос: ${question}. <break time=0.45s /> Давайте спокойно разберем его в эфире.`;
  });

  return createArchivedVoice(config, {
    kind: "listeners",
    theme: sanitizeSlug(userName) || "listener",
    userName,
    question,
    text,
  });
}

async function createArchivedVoice(config, item) {
  const admin = await readAdminConfig(config);
  const archive = getArchivePaths(config, item);
  const uniqueKind = `${item.kind}:${item.topic || item.theme}:${item.subtopic || ""}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const audio = await synthesize(config.elevenlabs, archive.dir, item.text, {
    kind: uniqueKind,
    publicUrlPrefix: archive.publicUrlPrefix,
    voice: admin.voice,
  }).catch((error) => {
    console.warn(`ElevenLabs ${item.kind} fallback: ${error.message}`);
    return null;
  });

  const payload = {
    text: item.text,
    audioUrl: audio?.audioUrl || null,
    archived: Boolean(audio?.audioUrl),
    archivePath: archive.relativeDir,
    theme: item.topic || item.theme,
    topic: item.topic || item.theme,
    topicIndex: item.topicIndex,
    subtopic: item.subtopic,
    subtopicIndex: item.subtopicIndex,
    kind: item.kind,
    userName: item.userName,
    question: item.question,
    voiceId: config.elevenlabs.voiceId,
  };

  if (audio?.audioUrl) {
    await fs.promises.mkdir(archive.dir, { recursive: true });
    const metaPath = path.join(archive.dir, `${Date.now()}-meta.json`);
    await fs.promises.writeFile(metaPath, JSON.stringify(payload, null, 2), "utf8");
  }

  return payload;
}

function getArchivePaths(config, item) {
  const date = new Date().toISOString().slice(0, 10);
  const safeKind = sanitizeSlug(item.kind);
  const topicPart = item.kind === "facts"
    ? `${String((item.topicIndex ?? 0) + 1).padStart(2, "0")}-${sanitizeSlug(item.topic)}`
    : sanitizeSlug(item.theme);
  const subtopicPart = item.kind === "facts"
    ? `${String((item.subtopicIndex ?? 0) + 1).padStart(2, "0")}-${sanitizeSlug(item.subtopic)}`
    : null;
  const dir = subtopicPart
    ? path.join(config.archiveDir, safeKind, date, topicPart, subtopicPart)
    : path.join(config.archiveDir, safeKind, date, topicPart);
  const relativeDir = subtopicPart
    ? `${safeKind}/${date}/${topicPart}/${subtopicPart}`
    : `${safeKind}/${date}/${topicPart}`;

  return {
    dir,
    relativeDir,
    publicUrlPrefix: `/archive/${relativeDir}`,
  };
}

function resolveRequestedSelection(admin, input) {
  const topicName = String(input.topic || "").trim();
  const subtopicName = String(input.subtopic || "").trim();
  let topicIndex = admin.topics.findIndex((topic) => topic.name === topicName);
  if (topicIndex < 0) topicIndex = 0;

  const topic = admin.topics[topicIndex];
  let subtopicIndex = topic.subtopics.findIndex((item) => item === subtopicName);
  if (subtopicIndex < 0) subtopicIndex = 0;

  return {
    topic,
    topicIndex,
    subtopic: topic.subtopics[subtopicIndex],
    subtopicIndex,
  };
}

function sanitizeSlug(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}0-9]+/giu, "-")
    .replace(/^-+|-+$/g, "");
}

module.exports = { createAnnouncement, createFact, createFarewell, createGreeting, createListenerQuestion };
