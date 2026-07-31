# LinkTalk — single-process Node app (HTTP + WebSocket on $PORT).
FROM node:22-alpine

WORKDIR /app

# Install production deps first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js phrasebook.js metrics.js ratelimit.js ./
COPY public ./public

# Room history is snapshotted here; mount a volume to keep it across restarts.
VOLUME /app/data

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
