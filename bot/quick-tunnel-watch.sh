#!/bin/sh
set -eu

STATE_PATH="${PUBLIC_URL_STATE_PATH:-/cache/config/public-url.json}"
mkdir -p "$(dirname "$STATE_PATH")"

cloudflared tunnel --no-autoupdate --url http://radio:3000 2>&1 | while IFS= read -r line; do
  echo "$line"
  url="$(printf '%s\n' "$line" | sed -n 's/.*\(https:\/\/[^ ]*trycloudflare.com\).*/\1/p' | head -n 1)"
  if [ -n "$url" ]; then
    tmp="${STATE_PATH}.tmp"
    printf '{"url":"%s","updatedAt":"%s"}\n' "$url" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp"
    mv "$tmp" "$STATE_PATH"
  fi
done
