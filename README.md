# AI Chill Radio

AI Chill Radio - серверное интернет-радио с единым MP3-потоком, админкой,
Telegram-ботом, генерацией текста через DeepSeek и озвучкой через ElevenLabs.

Проект сейчас разделен на два сервера:

- RU/Yandex - публичный сайт, админка, поток `/stream`, музыка, Postgres.
- EU/Vultr - Telegram-бот и внешний доступ к AI/Telegram API через европейскую
  сеть.

## Текущий Продакшен

### RU-сервер

Рабочая папка:

```text
/opt/radio_ru
```

Что делает RU:

- отдает публичный сайт `https://radio.ryudzaki.website/`;
- отдает админку `https://radio.ryudzaki.website/simsim`;
- ведет единый MP3-поток `/stream`;
- хранит музыку `music/live` и `music/play`;
- хранит runtime-кэш в Docker volume `radio-cache`;
- пишет понятную историю эфира в Postgres;
- пишет технические JSONL-логи в `/cache/logs`;
- ходит к ElevenLabs через EU proxy `http://10.77.0.1:18080`.

Запуск RU:

```bash
cd /opt/radio_ru
sudo docker compose up -d --build
```

На RU должны быть контейнеры:

```text
radio-ru
radio-ru-postgres
```

Telegram-бот на RU не запускается. Это важно: обычный `docker compose up -d`
на RU не должен поднимать Telegram-трафик из России.

### EU-сервер

Рабочая папка:

```text
/opt/radio_europa
```

Что делает EU:

- держит Telegram-бота `radio-eu`;
- ходит в Telegram Bot API;
- ходит в ElevenLabs API;
- общается с RU по внутреннему WireGuard-адресу;
- передает вопросы слушателей в RU radio API.

Запуск EU-бота:

```bash
cd /opt/radio_europa
docker compose -f docker-compose.eu-bot.yml up -d --build
```

На EU должен быть контейнер:

```text
radio-eu
```

## Публичные Ссылки

```text
Эфир:   https://radio.ryudzaki.website/
Админка: https://radio.ryudzaki.website/simsim
Поток:  https://radio.ryudzaki.website/stream
```

Логин и пароль админки задаются через:

```text
ADMIN_USERNAME
ADMIN_PASSWORD
```

Секреты не коммитятся в Git. Они должны жить только в `.env` на серверах.

## Как Работает Эфир

Радио работает как настоящий серверный поток:

1. Сервер запускает `BroadcastStream`.
2. Live-музыка играет по кругу из `music/live`.
3. Если слушателей нет, эфир все равно продолжает идти.
4. Если приходит голос ведущего, сервер заранее приглушает музыку.
5. Голос микшируется поверх музыки на сервере через `ffmpeg`.
6. Все слушатели слышат один и тот же поток `/stream`.
7. После речи музыка возвращается к обычной громкости.

Важный принцип: голос, музыка и play-вставки не должны копиться только из-за
того, что сейчас нет слушателей.

## Музыка

```text
music/live - основной бесконечный эфир
music/play - ручные вставки из админки
```

`music/live` играет автоматически по кругу.

`music/play` используется для ручных вставок. Сервер проверяет, что файл реально
существует, перед постановкой в очередь.

В админке вкладка `Аудио Файлы` управляет двумя музыкальными папками:

- `Музыка эфира` загружает и удаляет файлы из `music/live`;
- `Музыка для вставки` загружает и удаляет файлы из `music/play`;
- `Аудио ведущего` пока отображает архив озвучек только для прослушивания.

Музыкальные mp3-файлы обычно не коммитятся в Git. Репозиторий хранит структуру
и код, а музыка лежит на сервере.

## Диктор

Диктор работает в два этапа:

1. DeepSeek генерирует текст.
2. ElevenLabs озвучивает текст выбранным голосом.

Сгенерированное аудио сохраняется в архив, чтобы повторно использовать готовые
фразы и не тратить токены заново.

Темы и подтемы управляются из админки. Автоэфир тем может идти по выбранной
теме или по всем темам циклом.

## Telegram-Бот

