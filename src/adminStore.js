const fs = require("node:fs");
const path = require("node:path");

const defaultTopicTree = [
  ["космос", ["Марс", "Венера", "Юпитер", "Сатурн", "чёрные дыры", "экзопланеты", "кометы", "Луна", "звёзды", "космические миссии"]],
  ["океан", ["глубоководные рыбы", "кораллы", "киты", "течения", "биолюминесценция", "подводные вулканы", "солёность", "планктон", "Марианская впадина", "кораблекрушения"]],
  ["природа", ["грибы", "деревья", "пустыни", "ледники", "болота", "вулканы", "реки", "пещеры", "молнии", "сезоны"]],
  ["животные", ["вороны", "слоны", "кошки", "собаки", "пчёлы", "осьминоги", "пингвины", "летучие мыши", "дельфины", "муравьи"]],
  ["мозг", ["память", "внимание", "зрение", "запахи", "привычки", "эмоции", "музыка и мозг", "сон мозга", "иллюзии", "обучение"]],
  ["сон", ["фазы сна", "сны", "храп", "дневной сон", "бессонница", "лунатизм", "сон животных", "сновидения", "циркадные ритмы", "будильники"]],
  ["музыка", ["ритм", "бас", "джаз", "синтезаторы", "саундтреки", "тишина", "тембр", "радио", "винил", "музыкальная память"]],
  ["города", ["метро", "мосты", "небоскрёбы", "парки", "фонари", "старые улицы", "городской шум", "крыши", "площади", "подземелья"]],
  ["еда", ["кофе", "чай", "шоколад", "сыр", "хлеб", "острый вкус", "ферментация", "мороженое", "специи", "супы"]],
  ["история", ["древние письма", "карты", "монеты", "быт", "мореплаватели", "изобретатели", "старые профессии", "праздники", "дороги", "календарь"]],
  ["технологии", ["роботы", "спутники", "батареи", "интернет", "камера", "микросхемы", "нейросети", "сенсоры", "лазеры", "3D-печать"]],
  ["психология", ["мотивация", "выбор", "страх", "юмор", "общение", "внимательность", "ошибки мышления", "прокрастинация", "любопытство", "доверие"]],
  ["погода", ["облака", "туман", "радуга", "снег", "ветер", "штормы", "град", "давление", "жара", "северное сияние"]],
  ["путешествия", ["поезда", "аэропорты", "маяки", "острова", "горы", "пустынные дороги", "отели", "рынки", "порты", "навигация"]],
  ["кино", ["монтаж", "звук в кино", "каскадёры", "миниатюры", "реквизит", "немое кино", "анимация", "цвет", "дубляж", "титры"]],
  ["искусство", ["краски", "музеи", "скульптура", "фрески", "фотография", "граффити", "реставрация", "портреты", "абстракция", "рамки"]],
  ["спорт", ["дыхание", "баланс", "реакция", "марафон", "плавание", "шахматы", "велосипед", "йога", "футбол", "олимпиады"]],
  ["микромир", ["бактерии", "вирусы", "клетки", "ДНК", "микроскопы", "пыльца", "плесень", "дрожжи", "иммунитет", "биоплёнки"]],
  ["энергия", ["свет", "тепло", "электричество", "ветер", "солнечные панели", "молнии", "магниты", "волны", "топливо", "энергосбережение"]],
  ["изобретения", ["зонтик", "лифт", "пуговицы", "бумага", "часы", "карандаш", "велосипед", "холодильник", "радио", "молния-застёжка"]],
];

const defaultAdminConfig = {
  stationName: "AI Chill Radio",
  topics: defaultTopicTree.map(([name, subtopics]) => ({ name, subtopics })),
  prompts: {
    greeting: "Сделай уникальное весёлое приветствие для chill radio. Атмосфера: спокойная музыка, интересные факты, лёгкая улыбка. 2 коротких предложения, без эмодзи и кавычек.",
    farewell: "Сделай уникальное весёлое прощание для chill radio. Тёплый финал эфира, спокойная улыбка, приглашение вернуться. 1-2 коротких предложения, без эмодзи и кавычек.",
    fact: "Расскажи один интересный и достоверный факт по теме и подтеме. Не бери самый очевидный факт; выбери конкретную деталь, число, механизм, историю открытия или неожиданный контраст. Стиль: чил радио, живо, понятно, с лёгким удивлением. 2-3 коротких предложения, без списков, эмодзи и кавычек.",
    announcement: "Сделай короткую мягкую подводку к следующему треку для chill radio. 1 предложение, без эмодзи и кавычек.",
  },
  voice: {
    stability: 0.5,
    similarityBoost: 0.75,
    style: 0,
    speed: 1,
    speakerBoost: true,
  },
  audioMix: {
    musicLevel: 0.72,
    voiceLevel: 1,
    duckingRatio: 0.18,
  },
  factPolicy: {
    archiveAfterTotal: 200,
    useArchiveWhenReady: false,
  },
};

