const { fetchJson } = require("../http");
const { getActivePromptSet } = require("../adminStore");
const { config: appConfig } = require("../config");
const { recordAiUsageEvent } = require("../database");

async function generateGreeting(config, admin) {
  if (!config.apiKey) {
    return "Добро пожаловать на AI Chill Radio. Сегодня ловим мягкий вайб, странные факты и музыку без лишней суеты.";
  }

  const promptSet = getActivePromptSet(admin);
  const text = await chat(config, {
    operation: "greeting",
    temperature: 0.95,
    maxTokens: 130,
    maxChars: 900,
    system: "Ты весёлый русскоязычный диктор chill radio. Каждый ответ должен быть новым, лёгким и живым. Без кавычек, эмодзи, списков и технических пометок.",
    user: buildPrompt(admin, "greeting", `Название станции: ${admin.stationName}. Сделай новую версию, не повторяй прошлые формулировки.`),
    fallback: "Добро пожаловать на AI Chill Radio. Сегодня ловим мягкий вайб, странные факты и музыку без лишней суеты.",
  });
  return limitByPromptSentenceCount(text, promptSet.greeting || promptSet.fact);
}

async function generateFarewell(config, admin) {
  if (!config.apiKey) {
    return "Спасибо, что были на волне AI Chill Radio. Уходите мягко, возвращайтесь с улыбкой.";
  }

  const promptSet = getActivePromptSet(admin);
  const text = await chat(config, {
    operation: "farewell",
    temperature: 0.95,
    maxTokens: 120,
    maxChars: 900,
    system: "Ты весёлый русскоязычный диктор chill radio. Прощание должно быть новым, тёплым и немного игривым. Без кавычек, эмодзи, списков и технических пометок.",
    user: buildPrompt(admin, "farewell", `Название станции: ${admin.stationName}. Сделай новую версию, не повторяй прошлые формулировки.`),
    fallback: "Спасибо, что были на волне AI Chill Radio. Уходите мягко, возвращайтесь с улыбкой.",
  });
  return limitByPromptSentenceCount(text, promptSet.farewell || promptSet.fact);
}

async function generateFact(config, topic, subtopic, admin, recentFacts = [], context = {}) {
  if (!config.apiKey) {
    return `Факт на тему ${topic}, ${subtopic}: иногда самые спокойные наблюдения оказываются самыми запоминающимися.`;
  }

  const avoid = recentFacts.length
    ? `\nУже звучали эти факты по этой теме, их нельзя повторять и нельзя пересказывать близко по смыслу:\n${recentFacts.map((fact, index) => `${index + 1}. ${fact.text}`).join("\n")}`
    : "";
  const topicIntro = Number(context.subtopicIndex) === 0
    ? "\nЭто первая подтема нового тематического часа. Первой фразой естественно объяви переход к теме, без шаблона и без слова «рубрика»."
    : "\nПервой фразой естественно напомни главную тему и назови текущую подтему, но меняй формулировку и не используй один и тот же шаблон.";

  const promptSet = getActivePromptSet(admin);
  const text = await chat(config, {
    operation: "fact",
    temperature: 0.92,
    maxTokens: 700,
    maxChars: 3600,
    system: "Ты редактор и диктор AI chill radio. Делай эфирный монолог на 30-40 секунд: подробно, понятно, без воды и без канцелярита. Каждый выпуск раскрывает одну подтему внутри главной темы. Нельзя повторять объект, пример, число или сюжет из списка запретов. Без списков, markdown, кавычек, эмодзи и технических пометок.",
    user: buildPrompt(admin, "fact", `Главная тема: ${topic}.\nПодтема: ${subtopic}.\nЭто обязательная подтема выпуска, не уходи в соседние подтемы.${topicIntro}${avoid}\nВыдай только готовый текст диктора для эфира.`),
    fallback: `Факт на тему ${topic}, ${subtopic}: иногда самые спокойные наблюдения оказываются самыми запоминающимися.`,
  });
  return limitByPromptSentenceCount(text, promptSet.fact);
}

async function generateListenerAnswer(config, userName, question, admin) {
  if (!config.apiKey) {
    return `${userName} прислал вопрос: ${question}. <break time=0.45s /> Интересный повод притормозить и посмотреть на тему внимательнее. Даже если вопрос звучит случайно, в нем можно найти маленькую дверь к любопытному факту.`;
  }

  const promptSet = getActivePromptSet(admin);
  const prompt = promptSet.listener || promptSet.fact;
  const text = await chat(config, {
    operation: "listener_answer",
    temperature: 0.9,
    maxTokens: 850,
    maxChars: 4600,
    system: `Ты диктор AI Chill Radio. Главная инструкция по стилю, длине, структуре и подаче находится в промпте администратора для ведущего ${promptSet.hostName}. Если промпт администратора задает количество предложений, строго соблюдай его. Не добавляй другую длину от себя. Без markdown, списков, кавычек и эмодзи.`,
    user: buildPrompt(admin, "listener", `Контекст эфира:\nСлушатель: ${userName}.\nВопрос слушателя: ${question}.\n\nСформируй ответ для живого эфира. Начни с обращения: ${userName} прислал такой вопрос. Затем коротко озвучь вопрос и ответь по сути. Если в промпте администратора разрешены паузы, используй <break time=0.35s /> или <break time=0.55s /> только там, где это естественно. Не превышай длину, указанную в промпте администратора.`),
    fallback: `${userName} прислал вопрос: ${question}. <break time=0.45s /> Интересный повод притормозить и посмотреть на тему внимательнее.`,
  });
  return limitByPromptSentenceCount(text, prompt);
}

