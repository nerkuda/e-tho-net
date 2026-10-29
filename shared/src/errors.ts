/**
 * ETN error codes and the canonical {@link EtnError} class.
 *
 * Wire format is defined by docs/03-server-api.md §2:
 *
 * ```json
 * { "error": { "code": "VALIDATION_ERROR", "message": "...", "details": ..., "request_id": "..." } }
 * ```
 *
 * NOTE on coverage: `RATE_LIMITED` (HTTP 429, see 06-auth.md §9) and
 * `PROTECTED_ENTITY` (delete/modify of `is_protected` entities) are required by
 * task A4 but are not listed in the §2.1 code table of 03-server-api.md. They
 * are included here per the A4 spec; the REST layer maps them to the
 * appropriate HTTP status.
 */

/**
 * Canonical error codes shared across REST responses, WebSocket close reasons
 * and MCP tool failures.
 */
export const ETN_ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'DUPLICATE',
  'VALIDATION_ERROR',
  'INTERNAL',
  'RATE_LIMITED',
  'PROTECTED_ENTITY',
  // Object locks (task 2031df5e — мягкий серверный захват при редактировании):
  // `LOCKED` — объект захвачен другим участником (HTTP 409); `LOCK_NOT_FOUND` —
  // попытка снять/проверить несуществующий захват (HTTP 404). Осмысленные коды
  // здесь, а не в `VALIDATION_ERROR`/`NOT_FOUND`, потому что клиент по ним
  // различает «правь позже» от «правки не было».
  'LOCKED',
  'LOCK_NOT_FOUND',
] as const;
export type EtnErrorCode = (typeof ETN_ERROR_CODES)[number];

/** Serialisable body of an error response (the `error` field of {@link ApiError}). */
export interface EtnErrorBody {
  code: EtnErrorCode;
  message: string;
  /**
   * Arbitrary machine-readable details. For `VALIDATION_ERROR` this commonly
   * carries `Array<{ field: string; issue: string }>`.
   */
  details?: unknown;
  /** Correlates with the `Client-Request-Id` of the failing request. */
  request_id?: string;
}

/**
 * Error thrown by the ETN domain and transport layers.
 *
 * Carries a stable {@link EtnErrorCode} plus optional machine-readable details
 * so Fastify handlers and the MCP transport can serialise it into
 * {@link EtnErrorBody}. Intended as a pure data carrier — no behaviour beyond
 * field assignment.
 */
export class EtnError extends Error {
  public readonly code: EtnErrorCode;
  public readonly details?: unknown;
  public readonly requestId?: string;

  constructor(code: EtnErrorCode, message: string, details?: unknown, requestId?: string) {
    super(message);
    this.name = 'EtnError';
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

/**
 * Причины отказа записи/удаления значения свойства-связи по адресу стороны
 * (`side`) — машиночитаемый дискриминатор `details.reason` (0.14.1, ошибка
 * d9bc6012).
 *
 * Серверный текст таких `422` адресован API и агентам (в нём есть `side`,
 * `source`, `target`), а пользователю клиент показывает свою формулировку из
 * словаря — выбор формулировки идёт по ЭТИМ значениям, а не по разбору
 * серверного текста. Один источник правды для обеих сторон контракта.
 *
 *   * `side-required` — сторона не указана, а имя адресует обе стороны
 *     симметричного типа связи и обе живые (либо display-имя принадлежит
 *     нескольким свойствам сети);
 *   * `side-mismatch` — при удалении/очистке указанная сторона пуста, а рёбра
 *     есть на противоположной (сверка с фактическим направлением);
 *   * `property-ambiguous` — display-имя принадлежит НЕСКОЛЬКИМ разным
 *     свойствам сети, и выбрать одно не удалось даже по `side` (`field =
 *     "property"`; 0.14.1, доработка d9bc6012). Причина общая для записи
 *     свойства по имени: клиент переводит её в человеческий текст так же, как
 *     side-причины;
 *   * `target-type-mismatch` — значение свойства-связи не того типа, который
 *     допускает привязка целевой стороны (`field = "value"`; 0.14.1, круг 3
 *     ошибки d9bc6012). Серверный текст русский и без GUID, причина нужна для
 *     централизованного перевода в клиенте.
 */
export const PROPERTY_SIDE_ERROR_REASON = {
  required: 'side-required',
  mismatch: 'side-mismatch',
  ambiguous: 'property-ambiguous',
  targetType: 'target-type-mismatch',
} as const;
export type PropertySideErrorReason =
  (typeof PROPERTY_SIDE_ERROR_REASON)[keyof typeof PROPERTY_SIDE_ERROR_REASON];

/**
 * Канонический отказ main-процесса до установки соединения (ошибка f803afb6,
 * круг 2).
 *
 * `requireRest` в `client/src/main/ipc/handlers.ts` и `openNetwork` в
 * `client/src/main/ipc/connection-lifecycle.ts` бросают эту строку, пока
 * профиль не подключён/уже отключён; в сеть запрос не уходил. Текст
 * английский и техничный — до интерфейса он доходить не должен: renderer
 * распознаёт его предикатом {@link isNotConnectedErrorMessage} и переводит в
 * словарное «нет соединения с сервером» (а панель «Свойства» — в повторное
 * чтение после восстановления связи).
 *
 * Строка живёт ЗДЕСЬ единственным источником: и main, и renderer, и тесты
 * берут её отсюда. Дубль литерала по коду краснит сторож
 * `client/tests/guard-not-connected-literal.test.ts`.
 */
export const NOT_CONNECTED_ERROR_PREFIX = 'Not connected: call etn.server.connect';

/** Отказ main, когда нет активного профиля или открытой сети. */
export const NOT_CONNECTED_NETWORK_ERROR_TEXT = `${NOT_CONNECTED_ERROR_PREFIX} and open a network first`;

/** Отказ main до установки соединения: профиль не подключён. */
export const NOT_CONNECTED_ERROR_TEXT = `${NOT_CONNECTED_ERROR_PREFIX} first`;

/**
 * Совпадает ли текст ошибки с каноническим отказом «Not connected…».
 *
 * Проверка структурная (по тексту, без `details.kind`): plain-`Error` из
 * main-процесса переживает IPC без кода и деталей, но означает ровно обрыв
 * связи. Граница слова после префикса не даёт принять за отказ сообщение,
 * лишь начинающееся теми же буквами.
 */
export function isNotConnectedErrorMessage(message: string): boolean {
  const escaped = NOT_CONNECTED_ERROR_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}\\b`, 'i').test(message);
}
