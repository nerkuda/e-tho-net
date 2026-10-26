/**
 * Типы для `ui-probe-delay-proxy.mjs` (замедляющий прокси стенда, ошибка
 * 58c55bb9). Нужны юнит-тесту `tests/ui-probe-stand.test.ts`: проверяется
 * чистая функция отбора задерживаемых запросов.
 */

/** Задерживать ли запрос этой сети (сегмент `<networkId>` в пути). */
export declare function needsDelay(url: string | undefined, networkId: string | undefined): boolean;

/** Опции запуска прокси задержки. */
export interface DelayProxyOptions {
  /** Порт сервера стенда, на который проксируются запросы. */
  targetPort: number;
  /** Сеть, запросы которой задерживаются. */
  networkId: string;
  /** Задержка ответа, мс (по умолчанию 3000). */
  delayMs?: number;
  /** Журнал запуска/остановки (по умолчанию тишина). */
  log?: (line: string) => void;
}

/** Поднятый прокси: адрес и остановка. */
export interface DelayProxyHandle {
  port: number;
  close: () => Promise<void>;
}

export declare function startDelayProxy(opts: DelayProxyOptions): Promise<DelayProxyHandle>;
