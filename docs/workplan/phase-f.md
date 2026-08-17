# Фаза F — Сервер: MCP

> [← Workplan (индекс)](../workplan.md) — оглавление, статусы фаз и решения.


> После C. Параллельна с D и E.

## F1. Каркас MCP-сервера
- **Статус:** `done` · **Assignee:** agent-F · **Зависимости:** A4
- **Описание:** Использование `@modelcontextprotocol/sdk`, два транспорта (stdio +
  StreamableHTTP), эндпоинт `/mcp`. `initialize` с `protocolVersion` и списком
  tools/resources/prompts.
- **DoD:** MCP-клиент может подключиться и получить список инструментов.
- [x] `server/src/mcp/server.ts` — сборка SDK `McpServer` (identity, capabilities,
  instructions) + регистрация resources/tools/prompts.
- [x] `server/src/mcp/index.ts` — фабрика `createMcpServer(deps)` (systemDb,
  dataDir, pubsub, authProvider, auth, logger), публичный экспорт.
- [x] stdio: `server/src/mcp/stdio.ts` + CLI `etn mcp [--api-key]`
  (env `ETN_API_KEY`); HTTP: `server/src/mcp/http.ts` (StreamableHTTP,
  session map, JSON-ответы + SSE для GET).
- [x] HTTP-эндпоинт `/mcp` на Fastify при `ETN_MCP_ENABLED=1`; отдельный
  порт `ETN_MCP_PORT` — выделенный listener в `index.ts`.
- [x] Тесты: client через InMemoryTransport получает 19 tools / 10 resources /
  4 prompts; HTTP-handshake initialize → session → tools/list → callTool.
- **Спецификация:** [05-mcp-server.md](../05-mcp-server.md), п. 2.

## F2. Авторизация MCP
- **Статус:** `done` · **Assignee:** agent-F · **Зависимости:** F1, B8
- **Описание:** API-key через env/аргумент (stdio) или Bearer (HTTP). Учёт
  `read_only` флага ключа. Повторное использование auth-слоя сервера.
- **DoD:** с невалидным ключом MCP-вызовы отвергаются; с read_only — изменяющие
  tools недоступны.
- [x] `mcp/auth.ts` — `createApiKeyAuthProvider` поверх `hashApiKey` +
  `SystemDb.findApiKeyByHash` (disabled ключ/пользователь → null) + touch.
- [x] stdio: `ETN_API_KEY` / `--api-key`; HTTP: `Authorization: Bearer`,
  повторная проверка ключа на каждый запрос сессии.
- [x] `requireWritable` — read-only ключ отклоняет изменяющие tools (FORBIDDEN).
- [x] Тесты: 401 (нет/невалидный ключ), 403 (чужой ключ в сессии), read-only
  отклонение, disabled ключ/пользователь, не-участник сети.
- **Спецификация:** [05-mcp-server.md](../05-mcp-server.md), п. 2; [06-auth.md](../06-auth.md).

## F3. Resources
- **Статус:** `done` · **Assignee:** agent-F · **Зависимости:** F1
- **Описание:** Реализовать все `etn://` URI из спецификации: networks, thoughts,
  neighbors, comments, attachments, links, types. JSON + Markdown-контент.
- **DoD:** ресурсы читаются по URI.
- [x] `mcp/resources.ts` — 10 ресурсов: `etn://networks` (static) + 9 шаблонов
  (network meta, thought, neighbors, comments, attachments, link,
  thought-types, link-types, thought-type с description).
- [x] JSON (`application/json`) + Markdown для комментариев (`text/markdown`).
- [x] Членство проверяется на каждом чтении (FORBIDDEN для чужих сетей).
- [x] Тест: чтение мысли HOME и комментариев по URI через SDK Client.
- **Спецификация:** [05-mcp-server.md](../05-mcp-server.md), п. 3.

## F4. Tools
- **Статус:** `done` · **Assignee:** agent-F · **Зависимости:** F3, C3–C13
- **Описание:** Все инструменты из спецификации: search, get, neighbors, subgraph,
  path, mentions, create/update/delete thoughts и links, comments.upsert,
  attachments.add, properties.set, find_duplicates, export.subgraph. Изменяющие
  вызывают тот же доменный слой, что и REST → события real-time идут тем же путём.
- **DoD:** инструмент создает мысль → участники видят её через WebSocket.
- [x] `mcp/tools.ts` — все 19 инструментов из §4.1–4.3 (zod-схемы параметров).
- [x] Изменяющие: доменные сервисы + `emitDomainEvent` (thought.created/
  updated/deleted, link.*, comment.*, attachment.created, property-value.set) +
  `expected_version`.
- [x] `etn.comments.upsert` (permanent — create-or-update, chronological — append).
- [x] Тест: create → событие в PubSub (thought.created + link.created), данные
  в data.db, `find_duplicates` до/после; subgraph/path/export на графе из 2 узлов.
- **Спецификация:** [05-mcp-server.md](../05-mcp-server.md), п. 4.

## F5. Prompts
- **Статус:** `done` · **Assignee:** agent-F · **Зависимости:** F4
- **Описание:** Шаблоны `etn.*` (summarize, suggest_links, detect_duplicates,
  generate_report).
- **DoD:** — · **Спецификация:** [05-mcp-server.md](../05-mcp-server.md), п. 5.
- [x] `mcp/prompts.ts` — 4 параметризованных шаблона, текстовые промпты с
  инструкциями в терминах tools/resources.
- [x] Тест: `getPrompt` возвращает текст с `etn://`-ресурсами.

## F6. Лимиты и журналирование MCP
- **Статус:** `done` · **Assignee:** agent-F · **Зависимости:** F4
- **Описание:** `max_nodes_per_subgraph`, `max_writes_per_minute` (L1-настройки),
  запись tool-вызовов в `audit_log`.
- **DoD:** лимиты работают; превышение → частичный результат или 429.
- [x] `SystemDb.getSetting(key)` (новый метод чтения `_system.db.settings`).
- [x] `mcp/limits.ts` — чтение L1-настроек с дефолтами `MCP_DEFAULTS`,
  `WriteRateLimiter` (sliding window 60 с).
- [x] Subgraph/neighbors ограничены `max_nodes_per_subgraph`; изменяющие tools
  расходуют бюджет, превышение → `RATE_LIMITED`.
- [x] Каждый изменяющий tool-вызов → `audit_log` (category `data`, action = tool,
  details = параметры).
- [x] Тесты: лимит записи (2/мин → третья отклонена), audit-строка create.
- **Спецификация:** [05-mcp-server.md](../05-mcp-server.md), п. 6.
