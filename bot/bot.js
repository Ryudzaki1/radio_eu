const fs = require("node:fs");
const path = require("node:path");

const token = process.env.TELEGRAM_BOT_TOKEN;
const radioUrl = process.env.RADIO_INTERNAL_URL || "http://radio:3000";
const publicRadioUrl = process.env.PUBLIC_RADIO_URL || "http://localhost:3000";
const listenerApiToken = process.env.LISTENER_API_TOKEN || "";
const allowedTelegramIds = parseList(process.env.BOT_ALLOWED_TELEGRAM_IDS);
const allowedUsernames = parseList(process.env.BOT_ALLOWED_USERNAMES).map((item) => item.toLowerCase());
const notifyChatIds = parseList(process.env.BOT_NOTIFY_CHAT_IDS);
const linkStatePath = process.env.BOT_LINK_STATE_PATH || "";
const publicUrlStatePath = process.env.PUBLIC_URL_STATE_PATH || "/cache/config/public-url.json";
const listenerStorePath = process.env.LISTENER_STORE_PATH || "/cache/config/listeners.json";

if (!token || !listenerApiToken) {
  console.error("TELEGRAM_BOT_TOKEN and LISTENER_API_TOKEN are required");
  process.exit(1);
}

let offset = 0;

scheduleRadioLinkNotification();
setupBotCommands().catch((error) => console.error(`bot commands error: ${error.message}`));

poll().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function poll() {
  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message"],
      });

      for (const update of updates.result || []) {
        offset = update.update_id + 1;
        if (update.message) await handleMessage(update.message);
      }
    } catch (error) {
      console.error(`poll error: ${error.message}`);
      await delay(3000);
    }
  }
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const telegramId = String(message.from.id);
  const text = String(message.text || "").trim();
  const username = message.from.username || "";
  const profileName = getProfileName(message.from);
  const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();

  if (!isBotUserAllowed(message.from)) {
    await sendAccessDenied(chatId);
    return;
  }

  if (command === "/start") {
    const result = await radio("/api/listeners/start", { telegramId, username, name: profileName });
    const currentPublicUrl = await getPublicRadioUrl();
    if (!result.ok) {
      await sendRegistrationError(chatId, result);
      return;
    }
    if (isOutOfQuestions(result.user)) {
      await sendLimit(chatId);
      return;
    }
    if (result.needsName) {
      await sendStartIntro(chatId, currentPublicUrl);
      return;
    }
    await sendIntro(chatId, result.user.name, currentPublicUrl);
    return;
  }

  if (command === "/radio") {
    const currentPublicUrl = await getPublicRadioUrl();
    await sendRadioLink(chatId, [
      "Актуальная ссылка на эфир Sweetie Fox:",
      "",
      `<a href="${escapeHtml(currentPublicUrl)}">${escapeHtml(currentPublicUrl)}</a>`,
    ].join("\n"), currentPublicUrl);
    return;
  }

  if (command === "/question") {
    await sendQuestionPrompt(chatId);
    return;
  }

  if (text.startsWith("/")) {
    await send(chatId, "Доступные команды: /radio — ссылка на эфир, /question — задать вопрос.");
    return;
  }

  const status = await radio("/api/listeners/status", { telegramId, username });
  if (!status.ok) {
    if (status.reason === "forbidden") {
      await sendAccessDenied(chatId);
      return;
    }
    await send(chatId, "Нажми /start, чтобы заново подключиться к эфиру.");
    return;
  }

  if (isOutOfQuestions(status.user)) {
    await sendLimit(chatId);
    return;
  }

  if (status.needsName) {
    const named = await radio("/api/listeners/name", { telegramId, name: profileName });
    if (!named.ok) {
      await send(chatId, "Не получилось сохранить имя. Нажми /start и попробуй еще раз.");
      return;
    }
    status.user = named.user;
  }

  const accepted = await radio("/api/listeners/question", {
    telegramId,
    username,
    question: text,
  });

  if (!accepted.ok && accepted.reason === "limit") {
    await sendLimit(chatId);
    return;
  }
  if (!accepted.ok && accepted.reason === "forbidden") {
    await sendAccessDenied(chatId);
    return;
  }
  if (!accepted.ok && accepted.reason === "empty") {
    await send(chatId, "Пришли вопрос текстом, чтобы я поставила его в очередь эфира. Пустые сообщения лимит не тратят.");
    return;
  }
  if (!accepted.ok) {
    await send(chatId, "Сейчас вопрос не принят. Нажми /start и попробуй снова.");
    return;
  }

  await send(chatId, [
    "Вопрос принят в очередь эфира.",
    `Осталось бесплатных вопросов: ${formatRemaining(accepted.user)}.`,
    "Открой эфир и слушай: Sweetie Fox ответит в общей очереди.",
  ].join("\n"));
}

