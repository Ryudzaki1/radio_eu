const { fetchJson } = require("../http");

async function generateScript(config, trackTitle, input, admin) {
  if (!config.apiKey) return fallbackScript(trackTitle);

  const position = Number(input?.position || 1);
  const total = Number(input?.total || 1);
  return chat(config, {
    temperature: 0.9,
    maxTokens: 110,
    maxChars: 620,
    system: "Ты русскоязычный диктор chill radio. Пиши только текст для эфира, без кавычек, эмодзи, списков и технических пометок.",
    user: `${admin.prompts.announcement}\nТрек: ${trackTitle}. Позиция: ${position} из ${total}.`,
    fallback: fallbackScript(trackTitle),
  });
}

async function generateGreeting(config, admin) {
  if (!config.apiKey) {
    return "Добро пожаловать на AI Chill Radio. Сегодня ловим мягкий вайб, странные факты и музыку без лишней суеты.";
  }

  return chat(config, {
    temperature: 0.95,
    maxTokens: 130,
    maxChars: 900,
    system: "Ты весёлый русскоязычный диктор chill radio. Каждый ответ должен быть новым, лёгким и живым. Без кавычек, эмодзи, списков и технических пометок.",
    user: `${admin.prompts.greeting}\nНазвание станции: ${admin.stationName}. Сделай новую версию, не повторяй прошлые формулировки.`,
    fallback: "Добро пожаловать на AI Chill Radio. Сегодня ловим мягкий вайб, странные факты и музыку без лишней суеты.",
  });
}

async function generateFarewell(config, admin) {
  if (!config.apiKey) {
    return "Спасибо, что были на волне AI Chill Radio. Уходите мягко, возвращайтесь с улыбкой.";
  }

  return chat(config, {
    temperature: 0.95,
    maxTokens: 120,
    maxChars: 900,
    system: "Ты весёлый русскоязычный диктор chill radio. Прощание должно быть новым, тёплым и немного игривым. Без кавычек, эмодзи, списков и технических пометок.",
    user: `${admin.prompts.farewell}\nНазвание станции: ${admin.stationName}. Сделай новую версию, не повторяй прошлые формулировки.`,
    fallback: "Спасибо, что были на волне AI Chill Radio. Уходите мягко, возвращайтесь с улыбкой.",
  });
}

async function generateFact(config, topic, subtopic, admin, recentFacts = []) {
  if (!config.apiKey) {
    return `Факт на тему ${topic}, ${subtopic}: иногда самые спокойные наблюдения оказываются самыми запоминающимися.`;
  }

  const avoid = recentFacts.length
    ? `\nУже звучали эти факты по этой теме, их нельзя повторять и нельзя пересказывать близко по смыслу:\n${recentFacts.map((fact, index) => `${index + 1}. ${fact.text}`).join("\n")}`
    : "";

  return chat(config, {
    temperature: 0.92,
    maxTokens: 900,
    maxChars: 3600,
    system: "Ты редактор и диктор AI chill radio. Твоя задача - каждый раз выбирать новый, конкретный и проверяемый факт. Не повторяй объект, пример, число или сюжет из списка запретов. Если тема широкая, уходи в менее очевидный подтопик. Без списков, кавычек, эмодзи и вступлений.",
    user: `${admin.prompts.fact}\nГлавная тема: ${topic}.\nПодтема: ${subtopic}.\nЭто обязательная подтема выпуска, не уходи в соседние подтемы.${avoid}\nВыдай только новый факт для эфира.`,
    fallback: `Факт на тему ${topic}, ${subtopic}: иногда самые спокойные наблюдения оказываются самыми запоминающимися.`,
  });
}

async function generateListenerAnswer(config, userName, question, admin) {
  if (!config.apiKey) {
    return `${userName} прислал вопрос: ${question}. <break time=0.45s /> Интересный повод притормозить и посмотреть на тему внимательнее. Даже если вопрос звучит случайно, в нем можно найти маленькую дверь к любопытному факту.`;
  }

  const prompt = admin.prompts.listener || admin.prompts.fact;
  const text = await chat(config, {
    temperature: 0.9,
    maxTokens: 1200,
    maxChars: 7000,
    system: "Ты диктор AI Chill Radio, женская спокойная подача Sweetie Fox. Главная инструкция по стилю, длине и структуре находится в промпте администратора. Если промпт администратора задает количество предложений, строго соблюдай его. Не добавляй другую длину от себя. Без markdown, списков, кавычек и эмодзи.",
    user: `Промпт администратора, он главный:\n${admin.prompts.listener || admin.prompts.fact}\n\nКонтекст эфира:\nСлушатель: ${userName}.\nВопрос слушателя: ${question}.\n\nСформируй ответ для живого эфира. Начни с обращения: ${userName} прислал такой вопрос. Затем коротко озвучь вопрос и ответь по сути. Если в промпте администратора разрешены паузы, используй <break time=0.35s /> или <break time=0.55s /> только там, где это естественно. Не превышай длину, указанную в промпте администратора.`,
    fallback: `${userName} прислал вопрос: ${question}. <break time=0.45s /> Интересный повод притормозить и посмотреть на тему внимательнее.`,
  });
  return limitByPromptSentenceCount(text, prompt);
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
  const payload = await fetchJson(config.url, {
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

  return sanitizeAnnouncement(payload.choices?.[0]?.message?.content, options.maxChars) || options.fallback;
}

function fallbackScript(trackTitle) {
  return `Остаёмся на спокойной волне. Дальше в эфире ${trackTitle}.`;
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

module.exports = { fallbackScript, generateFact, generateFarewell, generateGreeting, generateListenerAnswer, generateScript, pingDeepSeek, sanitizeAnnouncement };
