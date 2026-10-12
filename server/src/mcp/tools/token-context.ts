/**
 * Контекст разрешения токенов AST для MCP-вызовов (обязательный пункт задачи
 * cb78315b, замечание верификатора задачи 0f1b9892; требование 1b77decd).
 *
 * Собирается в одном месте, чтобы `etn.thoughts.query` и `etn.views.run` не
 * расходились: часы исполнения, вызывающий пользователь (`$user`), первый день
 * недели сети (настройка `first_day_of_week`, влияет на `$weekStart`/`$weekEnd`)
 * и профиль времени.
 */

import type { AstTokenContext } from '../../domain/query-service.js';
import type { McpRuntime } from '../context.js';

/**
 * Контекст для сетевого AST-отбора: `firstDayOfWeek` берётся из настроек сети
 * (системная БД). `withTime: true` — сетевая выборка исполняется в профиле со
 * временем: `$now`/`$hourStart`/`$hourEnd` и единицы `h`/`mi` разрешены
 * (историческая совместимость резолвера — профиль со временем по умолчанию).
 */
export function mcpTokenContext(rt: McpRuntime, networkId: string): AstTokenContext {
  const network = rt.deps.systemDb.getNetworkById(networkId);
  return {
    nowMs: Date.now(),
    userId: rt.deps.auth.userId,
    ...(network !== null && network.first_day_of_week !== undefined
      ? { firstDayOfWeek: network.first_day_of_week }
      : {}),
    withTime: true,
  };
}
