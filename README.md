# AI Chill Radio

## Production split

The production setup is split intentionally:

- `docker-compose.yml` starts the Russia/Yandex public radio node only: website,
  admin panel, API, and `/stream`.
- The Telegram bot must run on the Europe node with
  `docker-compose.eu-bot.yml`.
- Do not add the Telegram bot back to the default compose file on the Russia
  node. A plain `docker compose up -d` on RU must not start Telegram traffic
  from Russia.
- Old VPN/Xray/OpenVPN/VLESS/VMess/Shadowsocks helpers are archived in
  `scripts/legacy_vpn/` and are not part of the current production path.

AI Chill Radio - локальная интернет-радиостанция с единым серверным аудиопотоком. Музыка играет из локальных папок, диктор генерирует текст через DeepSeek API, голос создается через ElevenLabs, а слушатели и админ слышат один и тот же live-поток `/stream`.

Проект рассчитан на запуск в Docker: один контейнер ведет радиоэфир и веб-интерфейс, второй обслуживает Telegram-бота, отдельный опциональный контейнер может поднимать Cloudflare quick tunnel для временной публичной ссылки.

## Что умеет сервис

- Единый серверный MP3-поток `/stream` для всех слушателей.
- Бесконечный live-эфир из папки `music/live`.
- Ручные музыкальные вставки из папки `music/play` через ЛК администратора.
- Сервер проверяет, что play-файл реально существует в `music/play`, перед
  постановкой в очередь.
- Плавные переходы между live-музыкой, play-вставками и возвратом в эфир.
- Очередь play-вставок: трек может быть либо в очереди, либо играть, после проигрывания снова доступен для постановки.
- Диктор всегда идет в общем потоке поверх приглушенной музыки.
- Музыка под диктором приглушается на сервере, поэтому это одинаково работает у всех слушателей.
- Голосовые включения становятся в очередь и не накладываются друг на друга.
- Эфирный таймлайн продолжает идти даже без подключенных слушателей: музыка,
  play-вставки и диктор не ждут клиента и не копятся в очереди только из-за
  отсутствия слушателей.
- Перед голосом музыка заранее уходит в ducking-уровень из настроек
  `Голос/Музыка`; limiter не поднимает сигнал обратно до максимума.
- Между голосовыми включениями используется пауза 30-60 секунд.
- Приветствие, прощание и факты генерируются только по нажатию кнопки или по запросу из Telegram.
- Админ может редактировать промпты, темы, подтемы, голосовые параметры и микс эфира.
- Во вкладке «Темы» изменения сохраняются явной кнопкой «Сохранить темы».
- Автоэфир тем всегда стартует с выбранной темы. Для режима «Все темы по
  кругу» есть два порядка обхода: тема целиком или по слоям подтем.
- Факты идут по структуре тема/подтема без случайных повторов.
- Архив аудио сохраняется отдельно для админских фактов/приветствий/прощаний и вопросов слушателей.
- Полная очистка аудиоархива вынесена во вкладку «Архив» и требует двойного
  подтверждения.
- ЛК администратора обновляется через серверные события без ручного refresh для слушателей, архива и очередей.
- Публичная страница слушателя содержит только простой плеер, громкость, текущий трек и прогресс музыки.
- Публичная страница слушателя работает в лёгком режиме: без анимированного
  talk-loop, без постоянного SSE-канала и с более редким polling состояния на телефонах.
- Telegram-бот принимает вопросы слушателей и ставит ответы диктора в общий эфир.
- Для администратора Telegram-бот показывает отдельную панель: вопрос в эфир,
  ссылка на эфир и остатки генерации текста/аудио (`/tokens`).
- Бот периодически проверяет остатки DeepSeek и ElevenLabs и уведомляет
  администратора при низком остатке или ошибке проверки.
- Поддерживается ограничение доступа к Telegram-боту по пользователям, лимитам и админским исключениям.
- Системные логи пишутся в `/cache/logs` и ротируются по времени.
- Обновление промптов пишет отдельное событие `admin_prompts_refreshed` в
  системный лог.

## Как устроен эфир

