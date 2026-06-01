const fs = require("node:fs");
const path = require("node:path");
const { listTracks } = require("./music");

const DEFAULT_VIBE = "chill";
const MUSIC_ROLES = ["live", "play", "jingle", "transition"];
const ROLE_FOLDERS = {
  live: "live",
  play: "play",
  jingle: "jingles",
  transition: "transitions",
};

async function ensureMusicCatalogDirs(config) {
  const vibe = normalizeMusicVibe(config.activeMusicVibe || DEFAULT_VIBE);
  await Promise.all(MUSIC_ROLES.map((role) => fs.promises.mkdir(getMusicRoleDir(config, vibe, role), { recursive: true })));
}

async function listMusicCatalog(config, options = {}) {
  const vibe = normalizeMusicVibe(options.vibe || config.activeMusicVibe || DEFAULT_VIBE);
  const roles = {};

  for (const role of MUSIC_ROLES) {
    const dir = getMusicRoleDir(config, vibe, role);
    const tracks = await listTracks(dir, {
      urlPrefix: getMusicUrlPrefix(vibe, role),
      filePrefix: `${vibe}/${ROLE_FOLDERS[role]}`,
    }).catch(() => []);
    roles[role] = {
      role,
      folder: ROLE_FOLDERS[role],
      dir,
      urlPrefix: getMusicUrlPrefix(vibe, role),
      tracks,
      count: tracks.length,
    };
  }

  return {
    activeVibe: vibe,
    vibes: [{
      id: vibe,
      brand: "BAA Vibe",
      name: "BAA Vibe Chill Radio",
      roles,
      counts: Object.fromEntries(Object.entries(roles).map(([role, data]) => [role, data.count])),
    }],
  };
}

function getMusicRoleDir(config, vibe, role) {
  return path.join(config.musicDir, normalizeMusicVibe(vibe), ROLE_FOLDERS[normalizeMusicRole(role)]);
}

function getMusicUrlPrefix(vibe, role) {
  return `/music/${encodeURIComponent(normalizeMusicVibe(vibe))}/${ROLE_FOLDERS[normalizeMusicRole(role)]}`;
}

function normalizeMusicVibe(value) {
  const normalized = String(value || DEFAULT_VIBE)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || DEFAULT_VIBE;
}

function normalizeMusicRole(value) {
  const role = String(value || "").toLowerCase().trim();
  if (role === "live") return "live";
  if (role === "play") return "play";
  if (role === "jingle" || role === "jingles") return "jingle";
  if (role === "transition" || role === "transitions") return "transition";
  const error = new Error("Music role must be live, play, jingle, or transition");
  error.statusCode = 400;
  throw error;
}

module.exports = {
  DEFAULT_VIBE,
  MUSIC_ROLES,
  ROLE_FOLDERS,
  ensureMusicCatalogDirs,
  getMusicRoleDir,
  getMusicUrlPrefix,
  listMusicCatalog,
  normalizeMusicRole,
  normalizeMusicVibe,
};
