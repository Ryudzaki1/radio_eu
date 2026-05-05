FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV MUSIC_DIR=/music
ENV CACHE_DIR=/cache/announcements
ENV ARCHIVE_DIR=/cache/archive
ENV ADMIN_CONFIG_PATH=/cache/config/admin.json
ENV FACT_LOG_PATH=/cache/config/fact-log.json

COPY package.json ./
COPY server.js index.html script.js styles.css admin.html admin.js ./
COPY src ./src
COPY bot ./bot

USER root
RUN apk add --no-cache ffmpeg
RUN chmod +x /app/bot/quick-tunnel-watch.sh

RUN mkdir -p /music /cache/announcements /cache/archive /cache/config \
  && chown -R node:node /app /music /cache

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/tracks').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