async function sendStartIntro(chatId, publicUrl) {
  await sendRadioLink(chatId, [
    "Привет. Я сохраню тебя как слушателя AI Chill Radio.",
    "",
    `<a href="${escapeHtml(publicUrl)}">Открыть эфир Sweetie Fox</a>`,
    "",
    "Открой ссылку, нажми Play в браузере, а потом напиши здесь свое имя.",
    "После этого каждое новое сообщение в этом чате будет вопросом для диктора.",
    "",
    "Как тебя зовут?",
  ].join("\n"), publicUrl);
}

async function sendIntro(chatId, name, publicUrl) {
  await sendRadioLink(chatId, [
    `Приятно познакомиться, ${escapeHtml(name)}.`,
    "",
    `<a href="${escapeHtml(publicUrl)}">Открыть эфир Sweetie Fox</a>`,
    "",
    "Теперь каждое новое сообщение в этом чате будет вопросом для Sweetie Fox в эфире.",
  ].join("\n"), publicUrl);
  await send(chatId, "Какой факт ты хочешь услышать от Sweetie Fox?");
}

async function sendQuestionPrompt(chatId) {
  await send(chatId, "Напиши вопрос одним сообщением. Я передам его Sweetie Fox в очередь эфира.");
}

async function sendRegistrationError(chatId, result) {
  if (result.reason === "forbidden") {
    await sendAccessDenied(chatId);
    return;
  }
  if (result.reason === "closed") {
    await send(chatId, "Регистрация закрыта: первые 9 слушателей уже заняли места в эфире.");
    return;
  }
  await send(chatId, "Сейчас регистрация недоступна. Попробуй позже.");
}

async function sendLimit(chatId) {
  await send(chatId, "Бесплатные вопросы закончились. Лимит строгий: новых бесплатных вопросов нет.");
}

async function sendAccessDenied(chatId) {
  await send(chatId, "Сейчас бот закрыт для тестирования. Доступ есть только у администратора эфира.");
}

