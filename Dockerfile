FROM node:22-slim
WORKDIR /app
# package-lock.json (commit it: `npm install` once) makes the build reproducible; without one the dependency ranges float
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi
COPY index.js ./
COPY src ./src
# userdata.json, its backups and .keysecret live in the /data volume
ENV NODE_ENV=production DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
# Unhealthy when the manager has not written /data/.health for 3 min (it does so every minute while Telegram answers).
# This flags a hung or cut-off container (`docker ps`); to restart one automatically, use an autoheal helper.
HEALTHCHECK --interval=60s --timeout=10s --start-period=90s --retries=3 \
  CMD node -e "const s=require('fs').statSync(process.env.DATA_DIR+'/.health');process.exit(Date.now()-s.mtimeMs<180000?0:1)"
CMD ["node", "index.js"]
