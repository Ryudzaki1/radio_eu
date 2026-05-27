FROM node:22-alpine3.23

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV MUSIC_DIR=/music
ENV CACHE_DIR=/cache/announcements
ENV ARCHIVE_DIR=/cache/archive
ENV ADMIN_CONFIG_PATH=/cache/config/admin.json
ENV FACT_LOG_PATH=/cache/config/fact-log.json

USER root
ARG APK_MIRROR=http://mirror.yandex.ru/mirrors/alpine
ARG ALPINE_VERSION=3.23
RUN printf "%s/v%s/main\n%s/v%s/community\n" "$APK_MIRROR" "$ALPINE_VERSION" "$APK_MIRROR" "$ALPINE_VERSION" > /etc/apk/repositories \
  && apk add --no-cache ffmpeg

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js index.html script.js styles.css admin-login.html admin.html admin.js ./
COPY assets ./assets
COPY src ./src
COPY bot ./bot
COPY scripts/smoke-tests.js ./scripts/smoke-tests.js

RUN mkdir -p /music /cache/announcements /cache/archive /cache/config \
  && chown -R node:node /app /music /cache

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/tracks').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
