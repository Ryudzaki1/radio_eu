const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_HOST_ID = "sweetiefox";

async function readFactLog(config) {
  try {
    const payload = JSON.parse(await fs.promises.readFile(config.factLogPath, "utf8"));
    return normalizeFactLog(payload);
  } catch {
    return { facts: [], cursor: { topicIndex: 0, subtopicIndex: 0 } };
  }
}

async function readAvailableFactLog(config, options = {}) {
  const log = await readFactLog(config);
  const availableFacts = [];

  for (const fact of log.facts) {
    if (await factAudioExists(config, fact)) {
      availableFacts.push(fact);
    }
  }

  const availableLog = { ...log, facts: availableFacts };
  if (options.prune && availableFacts.length !== log.facts.length) {
    await writeFactLog(config, availableLog);
  }

  return availableLog;
}

async function writeFactLog(config, log) {
  await fs.promises.mkdir(path.dirname(config.factLogPath), { recursive: true });
  await fs.promises.writeFile(config.factLogPath, JSON.stringify(normalizeFactLog(log), null, 2), "utf8");
}

async function addFactLogEntry(config, entry) {
  const log = await readFactLog(config);
  log.facts.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    topic: entry.topic,
    topicIndex: entry.topicIndex,
    subtopic: entry.subtopic,
    subtopicIndex: entry.subtopicIndex,
    text: entry.text,
    audioUrl: entry.audioUrl,
    archivePath: entry.archivePath,
    voiceId: entry.voiceId,
    promptRevision: normalizePromptRevision(entry.promptRevision),
    hostId: normalizeHostId(entry.hostId),
    hostName: entry.hostName ? String(entry.hostName) : null,
  });
  log.facts = log.facts.slice(-5000);
  await writeFactLog(config, log);
  return log;
}

async function advanceCursor(config, admin) {
  const log = await readFactLog(config);
  const topics = admin.topics;
  const current = normalizeCursor(log.cursor);
  const topicIndex = current.topicIndex % topics.length;
  const topic = topics[topicIndex];
  const subtopics = topic.subtopics;
  const subtopicIndex = current.subtopicIndex % subtopics.length;
  const subtopic = subtopics[subtopicIndex];

  const next = { topicIndex, subtopicIndex: subtopicIndex + 1 };
  if (next.subtopicIndex >= subtopics.length) {
    next.subtopicIndex = 0;
    next.topicIndex = topicIndex + 1;
    if (next.topicIndex >= topics.length) {
      next.topicIndex = 0;
    }
  }

  log.cursor = next;
  await writeFactLog(config, log);

  return { topic, topicIndex, subtopic, subtopicIndex };
}

async function setCursor(config, cursor) {
  const log = await readFactLog(config);
  log.cursor = normalizeCursor(cursor);
  await writeFactLog(config, log);
  return log.cursor;
}

function getRecentFacts(log, topicName, subtopicName, limit = 8) {
  return normalizeFactLog(log).facts
    .filter((fact) => fact.topic === topicName || fact.subtopic === subtopicName)
    .slice(-limit)
    .reverse();
}

function getArchivedFacts(log, voiceId, hostId = DEFAULT_HOST_ID, promptRevision = 0) {
  const normalizedHostId = normalizeHostId(hostId);
  const normalizedPromptRevision = normalizePromptRevision(promptRevision);
  return normalizeFactLog(log).facts.filter((fact) => (
    fact.voiceId === voiceId
    && fact.audioUrl
    && normalizeHostId(fact.hostId) === normalizedHostId
    && normalizePromptRevision(fact.promptRevision) === normalizedPromptRevision
  ));
}

function getArchivedFactForSelection(log, voiceId, topicName, subtopicName, hostId = DEFAULT_HOST_ID, promptRevision = 0) {
  return getArchivedFacts(log, voiceId, hostId, promptRevision)
    .filter((fact) => fact.topic === topicName && fact.subtopic === subtopicName)
    .at(-1) || null;
}

function getAnyArchivedFactForSelection(log, voiceId, topicName, subtopicName, hostId = DEFAULT_HOST_ID) {
  const normalizedHostId = normalizeHostId(hostId);
  return normalizeFactLog(log).facts
    .filter((fact) => (
      fact.voiceId === voiceId
      && fact.audioUrl
      && fact.topic === topicName
      && fact.subtopic === subtopicName
      && normalizeHostId(fact.hostId) === normalizedHostId
    ))
    .at(-1) || null;
}

async function factAudioExists(config, fact) {
  const audioPath = resolveArchiveAudioPath(config, fact.audioUrl);
  if (!audioPath) return false;

  try {
    const stats = await fs.promises.stat(audioPath);
    return stats.isFile();
  } catch {
    return false;
  }
}

function resolveArchiveAudioPath(config, audioUrl) {
  if (!audioUrl) return null;

  let pathname = String(audioUrl);
  try {
    pathname = /^https?:\/\//i.test(pathname) ? new URL(pathname).pathname : pathname.split(/[?#]/)[0];
  } catch {
    return null;
  }

  if (!pathname.startsWith("/archive/")) return null;

  let relativePath;
  try {
    relativePath = decodeURIComponent(pathname.slice("/archive/".length));
  } catch {
    return null;
  }

  const archiveDir = path.resolve(config.archiveDir);
  const audioPath = path.resolve(archiveDir, relativePath);
  if (!audioPath.startsWith(`${archiveDir}${path.sep}`)) return null;

  return audioPath;
}

function normalizeFactLog(payload = {}) {
  const facts = Array.isArray(payload.facts) ? payload.facts : [];
  return {
    cursor: normalizeCursor(payload.cursor),
    facts: facts
      .map((fact) => ({
        id: String(fact.id || ""),
        createdAt: String(fact.createdAt || ""),
        topic: String(fact.topic || fact.theme || ""),
        topicIndex: Number.isFinite(Number(fact.topicIndex)) ? Number(fact.topicIndex) : null,
        subtopic: String(fact.subtopic || ""),
        subtopicIndex: Number.isFinite(Number(fact.subtopicIndex)) ? Number(fact.subtopicIndex) : null,
        text: String(fact.text || ""),
        audioUrl: fact.audioUrl ? String(fact.audioUrl) : null,
        archivePath: fact.archivePath ? String(fact.archivePath) : null,
        voiceId: fact.voiceId ? String(fact.voiceId) : null,
        promptRevision: normalizePromptRevision(fact.promptRevision),
        hostId: normalizeHostId(fact.hostId),
        hostName: fact.hostName ? String(fact.hostName) : null,
      }))
      .filter((fact) => fact.topic && fact.text),
  };
}

function normalizeHostId(value) {
  return String(value || DEFAULT_HOST_ID)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || DEFAULT_HOST_ID;
}

function normalizeCursor(cursor = {}) {
  return {
    topicIndex: Math.max(0, Math.floor(Number(cursor.topicIndex) || 0)),
    subtopicIndex: Math.max(0, Math.floor(Number(cursor.subtopicIndex) || 0)),
  };
}

function normalizePromptRevision(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

module.exports = {
  addFactLogEntry,
  getArchivedFactForSelection,
  getAnyArchivedFactForSelection,
  advanceCursor,
  getArchivedFacts,
  getRecentFacts,
  readAvailableFactLog,
  readFactLog,
  setCursor,
};