async function radio(requestPath, body) {
  const response = await fetchWithTimeout(`${radioUrl}${requestPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Radio-Listener-Token": listenerApiToken,
    },
    body: JSON.stringify(body),
  }, 20_000);
  return response.json();
}

async function telegram(method, body) {
  const response = await fetchWithTimeout(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 35_000);
  const payload = await response.json();
  if (!payload.ok) throw new Error(`${method}: ${JSON.stringify(payload)}`);
  return payload;
}

async function send(chatId, text) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
}

async function sendRadioLink(chatId, text, url) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[
        { text: "Слушать эфир", url },
      ]],
    },
  });
}

async function sendRadioLink(chatId, text, url) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

async function setupBotCommands() {
  await telegram("setMyCommands", {
    commands: [
      { command: "start", description: "Запуск и регистрация" },
      { command: "radio", description: "Получить актуальную ссылку на эфир" },
      { command: "question", description: "Задать вопрос Sweetie Fox" },
    ],
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getProfileName(from = {}) {
  const parts = [from.first_name, from.last_name]
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  return parts.join(" ").slice(0, 80) || String(from.username || "").trim().slice(0, 80) || "слушатель";
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isBotUserAllowed(from = {}) {
  if (!allowedTelegramIds.length && !allowedUsernames.length) return true;
  const telegramId = String(from.id || "");
  const username = String(from.username || "").trim().toLowerCase();
  return allowedTelegramIds.includes(telegramId) || Boolean(username && allowedUsernames.includes(username));
}

function isOutOfQuestions(user = {}) {
  return !user.unlimited && Number(user.remaining) <= 0;
}

function formatRemaining(user = {}) {
  return user.unlimited ? "безлимит" : String(Math.max(0, Number(user.remaining) || 0));
}

async function getPublicRadioUrl() {
  try {
    const payload = JSON.parse(await fs.promises.readFile(publicUrlStatePath, "utf8"));
    if (isValidPublicUrl(payload.url)) return payload.url;
  } catch {}
  return publicRadioUrl;
}

function isValidPublicUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

async function notifyRadioLinkChange() {
  const currentPublicUrl = await getPublicRadioUrl();
  if (!currentPublicUrl || !notifyChatIds.length || !linkStatePath) return;

  let previousUrl = "";
  try {
    previousUrl = JSON.parse(await fs.promises.readFile(linkStatePath, "utf8")).url || "";
  } catch {}

  if (previousUrl === currentPublicUrl) return;

  for (const chatId of notifyChatIds) {
    await sendRadioLink(chatId, [
      "Ссылка на эфир обновилась.",
      "",
      `<a href="${escapeHtml(publicRadioUrl)}">Открыть эфир Sweetie Fox</a>`,
    ].join("\n"), publicRadioUrl);
  }

  await fs.promises.mkdir(path.dirname(linkStatePath), { recursive: true });
  await fs.promises.writeFile(linkStatePath, JSON.stringify({
    url: publicRadioUrl,
    updatedAt: new Date().toISOString(),
  }, null, 2), "utf8");
}

function scheduleRadioLinkNotification(attempt = 1) {
  notifyRadioLinkChange().catch((error) => {
    console.error(`radio link notification error: ${error.message}`);
    const nextAttempt = attempt + 1;
    const timeout = Math.min(60_000, 5_000 * nextAttempt);
    setTimeout(() => scheduleRadioLinkNotification(nextAttempt), timeout);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function notifyRadioLinkChange() {
  const currentPublicUrl = await getPublicRadioUrl();
  if (!currentPublicUrl || !notifyChatIds.length || !linkStatePath) return;

  let previousUrl = "";
  try {
    previousUrl = JSON.parse(await fs.promises.readFile(linkStatePath, "utf8")).url || "";
  } catch {}

  if (previousUrl === currentPublicUrl) return;

  for (const chatId of notifyChatIds) {
    await sendRadioLink(chatId, [
      "Ссылка на эфир обновилась.",
      "",
      `<a href="${escapeHtml(currentPublicUrl)}">Открыть эфир Sweetie Fox</a>`,
    ].join("\n"), currentPublicUrl);
  }

  await fs.promises.mkdir(path.dirname(linkStatePath), { recursive: true });
  await fs.promises.writeFile(linkStatePath, JSON.stringify({
    url: currentPublicUrl,
    updatedAt: new Date().toISOString(),
  }, null, 2), "utf8");
}

function scheduleRadioLinkNotification(attempt = 1) {
  notifyRadioLinkChange().then(() => {
    setTimeout(() => scheduleRadioLinkNotification(1), 30_000);
  }).catch((error) => {
    console.error(`radio link notification error: ${error.message}`);
    const nextAttempt = attempt + 1;
    const timeout = Math.min(60_000, 5_000 * nextAttempt);
    setTimeout(() => scheduleRadioLinkNotification(nextAttempt), timeout);
  });
}

async function notifyRadioLinkChange() {
  const currentPublicUrl = await getPublicRadioUrl();
  if (!currentPublicUrl || !linkStatePath) return;

  let previousUrl = "";
  let history = [];
  try {
    const state = JSON.parse(await fs.promises.readFile(linkStatePath, "utf8"));
    previousUrl = state.url || "";
    history = Array.isArray(state.history) ? state.history : [];
  } catch {}

  if (previousUrl === currentPublicUrl) return;

  const recipients = await getLinkNotificationChatIds();
  for (const chatId of recipients) {
    await sendRadioLink(chatId, [
      "Ссылка на эфир обновилась.",
      "",
      `<a href="${escapeHtml(currentPublicUrl)}">Открыть эфир Sweetie Fox</a>`,
    ].join("\n"), currentPublicUrl);
  }

  if (previousUrl) {
    history.push({
      previousUrl,
      currentUrl: currentPublicUrl,
      changedAt: new Date().toISOString(),
      notifiedChatIds: recipients,
    });
  }

  await fs.promises.mkdir(path.dirname(linkStatePath), { recursive: true });
  await fs.promises.writeFile(linkStatePath, JSON.stringify({
    url: currentPublicUrl,
    previousUrl,
    updatedAt: new Date().toISOString(),
    notifiedChatIds: recipients,
    history: history.slice(-50),
  }, null, 2), "utf8");
}

async function getLinkNotificationChatIds() {
  const ids = new Set(notifyChatIds);
  try {
    const state = JSON.parse(await fs.promises.readFile(linkStatePath, "utf8"));
    for (const chatId of state.notifiedChatIds || []) {
      ids.add(String(chatId));
    }
    for (const item of state.history || []) {
      for (const chatId of item.notifiedChatIds || []) {
        ids.add(String(chatId));
      }
    }
  } catch {}
  try {
    const store = JSON.parse(await fs.promises.readFile(listenerStorePath, "utf8"));
    for (const user of store.users || []) {
      if (user.telegramId) ids.add(String(user.telegramId));
    }
  } catch {}
  return [...ids].filter(Boolean);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
