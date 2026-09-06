-- Object locks — мягкие серверные захваты объектов при совместном
-- редактировании (задача 2031df5e, сущность e0a1ae3a «object_locks»;
-- требования f8d55c19 «захват — границы и запрет записи» и 9ac48831
-- «сброс захватов — старт, разрыв WS, ручная команда»;
-- docs/02-data-model.md §3 — таблицы мыслесети).
--
-- Не ветвится: это состояние сети «здесь и сейчас», а не история правок.
-- Слой не несём — захваты переживают выбор рабочего слоя, но не переживают
-- рестарт сервера (см. openNetworkDb — таблица очищается при первом открытии
-- каждой сети в текущем процессе).
--
-- Один объект сети может быть захвачен только одним пользователем
-- (UNIQUE на тройке network_id/entity_type/entity_id). Свои захваты
-- идемпотентны: повторный acquire того же объекта тем же пользователем —
-- продление (обновляются client_id и acquired_at_ms).
--
-- Чтение объектов НЕ блокируется захватом — только операции записи
-- (через enforceLock в доменном слое).
--
-- Очистка:
--   * старт сервера — все строки (openNetworkDb чистит таблицу при первом
--     открытии сети; см. server/src/db/network-db.ts);
--   * разрыв WebSocket-подключения — все строки с совпадающим client_id
--     (сброс в real-time/gateway.ts на socket 'close');
--   * ручная команда — все строки выбранного пользователя (POST /locks/clear).

CREATE TABLE object_locks (
  id              TEXT PRIMARY KEY,
  -- Вид объекта: 'thought' | 'link' | 'thought_type' | 'link_type' |
  -- 'comment' | 'attachment' | 'network_property' | 'type_property' |
  -- 'property_value' | 'layer'. Состав растёт вместе с доменом — текстовое
  -- поле без CHECK, чтобы новые виды не требовали миграции.
  entity_type     TEXT    NOT NULL,
  entity_id       TEXT    NOT NULL,
  network_id      TEXT    NOT NULL,
  user_id         TEXT    NOT NULL,
  -- Client-Id запроса, поставившего захват. NULL когда захват пришёл
  -- по REST/MCP без WebSocket-подключения или когда клиент не передал
  -- заголовок Client-Id.
  client_id       TEXT,
  acquired_at_ms  INTEGER NOT NULL,
  UNIQUE (network_id, entity_type, entity_id)
);

-- Поддержка сброса всех захватов участника (POST /locks/clear, требование 9ac48831).
CREATE INDEX idx_object_locks_user
  ON object_locks (network_id, user_id);

-- Поддержка сброса всех захватов клиента при разрыве WebSocket-подключения
-- (требование 9ac48831).
CREATE INDEX idx_object_locks_client
  ON object_locks (network_id, client_id)
  WHERE client_id IS NOT NULL;