function buildPrompt(admin, kind, context) {
  const promptSet = getActivePromptSet(admin);
  return [
    `Общий промпт для всех ведущих:\n${promptSet.common}`,
    `Индивидуальный промпт ведущего ${promptSet.hostName}:\n${promptSet[kind] || promptSet.fact}`,
    context,
  ].filter(Boolean).join("\n\n");
}

async function pingDeepSeek(config) {
  const startedAt = Date.now();

  if (!config.apiKey) {
    return { service: "deepseek", ok: false, configured: false, reason: "DEEPSEEK_API_KEY is empty" };
  }

  try {
    const payload = await fetchJson(config.url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 8,
        temperature: 0,
        messages: [{ role: "user", content: "Ответь одним словом: pong" }],
      }),
    });

    return {
      service: "deepseek",
      ok: true,
      configured: true,
      latencyMs: Date.now() - startedAt,
      model: payload.model || config.model,
      sample: sanitizeAnnouncement(payload.choices?.[0]?.message?.content, 120),
    };
  } catch (error) {
    return {
      service: "deepseek",
      ok: false,
      configured: true,
      latencyMs: Date.now() - startedAt,
      reason: error.message,
    };
  }
}

async function chat(config, options) {
  const operation = options.operation || "chat";
  let payload = null;
  try {
    payload = await fetchJson(config.url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        messages: [
          { role: "system", content: options.system },
          { role: "user", content: options.user },
        ],
      }),
    });
  } catch (error) {
    recordDeepSeekUsage(config, operation, {
      status: "error",
      error: error.message,
      requestMaxTokens: options.maxTokens,
    }).catch(() => {});
    throw error;
  }

  const rawText = payload.choices?.[0]?.message?.content || "";
  const text = sanitizeAnnouncement(rawText, options.maxChars) || options.fallback;
  recordDeepSeekUsage(config, operation, {
    status: "ok",
    usage: payload.usage,
    model: payload.model || config.model,
    requestMaxTokens: options.maxTokens,
    outputChars: text.length,
  }).catch(() => {});

  return text;
}

async function recordDeepSeekUsage(config, operation, details = {}) {
  const usage = details.usage || {};
  await recordAiUsageEvent(appConfig, {
    provider: "deepseek",
    operation,
    units: finiteNumber(usage.total_tokens),
    metadata: {
      status: details.status,
      model: details.model || config.model,
      promptTokens: finiteNumber(usage.prompt_tokens),
      completionTokens: finiteNumber(usage.completion_tokens),
      totalTokens: finiteNumber(usage.total_tokens),
      requestMaxTokens: finiteNumber(details.requestMaxTokens),
      outputChars: finiteNumber(details.outputChars),
      error: details.error ? String(details.error).slice(0, 300) : undefined,
    },
  });
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sanitizeAnnouncement(text, maxChars = 620) {
  return String(text || "")
    .replace(/^["'«»\s]+|["'«»\s]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, maxChars)
    .trim();
}

function limitByPromptSentenceCount(text, prompt) {
  const limit = extractSentenceLimit(prompt);
  if (!limit) return text;

  const tags = [];
  const protectedText = text.replace(/<break\s+time=["'][^"']+["']\s*\/>/gi, (tag) => {
    const index = tags.push(tag) - 1;
    return `__BREAK_${index}__`;
  });
  const sentences = splitSentences(protectedText);
  if (sentences.length <= limit) return text;

  return restoreBreakTags(sentences.slice(0, limit).join(" ").trim(), tags);
}

function extractSentenceLimit(prompt) {
  const text = String(prompt || "").replace(/\s+/g, " ");
  const range = text.match(/(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*(?:предлож|фраз)/i);
  if (range) return normalizeSentenceLimit(Math.max(Number(range[1]), Number(range[2])));

  const exact = text.match(/(\d{1,2})\s*(?:предлож|фраз)/i);
  if (exact) return normalizeSentenceLimit(Number(exact[1]));

  return null;
}

function normalizeSentenceLimit(value) {
  return Number.isInteger(value) && value > 0 && value <= 40 ? value : null;
}

function splitSentences(text) {
  const sentences = [];
  let start = 0;
  for (const match of text.matchAll(/[.!?…]+(?=\s+|$)/g)) {
    const end = match.index + match[0].length;
    const sentence = text.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
  }

  const tail = text.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences;
}

function restoreBreakTags(text, tags) {
  return text.replace(/__BREAK_(\d+)__/g, (_, index) => tags[Number(index)] || "");
}

module.exports = { generateFact, generateFarewell, generateGreeting, generateListenerAnswer, pingDeepSeek, sanitizeAnnouncement };
