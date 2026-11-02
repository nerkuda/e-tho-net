/**
 * Состояние обслуживания сервера в главном процессе клиента (задача 479e37ed,
 * требование 9636b1cc; серверная сторона — сущность aa55d459, задача 2f599b67).
 *
 * **Зачем отдельный модуль.** Один и тот же факт «сервер обновляется» приходит
 * двумя путями: кадром `maintenance` + close `1012` по WebSocket и отказом
 * `503 SERVER_UPDATING` на изменяющем REST-запросе. Потребителей у факта тоже
 * двое: REST-клиент не отправляет изменяющие запросы, пока состояние активно
 * (это и есть «не повторять раньше `Retry-After`»), а рендерер показывает
 * единое состояние обслуживания. Держать флаг в любом из них порознь —
 * расхождение (кадр пришёл, а запись всё ещё уходит).
 *
 * **Инварианты.**
 *  - Состояние живёт в памяти процесса: переживать перезапуск ему незачем —
 *    клиент после перезапуска начинает с чистого листа и проверяет `/version`.
 *  - Вход идемпотентен: повторный кадр/отказ обновляет `retry_after` и
 *    `target_version`, но не плодит уведомления при тех же значениях.
 *  - Выход из состояния — только внешний и только по двум признакам: успешный
 *    `GET /api/v1/me` ВМЕСТЕ со сменой версии процесса (публичный `GET /version`
 *    показывает другую версию либо не меньше `target_version`) либо сокет,
 *    проживший стабильное окно `maintenanceStableMs` (`maintenance-stable`).
 *    Сам по себе `GET /me` выходом НЕ является: это чтение, и сервер в
 *    обслуживании отвечает на него 200 (вердикт повторной приёмки 479e37ed).
 *    ОТКРЫТИЕ сокета выходом не является тоже: сервер в обслуживании намеренно
 *    принимает сокет и сразу закрывает его кодом 1012. Само состояние ничего
 *    не опрашивает — сети в модуле нет; проверку версии делает REST-клиент,
 *    правило решения — {@link isMaintenanceEndedByVersion}.
 *  - Модуль без зависимости от Electron: юнит-тестируется обычным `node --test`
 *    (тот же приём, что `ipc/connection-lifecycle.ts`).
 *
 * **Тексты.** Пользовательские формулировки здесь не собираются: модуль отдаёт
 * числа (`retry_after`) и признак активности, рендерер переводит их через
 * словарь `t()`. Так строки остаются в одном месте (требование локализации).
 */

import { EtnError, compareSemver, type ServerUpdatingErrorDetails } from '@etn/shared';

/**
 * Текст отказа периода обслуживания — тот же, что у сервера
 * (`SERVER_UPDATING_MESSAGE` в `server/src/maintenance.ts`): пользователь не
 * должен различать, кто именно остановил изменяющий запрос — REST-гейт main,
 * центральный IPC-гейт или сам сервер.
 */
export const SERVER_UPDATING_CLIENT_MESSAGE = 'Сервер обновляется, повторите позже.';

/** Канонический `SERVER_UPDATING` с конвертом `details` — для IPC и REST. */
export function serverUpdatingError(details: ServerUpdatingErrorDetails): EtnError {
  return new EtnError('SERVER_UPDATING', SERVER_UPDATING_CLIENT_MESSAGE, details);
}

/**
 * Пауза до повтора, если сервер/кадр её не сообщил, секунды. Значение —
 * рекомендуемая пауза обслуживания по умолчанию серверной стороны; клиент её
 * не уменьшает, а только использует для показа и отложенного переподключения.
 */
export const DEFAULT_SERVER_MAINTENANCE_RETRY_AFTER_SECONDS = 300;

/** Откуда клиент узнал об обслуживании. */
export type ServerMaintenanceSource = 'realtime' | 'rest';

/** Снимок состояния обслуживания для IPC и REST-гейта. */
export interface ServerMaintenanceInfo {
  /** Рекомендуемая пауза до повтора, целые секунды. */
  retry_after: number;
  /** Версия, до которой обновляется сервер; `null` — неизвестна. */
  target_version: string | null;
  /**
   * Версия процесса, объявившего обслуживание, — та, что клиент наблюдал
   * последней (`GET /version` при подключении/переподключении). Фиксируется
   * при входе в эпизод первым непустым значением и дальше не перезаписывается:
   * именно её смена доказывает, что поднялся НОВЫЙ процесс. `null` — клиент
   * версию не наблюдал.
   */
  entry_version: string | null;
  /** Момент входа в состояние (epoch ms) — для журнала и диагностики. */
  since: number;
  /** Источник последнего уведомления. */
  source: ServerMaintenanceSource;
}

/** Слушатель смены состояния: `null` — обслуживание закончилось. */
export type ServerMaintenanceListener = (info: ServerMaintenanceInfo | null) => void;

/** Нормализует `retry_after` из кадра/конверта: конечное целое ≥ 1, иначе — умолчание. */
function normaliseRetryAfter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_SERVER_MAINTENANCE_RETRY_AFTER_SECONDS;
  }
  return Math.max(1, Math.ceil(value));
}

