const fs = require("node:fs");
const path = require("node:path");
const { hash } = require("../music");
const { fetchWithTimeout } = require("../http");

async function synthesize(config, outputDir, text, options = {}) {
  if (!config.apiKey || !config.voiceId) return null;

  await fs.promises.mkdir(outputDir, { recursive: true });

  const cacheKey = hash(`${config.voiceId}:${text}:${options.kind || "voice"}`);
  const fileName = `${cacheKey}.mp3`;
  const filePath = path.join(outputDir, fileName);
  const publicUrl = options.publicUrlPrefix ? `${options.publicUrlPrefix}/${fileName}` : `/cache/announcements/${fileName}`;

  if (fs.existsSync(filePath)) {
    return { audioUrl: publicUrl, fileName, filePath, fromCache: true };
  }

  const url = `${config.baseUrl}/v1/text-to-speech/${encodeURIComponent(config.voiceId)}?output_format=mp3_44100_128`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "xi-api-key": config.apiKey,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg",
    },
    body: JSON.stringify({
      text: prepareTextForSpeech(text),
      model_id: config.model,
      language_code: "ru",
      voice_settings: getVoiceSettings(options.voice),
    }),
  }, 90_000);

  if (!response.ok) {
    throw new Error(`ElevenLabs ${response.status}: ${await response.text()}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.promises.writeFile(filePath, bytes);
  return { audioUrl: publicUrl, fileName, filePath, fromCache: false };
}

function getVoiceSettings(settings = {}) {
  return {
    stability: clamp(settings.stability, 0.5, 0, 1),
    similarity_boost: clamp(settings.similarityBoost, 0.75, 0, 1),
    style: clamp(settings.style, 0, 0, 1),
    speed: clamp(settings.speed, 1, 0.7, 1.2),
    use_speaker_boost: Boolean(settings.speakerBoost ?? true),
  };
}

function prepareTextForSpeech(text) {
  const breakTag = (seconds) => `<break time="${seconds}s" />`;
  return String(text || "")
    .replace(/\[(?:short\s+pause|короткая\s+пауза)\]/giu, breakTag(0.35))
    .replace(/\[(?:pause|пауза)\]/giu, breakTag(0.55))
    .replace(/\[(?:long\s+pause|длинная\s+пауза)\]/giu, breakTag(0.8))
    .replace(/<break\s+time=["']?([0-9.]+)s["']?\s*\/?>/giu, (_, value) => {
      const seconds = clamp(value, 0.45, 0.15, 1.2);
      return breakTag(Number(seconds.toFixed(2)));
    })
    .replace(/<(?!break\b)[^>]+>/giu, "")
    .replace(/\[(?!\/?break\b)[^\]]+\]/giu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

async function pingElevenLabs(config) {
  const startedAt = Date.now();

  if (!config.apiKey) {
    return { service: "elevenlabs", ok: false, configured: false, reason: "ELEVENLABS_API_KEY is empty" };
  }

  try {
    const response = await fetchWithTimeout(`${config.baseUrl}/v1/voices`, {
      headers: { "xi-api-key": config.apiKey },
    }, 15_000);
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`${response.status}: ${text}`);
    }

    let payload = {};
    try {
      payload = JSON.parse(text);
    } catch {
      payload = {};
    }

    const voices = Array.isArray(payload.voices) ? payload.voices : [];
    const selectedVoice = voices.find((voice) => voice.voice_id === config.voiceId);

    return {
      service: "elevenlabs",
      ok: Boolean(selectedVoice || !config.voiceId),
      configured: true,
      voiceConfigured: Boolean(config.voiceId),
      latencyMs: Date.now() - startedAt,
      voiceName: selectedVoice?.name,
      voiceCategory: selectedVoice?.category,
      availableVoices: voices.length,
      reason: config.voiceId && !selectedVoice ? "Configured voice id is not available for this API key" : undefined,
    };
  } catch (error) {
    return {
      service: "elevenlabs",
      ok: false,
      configured: true,
      voiceConfigured: Boolean(config.voiceId),
      latencyMs: Date.now() - startedAt,
      reason: error.message,
    };
  }
}

module.exports = { pingElevenLabs, prepareTextForSpeech, synthesize };
