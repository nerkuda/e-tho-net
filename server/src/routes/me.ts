/**
 * Self-service user & API-key routes (task B12, 03-server-api.md §3).
 *
 *   GET    /api/v1/me              — current user (no secrets)
 *   PATCH  /api/v1/me              — edit own profile (display_name only)
 *   GET    /api/v1/me/keys         — list own keys (prefix only)
 *   POST   /api/v1/me/keys         — create a key, full key returned once (201)
 *   PATCH  /api/v1/me/keys/:id     — edit a key's write rate limit (O8)
 *   DELETE /api/v1/me/keys/:id     — revoke an own key (204)
 *
 * Registered under the `/api/v1` prefix by the server factory. The auth
 * preHandler runs first; the idempotency preHandler is attached to the
 * mutating endpoints so client retries are safe.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import type {
  ApiKeyWithSecret,
  CreateApiKeyInput,
  CurrentUser,
  UpdateApiKeyInput,
  User,
} from '@etn/shared';

import { EtnError } from '@etn/shared';

/** Max length of `users.display_name`; mirrors the schema CHECK. */
const DISPLAY_NAME_MAX_LENGTH = 200;

/** Body of `PATCH /me`. */
interface PatchMeBody {
  display_name?: unknown;
}

/** Shape returned by `PATCH /me` and `GET /me` (subset of {@link User}). */
function currentUserDto(user: User): CurrentUser {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    is_admin: user.is_admin,
  };
}

import { generateApiKey, hashApiKey } from '../auth/api-key.js';
import { sendCreated, sendList, sendSuccess } from '../http/responses.js';

/** Body of `POST /me/keys`. */
type CreateKeyBody = CreateApiKeyInput;

/** Body of `PATCH /me/keys/:id`. */
type UpdateKeyBody = UpdateApiKeyInput;

/** Path params for `DELETE /me/keys/:id`. */
interface KeyIdParams {
  id: string;
}

/**
 * Validate a `max_writes_per_minute` value from a request body. Accepts `null`
 * (clear/inherit the server default) or a positive integer; anything else
 * raises `VALIDATION_ERROR`.
 */
export function parseMaxWritesPerMinute(
  value: unknown,
  requestId?: string,
): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'max_writes_per_minute должен быть положительным целым числом или null.',
      { field: 'max_writes_per_minute' },
      requestId,
    );
  }
  return value;
}

/** Build the public DTO of an existing key (no secret). */
function keyPublicDto(k: {
  id: string;
  user_id: string;
  label: string | null;
  prefix: string;
  read_only: boolean;
  max_writes_per_minute: number | null;
  disabled: boolean;
  created_at: string;
  last_used_at: string | null;
}) {
  return {
    id: k.id,
    user_id: k.user_id,
    label: k.label,
    prefix: k.prefix,
    read_only: k.read_only,
    max_writes_per_minute: k.max_writes_per_minute,
    disabled: k.disabled,
    created_at: k.created_at,
    last_used_at: k.last_used_at,
  };
}

