const fs = require("node:fs");
const path = require("node:path");

const MAX_USERS = 9;
const FREE_QUESTIONS = 1;
let storeQueue = Promise.resolve();

async function readListenerStore(config) {
  try {
    const payload = JSON.parse(await fs.promises.readFile(config.listenerStorePath, "utf8"));
    return normalizeStore(payload);
  } catch {
    return { users: [], questions: [] };
  }
}

async function writeListenerStore(config, store) {
  await fs.promises.mkdir(path.dirname(config.listenerStorePath), { recursive: true });
  await fs.promises.writeFile(config.listenerStorePath, JSON.stringify(normalizeStore(store), null, 2), "utf8");
}

async function resetListenerStore(config) {
  return withStoreLock(async () => {
    await writeListenerStore(config, { users: [], questions: [] });
    return { users: [], questions: [] };
  });
}

async function registerListener(config, input) {
  return withStoreLock(async () => {
    const store = await readListenerStore(config);
    const telegramId = String(input.telegramId || "");
    let user = store.users.find((item) => item.telegramId === telegramId);

    if (!isListenerAllowed(config, input, user)) {
      return { ok: false, reason: "forbidden" };
    }

    if (!user) {
      if (!isListenerAdmin(config, input) && regularUserCount(store) >= MAX_USERS) {
        return { ok: false, reason: "closed", maxUsers: MAX_USERS };
      }
      user = {
        telegramId,
        name: String(input.name || "").trim().slice(0, 80),
        username: String(input.username || ""),
        role: isListenerAdmin(config, input) ? "admin" : "listener",
        unlimited: isListenerUnlimited(config, input),
        remaining: isListenerUnlimited(config, input) ? null : FREE_QUESTIONS,
        createdAt: new Date().toISOString(),
      };
      store.users.push(user);
      await writeListenerStore(config, store);
    } else {
      const role = isListenerAdmin(config, input, user) ? "admin" : "listener";
      const unlimited = isListenerUnlimited(config, input, user);
      if (user.username !== String(input.username || user.username || "") || user.role !== role || user.unlimited !== unlimited) {
        user.username = String(input.username || user.username || "");
        user.role = role;
        user.unlimited = unlimited;
        if (unlimited) user.remaining = null;
        if (!unlimited && user.remaining === null) user.remaining = FREE_QUESTIONS;
        await writeListenerStore(config, store);
      }
    }

    return { ok: true, user, needsName: !user.name };
  });
}

async function getListenerStatus(config, input) {
  const store = await readListenerStore(config);
  const telegramId = String(input.telegramId || "");
  const user = store.users.find((item) => item.telegramId === telegramId);
  if (!user) return { ok: false, reason: "not_registered" };
  if (!isListenerAllowed(config, input, user)) return { ok: false, reason: "forbidden" };
  return { ok: true, user, needsName: !user.name };
}

async function setListenerName(config, telegramId, name) {
  return withStoreLock(async () => {
    const store = await readListenerStore(config);
    const user = store.users.find((item) => item.telegramId === String(telegramId));
    if (!user) return { ok: false, reason: "not_registered" };
    if (!isListenerAllowed(config, { telegramId }, user)) return { ok: false, reason: "forbidden" };

    user.name = String(name || "").trim().slice(0, 80);
    await writeListenerStore(config, store);
    return { ok: true, user };
  });
}

async function acceptQuestion(config, input) {
  return withStoreLock(async () => {
    const store = await readListenerStore(config);
    const telegramId = String(input.telegramId || "");
    const user = store.users.find((item) => item.telegramId === telegramId);
    const questionText = String(input.question || "").trim().slice(0, 1200);
    if (!user) return { ok: false, reason: "not_registered" };
    if (!isListenerAllowed(config, input, user)) return { ok: false, reason: "forbidden" };
    if (!user.name) return { ok: false, reason: "needs_name", user };
    if (!questionText) return { ok: false, reason: "empty", user };
    const requiresPayment = !user.unlimited && user.remaining <= 0;
    if (!requiresPayment && !user.unlimited) user.remaining -= 1;
    const question = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      telegramId,
      userName: user.name,
      username: user.username,
      question: questionText,
      status: requiresPayment ? "waiting_payment" : "queued",
      remainingAfter: user.unlimited ? null : user.remaining,
      priceStars: requiresPayment ? config.listenerQuestionPriceStars : 0,
      paymentStatus: requiresPayment ? "waiting_payment" : "free",
      paymentChargeId: null,
      createdAt: new Date().toISOString(),
      text: "",
      audioUrl: null,
      archivePath: null,
    };
    store.questions.push(question);
    await writeListenerStore(config, store);
    return { ok: true, user, question, requiresPayment };
  });
}

