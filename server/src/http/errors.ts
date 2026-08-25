/**
 * Error-response helpers shared by all Fastify handlers (task B7,
 * 03-server-api.md §2).
 *
 * The wire shape is `{ error: { code, message, details?, request_id? } }`.
 * Domain code throws {@link EtnError} (from @etn/shared); the Fastify error
 * handler converts it into the canonical JSON body and HTTP status. Handlers
 * can also call {@link sendEtnError} directly for cases that don't fit the
 * throw model (e.g. authentication preHandlers).
 */

import type { FastifyReply } from 'fastify';

import { EtnError, type ApiError, type EtnErrorBody, type EtnErrorCode } from '@etn/shared';

/** Maps a stable {@link EtnErrorCode} to its HTTP status code. */
export function httpStatusForCode(code: EtnErrorCode): number {
  switch (code) {
    case 'BAD_REQUEST':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'VERSION_CONFLICT':
    case 'DUPLICATE':
      return 409;
    case 'VALIDATION_ERROR':
    case 'PROTECTED_ENTITY':
      return 422;
    case 'RATE_LIMITED':
      return 429;
    case 'INTERNAL':
    default:
      return 500;
  }
}

/** Build the canonical {@link ApiError} body for a code+message. */
export function buildErrorBody(
  code: EtnErrorCode,
  message: string,
  details?: unknown,
  requestId?: string,
): ApiError {
  const body: EtnErrorBody = { code, message };
  if (details !== undefined) {
    body.details = details;
  }
  if (requestId !== undefined) {
    body.request_id = requestId;
  }
  return { error: body };
}

/**
 * Send an error response with the canonical body and the HTTP status derived
 * from `code`. Used by preHandlers (auth/access-control) that must reply
 * directly rather than throw.
 */
export function sendEtnError(
  reply: FastifyReply,
  code: EtnErrorCode,
  message: string,
  details?: unknown,
  requestId?: string,
): void {
  reply.code(httpStatusForCode(code)).send(buildErrorBody(code, message, details, requestId));
}

/**
 * Normalise any thrown value into the {@link ApiError} body + HTTP status used
 * by the global error handler. `EtnError` carries the canonical code/details;
 * Fastify validation errors map to `VALIDATION_ERROR`; anything else becomes a
 * generic `INTERNAL` 500 (with the real message only in logs, never on the
 * wire).
 */
export function normaliseError(
  err: unknown,
  requestId?: string,
): { statusCode: number; body: ApiError; internalMessage: string } {
  if (err instanceof EtnError) {
    return {
      statusCode: httpStatusForCode(err.code),
      body: buildErrorBody(err.code, err.message, err.details, requestId ?? err.requestId),
      internalMessage: err.message,
    };
  }

  // Fastify's own validation errors (schema/ajv) carry `validation` context.
  const maybeValidation = err as { validation?: unknown; message?: string; statusCode?: number };
  if (maybeValidation.validation !== undefined) {
    return {
      statusCode: 400,
      body: buildErrorBody(
        'BAD_REQUEST',
        maybeValidation.message ?? 'Invalid request body',
        undefined,
        requestId,
      ),
      internalMessage: maybeValidation.message ?? 'validation error',
    };
  }

  // Fastify's built-in body/content-type parser already classifies malformed
  // request bodies as 400 before our handlers ever run — e.g. a body that
  // isn't valid JSON (`SyntaxError`, statusCode 400) or, notably, a body sent
  // in a non-UTF-8 encoding: `payload.setEncoding('utf8')` silently replaces
  // invalid byte sequences with U+FFFD, which then makes the re-encoded byte
  // length disagree with the client's `Content-Length` header
  // (`FST_ERR_CTP_INVALID_CONTENT_LENGTH`) or leaves an empty/unparsable body
  // (`FST_ERR_CTP_EMPTY_JSON_BODY`). None of these carry `.validation`, so
  // without this branch they used to fall through to a generic 500 — a client
  // mistake masquerading as a server failure. Treat any such pre-classified
  // 400 as `BAD_REQUEST` (03-server-api.md §2.1: "Невалидное тело запроса")
  // instead of discarding the statusCode Fastify already computed.
  if (maybeValidation.statusCode === 400) {
    const rawMessage = maybeValidation.message ?? 'invalid request body';
    return {
      statusCode: 400,
      body: buildErrorBody(
        'BAD_REQUEST',
        `Тело запроса не удалось разобрать как JSON в кодировке UTF-8: ${rawMessage}`,
        undefined,
        requestId,
      ),
      internalMessage: rawMessage,
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    statusCode: 500,
    body: buildErrorBody('INTERNAL', 'Внутренняя ошибка сервера', undefined, requestId),
    internalMessage: message,
  };
}
