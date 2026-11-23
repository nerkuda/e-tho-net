# ETN server images (task K2, задача 3db76d75; ADRs ad67950b, aa9507e6, d17c3a29).
#
# Две цели из одного рантайма:
#   server — HTTP/REST/WS: ENTRYPOINT node server/dist/index.js
#   mcp    — MCP stdio:     ENTRYPOINT node server/dist/cli.js mcp
#
# Каталог данных — /data (ETN_DATA_DIR): классификация, инициализация, маркер
# mcp/ownership.json и ключ mcp/key делаются общим bootstrap-модулем рантайма,
# а не этим файлом (ADR aa9507e6 п. 5) — своей логики входа у образа нет.
#
# Метки собираются из build-args (их считает `server/scripts/lib/docker-metadata.mjs`:
# реестровое имя читается из `server/src/mcp/server.ts`, версия — из корневого
# `package.json`, лицензия — из `LICENSE`); литерала реестрового имени здесь нет
# намеренно. Обе цели падают, если метки не переданы: образ адресуется явно
# (`--target`), а не «собери что получится».
#
# `better-sqlite3` ставится из prebuilt-бинарников на node:22 — Python и
# toolchain не нужны. Клиент Electron в образ не входит.

FROM node:22-alpine AS builder
WORKDIR /build

# Установка всех workspace (npm-hoisting в корень), клиент — только манифест.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY markdown/package.json markdown/
COPY server/package.json server/
COPY client/package.json client/
RUN npm install

# Компиляция shared + markdown + server: клиент в образе не нужен.
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY markdown/ markdown/
COPY server/ server/
RUN npm run build:shared && npm -w @etn/server run build

# Общий слой рантайма: prod-зависимости и собранный сервер.
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    ETN_DATA_DIR=/data
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY markdown/package.json markdown/
COPY server/package.json server/
# Prod-зависимости (только сервер — better-sqlite3 prebuilt для alpine/musl).
RUN npm install --omit=dev --workspace @etn/server --include-workspace-root && \
    npm install --omit=dev --workspace @etn/shared --include-workspace-root && \
    npm install --omit=dev --workspace @etn/markdown --include-workspace-root

COPY --from=builder /build/shared/dist ./shared/dist
COPY --from=builder /build/markdown/dist ./markdown/dist
COPY --from=builder /build/server/dist ./server/dist
COPY --from=builder /build/server/migrations ./server/migrations

VOLUME /data

# HTTP-образ: GUI-сервер. Реестровой MCP-метки на нём нет — он не запускает MCP.
FROM runtime AS server
ARG VERSION
ARG REVISION
ARG SOURCE_URL
ARG LICENSE
RUN test -n "$VERSION" && test -n "$REVISION" && test -n "$SOURCE_URL" && test -n "$LICENSE"
# В контейнере слушаем все интерфейсы и штатный порт ETN: без этого plain
# `docker run -p 4321:4321` не отвечает (сервер по умолчанию 127.0.0.1:3000).
ENV ETN_HOST=0.0.0.0 \
    ETN_PORT=4321
LABEL org.opencontainers.image.title="ETN server (HTTP)" \
      org.opencontainers.image.description="ETN knowledge-graph server: REST, WebSocket and the web UI backend" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.licenses="${LICENSE}"

EXPOSE 4321
ENTRYPOINT ["node", "server/dist/index.js"]

# stdio-образ MCP-сервера: тот же рантайм, другой вход. Единственный образ с
# меткой владения `io.modelcontextprotocol.server.name` (ADR d17c3a29 п. 2).
FROM runtime AS mcp
ARG VERSION
ARG REVISION
ARG SOURCE_URL
ARG LICENSE
ARG MCP_REGISTRY_NAME
RUN test -n "$VERSION" && test -n "$REVISION" && test -n "$SOURCE_URL" && \
    test -n "$LICENSE" && test -n "$MCP_REGISTRY_NAME"
LABEL org.opencontainers.image.title="ETN MCP server (stdio)" \
      org.opencontainers.image.description="ETN MCP server: graph-of-thoughts knowledge bases over stdio" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.licenses="${LICENSE}" \
      io.modelcontextprotocol.server.name="${MCP_REGISTRY_NAME}"

ENTRYPOINT ["node", "server/dist/cli.js", "mcp"]
