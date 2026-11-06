/**
 * Состояние обслуживания сервера (сущность aa55d459, задача 2f599b67,
 * требование 20be64a8; тех.проект обновления сервера 2d9f5cc7).
 *
 * Единственная точка правды о том, что сервер уходит на обновление. Из неё
 * выводятся все отказы периода обслуживания:
 *
 *   * REST — `503 SERVER_UPDATING` + `Retry-After` на изменяющих запросах
 *     (`http/maintenance-guard.ts`);
 *   * WebSocket — кадр `maintenance` и close `1012` всем сокетам
 *     (`realtime/gateway.ts`);
 *   * MCP — ошибка `SERVER_UPDATING` на изменяющих инструментах
 *     (`mcp/context.ts`).
 *
 * Границы и инварианты:
 *   * состояние живёт в памяти процесса и после старта всегда `idle` — в БД
 *     его нет (переживать перезапуск ему незачем: обновлённый сервер стартует
 *     заново);
 *   * переход только `idle → updating`: обратного перехода в рабочем коде нет,
 *     обновившийся сервер поднимается с `idle`; перевод выполняет задание
 *     обновления (`0a27a63b`) до запуска установщика, а не отдельный процесс;
 *   * `beginUpdating` резолвится, когда кадр разослан и сокеты закрыты, —
 *     задание только после этого запускает установщик (подтверждение
 *     доставки).
 *
 * Модуль не решает, когда обновляться, и не выполняет бэкапы.
 */

import type { RealtimeMaintenanceFrame } from '@etn/shared';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Состояние обслуживания сервера и переход в него (задача 2f599b67).
     * Задание обновления (`0a27a63b`) вызывает `beginUpdating` перед запуском
     * установщика.
     */
    maintenance: MaintenanceService;
  }
}

/** Причина обслуживания — единственная на 0.15.1. */
export const MAINTENANCE_REASON = 'server-updating' as const;
export type MaintenanceReason = typeof MAINTENANCE_REASON;

/**
 * Текст отказа периода обслуживания — общий для REST (`503`) и MCP: одна и та
 * же формулировка из требования «сервер обновляется, повторите позже».
 */
export const SERVER_UPDATING_MESSAGE = "The server is updating, try again later.";

/** Рекомендуемая пауза до повтора по умолчанию, секунды. */
export const DEFAULT_MAINTENANCE_RETRY_AFTER_SECONDS = 300;

/** Нижняя граница `retry_after`: целые секунды, не меньше 30. */
export const MIN_MAINTENANCE_RETRY_AFTER_SECONDS = 30;

/** Фаза обслуживания. */
export type MaintenancePhase = 'idle' | 'updating';

/** Состояние обслуживания — форма сущности aa55d459. */
export interface MaintenanceState {
  state: MaintenancePhase;
  reason: MaintenanceReason | null;
  /** ISO-8601 момента начала обслуживания; `null` в `idle`. */
  since: string | null;
  /** Рекомендуемая пауза до повтора, целые секунды (≥ 30). */
  retry_after: number;
  /** Версия, до которой обновляется сервер; `null` — неизвестна. */
  target_version: string | null;
}

/** Состояние «обслуживание не идёт» — после старта сервера. */
export const IDLE_MAINTENANCE_STATE: MaintenanceState = Object.freeze({
  state: 'idle',
  reason: null,
  since: null,
  retry_after: DEFAULT_MAINTENANCE_RETRY_AFTER_SECONDS,
  target_version: null,
});

/** Параметры перехода `idle → updating`. */
export interface MaintenanceBeginOptions {
  /** Версия, до которой обновляется сервер (`0.15.2`); по умолчанию `null`. */
  target_version?: string | null;
  /** Пауза до повтора, секунды; нормализуется к целому ≥ 30. */
  retry_after?: number;
}

/** Зависимости сервиса обслуживания. */
export interface MaintenanceServiceDeps {
  /**
   * Доставка кадра `maintenance` и закрытие всех сокетов кодом `1012`.
   * Сервис ждёт её завершения перед тем, как разрешить `beginUpdating` —
   * это и есть подтверждение доставки, после которого задание обновления
   * запускает установщик.
   */
  announce: (frame: RealtimeMaintenanceFrame) => Promise<void>;
  /** Часы (тесты); по умолчанию — системное время. */
  now?: () => Date;
}

/** Сервис состояния обслуживания одного процесса сервера. */
export interface MaintenanceService {
  /** Текущее состояние; всегда непустое (`idle` после старта). */
  getState(): MaintenanceState;
  /**
   * `idle → updating`. Состояние меняется синхронно — с этого момента ни один
   * изменяющий запрос не проходит; кадр рассылается и сокеты закрываются
   * после этого. Повторный вызов во время обслуживания не рассылает кадр
   * второй раз и ждёт уже начатую рассылку.
   */
  beginUpdating(options?: MaintenanceBeginOptions): Promise<MaintenanceState>;
}

/** `retry_after` — целые секунды, не меньше 30; мусор заменяется значением по умолчанию. */
function normaliseRetryAfter(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAINTENANCE_RETRY_AFTER_SECONDS;
  }
  return Math.max(MIN_MAINTENANCE_RETRY_AFTER_SECONDS, Math.trunc(value));
}

/** Кадр обслуживания из состояния — ровно те поля, что уходят в сокеты. */
function maintenanceFrame(state: MaintenanceState): RealtimeMaintenanceFrame {
  return {
    type: 'maintenance',
    reason: MAINTENANCE_REASON,
    retry_after: state.retry_after,
    target_version: state.target_version,
  };
}

/**
 * Создать сервис обслуживания. Один экземпляр на процесс сервера
 * (`createServer` создаёт его и декорирует `app.maintenance`); тесты вправе
 * собрать изолированный экземпляр со своим `announce`.
 */
export function createMaintenanceService(deps: MaintenanceServiceDeps): MaintenanceService {
  const now = deps.now ?? (() => new Date());
  let state: MaintenanceState = { ...IDLE_MAINTENANCE_STATE };
  /** Идущая рассылка кадра: второй `beginUpdating` ждёт её, а не дублирует. */
  let announcement: Promise<void> | null = null;

  return {
    getState(): MaintenanceState {
      return { ...state };
    },

    async beginUpdating(options: MaintenanceBeginOptions = {}): Promise<MaintenanceState> {
      if (state.state === 'updating') {
        // Кадр рассылается один раз на переход (требование 9636b1cc:
        // повторной рассылки нет); второй сигнал лишь ждёт доставки.
        if (announcement !== null) {
          await announcement;
        }
        return { ...state };
      }

      state = {
        state: 'updating',
        reason: MAINTENANCE_REASON,
        since: now().toISOString(),
        retry_after: normaliseRetryAfter(options.retry_after),
        target_version: options.target_version ?? null,
      };
      // Состояние уже `updating`: изменяющие запросы получают отказ даже пока
      // кадр ещё летит. Рассылка — следующей строкой; ссылка сохраняется,
      // чтобы повторный вызов дождался её, а не вернулся раньше времени.
      announcement = deps.announce(maintenanceFrame(state));
      try {
        await announcement;
      } finally {
        announcement = null;
      }
      return { ...state };
    },
  };
}
