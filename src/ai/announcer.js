const fs = require("node:fs");
const path = require("node:path");
const { generateFact, generateFarewell, generateGreeting, generateListenerAnswer } = require("./deepseek");
const { synthesize } = require("./elevenlabs");
const { getActivePromptSet, readAdminConfig } = require("../adminStore");
const {
  addFactLogEntry,
  advanceCursor,
  getAnyArchivedFactForSelection,
  getArchivedFactForSelection,
  getRecentFacts,
  readAvailableFactLog,
} = require("../factLog");

let factQueue = Promise.resolve();
const STANDARD_VOICE_POOL_LIMIT = 6;

async function createGreeting(config, input = {}) {
  const admin = await readAdminConfig(config);
  const promptSet = getActivePromptSet(admin);
  const pool = await getReusableVoiceAssets(config, "greeting", promptSet, config.elevenlabs.voiceId);
  if (!input.forceGenerate && pool.anyRevision.length >= STANDARD_VOICE_POOL_LIMIT) {
    return toReusableVoicePayload(
      pickReusableVoiceAsset(pool.currentRevision.length ? pool.currentRevision : pool.anyRevision),
      "greeting",
      "hello",
      "pool",
    );
  }
  const text = await generateGreeting(config.deepseek, admin).catch((error) => {
    console.warn(`DeepSeek greeting fallback: ${error.message}`);
    return "Добро пожаловать на AI Chill Radio. Проверяем голос диктора и запускаем локальный эфир.";
  });

  const payload = await createArchivedVoice(config, {
    kind: "greeting",
    theme: "hello",
    text,
  });
  if (!payload.audioUrl && pool.anyRevision.length) {
    return toReusableVoicePayload(
      pickReusableVoiceAsset(pool.currentRevision.length ? pool.currentRevision : pool.anyRevision),
      "greeting",
      "hello",
      "fallback",
      payload.audioError,
    );
  }
  return payload;
}

async function createFarewell(config, input = {}) {
  const admin = await readAdminConfig(config);
  const promptSet = getActivePromptSet(admin);
  const pool = await getReusableVoiceAssets(config, "farewell", promptSet, config.elevenlabs.voiceId);
  if (!input.forceGenerate && pool.anyRevision.length >= STANDARD_VOICE_POOL_LIMIT) {
    return toReusableVoicePayload(
      pickReusableVoiceAsset(pool.currentRevision.length ? pool.currentRevision : pool.anyRevision),
      "farewell",
      "bye",
      "pool",
    );
  }
  const text = await generateFarewell(config.deepseek, admin).catch((error) => {
    console.warn(`DeepSeek farewell fallback: ${error.message}`);
    return "Спасибо, что были на волне AI Chill Radio. До встречи в следующем спокойном эфире.";
  });

  const payload = await createArchivedVoice(config, {
    kind: "farewell",
    theme: "bye",
    text,
  });
  if (!payload.audioUrl && pool.anyRevision.length) {
    return toReusableVoicePayload(
      pickReusableVoiceAsset(pool.currentRevision.length ? pool.currentRevision : pool.anyRevision),
      "farewell",
      "bye",
      "fallback",
      payload.audioError,
    );
  }
  return payload;
}

async function createFact(config, input = {}) {
  const run = () => withTimeout(createFactUnlocked(config, input), 180_000, "Fact generation timed out");
  factQueue = factQueue.then(run, run);
  return factQueue;
}

