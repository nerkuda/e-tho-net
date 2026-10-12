/**
 * Запись статистики исполнения отбора в серверный файловый журнал (требование
 * 0f34a5ff «Статистика исполнения отборов при серверном логировании»).
 *
 * Механизм журнала переиспользован, второго не заводится: `FileLog` пишет
 * INFO только при включённом флаге (`enabled`), а счётчики вовсе не собираются,
 * пока фасад не запросил `collectStats` — при выключенном логировании
 * накладных расходов нет. Наружу (в API-ответ) статистика не выводится.
 */

import type { FileLog } from './file-log.js';
import type { QueryStats } from '../domain/query-service.js';

/**
 * Записать статистику одного исполнения отбора. No-op, если журнал недоступен
 * или статистика не собиралась (логирование выключено либо фасад её не просил).
 */
export function logFilterStats(
  fileLog: FileLog | undefined,
  networkId: string,
  source: string,
  stats: QueryStats | undefined,
): void {
  if (fileLog === undefined || stats === undefined) return;
  fileLog.info('filter', 'execution stats', {
    network: networkId,
    source,
    duration_ms: stats.duration_ms,
    conditions: stats.conditions,
    nodes_walked: stats.nodes_walked,
    hierarchy_calls: stats.hierarchy_calls,
    limits_hit: stats.limits_hit.length > 0 ? stats.limits_hit.join(',') : 'none',
  });
}
