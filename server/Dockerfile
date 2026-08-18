# ETN server image (task K2, docs/install-server.md §6).
#
# Multi-stage build: dependencies + compile in the builder, then a slim
# runtime. `better-sqlite3` installs from prebuilt binaries on node:22 —
# no Python/toolchain needed.

FROM node:22-alpine AS builder
WORKDIR /build

# Install all workspaces (npm workspaces hoist everything to the root).
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY markdown/package.json markdown/
COPY server/package.json server/
COPY client/package.json client/
RUN npm install

# Compile shared + markdown + server only (the client is not needed in this image).
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY markdown/ markdown/
COPY server/ server/
RUN npm run build:shared && npm -w @etn/server run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    ETN_DATA_DIR=/data
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY markdown/package.json markdown/
COPY server/package.json server/
# Production deps (server only — better-sqlite3 prebuilt for alpine/musl).
RUN npm install --omit=dev --workspace @etn/server --include-workspace-root && \
    npm install --omit=dev --workspace @etn/shared --include-workspace-root && \
    npm install --omit=dev --workspace @etn/markdown --include-workspace-root

COPY --from=builder /build/shared/dist ./shared/dist
COPY --from=builder /build/markdown/dist ./markdown/dist
COPY --from=builder /build/server/dist ./server/dist
COPY --from=builder /build/server/migrations ./server/migrations

VOLUME /data
EXPOSE 4321

ENTRYPOINT ["node", "server/dist/index.js"]