Радио работает не как набор отдельных браузерных аудиоэлементов, а как один серверный поток.

1. Контейнер `radio` запускает HTTP-сервер на порту `3000`.
2. При подключении слушателя браузер открывает `/stream`.
3. Сервер через `ffmpeg` читает музыку, микширует переходы и отдает MP3-байты всем подключенным клиентам.
4. Если никто не слушает, сервер всё равно продолжает проигрывать музыку,
   play-вставки и диктора по расписанию, чтобы эфир оставался настоящим
   live-радио без накопления очереди.
5. Если слушатель нажал Play позже остальных, он подключается к текущему live-потоку, а не к началу трека.

Обычная live-музыка больше не режется на короткие 12-секундные циклы. Сервер считает длительность текущего файла через `ffprobe` и стримит остаток трека целиком. Это уменьшает количество перезапусков `ffmpeg` и снижает риск заиканий.

## Live и Play музыка

Музыка разделена на две папки:

```text
music/live  постоянный эфирный плейлист
music/play  ручные музыкальные вставки из ЛК админа
```

`music/live`:

- играет автоматически по кругу;
- не выбирается вручную в ЛК;
- используется как основная подложка эфира;
- продолжает позицию после диктора и play-вставок.

`music/play`:

- отображается в ЛК администратора как список доступных вставок;
- трек можно поставить в очередь;
- API принимает только точное имя существующего аудиофайла из `music/play`;
- если в очереди несколько play-треков, они идут друг за другом с плавными переходами;
- когда очередь play заканчивается, эфир плавно возвращается к `music/live`;
- после проигрывания play-трек снова можно поставить в очередь.

Музыкальные файлы не коммитятся в Git. В репозитории лежат только `.gitkeep`, чтобы структура папок сохранялась после клона.

## Диктор

Диктор состоит из двух этапов:

1. DeepSeek генерирует текст по промпту.
2. ElevenLabs озвучивает текст выбранным голосом.

После генерации аудио:

- файл сохраняется в архив;
- событие ставится в очередь диктора;
- при наступлении очереди сервер строит единый аудиоотрезок: live-музыка, плавное приглушение, голос, плавное восстановление музыки;
- слушатели слышат это в том же `/stream`, без отдельного голосового плеера.

Правило микса:

- голос диктора главный;
- музыка во время диктора приглушается на сервере;
- уровни музыки, голоса и ducking ratio настраиваются в ЛК администратора;
- громкость на странице слушателя меняет только общий браузерный уровень.

По умолчанию перед голосом и после голоса есть короткая live-подложка. Это дает мягкий переход и не обрывает речь.

## Очереди

В проекте есть две независимые очереди:

```text
voice queue  очередь диктора
music queue  очередь play-вставок
```

Если админ случайно нажал несколько фактов подряд, они не накладываются. Каждый факт становится в очередь диктора.

Если слушатели в Telegram одновременно задали вопросы, ответы также идут по очереди. После каждого голосового события применяется задержка 30-60 секунд.

Если в это время играет play-вставка:

- текущий play-трек доигрывает;
- затем включается короткая live-подложка;
- говорит диктор;
- после диктора эфир возвращается к оставшейся очереди play;
- когда play-очередь закончится, радио вернется в live.

## ЛК администратора

Админка открывается по адресу:

```text
http://localhost:3000/admin.html
```

Доступ защищается `ADMIN_USERNAME` и `ADMIN_PASSWORD`.

Основные вкладки:

- `Эфир` - плеер администратора, текущий трек, прогресс музыки, кнопки диктора, live/play списки.
- `Темы` - список тем и подтем для фактов.
- `Промпты` - базовые промпты приветствий, фактов, слушательских ответов и прощаний.
- `Голос` - параметры ElevenLabs и микс музыки/диктора.
- `Архив` - прослушивание и удаление сгенерированных mp3.
- `Слушатели` - Telegram-пользователи, их лимиты, вопросы и ответы.
- `Тесты` - ручная проверка генерации.

Вкладка `Эфир` показывает только тайминг музыки. Таймер диктора специально не отображается, чтобы не путать голосовые включения с музыкальным треком.

## Страница слушателя

