const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const audioTypes = new Map([
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".ogg", "audio/ogg"],
  [".m4a", "audio/mp4"],
  [".aac", "audio/aac"],
  [".flac", "audio/flac"],
]);

async function listTracks(musicDir, options = {}) {
  const urlPrefix = String(options.urlPrefix || "/music").replace(/\/+$/, "");
  const entries = await fs.promises.readdir(musicDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && audioTypes.has(path.extname(entry.name).toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true }))
    .map((entry) => ({
      id: hash(entry.name).slice(0, 12),
      title: prettifyTitle(entry.name),
      file: entry.name,
      url: `${urlPrefix}/${encodeURIComponent(entry.name)}`,
    }));
}

function getAudioType(filePath) {
  return audioTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
}

function resolveInside(baseDir, unsafeName) {
  const filePath = path.resolve(baseDir, unsafeName);
  if (!filePath.startsWith(`${baseDir}${path.sep}`)) {
    const error = new Error("Invalid path");
    error.statusCode = 400;
    throw error;
  }
  return filePath;
}

function prettifyTitle(fileName) {
  return path
    .basename(fileName, path.extname(fileName))
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

module.exports = { getAudioType, hash, listTracks, resolveInside };
