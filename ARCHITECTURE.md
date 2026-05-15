# Current production architecture

## Russia/Yandex node

Path: `/opt/radio_ru`

Responsibilities:

- public website and player;
- admin panel at `/simsim`;
- public API and `/stream`;
- local music storage under `music/live` and `music/play`;
- private WireGuard listener API at `http://10.77.0.2:18082`.

The Russia node runs only the Docker service `radio`.

Do not run Telegram from the Russia node. The default `docker-compose.yml` is
kept radio-only so a plain `docker compose up -d` cannot accidentally start
Telegram traffic from Russia.

## Europe node

Path: `/opt/radio_europa`

Responsibilities:

- WireGuard peer at `10.77.0.1`;
- private Caddy proxy to ElevenLabs at `http://10.77.0.1:18080`;
- private Caddy proxy to Telegram Bot API at `http://10.77.0.1:18081`;
- Telegram bot container `radio-eu`.

The Europe bot talks to the Russia radio API through:

```text
RADIO_INTERNAL_URL=http://10.77.0.2:18082
PUBLIC_RADIO_URL=https://radio.ryudzaki.website/
```

Run it with:

```bash
docker compose -f docker-compose.eu-bot.yml up -d --build
```
