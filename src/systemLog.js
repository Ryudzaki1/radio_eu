const fs = require("node:fs");
const path = require("node:path");

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
let cleanupDueAt = 0;

async function writeSystemLog(config, event, data = {}) {
  const logDir = config.logDir;
  if (!logDir) return;

  const now = new Date();
  const filePath = path.join(logDir, `${bucketName(now)}.jsonl`);
  const entry = {
    ts: now.toISOString(),
    event,
    ...sanitize(data),
  };

  try {
    await fs.promises.mkdir(logDir, { recursive: true });
    await fs.promises.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
    if (Date.now() >= cleanupDueAt) {
      cleanupDueAt = Date.now() + 60 * 60 * 1000;
      cleanupOldLogs(logDir).catch(() => {});
    }
  } catch (error) {
    console.warn(`system log failed: ${error.message}`);
  }
}

async function readRecentSystemLogs(config, limit = 200) {
  const logDir = config.logDir;
  let entries = [];
  try {
    entries = await fs.promises.readdir(logDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(logDir, entry.name))
    .sort()
    .slice(-8);

  const lines = [];
  for (const file of files) {
    try {
      const content = await fs.promises.readFile(file, "utf8");
      lines.push(...content.split(/\r?\n/).filter(Boolean));
    } catch {}
  }

  return lines.slice(-limit).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { ts: "", event: "invalid_log_line", line };
    }
  });
}

function bucketName(date) {
  const hour = Math.floor(date.getUTCHours() / 3) * 3;
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    String(hour).padStart(2, "0"),
  ].join("-");
}

async function cleanupOldLogs(logDir) {
  const cutoff = Date.now() - RETENTION_MS;
  const entries = await fs.promises.readdir(logDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return;
    const filePath = path.join(logDir, entry.name);
    const stats = await fs.promises.stat(filePath).catch(() => null);
    if (stats && stats.mtimeMs < cutoff) {
      await fs.promises.rm(filePath, { force: true }).catch(() => {});
    }
  }));
}

function sanitize(data) {
  const result = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (/key|token|password|secret/i.test(key)) continue;
    if (typeof value === "string") {
      result[key] = value.length > 500 ? `${value.slice(0, 500)}...` : value;
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      result[key] = value;
    } else if (Array.isArray(value)) {
      result[key] = value.slice(0, 20);
    } else if (value && typeof value === "object") {
      const serialized = JSON.stringify(value);
      result[key] = serialized.length > 1000 ? `${serialized.slice(0, 1000)}...` : value;
    }
  }
  return result;
}

module.exports = { readRecentSystemLogs, writeSystemLog };
