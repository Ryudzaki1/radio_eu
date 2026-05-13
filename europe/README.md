# Europe node

This folder documents the Germany/EU server role.

Role:
- no public radio website;
- runs only the Telegram bot container when Telegram must exit from Europe;
- WireGuard peer for the Russia node;
- private Caddy reverse proxy from `http://10.77.0.1:18080` to `https://api.elevenlabs.io`;
- private Caddy reverse proxy from `http://10.77.0.1:18081` to `https://api.telegram.org`;
- lets the Russia node use ElevenLabs and Telegram Bot API without exposing that traffic from the Russia VM.

Current private network:

```text
EU: 10.77.0.1
RU: 10.77.0.2
EU public endpoint: 80.240.16.151:51820/udp
Private ElevenLabs proxy: http://10.77.0.1:18080
Private Telegram API proxy: http://10.77.0.1:18081
```

The EU server should not run the public radio Docker containers.
The EU Telegram bot talks to the Russia radio API through WireGuard:

```text
RADIO_INTERNAL_URL=http://10.77.0.2:18082
PUBLIC_RADIO_URL=http://111.88.156.237
```

Run only the EU bot from the full app checkout:

```bash
docker compose -f docker-compose.eu-bot.yml up -d --build
```

Layout:

```text
Caddyfile          private ElevenLabs proxy config
docker-compose.bot.yml EU-only Telegram bot compose shape for the split folder
wg0.example.conf   WireGuard shape without private keys
scripts/           helper scripts for tunnel/proxy/server checks
```

Private WireGuard keys stay only on the servers.
