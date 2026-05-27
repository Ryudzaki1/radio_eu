const telegramApiBaseUrl = normalizeBaseUrl(process.env.TELEGRAM_API_BASE_URL || "https://api.telegram.org");
const token = process.env.TELEGRAM_BOT_TOKEN || "";
const radioUrl = normalizeBaseUrl(process.env.RADIO_INTERNAL_URL || "");

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

async function main() {
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is empty");
  if (!radioUrl) throw new Error("RADIO_INTERNAL_URL is empty");

  await checkJson(`${telegramApiBaseUrl}/bot${token}/getMe`, (payload) => payload?.ok === true, "Telegram getMe failed");
  await checkJson(`${radioUrl}/api/tracks`, (payload) => Array.isArray(payload?.tracks), "RU radio API failed");
}

async function checkJson(url, isOk, message) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${message}: HTTP ${response.status}`);
    const payload = await response.json();
    if (!isOk(payload)) throw new Error(message);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}