Бот работает на EU-сервере.

У бота теперь два независимых сценария:

- админ видит отдельное меню с управлением вопросами, ссылкой на эфир и
  остатками токенов;
- обычный пользователь видит только `Задать вопрос` и `Ссылка на эфир`.

Обычный пользователь получает `1` бесплатный вопрос. После него каждый новый
вопрос стоит `50 Stars`: бот сначала принимает текст вопроса, затем выставляет
счёт Telegram Stars, а в очередь эфира вопрос попадает только после успешной
оплаты.

Основные команды/кнопки для админа:

```text
/menu     - открыть главное меню администратора
/question - задать вопрос в эфир
/radio    - получить ссылку на эфир
/tokens   - проверить остатки DeepSeek и ElevenLabs
/stars    - проверить баланс Stars бота
```

Основные команды/кнопки для пользователя:

```text
/menu     - открыть главное меню
/question - задать вопрос диктору
/radio    - получить ссылку на эфир
```

Обычные пользователи не получают админские функции. Доступ управляется через
переменные:

```text
BOT_ALLOWED_TELEGRAM_IDS
BOT_ALLOWED_USERNAMES
BOT_ADMIN_TELEGRAM_IDS
BOT_ADMIN_USERNAMES
BOT_NOTIFY_CHAT_IDS
LISTENER_QUESTION_PRICE_STARS=50
```

Бот отправляет вопросы в RU через:

```text
RADIO_INTERNAL_URL=http://10.77.0.2:18082
```

Доходы Stars разделены на два источника:

- `payments` / `payment_orders` - оплаченные вопросы через бота;
- `channel_paid_reaction_events` и `channel_post_reactions` - платные реакции Stars под постами канала.

EU-бот запрашивает у Telegram обновления `message_reaction_count`, записывает изменения счетчика paid reactions в RU Postgres и отправляет админу уведомление, если paid-счетчик поста вырос. Дополнительно бот периодически сверяет `getStarTransactions` и сохраняет транзакции бота в `bot_star_transactions`.

Сейчас Stars используются для платных вопросов диктору. Отдельного сценария
`донат без вопроса` пока нет: для него нужно добавить отдельную команду/кнопку,
invoice payload вида `donate:<id>` и запись доната в Postgres отдельно от
`listener_questions`.

Во вкладке `Тесты` есть кнопка `Тест оплаты вопроса`. Она без списания Stars
проверяет внутренний переход `бесплатный вопрос -> ожидание оплаты -> оплачено`
и отдельно прогоняет транзакционный self-test записи заказа, платежа и вопроса
в Postgres.

## Telegram-Канал

Канал создается вручную в Telegram, не через Bot API.

Рекомендуемая подготовка:

1. Создать публичный канал, например `AI Chill Radio`.
2. Зарезервировать короткий username канала.
3. Добавить `ai_chill_radio_bot` администратором канала.
4. Выдать боту права только на нужные действия: публикация сообщений и
   управление комментариями, без лишних прав на удаление/назначение админов.
5. Создать discussion group для комментариев и привязать ее к каналу.
6. После этого добавить в проект отдельную настройку `TELEGRAM_CHANNEL_ID` и
   реализовать публикации: ссылка на эфир, тема часа, топ вопросов, платные
   анонсы и уведомления о донатах.

## Postgres

Postgres запускается на RU.

Главная таблица для чтения человеком:

```text
broadcast_air_items
```

Она хранит простую историю эфира: одна строка - одно событие.

Пример:

```sql
select started_at, ended_at, item_type, status, title, source_file
from broadcast_air_items
order by started_at desc
limit 100;
```

Технической таблицы `broadcast_events` в актуальной схеме больше нет. Раньше
она создавала путаницу: один голосовой выход мог выглядеть как несколько строк.
Для чтения эфира используем только `broadcast_air_items`, а технические этапы
остаются в JSONL-логах.

Полное описание БД лежит в [DATABASE.md](DATABASE.md).

## Логи

Технические логи пишутся в контейнере RU в:

```text
/cache/logs/*.jsonl
```

