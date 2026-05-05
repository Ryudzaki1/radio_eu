# AI Chill Radio

Локальная интернет-радиостанция: музыка берётся из папки `music/`, диктор пишет тексты через DeepSeek API, голос генерируется через ElevenLabs, а слушатели получают единый серверный live-поток.

## Возможности

- последовательное проигрывание локальных `mp3`, `wav`, `ogg`, `m4a`, `aac`, `flac`;
- единый live-аудиопоток `/stream` для админа и слушателей;
- отдельные кнопки диктора: приветствие, факт, прощание;
- вопросы слушателей из Telegram попадают в общую очередь диктора;
- музыка играет по кругу, а голос диктора идёт поверх приглушённой музыки;
- факты и вопросы архивируются в `ARCHIVE_DIR`;
- кеширование служебных mp3-озвучек в `CACHE_DIR`;
- fallback без ключей API: текст диктора создаётся локально, а аудио не создаётся;
- ключи API не попадают в браузер.

## Настройка

1. Скопируйте `.env.example` в `.env`.
2. Заполните ключи:

```text
DEEPSEEK_API_KEY=...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
TELEGRAM_BOT_TOKEN=...
LISTENER_API_TOKEN=long-random-secret
ADMIN_USERNAME=admin
ADMIN_PASSWORD=long-random-admin-password
```

`ELEVENLABS_VOICE_ID` можно взять в библиотеке голосов ElevenLabs. `LISTENER_API_TOKEN` нужен только для внутренней связи Telegram-бота с radio-сервисом; публичный браузер его не получает. `ADMIN_PASSWORD` должен быть длинным случайным значением, не дефолтным паролем.

3. Положите бесплатную chill-музыку без авторских прав в папку `music/`.

## Запуск через Docker

```bash
docker compose up --build
```

Откройте:

```text
http://localhost:3000
```

Контейнер читает музыку из локальной папки `music/` в режиме read-only. Кеш озвучек хранится в Docker volume `radio-cache`.

Остановить:

```bash
docker compose down
```

## Локальный запуск без Docker

```bash
npm start
```

Откройте:

```text
http://localhost:3000
```

Если `npm` недоступен, можно запустить напрямую:

```bash
node server.js
```

## Структура

```text
index.html       страница слушателя
admin.html       ЛК админа
script.js        подключение к live-потоку и общие UI-настройки
admin.js         функции ЛК админа
styles.css       оформление
server.js        точка входа сервера
src/app.js       маршруты HTTP API и статических файлов
src/config.js    переменные окружения и runtime-директории
src/http.js      JSON, файлы, range-запросы для аудио, fetch timeout
src/music.js     плейлист и безопасная раздача треков
src/broadcast.js единый серверный аудиопоток
src/ai/          DeepSeek, ElevenLabs и диктор
bot/             Telegram-бот
music/           папка с треками
.env.example     пример конфигурации
```

## Проверка из контейнера

```bash
docker exec ai-chill-radio node -e "const auth='Basic '+Buffer.from(process.env.ADMIN_USERNAME+':'+process.env.ADMIN_PASSWORD).toString('base64'); fetch('http://127.0.0.1:3000/api/health/ai',{headers:{Authorization:auth}}).then(async r => console.log(r.status, await r.text()))"
```

Endpoint защищён админской авторизацией, потому что делает реальные запросы к DeepSeek и ElevenLabs.

Тестовое приветствие:

```bash
docker exec ai-chill-radio node -e "const auth='Basic '+Buffer.from(process.env.ADMIN_USERNAME+':'+process.env.ADMIN_PASSWORD).toString('base64'); fetch('http://127.0.0.1:3000/api/greeting', { method: 'POST', headers:{Authorization:auth} }).then(async r => console.log(r.status, await r.text()))"
```
