# Russia node

This folder is the public radio node for the Yandex Cloud VM.

Role:
- serves the website, player, admin panel, public radio API, and `/stream`;
- does not run the Telegram bot container; Telegram runs on the Europe node;
- uses the repository root as the application source;
- stores local music under `music/live` and `music/play`;
- calls ElevenLabs through the private EU tunnel using `ELEVENLABS_BASE_URL=http://10.77.0.1:18080`;
- calls Telegram Bot API through the private EU tunnel using `TELEGRAM_API_BASE_URL=http://10.77.0.1:18081`.

Current test URL:

```text
https://radio.ryudzaki.website/
https://radio.ryudzaki.website/simsim
https://radio.ryudzaki.website/stream
```

Keep `radio.ryudzaki.website` pointed to the current Yandex VM public IP with DNS-only mode.
If the VM public IP changes, the Europe bot health check notifies admin Telegram IDs.

Do not commit `.env` or real audio files unless you intentionally want them in GitHub.
