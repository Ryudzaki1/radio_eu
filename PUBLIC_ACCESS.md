# Public access

Radio runs locally at `http://localhost:3000`.

The listener page is `/`. The admin page is `/admin.html` and is protected by `ADMIN_USERNAME` / `ADMIN_PASSWORD`.

Listener questions are accepted only through the internal Telegram bot API. Set the same `LISTENER_API_TOKEN` for `radio` and `telegram-bot`; do not share it publicly.

## Best option: Cloudflare Tunnel with your domain

1. Create a Cloudflare Tunnel for HTTP service `http://radio:3000`.
2. Put values into `.env`:

```env
CLOUDFLARE_TUNNEL_TOKEN=your_cloudflare_tunnel_token
PUBLIC_RADIO_URL=https://your-radio-domain.example
LISTENER_API_TOKEN=your-long-random-internal-token
```

3. Start:

```powershell
docker compose --profile tunnel up -d
```

4. Restart the bot so Telegram sends the public link:

```powershell
docker compose up -d --build telegram-bot
```

## Quick temporary option

This creates a random `trycloudflare.com` URL. It is good for testing, but the URL can change after restart.

```powershell
docker compose --profile quick-tunnel up -d quick-tunnel
docker logs ai-chill-radio-quick-tunnel
```

Find the `https://...trycloudflare.com` URL in logs, then put it into `.env`:

```env
PUBLIC_RADIO_URL=https://your-random-url.trycloudflare.com
LISTENER_API_TOKEN=your-long-random-internal-token
```

Restart the bot:

```powershell
docker compose up -d --build telegram-bot
```

Telegram listeners will receive `PUBLIC_RADIO_URL`. They must open the link and press Play once, because browsers block audio autoplay. After that, listener questions from Telegram are emitted into the same live radio channel for admin and all connected listeners.
