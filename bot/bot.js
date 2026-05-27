const fs = require("node:fs");
const path = require("node:path");
const dns = require("node:dns").promises;

const token = process.env.TELEGRAM_BOT_TOKEN;
const telegramApiBaseUrl = normalizeBaseUrl(process.env.TELEGRAM_API_BASE_URL || "https://api.telegram.org");
const radioUrl = process.env.RADIO_INTERNAL_URL || "http://radio:3000";
const publicRadioUrl = process.env.PUBLIC_RADIO_URL || "http://localhost:3000";
const listenerApiToken = process.env.LISTENER_API_TOKEN || "";
const allowedTelegramIds = parseList(process.env.BOT_ALLOWED_TELEGRAM_IDS);
const allowedUsernames = parseList(process.env.BOT_ALLOWED_USERNAMES).map((item) => item.toLowerCase());
const notifyChatIds = parseList(process.env.BOT_NOTIFY_CHAT_IDS);
const adminTelegramIds = parseList(process.env.BOT_ADMIN_TELEGRAM_IDS);
const adminUsernames = parseList(process.env.BOT_ADMIN_USERNAMES).map((item) => item.toLowerCase());
const linkStatePath = process.env.BOT_LINK_STATE_PATH || "";
const publicUrlStatePath = process.env.PUBLIC_URL_STATE_PATH || "/cache/config/public-url.json";
const publicUrlHealthStatePath = process.env.PUBLIC_URL_HEALTH_STATE_PATH || "/cache/config/public-url-health.json";
const aiUsageStatePath = process.env.AI_USAGE_STATE_PATH || "/cache/config/ai-usage.json";
const aiUsageNotifyIntervalMs = clampNumber(process.env.AI_USAGE_NOTIFY_INTERVAL_MS, 60 * 60_000, 24 * 60 * 60_000, 6 * 60 * 60_000);
const aiUsageNotifyThresholdPercent = clampNumber(process.env.AI_USAGE_NOTIFY_THRESHOLD_PERCENT, 1, 100, 15);
const publicUrlHealthIntervalMs = clampNumber(process.env.PUBLIC_URL_HEALTH_INTERVAL_MS, 60_000, 24 * 60 * 60_000, 5 * 60_000);
const publicServerIp = String(process.env.PUBLIC_SERVER_IP || process.env.RU_PUBLIC_IP || "").trim();
const listenerStorePath = process.env.LISTENER_STORE_PATH || "/cache/config/listeners.json";
const questionPriceStars = clampNumber(process.env.LISTENER_QUESTION_PRICE_STARS, 1, 100_000, 50);
const deepseekConfig = {
  apiKey: process.env.DEEPSEEK_API_KEY || "",
  url: process.env.DEEPSEEK_URL || "https://api.deepseek.com/chat/completions",
  balanceUrl: process.env.DEEPSEEK_BALANCE_URL || "",
};
const elevenlabsConfig = {
  apiKey: process.env.ELEVENLABS_API_KEY || "",
  baseUrl: process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io",
};
const adminPanelLabels = {
  question: "Задать вопрос",
  radio: "Ссылка на эфир",
  tokens: "Остаток токенов",
  stars: "Баланс Stars",
};
const userPanelLabels = {
  question: "Задать вопрос",
  radio: "Ссылка на эфир",
};

if (!token || !listenerApiToken) {
  console.error("TELEGRAM_BOT_TOKEN and LISTENER_API_TOKEN are required");
  process.exit(1);
}

let offset = 0;
const pendingAdminQuestionChatIds = new Set();
const pendingUserQuestionChatIds = new Set();
const pendingUserNameChatIds = new Set();
const clearedReplyKeyboardChatIds = new Set();