В логах остаются технические события: очередь, prelude, старт голоса, конец
голоса, ошибки API, действия админки.

Старые лог-файлы удаляются автоматически через 30 календарных дней.

Секреты в логах маскируются по ключам:

```text
key
token
password
secret
```

## Проверка Состояния

RU:

```bash
cd /opt/radio_ru
sudo docker ps
sudo docker logs --tail 80 radio-ru
sudo docker exec radio-ru-postgres psql -U radio -d radio -c \
  "select started_at, ended_at, item_type, status, title from broadcast_air_items order by started_at desc limit 20;"
```

EU:

```bash
cd /opt/radio_europa
docker ps
docker logs --tail 80 radio-eu
```

Проверка API внутри RU-контейнера:

```bash
sudo docker exec radio-ru wget -q -O - http://127.0.0.1:3000/api/radio/state
sudo docker exec radio-ru wget -q -O - http://127.0.0.1:3000/api/tracks
```

`/api/health/ai` защищен админской авторизацией и без cookie вернет `401`.

## Переменные Окружения

Создать `.env` можно из примера:

```bash
cp .env.example .env
```

Критичные переменные:

```text
ADMIN_USERNAME
ADMIN_PASSWORD
LISTENER_API_TOKEN
DEEPSEEK_API_KEY
ELEVENLABS_API_KEY
ELEVENLABS_VOICE_ID
TELEGRAM_BOT_TOKEN
POSTGRES_PASSWORD
PUBLIC_RADIO_URL
```

На RU обычно используется:

```text
ELEVENLABS_BASE_URL=http://10.77.0.1:18080
PUBLIC_RADIO_URL=https://radio.ryudzaki.website/
```

На EU для бота обычно используется:

```text
RADIO_INTERNAL_URL=http://10.77.0.2:18082
PUBLIC_RADIO_URL=https://radio.ryudzaki.website/
```

## Локальная Разработка

Установить зависимости:

```bash
npm install
```

Запустить локально:

```bash
npm start
```

Или локально через Docker с обеими ролями:

```bash
docker compose -f docker-compose.local.yml up -d --build
```

Локальные адреса:

```text
http://localhost:3000/
http://localhost:3000/simsim
```

## Локальный Docker

Локальная разработка поднимает две прикладные роли:

```text
radio-local-ru
radio-local-eu
```

Отдельный контейнер `radio-local-ru-postgres` является БД внутри RU-роли.

Локальный `radio-local-eu` по умолчанию стартует в безопасном idle-режиме,
чтобы не конкурировать с боевым Telegram-ботом за `getUpdates`. Для отдельного
тестового бота можно передать `LOCAL_TELEGRAM_BOT_TOKEN`.

## Быстрый Аудит На 15.05.2026

Проверено:

- локальный git чистый перед изменением README;
- ветка `main` синхронизирована с `radio_ru/main` и `radio_eu/main`;
- RU-контейнеры `radio-ru` и `radio-ru-postgres` работают;
- EU-контейнер `radio-eu` требует повторной проверки после восстановления SSH;
- `node --check` проходит для серверных файлов, админки, клиента и бота;
- `/api/radio/state` отвечает, эфир идет;
- `/api/tracks` отвечает, музыка видна;
- в Postgres история эфира пишется в `broadcast_air_items`, одна строка на
  один элемент эфира.

Найдено для следующего этапа:

- при чтении файлов из PowerShell без `-Encoding UTF8` русские строки могут
  отображаться неверно, сам код хранится в UTF-8;
- старый README был поврежден кодировкой и заменен на этот актуальный документ;
- следующий аудит лучше делать отдельно по Telegram-боту: тексты, кнопки,
  `/tokens`, `/question`, обработка обычных пользователей.

## Репозитории

Рабочие репозитории:

```text
radio_ru
radio_eu
```


## Что Не Трогать Без Причины

- Не запускать Telegram-бота на RU.
- Не коммитить `.env`, ключи, токены и пароли.
- Не удалять `radio-cache` и `radio-postgres` на RU без явной причины.
- Не чистить архив аудио без понимания, что это приведет к повторной трате
  токенов на генерацию.
