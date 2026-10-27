/**
 * Типы для `ui-probe-delay-proxy.mjs` (замедляющий прокси стенда, ошибка
 * 58c55bb9). Нужны юнит-тесту `tests/ui-probe-stand.test.ts`: проверяются
 * чистые функции отбора задерживаемых запросов.
 */

/** Правило задержки: миллисекунды и (необязательная) подстрока пути. */
export interface DelayProxyRule {
  delayMs: number;
  /** `''`/не задано — задерживать все запросы засеянной сети. */
  pathFilter?: string;
}

/** Задерживать ли запрос этой сети (сегмент `<networkId>` в пути + pathFilter). */
export declare function needsDelay(
  url: string | undefined,
  networkId: string | undefined,
  pathFilter?: string,
): boolean;

/** Индекс первого подходящего правила или -1 (URL чужой сети — тоже -1). */
export declare function matchDelayRule(
  url: string | undefined,
  networkId: string | undefined,
  rules: DelayProxyRule[],
): number;

/** Миллисекунды задержки по первому подходящему правилу; `null` — нет совпадения. */
export declare function delayForUrl(
  url: string | undefined,
  networkId: string | undefined,
  rules: DelayProxyRule[],
): number | null;

/** Опции запуска прокси задержки. */
export interface DelayProxyOptions {
  /** Порт сервера стенда, на который проксируются запросы. */
  targetPort: number;
  /** Сеть, запросы которой задерживаются. */
  networkId: string;
  /** Задержка ответа, мс (по умолчанию 3000); действует без `rules`. */
  delayMs?: number;
  /** Задерживать только пути, содержащие подстроку ('' — все пути сети). */
  pathFilter?: string;
  /** Список правил «путь → задержка» (первое совпадение); сильнее delayMs/pathFilter. */
  rules?: DelayProxyRule[];
  /** Журнал запуска/остановки (по умолчанию тишина). */
  log?: (line: string) => void;
}

/** Поднятый прокси: адрес, счётчики задержек и остановка. */
export interface DelayProxyHandle {
  port: number;
  /** Сколько запросов реально задержано (0 — path-фильтр не совпал). */
  delayedCount: () => number;
  /** Сколько запросов задержало каждое правило (по индексам `rules`). */
  delayedByRule: () => number[];
  close: () => Promise<void>;
}

export declare function startDelayProxy(opts: DelayProxyOptions): Promise<DelayProxyHandle>;