scheduleRadioLinkNotification();
schedulePublicUrlHealthCheck();
scheduleAiUsageNotification();
setupBotInterface().catch((error) => console.error(`bot interface error: ${error.message}`));

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
        allowed_updates: ["message", "callback_query", "pre_checkout_query"],
      });

      for (const update of updates.result || []) {
        if (update.message) await handleMessage(update.message);
        if (update.callback_query) await handleCallbackQuery(update.callback_query);
        if (update.pre_checkout_query) await handlePreCheckoutQuery(update.pre_checkout_query);
        offset = update.update_id + 1;
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
  const isAdmin = isBotAdmin(message.from);
  const adminQuestionIsPending = pendingAdminQuestionChatIds.has(String(chatId));
  const userQuestionIsPending = pendingUserQuestionChatIds.has(String(chatId));
  const userNameIsPending = pendingUserNameChatIds.has(String(chatId));

  const canAskQuestions = isAdmin || isQuestionUserAllowed(message.from);

  if (message.successful_payment) {
    await handleSuccessfulPayment(message);
    return;
  }

  if (command === "/start") {
    const currentPublicUrl = await getPublicRadioUrl();
    if (isAdmin) {
      await sendAdminPanel(chatId, currentPublicUrl);
      return;
    }
    if (!canAskQuestions) {
      await sendListenOnlyIntro(chatId, currentPublicUrl);
      return;
    }

    const result = await radio("/api/listeners/start", { telegramId, username, name: profileName });
    if (!result.ok) {
      await sendRegistrationError(chatId, result);
      return;
    }
    if (result.needsName) {
      await sendStartIntro(chatId, currentPublicUrl);
      return;
    }
    await sendIntro(chatId, result.user.name, currentPublicUrl);
    return;
  }

  if (isAdmin && isAdminPanelText(text, adminPanelLabels.question)) {
    await startAdminQuestionMode(chatId);
    return;
  }

  if (isAdmin && isAdminPanelText(text, adminPanelLabels.radio)) {
    await sendRadioLinkMessage(chatId);
    return;
  }

  if (isAdmin && isAdminPanelText(text, adminPanelLabels.tokens)) {
    await sendAiUsageReport(chatId);
    return;
  }

  if (isAdmin && isAdminPanelText(text, adminPanelLabels.stars)) {
    await sendStarBalanceReport(chatId);
    return;
  }

  if (command === "/tokens") {
    if (!isAdmin) {
      await sendAccessDenied(chatId);
      return;
    }
    await sendAiUsageReport(chatId);
    return;
  }

  if (command === "/stars") {
    if (!isAdmin) {
      await sendAccessDenied(chatId);
      return;
    }
    await sendStarBalanceReport(chatId);
    return;
  }

  if (command === "/radio") {
    await sendRadioLinkMessage(chatId);
    return;
  }

  if (command === "/menu") {
    if (isAdmin) {
      await sendAdminPanel(chatId, await getPublicRadioUrl(), { includeRadioLink: false });
    } else if (canAskQuestions) {
      await sendUserMenu(chatId, await getPublicRadioUrl(), { includeRadioLink: false });
    } else {
      await sendListenOnly(chatId, await getPublicRadioUrl());
    }
    return;
  }

  if (command === "/question") {
    if (!canAskQuestions) {
      await sendListenOnly(chatId, await getPublicRadioUrl());
      return;
    }
    if (isAdmin) {
      await startAdminQuestionMode(chatId);
    } else {
      await startUserQuestionMode(chatId, { telegramId, username });
    }
    return;
  }

  if (text.startsWith("/")) {
    await send(chatId, canAskQuestions
      ? "Доступные команды: /menu — главное меню, /radio — открыть эфир, /question — задать вопрос."
      : "Доступная команда: /radio — открыть эфир.");
    return;
  }

  if (!canAskQuestions) {
    await sendListenOnly(chatId, await getPublicRadioUrl());
    return;
  }

  if (!isAdmin && userNameIsPending) {
    const named = await radio("/api/listeners/name", { telegramId, name: text });
    if (!named.ok) {
      await send(chatId, "Не получилось сохранить имя. Нажми /start и попробуй еще раз.");
      return;
    }
    pendingUserNameChatIds.delete(String(chatId));
    await sendIntro(chatId, named.user.name, await getPublicRadioUrl());
    return;
  }

  if (isAdmin && !adminQuestionIsPending) {
    await send(chatId, "Чтобы отправить вопрос в эфир, сначала нажми «Задать вопрос» в меню.", buildAdminPanelReplyMarkup());
    return;
  }

  if (!isAdmin && !userQuestionIsPending) {
    await send(chatId, "Сначала выбери действие в главном меню.", buildUserMenuReplyMarkup());
    return;
  }

  if (isAdmin) {
    pendingAdminQuestionChatIds.delete(String(chatId));
    await radio("/api/listeners/start", { telegramId, username, name: profileName }).catch((error) => {
      console.error(`admin listener registration failed: ${error.message}`);
    });
  }

  if (!isAdmin) {
    pendingUserQuestionChatIds.delete(String(chatId));
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

  if (!accepted.ok && accepted.reason === "forbidden") {
    await sendAccessDenied(chatId);
    return;
  }
  if (!accepted.ok && accepted.reason === "empty") {
    await send(chatId, "Пришли вопрос текстом. Пустые сообщения лимит не тратят.");
    return;
  }
  if (!accepted.ok) {
    await send(chatId, "Сейчас вопрос не принят. Нажми /start и попробуй снова.");
    return;
  }

  if (accepted.requiresPayment) {
    await send(chatId, [
      "Бесплатный вопрос уже использован.",
      `Чтобы отправить этот вопрос в эфир, оплати ${accepted.question.priceStars} Stars.`,
    ].join("\n"));
    try {
      await sendQuestionInvoice(chatId, accepted.question);
    } catch (error) {
      console.error(`question invoice failed: ${error.message}`);
      await send(chatId, "Не удалось выставить счет Stars. Вопрос пока не поставлен в эфир, попробуй позже или напиши администратору.");
      if (isAdmin) {
        await sendAdminPanel(chatId, await getPublicRadioUrl(), { includeRadioLink: false });
      } else {
        await sendUserMenu(chatId, await getPublicRadioUrl(), { includeRadioLink: false });
      }
    }
    return;
  }

  await sendRadioLink(chatId, [
    "Вопрос принят в очередь эфира.",
    `Осталось бесплатных вопросов: ${formatRemaining(accepted.user)}.`,
    "Открой эфир и слушай: Sweetie Fox ответит в общей очереди.",
  ].join("\n"), await getPublicRadioUrl());
  if (isAdmin) {
    await sendAdminPanel(chatId, await getPublicRadioUrl(), { includeRadioLink: false });
  } else {
    await sendUserMenu(chatId, await getPublicRadioUrl(), { includeRadioLink: false });
  }
}

async function handleCallbackQuery(query) {
  const chatId = query.message?.chat?.id || query.from?.id;
  const data = String(query.data || "");
  if (!chatId) return;

  if (data === "user:question") {
    if (!isQuestionUserAllowed(query.from)) {
      await answerCallbackQuery(query.id, "Вопросы сейчас недоступны.");
      await sendListenOnly(chatId, await getPublicRadioUrl());
      return;
    }
    await answerCallbackQuery(query.id, "Напиши вопрос следующим сообщением.");
    await startUserQuestionMode(chatId, {
      telegramId: String(query.from.id),
      username: query.from.username || "",
    });
    return;
  }

  if (data === "user:radio") {
    await answerCallbackQuery(query.id, "Отправляю ссылку.");
    await sendRadioLinkMessage(chatId);
    return;
  }

  if (!isBotAdmin(query.from)) {
    await answerCallbackQuery(query.id, "Эта панель доступна только админу.");
    await sendAccessDenied(chatId);
    return;
  }

  if (data === "admin:question") {
    await answerCallbackQuery(query.id, "Напиши вопрос следующим сообщением.");
    await startAdminQuestionMode(chatId);
    return;
  }

  if (data === "admin:radio") {
    await answerCallbackQuery(query.id, "Отправляю ссылку.");
    await sendRadioLinkMessage(chatId);
    return;
  }

  if (data === "admin:tokens") {
    await answerCallbackQuery(query.id, "Проверяю остатки.");
    await sendAiUsageReport(chatId);
    return;
  }

  if (data === "admin:stars") {
    await answerCallbackQuery(query.id, "Проверяю Stars.");
    await sendStarBalanceReport(chatId);
    return;
  }

  await answerCallbackQuery(query.id);
}

async function handlePreCheckoutQuery(query) {
  const payload = parseQuestionInvoicePayload(query.invoice_payload);
  if (!payload) {
    await answerPreCheckoutQuery(query.id, false, "Не удалось проверить заказ.");
    return;
  }

  const result = await radio("/api/listeners/question/checkout", {
    questionId: payload.questionId,
    telegramId: String(query.from.id),
    amountStars: query.total_amount,
  });
  if (!result.ok || query.currency !== "XTR") {
    await answerPreCheckoutQuery(query.id, false, "Этот заказ уже недоступен.");
    return;
  }

  await answerPreCheckoutQuery(query.id, true);
}

async function handleSuccessfulPayment(message) {
  const chatId = message.chat.id;
  const payment = message.successful_payment;
  const payload = parseQuestionInvoicePayload(payment.invoice_payload);
  if (!payload || payment.currency !== "XTR") {
    await send(chatId, "Оплата получена, но заказ не удалось сопоставить автоматически. Напиши администратору.");
    return;
  }

  const result = await radio("/api/listeners/question/paid", {
    questionId: payload.questionId,
    telegramId: String(message.from.id),
    telegramPaymentChargeId: payment.telegram_payment_charge_id,
    rawPayload: payment,
  });
  if (!result.ok) {
    await send(chatId, "Оплата получена, но вопрос уже не удалось поставить в очередь автоматически. Напиши администратору.");
    return;
  }

  if (result.alreadyPaid) {
    await sendRadioLink(chatId, [
      "Эта оплата уже была обработана.",
      "Вопрос уже находится в очереди эфира или был поставлен туда раньше.",
      "Открой эфир и слушай Sweetie Fox.",
    ].join("\n"), await getPublicRadioUrl());
    await sendUserMenu(chatId, await getPublicRadioUrl(), { includeRadioLink: false });
    return;
  }

  await sendRadioLink(chatId, [
    "Оплата получена.",
    "Вопрос поставлен в очередь эфира.",
    "Открой эфир и слушай: Sweetie Fox ответит в общей очереди.",
  ].join("\n"), await getPublicRadioUrl());
  await notifyAdminsAboutPaidQuestion(message, result.question);
  await sendUserMenu(chatId, await getPublicRadioUrl(), { includeRadioLink: false });
}

async function sendStartIntro(chatId, publicUrl) {
  pendingUserNameChatIds.add(String(chatId));
  await sendRadioLink(chatId, [
    "Привет. Я сохраню тебя как слушателя AI Chill Radio.",
    "",
    `<a href="${escapeHtml(publicUrl)}">Открыть эфир Sweetie Fox</a>`,
    "",
    "Открой эфир, нажми Play, а потом напиши здесь свое имя.",
    "После этого появится главное меню с действиями.",
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
    "Первый вопрос диктору бесплатный. Следующие вопросы стоят 50 Stars.",
  ].join("\n"), publicUrl);
  await sendUserMenu(chatId, publicUrl, { includeRadioLink: false });
}

async function sendListenOnlyIntro(chatId, publicUrl) {
  await sendRadioLink(chatId, [
    "Привет. Сейчас бот работает в режиме прослушивания эфира.",
    "",
    `<a href="${escapeHtml(publicUrl)}">Открыть эфир Sweetie Fox</a>`,
    "",
    "Нажми кнопку, открой радио внутри Telegram и включи Play.",
    "Вопросы диктору сейчас закрыты для обычных слушателей.",
  ].join("\n"), publicUrl);
}

async function sendListenOnly(chatId, publicUrl) {
  await sendRadioLink(chatId, [
    "Сейчас доступно только прослушивание эфира.",
    "",
    `<a href="${escapeHtml(publicUrl)}">Открыть эфир Sweetie Fox</a>`,
  ].join("\n"), publicUrl);
}

async function sendQuestionPrompt(chatId) {
  await send(chatId, "Напиши вопрос одним сообщением. Если бесплатный вопрос уже использован, после текста я пришлю оплату на 50 Stars.", {
    force_reply: true,
    input_field_placeholder: "Вопрос для Sweetie Fox",
  });
}

async function startAdminQuestionMode(chatId) {
  pendingAdminQuestionChatIds.add(String(chatId));
  await send(chatId, "Напиши вопрос следующим сообщением. После отправки режим вопроса выключится.", {
    force_reply: true,
    input_field_placeholder: "Вопрос для Sweetie Fox",
  });
}

async function startUserQuestionMode(chatId, identity = {}) {
  await radio("/api/listeners/start", {
    telegramId: identity.telegramId,
    username: identity.username,
    name: identity.name || "",
  }).catch(() => {});
  pendingUserQuestionChatIds.add(String(chatId));
  await sendQuestionPrompt(chatId);
}

async function sendAdminPanel(chatId, publicUrl, options = {}) {
  if (!clearedReplyKeyboardChatIds.has(String(chatId))) {
    clearedReplyKeyboardChatIds.add(String(chatId));
    await send(chatId, "Старая клавиатура убрана. Ниже новая панель кнопок.", { remove_keyboard: true });
  }
  await send(chatId, [
    "Админ-панель Sweetie Fox.",
    "Главное меню администратора. Вернуться сюда можно командой /menu.",
  ].join("\n"), buildAdminPanelReplyMarkup());
  if (options.includeRadioLink === false) return;
  await sendRadioLink(chatId, [
    "Актуальная ссылка на эфир:",
    "",
    `<a href="${escapeHtml(publicUrl)}">${escapeHtml(publicUrl)}</a>`,
  ].join("\n"), publicUrl);
}

async function sendUserMenu(chatId, publicUrl, options = {}) {
  await send(chatId, [
    "Главное меню.",
    "Первый вопрос бесплатный. Следующие вопросы стоят 50 Stars.",
  ].join("\n"), buildUserMenuReplyMarkup());
  if (options.includeRadioLink === false) return;
  await sendRadioLink(chatId, [
    "Актуальная ссылка на эфир:",
    "",
    `<a href="${escapeHtml(publicUrl)}">${escapeHtml(publicUrl)}</a>`,
  ].join("\n"), publicUrl);
}

async function sendRadioLinkMessage(chatId) {
  const currentPublicUrl = await getPublicRadioUrl();
  await sendRadioLink(chatId, [
    "Актуальная ссылка на эфир Sweetie Fox:",
    "",
    `<a href="${escapeHtml(currentPublicUrl)}">${escapeHtml(currentPublicUrl)}</a>`,
  ].join("\n"), currentPublicUrl);
}

async function sendAiUsageReport(chatId) {
  await send(chatId, "Проверяю остатки генерации текста и аудио...");
  const usage = await getAiUsage();
  await send(chatId, formatAiUsageReport(usage), buildAdminPanelReplyMarkup());
}

async function sendStarBalanceReport(chatId) {
  try {
    const payload = await telegram("getMyStarBalance", {});
    const amount = payload.result?.amount ?? 0;
    await send(chatId, `Баланс бота: ${amount} Stars.`, buildAdminPanelReplyMarkup());
  } catch (error) {
    await send(chatId, `Не удалось получить баланс Stars: ${error.message}`, buildAdminPanelReplyMarkup());
  }
}

async function notifyAdminsAboutPaidQuestion(message, question) {
  const recipients = await getAdminNotificationChatIds();
  const payer = getProfileName(message.from);
  for (const chatId of recipients) {
    await send(chatId, [
      "Оплачен вопрос диктору.",
      `Пользователь: ${payer}`,
      `Сумма: ${question.priceStars || questionPriceStars} Stars`,
      `Вопрос: ${question.question}`,
    ].join("\n"), buildAdminPanelReplyMarkup()).catch(() => {});
  }
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

async function radioGet(requestPath) {
  const response = await fetchWithTimeout(`${radioUrl}${requestPath}`, {
    method: "GET",
    headers: {
      "X-Radio-Listener-Token": listenerApiToken,
    },
  }, 20_000);
  return response.json();
}

async function telegram(method, body) {
  const response = await fetchWithTimeout(`${telegramApiBaseUrl}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 35_000);
  const payload = await response.json();
  if (!payload.ok) throw new Error(`${method}: ${JSON.stringify(payload)}`);
  return payload;
}

async function answerCallbackQuery(callbackQueryId, text = "") {
  await telegram("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  });
}

async function answerPreCheckoutQuery(preCheckoutQueryId, ok, errorMessage = undefined) {
  await telegram("answerPreCheckoutQuery", {
    pre_checkout_query_id: preCheckoutQueryId,
    ok,
    error_message: ok ? undefined : errorMessage,
  });
}

async function send(chatId, text, replyMarkup = undefined) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    reply_markup: replyMarkup,
  });
}

async function sendRadioLink(chatId, text, url) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: buildRadioReplyMarkup(url),
  });
}

async function sendQuestionInvoice(chatId, question) {
  await telegram("sendInvoice", {
    chat_id: chatId,
    title: "Вопрос диктору",
    description: "Sweetie Fox ответит на твой вопрос в эфире радио.",
    payload: buildQuestionInvoicePayload(question.id),
    provider_token: "",
    currency: "XTR",
    prices: [{ label: "Вопрос диктору", amount: Number(question.priceStars || questionPriceStars) }],
    start_parameter: `question_${String(question.id).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48)}`,
  });
}

async function setupBotInterface() {
  await telegram("setMyCommands", {
    commands: [
      { command: "start", description: "Запуск и регистрация" },
      { command: "menu", description: "Главное меню" },
      { command: "radio", description: "Открыть эфир" },
      { command: "question", description: "Задать вопрос диктору" },
    ],
  });
  for (const chatId of adminTelegramIds) {
    await telegram("setMyCommands", {
      scope: { type: "chat", chat_id: chatId },
      commands: [
        { command: "start", description: "Открыть админ-панель" },
        { command: "menu", description: "Главное меню администратора" },
        { command: "question", description: "Задать вопрос Sweetie Fox" },
        { command: "radio", description: "Получить ссылку на эфир" },
        { command: "tokens", description: "Остаток генерации текста и аудио" },
        { command: "stars", description: "Баланс Stars бота" },
      ],
    });
  }
  await setupBotMenu();
}

async function setupBotMenu() {
  await telegram("setChatMenuButton", {
    menu_button: {
      type: "commands",
    },
  });
}

function buildRadioReplyMarkup(url) {
  const keyboard = [];
  if (isWebAppUrl(url)) {
    keyboard.push([{ text: "Слушать в Telegram", web_app: { url } }]);
    keyboard.push([{ text: "Открыть в браузере", url }]);
  } else if (isValidPublicUrl(url)) {
    keyboard.push([{ text: "Слушать эфир", url }]);
  }
  return keyboard.length ? { inline_keyboard: keyboard } : undefined;
}

function buildAdminPanelReplyMarkup() {
  return {
    inline_keyboard: [
      [
        { text: adminPanelLabels.question, callback_data: "admin:question" },
        { text: adminPanelLabels.radio, callback_data: "admin:radio" },
      ],
      [
        { text: adminPanelLabels.tokens, callback_data: "admin:tokens" },
        { text: adminPanelLabels.stars, callback_data: "admin:stars" },
      ],
    ],
  };
}

function buildUserMenuReplyMarkup() {
  return {
    inline_keyboard: [
      [{ text: userPanelLabels.question, callback_data: "user:question" }],
      [{ text: userPanelLabels.radio, callback_data: "user:radio" }],
    ],
  };
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

function isQuestionUserAllowed(from = {}) {
  if (!allowedTelegramIds.length && !allowedUsernames.length) return true;
  const telegramId = String(from.id || "");
  const username = String(from.username || "").trim().toLowerCase();
  return allowedTelegramIds.includes(telegramId) || Boolean(username && allowedUsernames.includes(username));
}

function isBotAdmin(from = {}) {
  const telegramId = String(from.id || "");
  const username = String(from.username || "").trim().toLowerCase();
  return adminTelegramIds.includes(telegramId) || Boolean(username && adminUsernames.includes(username));
}

function isAdminPanelText(text, label) {
  return String(text || "").trim().toLowerCase() === String(label || "").trim().toLowerCase();
}

function isOutOfQuestions(user = {}) {
  return !user.unlimited && Number(user.remaining) <= 0;
}

function formatRemaining(user = {}) {
  return user.unlimited ? "безлимит" : String(Math.max(0, Number(user.remaining) || 0));
}

function buildQuestionInvoicePayload(questionId) {
  return `question:${questionId}`;
}

function parseQuestionInvoicePayload(payload) {
  const value = String(payload || "");
  if (!value.startsWith("question:")) return null;
  const questionId = value.slice("question:".length);
  return questionId ? { questionId } : null;
}

async function getPublicRadioUrl() {
  if (isValidPublicUrl(publicRadioUrl)) return publicRadioUrl;
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

function isWebAppUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
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

  await setupBotMenu().catch((error) => {
    console.error(`bot menu update error: ${error.message}`);
  });

  if (previousUrl === currentPublicUrl) return;

  const recipients = await getAdminNotificationChatIds();
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

async function getAdminNotificationChatIds() {
  const ids = new Set([...adminTelegramIds, ...notifyChatIds]);
  try {
    const state = JSON.parse(await fs.promises.readFile(linkStatePath, "utf8"));
    for (const chatId of state.notifiedChatIds || []) {
      if (adminTelegramIds.includes(String(chatId)) || notifyChatIds.includes(String(chatId))) {
        ids.add(String(chatId));
      }
    }
  } catch {}
  return [...ids].filter(Boolean);
}

function schedulePublicUrlHealthCheck(attempt = 1) {
  checkPublicUrlHealth().then(() => {
    setTimeout(() => schedulePublicUrlHealthCheck(1), publicUrlHealthIntervalMs);
  }).catch((error) => {
    console.error(`public url health check error: ${error.message}`);
    const nextAttempt = attempt + 1;
    setTimeout(() => schedulePublicUrlHealthCheck(nextAttempt), Math.min(60_000, 5_000 * nextAttempt));
  });
}

async function checkPublicUrlHealth() {
  const url = await getPublicRadioUrl();
  if (!isValidPublicUrl(url)) return;

  const publicUrl = new URL(url);
  const [dnsA, httpCheck, ruNetwork] = await Promise.all([
    resolveDnsA(publicUrl.hostname),
    checkHttpUrl(url),
    radioGet("/api/public-network/status").catch((error) => ({ error: error.message })),
  ]);

  const issues = [];
  const actualPublicIp = String(ruNetwork.publicIp || "").trim();
  const expectedIp = publicServerIp || actualPublicIp;

  if (!dnsA.length) {
    issues.push(`DNS A for ${publicUrl.hostname} is empty`);
  }
  if (expectedIp && !dnsA.includes(expectedIp)) {
    issues.push(`DNS A does not include server IP ${expectedIp}; current DNS: ${dnsA.join(", ") || "none"}`);
  }
  if (actualPublicIp && publicServerIp && actualPublicIp !== publicServerIp) {
    issues.push(`RU server public IP changed: env=${publicServerIp}, actual=${actualPublicIp}`);
  }
  if (!httpCheck.ok) {
    issues.push(`Public URL is not open: ${httpCheck.error || `HTTP ${httpCheck.status}`}`);
  }
  if (ruNetwork.error) {
    issues.push(`RU internal network status failed: ${ruNetwork.error}`);
  }

  const state = await readPublicUrlHealthState();
  const issueKey = issues.join("\n");
  const now = Date.now();
  const notifyAgainMs = 60 * 60_000;
  const shouldNotifyProblem = issues.length
    && (state.issueKey !== issueKey || now - Number(state.lastNotifiedAt || 0) > notifyAgainMs);
  const shouldNotifyRecovery = !issues.length && state.status === "broken";

  if (shouldNotifyProblem) {
    await notifyAdmins([
      "Radio public URL problem",
      `URL: ${url}`,
      `DNS A: ${dnsA.join(", ") || "none"}`,
      `RU public IP: ${actualPublicIp || "unknown"}`,
      "",
      ...issues.map((issue) => `- ${issue}`),
    ].join("\n"));
  } else if (shouldNotifyRecovery) {
    await notifyAdmins([
      "Radio public URL recovered",
      `URL: ${url}`,
      `DNS A: ${dnsA.join(", ") || "none"}`,
      `RU public IP: ${actualPublicIp || "unknown"}`,
    ].join("\n"));
  }

  await writePublicUrlHealthState({
    status: issues.length ? "broken" : "ok",
    url,
    dnsA,
    publicIp: actualPublicIp,
    issueKey,
    issues,
    checkedAt: new Date().toISOString(),
    lastNotifiedAt: shouldNotifyProblem ? now : state.lastNotifiedAt || 0,
  });
}

async function resolveDnsA(hostname) {
  try {
    return await dns.resolve4(hostname);
  } catch {
    return [];
  }
}

async function checkHttpUrl(url) {
  try {
    let response = await fetchWithTimeout(url, { method: "HEAD" }, 20_000);
    if (response.status === 405) {
      response = await fetchWithTimeout(url, { method: "GET" }, 20_000);
    }
    return { ok: response.status >= 200 && response.status < 400, status: response.status };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function notifyAdmins(text) {
  const recipients = await getAdminNotificationChatIds();
  for (const chatId of recipients) {
    await send(chatId, text);
  }
}

function scheduleAiUsageNotification(attempt = 1) {
  checkAiUsageForNotification().then(() => {
    setTimeout(() => scheduleAiUsageNotification(1), aiUsageNotifyIntervalMs);
  }).catch((error) => {
    console.error(`ai usage notification error: ${error.message}`);
    const nextAttempt = attempt + 1;
    setTimeout(() => scheduleAiUsageNotification(nextAttempt), Math.min(60_000, 5_000 * nextAttempt));
  });
}

async function checkAiUsageForNotification() {
  const usage = await getAiUsage();
  const warnings = getAiUsageWarnings(usage);
  const state = await readJsonFile(aiUsageStatePath);
  const warningKey = warnings.join("\n");
  const now = Date.now();
  const notifyAgainMs = 12 * 60 * 60_000;

  if (!warnings.length) {
    await writeJsonFile(aiUsageStatePath, {
      status: "ok",
      warningKey: "",
      lastCheckedAt: new Date().toISOString(),
      lastNotifiedAt: state.lastNotifiedAt || 0,
    });
    return;
  }

  const shouldNotify = state.warningKey !== warningKey
    || now - Number(state.lastNotifiedAt || 0) > notifyAgainMs;
  if (shouldNotify) {
    await notifyAdmins(formatAiUsageReport(usage, warnings));
  }

  await writeJsonFile(aiUsageStatePath, {
    status: "warning",
    warningKey,
    warnings,
    lastCheckedAt: new Date().toISOString(),
    lastNotifiedAt: shouldNotify ? now : state.lastNotifiedAt || 0,
  });
}

async function getAiUsage() {
  try {
    const usage = await radioGet("/api/listeners/ai-usage");
    if (usage?.deepseek || usage?.elevenlabs) return usage;
  } catch (error) {
    console.error(`radio ai usage fallback: ${error.message}`);
  }

  const [deepseek, elevenlabs] = await Promise.all([
    getDeepSeekUsage(),
    getElevenLabsUsage(),
  ]);
  return { deepseek, elevenlabs, checkedAt: new Date().toISOString() };
}

async function getDeepSeekUsage() {
  if (!deepseekConfig.apiKey) {
    return { service: "deepseek", ok: false, configured: false, reason: "DEEPSEEK_API_KEY is empty" };
  }

  try {
    const response = await fetchWithTimeout(getDeepSeekBalanceUrl(), {
      headers: {
        "Authorization": `Bearer ${deepseekConfig.apiKey}`,
        "Accept": "application/json",
      },
    }, 20_000);
    const text = await response.text();
    if (!response.ok) {
      return { service: "deepseek", ok: false, configured: true, reason: `${response.status}: ${summarizeResponse(text)}` };
    }
    const payload = parseJson(text);
    const balances = Array.isArray(payload.balance_infos) ? payload.balance_infos : [];
    return {
      service: "deepseek",
      ok: true,
      configured: true,
      isAvailable: Boolean(payload.is_available),
      balances: balances.map((item) => ({
        currency: String(item.currency || ""),
        total: parseMoney(item.total_balance),
        granted: parseMoney(item.granted_balance),
        toppedUp: parseMoney(item.topped_up_balance),
      })),
    };
  } catch (error) {
    return { service: "deepseek", ok: false, configured: true, reason: error.message };
  }
}

async function getElevenLabsUsage() {
  if (!elevenlabsConfig.apiKey) {
    return { service: "elevenlabs", ok: false, configured: false, reason: "ELEVENLABS_API_KEY is empty" };
  }

  try {
    const response = await fetchWithTimeout(`${normalizeBaseUrl(elevenlabsConfig.baseUrl)}/v1/user/subscription`, {
      headers: {
        "xi-api-key": elevenlabsConfig.apiKey,
        "Accept": "application/json",
      },
    }, 20_000);
    const text = await response.text();
    if (!response.ok) {
      return { service: "elevenlabs", ok: false, configured: true, reason: `${response.status}: ${summarizeResponse(text)}` };
    }
    const payload = parseJson(text);
    const used = Number(payload.character_count);
    const limit = Number(payload.character_limit);
    const remaining = Number.isFinite(used) && Number.isFinite(limit) ? Math.max(0, limit - used) : null;
    return {
      service: "elevenlabs",
      ok: true,
      configured: true,
      tier: payload.tier || null,
      status: payload.status || null,
      used: Number.isFinite(used) ? used : null,
      limit: Number.isFinite(limit) ? limit : null,
      remaining,
      remainingPercent: Number.isFinite(remaining) && limit > 0 ? (remaining / limit) * 100 : null,
      resetAt: payload.next_character_count_reset_unix
        ? new Date(Number(payload.next_character_count_reset_unix) * 1000).toISOString()
        : null,
    };
  } catch (error) {
    return { service: "elevenlabs", ok: false, configured: true, reason: error.message };
  }
}

function getAiUsageWarnings(usage) {
  const warnings = [];
  const elevenlabs = usage.elevenlabs || {};
  if (elevenlabs.ok && Number.isFinite(elevenlabs.remainingPercent) && elevenlabs.remainingPercent <= aiUsageNotifyThresholdPercent) {
    warnings.push(`ElevenLabs осталось ${formatPercent(elevenlabs.remainingPercent)} символов от лимита`);
  }
  if (elevenlabs.configured && !elevenlabs.ok) {
    warnings.push(`ElevenLabs не отвечает: ${elevenlabs.reason || "unknown error"}`);
  }

  const deepseek = usage.deepseek || {};
  if (deepseek.ok && deepseek.isAvailable === false) {
    warnings.push("DeepSeek пометил баланс как недоступный");
  }
  if (deepseek.ok) {
    for (const balance of deepseek.balances || []) {
      if (Number.isFinite(balance.total) && balance.total <= 0) {
        warnings.push(`DeepSeek баланс ${balance.currency || ""} равен нулю`);
      }
    }
  }
  if (deepseek.configured && !deepseek.ok) {
    warnings.push(`DeepSeek не отвечает: ${deepseek.reason || "unknown error"}`);
  }
  return warnings;
}

function formatAiUsageReport(usage, warnings = getAiUsageWarnings(usage)) {
  const lines = [
    "Остатки генерации:",
    "",
    formatElevenLabsUsage(usage.elevenlabs),
    "",
    formatDeepSeekUsage(usage.deepseek),
  ];
  if (warnings.length) {
    lines.push("", "Предупреждения:", ...warnings.map((item) => `- ${item}`));
  }
  lines.push("", `Проверено: ${formatDateTime(usage.checkedAt)}`);
  return lines.join("\n");
}

function formatElevenLabsUsage(usage = {}) {
  if (!usage.configured) return "Аудио ElevenLabs: ключ не задан.";
  if (!usage.ok) return `Аудио ElevenLabs: ошибка проверки (${usage.reason || "unknown error"}).`;
  const remaining = usage.remaining === null ? "неизвестно" : formatInteger(usage.remaining);
  const limit = usage.limit === null ? "неизвестно" : formatInteger(usage.limit);
  const used = usage.used === null ? "неизвестно" : formatInteger(usage.used);
  const percent = usage.remainingPercent === null ? "" : ` (${formatPercent(usage.remainingPercent)} осталось)`;
  const reset = usage.resetAt ? `\nСброс лимита: ${formatDateTime(usage.resetAt)}` : "";
  return [
    `Аудио ElevenLabs: осталось ${remaining} из ${limit} символов${percent}.`,
    `Использовано: ${used}.`,
    usage.tier ? `Тариф: ${usage.tier}.` : "",
    reset,
  ].filter(Boolean).join("\n");
}

function formatDeepSeekUsage(usage = {}) {
  if (!usage.configured) return "Текст DeepSeek: ключ не задан.";
  if (!usage.ok) return `Текст DeepSeek: ошибка проверки (${usage.reason || "unknown error"}).`;
  const balances = usage.balances?.length
    ? usage.balances.map((item) => {
      const currency = item.currency || "";
      return `- ${currency}: всего ${formatMoney(item.total)}, бонус ${formatMoney(item.granted)}, пополнение ${formatMoney(item.toppedUp)}`;
    }).join("\n")
    : "- баланс не вернулся от API";
  return [
    `Текст DeepSeek: ${usage.isAvailable ? "баланс доступен" : "баланс недоступен"}.`,
    "DeepSeek показывает денежный баланс, а не остаток токенов:",
    balances,
  ].join("\n");
}

function getDeepSeekBalanceUrl() {
  if (deepseekConfig.balanceUrl) return deepseekConfig.balanceUrl;
  const url = new URL(deepseekConfig.url);
  url.pathname = "/user/balance";
  url.search = "";
  return url.toString();
}

function parseMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatMoney(value) {
  return Number.isFinite(value) ? value.toFixed(4).replace(/\.?0+$/, "") : "неизвестно";
}

function formatPercent(value) {
  return `${Math.max(0, Number(value) || 0).toFixed(1).replace(/\.0$/, "")}%`;
}

function formatInteger(value) {
  return new Intl.NumberFormat("ru-RU").format(Math.max(0, Math.round(Number(value) || 0)));
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "неизвестно";
  return date.toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function summarizeResponse(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "empty response";
  const payload = parseJson(value);
  return String(payload.detail?.message || payload.message || payload.error || value).slice(0, 300);
}

async function readPublicUrlHealthState() {
  try {
    return JSON.parse(await fs.promises.readFile(publicUrlHealthStatePath, "utf8"));
  } catch {
    return {};
  }
}

async function writePublicUrlHealthState(state) {
  await fs.promises.mkdir(path.dirname(publicUrlHealthStatePath), { recursive: true });
  await fs.promises.writeFile(publicUrlHealthStatePath, JSON.stringify(state, null, 2), "utf8");
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

async function writeJsonFile(filePath, payload) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
