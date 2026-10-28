/**
 * Типы для `ui-probe-delay-proxy.mjs` (прокси стенда, ошибки 58c55bb9 и
 * b213cf60). Нужны юнит-тесту `tests/ui-probe-stand.test.ts`: проверяются
 * чистые функции отбора задерживаемых запросов и режим «форвард + подмена
 * статуса».
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
  /**
   * Задержка ОТВЕТА: запрос уходит сразу, ответ придерживается. Нужна, чтобы
   * ответ, вычисленный до правки, был доставлен после неё (дедупликация
   * in-flight GET, задача ddcb8e84).
   */
  responseRules?: DelayProxyRule[];
  /**
   * Режим «форвард + подмена статуса»: запросы засеянной сети, чей путь
   * содержит подстроку, уходят на сервер, а клиент получает `failStatus`
   * (ошибка b213cf60). `''` — режим выключен.
   */
  failPath?: string;
  /** Подменяемый статус (по умолчанию 404). */
  failStatus?: number;
  /** Журнал запуска/остановки (по умолчанию тишина). */
  log?: (line: string) => void;
}

/** Поднятый прокси: адрес, счётчики задержек/подмен и остановка. */
export interface DelayProxyHandle {
  port: number;
  /** Сколько запросов реально задержано (0 — path-фильтр не совпал). */
  delayedCount: () => number;
  /** Сколько запросов задержало каждое правило (по индексам `rules`). */
  delayedByRule: () => number[];
  /** Сколько ОТВЕТОВ придержано (0 — фильтр `responseRules` не совпал). */
  delayedResponseCount: () => number;
  /** Сколько ответов придержало каждое правило (по индексам `responseRules`). */
  delayedResponseByRule: () => number[];
  /** Сколько запросов получило подменённый статус (0 — failPath не совпал). */
  failedCount: () => number;
  close: () => Promise<void>;
}

export declare function startDelayProxy(opts: DelayProxyOptions): Promise<DelayProxyHandle>;
