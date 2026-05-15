const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");

loadDotEnv();

const config = {
  rootDir,
  port: Number(process.env.PORT || 3000),
  musicDir: resolveConfigDir(process.env.MUSIC_DIR, path.join(rootDir, "music")),
  liveMusicDir: resolveConfigDir(process.env.LIVE_MUSIC_DIR, path.join(process.env.MUSIC_DIR || path.join(rootDir, "music"), "live")),
  playMusicDir: resolveConfigDir(process.env.PLAY_MUSIC_DIR, path.join(process.env.MUSIC_DIR || path.join(rootDir, "music"), "play")),
  cacheDir: resolveConfigDir(process.env.CACHE_DIR, path.join(rootDir, ".cache", "announcements")),
  archiveDir: resolveConfigDir(process.env.ARCHIVE_DIR, path.join(rootDir, ".cache", "archive")),
  logDir: resolveConfigDir(process.env.LOG_DIR, path.join(rootDir, ".cache", "logs")),
  adminConfigPath: resolveConfigFile(process.env.ADMIN_CONFIG_PATH, path.join(rootDir, ".cache", "config", "admin.json")),
  factLogPath: resolveConfigFile(process.env.FACT_LOG_PATH, path.join(rootDir, ".cache", "config", "fact-log.json")),
  topicCycleStatePath: resolveConfigFile(process.env.TOPIC_CYCLE_STATE_PATH, path.join(rootDir, ".cache", "config", "topic-cycle.json")),
  listenerStorePath: resolveConfigFile(process.env.LISTENER_STORE_PATH, path.join(rootDir, ".cache", "config", "listeners.json")),
  publicRadioUrl: process.env.PUBLIC_RADIO_URL || `http://localhost:${process.env.PORT || 3000}`,
  listenerApiToken: process.env.LISTENER_API_TOKEN || "",
  listenerQuestionPriceStars: clampPositiveInteger(process.env.LISTENER_QUESTION_PRICE_STARS, 50),
  listenerAccess: {
    allowedTelegramIds: parseList(process.env.LISTENER_ALLOWED_TELEGRAM_IDS),
    allowedUsernames: parseList(process.env.LISTENER_ALLOWED_USERNAMES).map((item) => item.toLowerCase()),
    unlimitedTelegramIds: parseList(process.env.LISTENER_UNLIMITED_TELEGRAM_IDS),
    unlimitedUsernames: parseList(process.env.LISTENER_UNLIMITED_USERNAMES).map((item) => item.toLowerCase()),
    adminTelegramIds: parseList(process.env.LISTENER_ADMIN_TELEGRAM_IDS || process.env.BOT_ADMIN_TELEGRAM_IDS),
    adminUsernames: parseList(process.env.LISTENER_ADMIN_USERNAMES || process.env.BOT_ADMIN_USERNAMES).map((item) => item.toLowerCase()),
  },
  admin: {
    username: process.env.ADMIN_USERNAME || "admin",
    password: process.env.ADMIN_PASSWORD || "",
  },
  database: {
    enabled: process.env.POSTGRES_ENABLED !== "false" && Boolean(process.env.POSTGRES_PASSWORD),
    host: process.env.POSTGRES_HOST || "postgres",
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB || "radio",
    user: process.env.POSTGRES_USER || "radio",
    password: process.env.POSTGRES_PASSWORD || "",
    ssl: process.env.POSTGRES_SSL === "true",
  },
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || "",
    model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    url: process.env.DEEPSEEK_URL || "https://api.deepseek.com/chat/completions",
    balanceUrl: process.env.DEEPSEEK_BALANCE_URL || "",
  },
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY || "",
    voiceId: process.env.ELEVENLABS_VOICE_ID || "",
    model: process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2",
    baseUrl: process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io",
  },
};

function ensureRuntimeDirs() {
  fs.mkdirSync(config.musicDir, { recursive: true });
  fs.mkdirSync(config.liveMusicDir, { recursive: true });
  fs.mkdirSync(config.playMusicDir, { recursive: true });
  fs.mkdirSync(config.cacheDir, { recursive: true });
  fs.mkdirSync(config.archiveDir, { recursive: true });
  fs.mkdirSync(config.logDir, { recursive: true });
  fs.mkdirSync(path.dirname(config.adminConfigPath), { recursive: true });
  fs.mkdirSync(path.dirname(config.factLogPath), { recursive: true });
  fs.mkdirSync(path.dirname(config.topicCycleStatePath), { recursive: true });
  fs.mkdirSync(path.dirname(config.listenerStorePath), { recursive: true });
  if (!config.listenerApiToken) {
    console.warn("LISTENER_API_TOKEN is empty. Telegram listener API is closed until the token is configured.");
  }
  if (!config.admin.password) {
    console.warn("ADMIN_PASSWORD is empty. Admin area is inaccessible until ADMIN_PASSWORD is configured.");
  }
}

function resolveConfigDir(value, fallback) {
  if (!value) return path.resolve(fallback);
  return path.resolve(path.isAbsolute(value) ? value : path.join(rootDir, value));
}

function resolveConfigFile(value, fallback) {
  if (!value) return path.resolve(fallback);
  return path.resolve(path.isAbsolute(value) ? value : path.join(rootDir, value));
}

function loadDotEnv() {
  const filePath = path.join(rootDir, ".env");
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function clampPositiveInteger(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

module.exports = { config, ensureRuntimeDirs };