async function getQuestion(config, id) {
  const store = await readListenerStore(config);
  return store.questions.find((item) => item.id === String(id)) || null;
}

async function markQuestionPaid(config, id, payment = {}) {
  return withStoreLock(async () => {
    const store = await readListenerStore(config);
    const question = store.questions.find((item) => item.id === String(id));
    if (!question) return { ok: false, reason: "not_found" };
    if (question.status !== "waiting_payment") return { ok: false, reason: "invalid_status", question };

    Object.assign(question, {
      status: "queued",
      paymentStatus: "paid",
      paymentChargeId: payment.telegramPaymentChargeId ? String(payment.telegramPaymentChargeId) : null,
      paidAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await writeListenerStore(config, store);
    return { ok: true, question };
  });
}

async function updateQuestion(config, id, patch) {
  return withStoreLock(async () => {
    const store = await readListenerStore(config);
    const question = store.questions.find((item) => item.id === id);
    if (!question) return null;
    Object.assign(question, patch, { updatedAt: new Date().toISOString() });
    await writeListenerStore(config, store);
    return question;
  });
}

function withStoreLock(task) {
  const run = storeQueue.then(task, task);
  storeQueue = run.catch(() => {});
  return run;
}

function normalizeStore(payload = {}) {
  return {
    users: (Array.isArray(payload.users) ? payload.users : []).map((user) => ({
      telegramId: String(user.telegramId || ""),
      name: String(user.name || ""),
      username: String(user.username || ""),
      role: user.role === "admin" ? "admin" : "listener",
      unlimited: Boolean(user.unlimited),
      remaining: user.unlimited ? null : Math.max(0, Math.floor(Number(user.remaining) || 0)),
      createdAt: String(user.createdAt || ""),
    })).filter((user) => user.telegramId),
    questions: (Array.isArray(payload.questions) ? payload.questions : []).map((question) => ({
      id: String(question.id || ""),
      telegramId: String(question.telegramId || ""),
      userName: String(question.userName || ""),
      username: String(question.username || ""),
      question: String(question.question || ""),
      status: String(question.status || "queued"),
      remainingAfter: question.remainingAfter === null ? null : Math.max(0, Math.floor(Number(question.remainingAfter) || 0)),
      priceStars: Math.max(0, Math.floor(Number(question.priceStars) || 0)),
      paymentStatus: String(question.paymentStatus || (question.status === "waiting_payment" ? "waiting_payment" : "free")),
      paymentChargeId: question.paymentChargeId ? String(question.paymentChargeId) : null,
      paidAt: question.paidAt ? String(question.paidAt) : null,
      createdAt: String(question.createdAt || ""),
      updatedAt: question.updatedAt ? String(question.updatedAt) : null,
      text: String(question.text || ""),
      audioUrl: question.audioUrl ? String(question.audioUrl) : null,
      archivePath: question.archivePath ? String(question.archivePath) : null,
      error: question.error ? String(question.error) : null,
    })).filter((question) => question.id),
  };
}

function isListenerAllowed(config, input = {}, user = null) {
  const access = config.listenerAccess || {};
  const allowedIds = access.allowedTelegramIds || [];
  const allowedNames = access.allowedUsernames || [];
  if (!allowedIds.length && !allowedNames.length) return true;
  const telegramId = String(input.telegramId || user?.telegramId || "");
  const username = String(input.username || user?.username || "").trim().toLowerCase();
  return allowedIds.includes(telegramId) || Boolean(username && allowedNames.includes(username));
}

function isListenerUnlimited(config, input = {}, user = null) {
  const access = config.listenerAccess || {};
  const unlimitedIds = access.unlimitedTelegramIds || [];
  const unlimitedNames = access.unlimitedUsernames || [];
  const telegramId = String(input.telegramId || user?.telegramId || "");
  const username = String(input.username || user?.username || "").trim().toLowerCase();
  return isListenerAdmin(config, input, user) || unlimitedIds.includes(telegramId) || Boolean(username && unlimitedNames.includes(username));
}

function isListenerAdmin(config, input = {}, user = null) {
  const access = config.listenerAccess || {};
  const adminIds = access.adminTelegramIds || [];
  const adminNames = access.adminUsernames || [];
  const telegramId = String(input.telegramId || user?.telegramId || "");
  const username = String(input.username || user?.username || "").trim().toLowerCase();
  return adminIds.includes(telegramId) || Boolean(username && adminNames.includes(username));
}

function regularUserCount(store) {
  return (store.users || []).filter((user) => user.role !== "admin").length;
}

module.exports = {
  FREE_QUESTIONS,
  MAX_USERS,
  acceptQuestion,
  getQuestion,
  getListenerStatus,
  markQuestionPaid,
  readListenerStore,
  registerListener,
  resetListenerStore,
  setListenerName,
  updateQuestion,
};
