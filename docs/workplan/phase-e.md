# Фаза E — Сервер: real-time (WebSocket)

> [← Workplan (индекс)](../workplan.md) — оглавление, статусы фаз и решения.


> После C. Параллельна с D и F. Внутри фазы — последовательно E1→…→E6.

## E1. WebSocket-шлюз
- **Статус:** `done` · **Assignee:** agent-E · **Зависимости:** B7, B8
- **Описание:** `@fastify/websocket`, маршрут `/api/v1/realtime?network_id=...`.
  Проверка ключа и членства; закрытие 4401/4404. Структура подключения:
  `(user_id, client_id, network_id)`. Реестры `byClient`, `byNetwork`.
- **DoD:**
  - [x] Подключение с валидным ключом держится; невалидное — закрывается с кодом.
  - [x] 4401 для невалидного ключа и не-члена сети; 4404 для несуществующей сети.
  - [x] Реестры `connections` / `byNetwork` / `byClient` ведутся корректно.
- **Note:** реализовано вместе с E4/E5 в `server/src/realtime/gateway.ts`
  (один модуль); доставка с audience-фильтром, resume и ping/pong — там же.
- **Спецификация:** [04-realtime.md](../04-realtime.md), п. 2; [11-settings-and-state.md](../11-settings-and-state.md), п. 1.

## E2. event_log и network_seq
- **Статус:** `done` · **Assignee:** agent-E · **Зависимости:** E1, B10
- **Описание:** В каждой изменяющей операции в той же транзакции — инкремент
  `network_seq`, запись события в `event_log`. TTL-очистка по джобе.
- **DoD:**
  - [x] На каждое изменение создаётся событие с уникальным `seq`.
  - [x] `SystemDb.nextNetworkSeq/appendEvent/readEventsAfter/getMinEventSeq/pruneOldEvents`.
  - [x] TTL-джоба (`realtime/event-log-cleanup.ts`): окно 10 000 строк / 24 ч.
- **Note:** seq+append атомарны в одной транзакции `_system.db`; эмиссия — в
  `realtime/emit.ts` (E3), вызывается после мутации данных сети.
- **Спецификация:** [04-realtime.md](../04-realtime.md), п. 5; [02-data-model.md](../02-data-model.md).

## E3. Эмиссия событий из доменного слоя
- **Статус:** `done` · **Assignee:** agent-E · **Зависимости:** E2
- **Описание:** После коммита транзакции — `pubsub.emit(network_id, event)`. Все
  типы событий из `@etn/shared`. Связать с C3–C13 (внести эмитты в сервисы).
- **DoD:**
  - [x] На каждое REST-изменение эмиттится корректное событие.
  - [x] `realtime/emit.ts` — `emitDomainEvent(...)`: seq + event_log + pubsub.
  - [x] Внедрено в `routes/networks.ts`: `network.updated`, `member.added`,
    `member.removed`, 2× `member.role_changed` (передача владения),
    `user-preference.updated` (audience=user).
- **Note:** эмиссия внедрена в маршруты, а не в сервисы (безопаснее: после
  успешной мутации). Карта «событие → маршрут фазы D» задокументирована в
  заголовке `realtime/emit.ts` — D-агент подключает остальные события после
  merge своих маршрутов.
- **Спецификация:** [04-realtime.md](../04-realtime.md), п. 4.

## E4. Audience filtering
- **Статус:** `done` · **Assignee:** agent-E · **Зависимости:** E3
- **Описание:** Доставка: `audience=network` → всем подписчикам сети;
  `audience=user` → только тому же `user_id`. Подавление эха по `actor.client_id`.
- **DoD:**
  - [x] Приватные настройки доходят только владельцу (тест: два пользователя).
  - [x] Эхо автору не доставляется (подавление по `actor.client_id`).
  - [x] При `resume` чужие `audience=user` события не отдаются.
- **Спецификация:** [04-realtime.md](../04-realtime.md), п. 5; [11-settings-and-state.md](../11-settings-and-state.md), п. 4.

## E5. Resume и last_seq
- **Статус:** `done` · **Assignee:** agent-E · **Зависимости:** E4
- **Описание:** Сообщение `resume { last_seq }` → отдача событий из `event_log` с
  большим `seq`. При выходе за окно — `resume.stale`. Пинг/понг, реконнект.
- **DoD:**
  - [x] После обрыва клиент получает пропущенные события (пачками по 500).
  - [x] Дыра в окне → `resume.stale { last_seq: min_seq-1 }`.
  - [x] Серверный ping каждые 30 с; без pong 60 с → закрытие (1001);
    клиентский `ping` → `pong`.
- **Спецификация:** [04-realtime.md](../04-realtime.md), п. 2.1–2.2, 6;
  [11-settings-and-state.md](../11-settings-and-state.md), п. 1.3.

## E6. Несколько клиентов одного пользователя
- **Статус:** `done` · **Assignee:** agent-E · **Зависимости:** E5
- **Описание:** Тестирование сценария: один пользователь, два `client_id`
  одновременно. Каждый независимо получает поток и имеет свой `last_seq` (на
  клиенте).
- **DoD:**
  - [x] Сценарий `F1` из [09-scenarios.md](../09-scenarios.md) проходит
    (интеграционные WS-тесты в `tests/realtime-gateway.test.ts`).
  - [x] Два клиента одного пользователя получают общий поток независимо;
    эхо подавляется только у инициировавшего клиента.
- **Спецификация:** [11-settings-and-state.md](../11-settings-and-state.md), п. 1.5.
