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