async function createFactUnlocked(config, input = {}) {
  const admin = await readAdminConfig(config);
  const promptSet = getActivePromptSet(admin);
  const log = await readAvailableFactLog(config, { prune: true });
  const hasRequestedSelection = Boolean(input.topic || input.subtopic);
  const selection = hasRequestedSelection
    ? resolveRequestedSelection(admin, input)
    : await advanceCursor(config, admin);
  const topicName = selection.topic.name;
  const subtopicName = selection.subtopic;

  const archived = getArchivedFactForSelection(
    log,
    config.elevenlabs.voiceId,
    topicName,
    subtopicName,
    promptSet.hostId,
    promptSet.revision,
  );
  if (archived && !input.forceGenerate) {
    return {
      text: archived.text,
      audioUrl: archived.audioUrl,
      archived: true,
      archivePath: archived.archivePath,
      theme: archived.topic,
      topic: archived.topic,
      topicIndex: selection.topicIndex,
      subtopic: archived.subtopic,
      subtopicIndex: selection.subtopicIndex,
      kind: "facts",
      voiceId: archived.voiceId,
      source: "archive",
    };
  }

  const reusableArchived = getAnyArchivedFactForSelection(
    log,
    config.elevenlabs.voiceId,
    topicName,
    subtopicName,
    promptSet.hostId,
  );
  if (reusableArchived && !input.forceGenerate) {
    return {
      text: reusableArchived.text,
      audioUrl: reusableArchived.audioUrl,
      archived: true,
      archivePath: reusableArchived.archivePath,
      theme: reusableArchived.topic,
      topic: reusableArchived.topic,
      topicIndex: selection.topicIndex,
      subtopic: reusableArchived.subtopic,
      subtopicIndex: selection.subtopicIndex,
      kind: "facts",
      voiceId: reusableArchived.voiceId,
      promptRevision: reusableArchived.promptRevision,
      hostId: reusableArchived.hostId,
      hostName: reusableArchived.hostName,
      source: "archive-reuse",
    };
  }

  const recentFacts = getRecentFacts(log, topicName, subtopicName, 8);

  const text = await generateFact(config.deepseek, topicName, subtopicName, admin, recentFacts, selection).catch((error) => {
    console.warn(`DeepSeek fact fallback: ${error.message}`);
    return `Факт на тему ${topicName}, ${subtopicName}: иногда самые спокойные наблюдения оказываются самыми запоминающимися.`;
  });

  const payload = await createArchivedVoice(config, {
    kind: "facts",
    hostId: promptSet.hostId,
    hostName: promptSet.hostName,
    promptRevision: promptSet.revision,
    topic: topicName,
    topicIndex: selection.topicIndex,
    subtopic: subtopicName,
    subtopicIndex: selection.subtopicIndex,
    text,
  });
  if (!payload.audioUrl) {
    return { ...payload, source: "generation-failed" };
  }
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
  const promptSet = getActivePromptSet(admin);
  const archive = getArchivePaths(config, item);
  const uniqueKind = `${item.kind}:${item.topic || item.theme}:${item.subtopic || ""}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  let audio = null;
  let audioError = null;

  try {
    audio = await synthesize(config.elevenlabs, archive.dir, item.text, {
      kind: uniqueKind,
      publicUrlPrefix: archive.publicUrlPrefix,
      voice: admin.voice,
    });
  } catch (error) {
    audioError = error.message;
    console.warn(`ElevenLabs ${item.kind} fallback: ${error.message}`);
  }

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
    promptRevision: item.promptRevision ?? promptSet.revision,
    hostId: item.hostId || promptSet.hostId,
    hostName: item.hostName || promptSet.hostName,
    audioError,
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

async function getReusableVoiceAssets(config, kind, promptSet, voiceId) {
  const assets = [];
  const kindDir = path.join(config.archiveDir, sanitizeSlug(kind));
  for (const metaPath of await walkMetaFiles(kindDir)) {
    try {
      const payload = JSON.parse(await fs.promises.readFile(metaPath, "utf8"));
      if (
        payload.kind !== kind
        || payload.voiceId !== voiceId
        || payload.hostId !== promptSet.hostId
        || !payload.audioUrl
      ) continue;
      const audioPath = resolveArchiveAudioPath(config, payload.audioUrl);
      const stats = audioPath ? await fs.promises.stat(audioPath).catch(() => null) : null;
      if (!stats?.isFile()) continue;
      assets.push(payload);
    } catch {}
  }

  return {
    anyRevision: assets,
    currentRevision: assets.filter((asset) => Number(asset.promptRevision || 0) === Number(promptSet.revision || 0)),
  };
}

async function walkMetaFiles(rootDir) {
  let entries = [];
  try {
    entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    const filePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) files.push(...await walkMetaFiles(filePath));
    if (entry.isFile() && entry.name.endsWith("-meta.json")) files.push(filePath);
  }
  return files;
}

function resolveArchiveAudioPath(config, audioUrl) {
  let relativePath = String(audioUrl || "");
  if (!relativePath.startsWith("/archive/")) return null;
  try {
    relativePath = decodeURIComponent(relativePath.slice("/archive/".length));
  } catch {
    return null;
  }
  const archiveDir = path.resolve(config.archiveDir);
  const audioPath = path.resolve(archiveDir, relativePath);
  return audioPath.startsWith(`${archiveDir}${path.sep}`) ? audioPath : null;
}

function pickReusableVoiceAsset(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function toReusableVoicePayload(asset, kind, theme, source, audioError = null) {
  return {
    ...asset,
    kind,
    theme,
    topic: theme,
    archived: true,
    source,
    audioError,
  };
}

function resolveRequestedSelection(admin, input) {
  const topicName = String(input.topic || "").trim();
  const subtopicName = String(input.subtopic || "").trim();
  const topicIndex = admin.topics.findIndex((topic) => topic.name === topicName);
  if (topicIndex < 0) {
    throw createSelectionError(`Topic not found: ${topicName || "<empty>"}`);
  }

  const topic = admin.topics[topicIndex];
  const subtopicIndex = topic.subtopics.findIndex((item) => item === subtopicName);
  if (subtopicIndex < 0) {
    throw createSelectionError(`Subtopic not found for "${topic.name}": ${subtopicName || "<empty>"}`);
  }

  return {
    topic,
    topicIndex,
    subtopic: topic.subtopics[subtopicIndex],
    subtopicIndex,
  };
}

function createSelectionError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function sanitizeSlug(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}0-9]+/giu, "-")
    .replace(/^-+|-+$/g, "");
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

module.exports = { createFact, createFarewell, createGreeting, createListenerQuestion };
