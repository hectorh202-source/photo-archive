# The React interface, built separately: it has its own package.json and
# deps that have nothing to do with the server's runtime. Output lands in
# client/dist, served as static files by the server (see src/index.ts).
FROM node:24-slim AS client-builder
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client ./
RUN npm run build

# node:24 ships node:sqlite without an experimental flag, which is what the
# storage layer relies on (see src/db/index.ts).
FROM node:24-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# gosu drops from root to the unprivileged "node" user after the entrypoint
# fixes /data ownership — the app process itself never runs as root.
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=client-builder /app/client/dist ./client/dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3100
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
