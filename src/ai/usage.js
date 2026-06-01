const { fetchWithTimeout } = require("../http");

async function getAiUsage(config) {
  const [deepseek, elevenlabs] = await Promise.all([
    getDeepSeekUsage(config.deepseek || {}),
    getElevenLabsUsage(config.elevenlabs || {}),
  ]);
  return { deepseek, elevenlabs, checkedAt: new Date().toISOString() };
}

async function getDeepSeekUsage(config) {
  if (!config.apiKey) {
    return { service: "deepseek", ok: false, configured: false, reason: "DEEPSEEK_API_KEY is empty" };
  }

  try {
    const response = await fetchWithTimeout(getDeepSeekBalanceUrl(config), {
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
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

async function getElevenLabsUsage(config) {
  if (!config.apiKey) {
    return { service: "elevenlabs", ok: false, configured: false, reason: "ELEVENLABS_API_KEY is empty" };
  }

  try {
    const response = await fetchWithTimeout(`${normalizeBaseUrl(config.baseUrl || "https://api.elevenlabs.io")}/v1/user/subscription`, {
      headers: {
        "xi-api-key": config.apiKey,
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

function getDeepSeekBalanceUrl(config) {
  if (config.balanceUrl) return config.balanceUrl;
  const url = new URL(config.url || "https://api.deepseek.com/chat/completions");
  url.pathname = "/user/balance";
  url.search = "";
  return url.toString();
}

function parseMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

module.exports = { getAiUsage, getDeepSeekUsage, getElevenLabsUsage };
