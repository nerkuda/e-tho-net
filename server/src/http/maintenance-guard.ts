/**
 * REST-гейт обслуживания сервера (задача 2f599b67, требование 20be64a8;
 * состояние — сущность aa55d459).
 *
 * Пока сервер в состоянии `updating`, изменяющий запрос (тот же признак, что у
 * guard'а версии клиента: `PUT`/`PATCH`/`DELETE` и `POST` вне allowlist
 * читающих маршрутов — {@link isMutatingRequest}) получает `503
 * SERVER_UPDATING` с `Retry-After` из состояния. Обоснование признака: `POST`
 * — не признак изменения (клиент читает мысли и хронику именно `POST`-ами), а
 * второй список читающих маршрутов в проекте заводить запрещено.
 *
 * Исключения:
 *   * методы чтения (`GET`/`HEAD`/`OPTIONS`) не блокируются — клиент видит
 *     состояние сервера, `GET /api/v1/health`, `/api/v1/version` и `/api/v1/me`
 *     остаются доступны (по успешному `/me` клиент понимает, что обслуживание
 *     закончилось);
 *   * `/mcp` не перехватывается вовсе: у него собственный транспорт (в том
 *     числе сырой node-http листенер `ETN_MCP_PORT`, который в хуки Fastify не
 *     попадает), а обслуживание проверяет диспетчер MCP-инструментов.
 *
 * Приоритет: 503 за обслуживание важнее проверки версии клиента (426) —
 * гейт ставится `onRequest`-хуком, версия проверяется позже, в `preHandler`
 * (`auth/client-version-guard.ts`).
 *
 * Модуль чистый: только решает, отказать ли, и отдаёт значения для
 * `Retry-After`/`details`; ответ отправляет `http/server.ts` каноническим
 * конвертом.
 */

import type { ServerUpdatingErrorDetails } from '@etn/shared';

import {
  isMutatingRequest,
  requestPath,
  type ClientVersionGuardRequest,
} from '../auth/client-version-guard.js';
import { IDLE_MAINTENANCE_STATE, type MaintenanceState } from '../maintenance.js';

/** Путь MCP-эндпоинта: собственный транспорт, гейт обслуживания — в диспетчере. */
const MCP_PATH = '/mcp';

/**
 * Запрос-двойник гейта: те же поля, что читает guard версии (метод, путь),
 * поэтому юнит-тесты не поднимают Fastify.
 */
export type MaintenanceGuardRequest = ClientVersionGuardRequest;

/** Отказ гейта: значения для `Retry-After` и `details` ошибки `503`. */
export type MaintenanceRejection = ServerUpdatingErrorDetails;

/** Зависимости гейта. */
export interface MaintenanceGuardOptions {
  /**
   * Текущее состояние обслуживания. `null` — сервис ещё не создан (хук
   * зарегистрирован раньше гейтвея; запросов в этот момент быть не может) —
   * считается `idle`.
   */
  getState: () => MaintenanceState | null;
}

/**
 * Создать гейт. Возвращает `null` для допустимого запроса и значения отказа
 * для изменяющего запроса в состоянии `updating`.
 */
export function createMaintenanceGuard(
  options: MaintenanceGuardOptions,
): (req: MaintenanceGuardRequest) => MaintenanceRejection | null {
  return (req) => {
    // `/mcp` — своя проверка в диспетчере MCP; общий REST-503 его не касается.
    if (requestPath(req) === MCP_PATH) {
      return null;
    }
    if (!isMutatingRequest(req)) {
      return null;
    }
    const state = options.getState() ?? IDLE_MAINTENANCE_STATE;
    if (state.state !== 'updating') {
      return null;
    }
    return { retry_after: state.retry_after, target_version: state.target_version };
  };
}