/** `/api/v1/me*` route plugin. */
export const meRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/me', { preHandler: [app.authPreHandler] }, async (req: FastifyRequest, reply) => {
    const user = req.auth!.user;
    sendSuccess(reply, currentUserDto(user));
  });

  app.patch(
    '/me',
    { preHandler: [app.authPreHandler, app.idempotency.preHandler] },
    async (req: FastifyRequest, reply) => {
      const me = req.auth!.user;
      const body = (req.body ?? {}) as PatchMeBody;
      const previousDisplayName = me.display_name;

      let nextDisplayName: string | null;
      if (body.display_name === null) {
        nextDisplayName = null;
      } else if (typeof body.display_name === 'string') {
        const trimmed = body.display_name.trim();
        if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `Имя не должно превышать ${DISPLAY_NAME_MAX_LENGTH} символов.`,
            { field: 'display_name' },
            req.id,
          );
        }
        nextDisplayName = trimmed === '' ? null : trimmed;
      } else if (body.display_name === undefined) {
        nextDisplayName = me.display_name;
      } else {
        throw new EtnError(
          'VALIDATION_ERROR',
          'Поле display_name должно быть строкой или null.',
          { field: 'display_name' },
          req.id,
        );
      }

      if (nextDisplayName === previousDisplayName) {
        sendSuccess(reply, currentUserDto(me));
        return;
      }

      app.systemDb.updateUser(me.id, {
        displayName: nextDisplayName,
        isAdmin: me.is_admin,
        disabled: me.disabled,
      });
      app.systemDb.insertAuditLog({
        actorUserId: me.id,
        category: 'user',
        action: 'user.update',
        targetType: 'user',
        targetId: me.id,
        details: {
          display_name: nextDisplayName,
          previous_display_name: previousDisplayName,
          self: true,
        },
      });

      const updated = app.systemDb.getUserById(me.id);
      if (updated === null) {
        // Should not happen — we just updated an existing user.
        throw new EtnError('INTERNAL', 'Не удалось прочитать обновлённого пользователя.', undefined, req.id);
      }
      sendSuccess(reply, currentUserDto(updated));
    },
  );

  app.get('/me/keys', { preHandler: [app.authPreHandler] }, async (req: FastifyRequest, reply) => {
    const keys = app.systemDb.listApiKeysByUser(req.auth!.user.id);
    const data = keys.map(keyPublicDto);
    sendList(reply, data, data.length, 0, data.length);
  });

  app.post(
    '/me/keys',
    { preHandler: [app.authPreHandler, app.idempotency.preHandler] },
    async (req: FastifyRequest, reply) => {
      const body = (req.body ?? {}) as CreateKeyBody;
      const label = typeof body.label === 'string' ? body.label.trim() || null : null;
      const readOnly = body.read_only === true;
      const maxWritesPerMinute =
        body.max_writes_per_minute === undefined
          ? null
          : parseMaxWritesPerMinute(body.max_writes_per_minute, req.id);

      const gen = generateApiKey();
      const apiKey = app.systemDb.createApiKey({
        id: randomUUID(),
        userId: req.auth!.user.id,
        label,
        keyHash: hashApiKey(gen.key),
        keyPrefix: gen.keyPrefix,
        readOnly,
        maxWritesPerMinute,
      });
      app.systemDb.insertAuditLog({
        actorUserId: req.auth!.user.id,
        category: 'user',
        action: 'api_key.create',
        targetType: 'api_key',
        targetId: apiKey.id,
        details: { label, read_only: readOnly, max_writes_per_minute: maxWritesPerMinute, self: true },
      });
      const dto: ApiKeyWithSecret = { ...keyPublicDto(apiKey), key: gen.key };
      sendCreated(reply, dto);
    },
  );

  app.patch(
    '/me/keys/:id',
    { preHandler: [app.authPreHandler, app.idempotency.preHandler] },
    async (req: FastifyRequest, reply) => {
      const { id: keyId } = req.params as KeyIdParams;
      const key = app.systemDb.getApiKeyById(keyId);
      if (key === null || key.user_id !== req.auth!.user.id) {
        // Do not leak ownership: treat a foreign key as not-found.
        throw new EtnError('NOT_FOUND', 'Ключ не найден.', undefined, req.id);
      }
      const body = (req.body ?? {}) as UpdateKeyBody;
      if (!('max_writes_per_minute' in body)) {
        throw new EtnError(
          'VALIDATION_ERROR',
          'Требуется поле max_writes_per_minute (число или null).',
          { field: 'max_writes_per_minute' },
          req.id,
        );
      }
      const maxWritesPerMinute = parseMaxWritesPerMinute(body.max_writes_per_minute, req.id);
      app.systemDb.updateApiKeyMaxWrites(keyId, maxWritesPerMinute);
      app.systemDb.insertAuditLog({
        actorUserId: req.auth!.user.id,
        category: 'user',
        action: 'api_key.update',
        targetType: 'api_key',
        targetId: keyId,
        details: { max_writes_per_minute: maxWritesPerMinute, self: true },
      });
      const updated = app.systemDb.getApiKeyById(keyId)!;
      sendSuccess(reply, keyPublicDto(updated));
    },
  );

  app.delete(
    '/me/keys/:id',
    { preHandler: [app.authPreHandler, app.idempotency.preHandler] },
    async (req: FastifyRequest, reply) => {
      const { id: keyId } = req.params as KeyIdParams;
      const key = app.systemDb.getApiKeyById(keyId);
      if (key === null) {
        throw new EtnError('NOT_FOUND', 'Ключ не найден.', undefined, req.id);
      }
      if (key.user_id !== req.auth!.user.id) {
        // Do not leak ownership: treat a foreign key as not-found.
        throw new EtnError('NOT_FOUND', 'Ключ не найден.', undefined, req.id);
      }
      app.systemDb.disableApiKey(keyId);
      app.systemDb.insertAuditLog({
        actorUserId: req.auth!.user.id,
        category: 'user',
        action: 'api_key.revoke',
        targetType: 'api_key',
        targetId: keyId,
        details: { self: true },
      });
      reply.code(204).send();
    },
  );
};