/** Приводит версию (`target_version`/`entry_version`) к строке или `null`. */
function normaliseVersion(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Действующий выход из обслуживания по успешному `GET /me` (задача 479e37ed,
 * вердикт повторной приёмки). `/me` — ЧТЕНИЕ: сервер в обслуживании отвечает
 * на него 200 (`maintenance-guard.ts` пропускает читающие методы), поэтому
 * успех `/me` сам по себе не отличает старый процесс от нового. Доказывает
 * конец обслуживания только смена версии процесса — её показывает публичный
 * `GET /version` (гейт его не трогает, всегда 200).
 *
 *  - `observedVersion` не прочитана (`null`) — НЕ выход: без доказательства
 *    состояние остаётся, изменяющая запись по-прежнему блокируется;
 *  - версия отличается от наблюдённой на входе в эпизод (`entry_version`) —
 *    выход: сервер мог обновиться на версию, которую не объявлял;
 *  - `target_version` известна и версия процесса не меньше неё — тоже выход
 *    (сравнение `compareSemver` из `@etn/shared`, числовое: `0.15.10` новее
 *    `0.15.2`). Неразборчивая `target_version` сама выхода не даёт: тогда
 *    решение принимается по смене версии от базы эпизода.
 *
 * Чистая функция — вызывается REST-клиентом после успешного `/me` и
 * покрыта тестами без сети.
 */
export function isMaintenanceEndedByVersion(
  info: Pick<ServerMaintenanceInfo, 'target_version' | 'entry_version'>,
  observedVersion: string | null,
): boolean {
  const observed = normaliseVersion(observedVersion);
  if (observed === null) return false;
  if (info.target_version !== null) {
    const order = compareSemver(observed, info.target_version);
    if (order !== null && order >= 0) return true;
  }
  return info.entry_version !== null && observed !== info.entry_version;
}

/**
 * Единственное состояние обслуживания сервера в главном процессе.
 *
 * Владелец — `register.ts` (одно на активное подключение): REST-клиент получает
 * его для гейта изменяющих запросов, пул realtime — для входа по кадру `1012`,
 * IPC — для показа состояния рендереру.
 */
export class ServerMaintenanceState {
  private info: ServerMaintenanceInfo | null = null;
  private readonly listeners = new Set<ServerMaintenanceListener>();

  public constructor(private readonly now: () => number = Date.now) {}

  /** Текущее состояние или `null` (обслуживания нет). */
  public get(): ServerMaintenanceInfo | null {
    return this.info;
  }

  /** `true` — изменяющие запросы обязаны блокироваться. */
  public isActive(): boolean {
    return this.info !== null;
  }

  /**
   * Вход в обслуживание по кадру `maintenance` или конверту `503`. Повторный
   * вход с теми же значениями ничего не уведомляет; изменившиеся
   * `retry_after`/`target_version` доезжают до слушателей. `entryVersion` —
   * версия процесса, объявившего обслуживание (`GET /version`): фиксируется
   * первым непустым значением эпизода и не перезаписывается, иначе смена
   * версии после обновления потерялась бы.
   */
  public enter(
    details: Pick<ServerUpdatingErrorDetails, 'retry_after' | 'target_version'>,
    source: ServerMaintenanceSource,
    entryVersion: string | null = null,
  ): ServerMaintenanceInfo {
    const next: ServerMaintenanceInfo = {
      retry_after: normaliseRetryAfter(details.retry_after),
      target_version: normaliseVersion(details.target_version),
      // Вход повторно не сдвигает начало: «сколько уже длится» не должно
      // обнуляться каждым новым 503/кадром. База версии — так же: эпизод один,
      // а версию доносит то кадр (проверка совместимости), то отказ 503.
      entry_version: this.info?.entry_version ?? normaliseVersion(entryVersion),
      since: this.info?.since ?? this.now(),
      source,
    };
    const changed =
      this.info === null ||
      this.info.retry_after !== next.retry_after ||
      this.info.target_version !== next.target_version ||
      this.info.entry_version !== next.entry_version ||
      this.info.source !== next.source;
    this.info = next;
    if (changed) this.notify(next);
    return next;
  }

  /**
   * Выход из обслуживания. Возвращает `true`, если состояние действительно
   * было активно (вызывающий может зажечь «соединение восстановлено»).
   */
  public leave(): boolean {
    if (this.info === null) return false;
    this.info = null;
    this.notify(null);
    return true;
  }

  /** Подписка на смену состояния; возвращает отписку. */
  public subscribe(listener: ServerMaintenanceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(info: ServerMaintenanceInfo | null): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(info);
      } catch {
        // Слушатель не должен ломать состояние и остальных подписчиков.
      }
    }
  }
}

/** Зависимость REST-клиента: только чтение состояния и вход по 503. */
export interface ServerMaintenanceHandle {
  get(): ServerMaintenanceInfo | null;
  enter(
    details: Pick<ServerUpdatingErrorDetails, 'retry_after' | 'target_version'>,
    source: ServerMaintenanceSource,
    entryVersion?: string | null,
  ): ServerMaintenanceInfo;
  leave(): boolean;
}