defaultAdminConfig.prompts.listener = "Ответь слушателю как диктор chill radio Sweetie Fox: спокойно, женственно, мягко, с паузами и без спешки. Делай подробный эфирный ответ, но держи структуру живой радиоречи.";

async function readAdminConfig(config) {
  await ensureAdminConfig(config);
  const raw = await fs.promises.readFile(config.adminConfigPath, "utf8");
  return mergeAdminConfig(JSON.parse(raw));
}

async function writeAdminConfig(config, input) {
  const merged = mergeAdminConfig(input);
  await fs.promises.mkdir(path.dirname(config.adminConfigPath), { recursive: true });
  await fs.promises.writeFile(config.adminConfigPath, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

async function ensureAdminConfig(config) {
  await fs.promises.mkdir(path.dirname(config.adminConfigPath), { recursive: true });
  if (!fs.existsSync(config.adminConfigPath)) {
    await fs.promises.writeFile(config.adminConfigPath, JSON.stringify(defaultAdminConfig, null, 2), "utf8");
  }
}

function mergeAdminConfig(input = {}) {
  return {
    stationName: String(input.stationName || defaultAdminConfig.stationName).slice(0, 80),
    topics: normalizeTopicTree(input.topics),
    prompts: {
      greeting: normalizePrompt(input.prompts?.greeting, defaultAdminConfig.prompts.greeting),
      farewell: normalizePrompt(input.prompts?.farewell, defaultAdminConfig.prompts.farewell),
      fact: normalizePrompt(input.prompts?.fact, defaultAdminConfig.prompts.fact),
      listener: normalizePrompt(input.prompts?.listener, defaultAdminConfig.prompts.listener),
      announcement: normalizePrompt(input.prompts?.announcement, defaultAdminConfig.prompts.announcement),
    },
    voice: {
      stability: clampNumber(input.voice?.stability, defaultAdminConfig.voice.stability, 0, 1),
      similarityBoost: clampNumber(input.voice?.similarityBoost, defaultAdminConfig.voice.similarityBoost, 0, 1),
      style: clampNumber(input.voice?.style, defaultAdminConfig.voice.style, 0, 1),
      speed: clampNumber(input.voice?.speed, defaultAdminConfig.voice.speed, 0.7, 1.2),
      speakerBoost: Boolean(input.voice?.speakerBoost ?? defaultAdminConfig.voice.speakerBoost),
    },
    audioMix: {
      musicLevel: clampNumber(input.audioMix?.musicLevel, defaultAdminConfig.audioMix.musicLevel, 0, 1),
      voiceLevel: clampNumber(input.audioMix?.voiceLevel, defaultAdminConfig.audioMix.voiceLevel, 0, 1),
      duckingRatio: clampNumber(input.audioMix?.duckingRatio, defaultAdminConfig.audioMix.duckingRatio, 0, 1),
    },
    factPolicy: {
      archiveAfterTotal: Math.round(clampNumber(input.factPolicy?.archiveAfterTotal, defaultAdminConfig.factPolicy.archiveAfterTotal, 10, 2000)),
      useArchiveWhenReady: Boolean(input.factPolicy?.useArchiveWhenReady ?? defaultAdminConfig.factPolicy.useArchiveWhenReady),
    },
  };
}

function normalizeTopicTree(value) {
  const source = Array.isArray(value) ? value : defaultAdminConfig.topics;
  const topics = source.map((item) => {
    if (typeof item === "string") {
      return { name: item, subtopics: defaultSubtopicsFor(item) };
    }

    return {
      name: String(item?.name || "").trim(),
      subtopics: normalizeSubtopics(item?.subtopics),
    };
  }).filter((item) => item.name && item.subtopics.length);

  return topics.length ? topics.slice(0, 80) : defaultAdminConfig.topics;
}

function normalizeSubtopics(value) {
  const source = Array.isArray(value) ? value : [];
  const subtopics = source.map((item) => String(item).trim()).filter(Boolean);
  return [...new Set(subtopics)].slice(0, 40);
}

function defaultSubtopicsFor(topic) {
  const normalized = String(topic || "").toLowerCase();
  const found = defaultTopicTree.find(([name]) => name === normalized);
  return found ? found[1] : ["деталь", "история", "число", "механизм", "открытие", "рекорд", "миф", "контраст", "наблюдение", "будущее"];
}

function normalizePrompt(value, fallback) {
  const prompt = String(value || fallback).trim();
  return prompt.slice(0, 5000);
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

module.exports = { defaultAdminConfig, readAdminConfig, writeAdminConfig };