Публичная страница:

```text
http://localhost:3000/
```

Слушатель видит:

- кнопку Play/Pause;
- общую громкость;
- текущий статус эфира;
- название текущей музыки;
- прогресс текущего музыкального трека.

Админские функции, архивы, настройки и промпты на публичной странице недоступны.

## Telegram-бот

Контейнер `telegram-bot` запускает `bot/bot.js`.

Бот:

- принимает `/start`;
- регистрирует пользователя;
- запоминает имя;
- отправляет актуальную ссылку на эфир;
- предупреждает, что новые сообщения считаются вопросами;
- принимает вопрос слушателя;
- отправляет его в radio-сервис;
- сообщает остаток бесплатных вопросов.

Ограничения настраиваются через `.env`:

- можно разрешить доступ только конкретным Telegram ID или username;
- можно назначить админов;
- можно назначить безлимитных пользователей;
- обычным пользователям доступен лимит вопросов.

Ответ слушателю генерируется отдельным промптом `listenerPrompt`, чтобы отличать пользовательские вопросы от админских фактов.

## Публичный доступ

Для локальной разработки можно использовать Cloudflare quick tunnel:

```bash
docker compose --profile quick-tunnel up -d --build
```

Контейнер `quick-tunnel` получает временную публичную ссылку и пишет ее в:

```text
/cache/config/public-url.json
```

Telegram-бот читает этот файл и может отправлять актуальную ссылку в чат. Если ссылка изменилась, бот хранит историю в:

```text
/cache/config/bot-link.json
```

Quick tunnel удобен для тестов, но ссылка временная. Для постоянного публичного адреса лучше использовать:

- Cloudflare Tunnel с токеном `CLOUDFLARE_TUNNEL_TOKEN`;
- VPS;
- reverse proxy на сервере.

Запуск постоянного Cloudflare tunnel:

```bash
docker compose --profile tunnel up -d --build
```

## Переменные окружения

Создайте `.env` из `.env.example`:

```bash
cp .env.example .env
```

На Windows можно просто скопировать файл вручную.

Основные переменные:

```text
PORT=3000

DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-chat

ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
ELEVENLABS_MODEL=eleven_multilingual_v2

TELEGRAM_BOT_TOKEN=
LISTENER_API_TOKEN=change-this-long-random-token

ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-this-admin-password

PUBLIC_RADIO_URL=http://localhost:3000
CLOUDFLARE_TUNNEL_TOKEN=
```

Telegram-доступ:

```text
LISTENER_ALLOWED_TELEGRAM_IDS=
LISTENER_ALLOWED_USERNAMES=
LISTENER_UNLIMITED_TELEGRAM_IDS=
LISTENER_UNLIMITED_USERNAMES=
LISTENER_ADMIN_TELEGRAM_IDS=
LISTENER_ADMIN_USERNAMES=

BOT_ALLOWED_TELEGRAM_IDS=
BOT_ALLOWED_USERNAMES=
BOT_ADMIN_TELEGRAM_IDS=
BOT_ADMIN_USERNAMES=
BOT_NOTIFY_CHAT_IDS=
```

Секреты нельзя коммитить. `.env` уже добавлен в `.gitignore`.

## Запуск через Docker

Обычный запуск radio + Telegram bot:

```bash
docker compose up -d --build
```

Открыть:

```text
http://localhost:3000
http://localhost:3000/admin.html
```

С quick tunnel:

```bash
docker compose --profile quick-tunnel up -d --build
```

С постоянным Cloudflare tunnel:

```bash
docker compose --profile tunnel up -d --build
```

Остановить:

```bash
docker compose down
```

Посмотреть логи:

```bash
docker logs --tail 120 ai-chill-radio
docker logs --tail 120 ai-chill-radio-bot
docker logs --tail 120 ai-chill-radio-quick-tunnel
```

## Локальный запуск без Docker

Нужны Node.js и `ffmpeg`/`ffprobe` в PATH.

```bash
npm start
```

Или напрямую:

```bash
node server.js
```

Docker-режим предпочтительнее, потому что в контейнере уже есть ffmpeg.

## Хранилище и архивы

