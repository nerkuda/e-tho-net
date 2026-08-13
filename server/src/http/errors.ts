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

  const message = err instanceof Error ? err.message : String(err);
  return {
    statusCode: 500,
    body: buildErrorBody('INTERNAL', 'Внутренняя ошибка сервера', undefined, requestId),
    internalMessage: message,
  };
}