В Docker используется volume:

```text
radio-cache:/cache
```

Внутри него:

```text
/cache/announcements        служебные mp3
/cache/archive              архив сгенерированных аудио
/cache/config/admin.json    настройки ЛК администратора
/cache/config/fact-log.json прогресс тем и подтем
/cache/config/listeners.json Telegram-пользователи и вопросы
/cache/config/public-url.json актуальная quick tunnel ссылка
/cache/logs                 системные логи
```

Аудиоархив можно просматривать и удалять из ЛК администратора.

## API

Публичные:

```text
GET  /                       страница слушателя
GET  /stream                 единый live MP3-поток
GET  /api/radio/state        состояние эфира
GET  /api/tracks             список live/play музыки
GET  /api/radio/config       публичная часть конфигурации
```

Админские:

```text
GET    /admin.html
GET    /api/admin/config
PUT    /api/admin/config
POST   /api/admin/prompts/refresh
POST   /api/admin/music/insert     проверяет файл в music/play до постановки
POST   /api/admin/music/sync
GET    /api/admin/archive
DELETE /api/admin/archive
POST   /api/admin/archive/clear
GET    /api/admin/listeners
POST   /api/admin/listeners/reset
GET    /api/admin/system-log
GET    /api/health/ai
POST   /api/greeting
POST   /api/fact
POST   /api/farewell
POST   /api/announcement
```

Внутренние listener API для Telegram-бота защищаются `LISTENER_API_TOKEN`.

## Проверки

Проверить контейнеры:

```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

Проверить AI API из контейнера:

```bash
docker exec ai-chill-radio node -e "const auth='Basic '+Buffer.from(process.env.ADMIN_USERNAME+':'+process.env.ADMIN_PASSWORD).toString('base64'); fetch('http://127.0.0.1:3000/api/health/ai',{headers:{Authorization:auth}}).then(async r => console.log(r.status, await r.text()))"
```

Проверить состояние эфира:

```bash
docker exec ai-chill-radio node -e "fetch('http://127.0.0.1:3000/api/radio/state').then(async r => console.log(await r.text()))"
```

Проверить синтаксис:

```bash
docker exec ai-chill-radio node --check /app/src/app.js
docker exec ai-chill-radio node --check /app/src/broadcast.js
docker exec ai-chill-radio node --check /app/script.js
docker exec ai-chill-radio-bot node --check /app/bot/bot.js
```

## Структура проекта

```text
index.html                 публичная страница слушателя
admin.html                 ЛК администратора
script.js                  общий frontend для плеера и эфира
admin.js                   логика ЛК администратора
styles.css                 оформление
server.js                  точка входа HTTP-сервера
docker-compose.yml         radio, telegram-bot, tunnel, quick-tunnel
Dockerfile                 основной образ Node.js + ffmpeg
Dockerfile.quick-tunnel    образ quick tunnel watcher
PUBLIC_ACCESS.md           заметки по публичному доступу
bot/bot.js                 Telegram-бот
bot/quick-tunnel-watch.sh  watcher публичной ссылки
src/app.js                 HTTP API и маршрутизация
src/broadcast.js           единый серверный аудиопоток
src/config.js              env и runtime-директории
src/adminStore.js          настройки ЛК
src/factLog.js             прогресс тем и подтем
src/listenerStore.js       пользователи Telegram и вопросы
src/music.js               плейлисты и безопасные пути
src/systemLog.js           системные логи
src/ai/deepseek.js         DeepSeek API
src/ai/elevenlabs.js       ElevenLabs API
src/ai/announcer.js        сборка текстов и аудио диктора
music/live/.gitkeep        папка live-музыки
music/play/.gitkeep        папка play-вставок
.env.example               пример конфигурации
```

## Git и секреты

В репозиторий не попадают:

- `.env`;
- `.cache`;
- mp3 и другие аудиофайлы из `music/live` и `music/play`;
- runtime-архивы и логи.

Перед пушем проверяйте:

```bash
git status --ignored --short
```

Секреты DeepSeek, ElevenLabs, Telegram и Cloudflare должны храниться только в `.env` или в настройках сервера, но не в Git.
