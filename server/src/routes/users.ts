/**
 * Admin user-management routes (task B12, 03-server-api.md §4.1, 06-auth.md §6).
 *
 *   GET    /api/v1/admin/users                  — list users
 *   POST   /api/v1/admin/users                  — create user + one-time key (201)
 *   GET    /api/v1/admin/users/:id              — fetch one
 *   PATCH  /api/v1/admin/users/:id              — update display_name/is_admin/disabled
 *   DELETE /api/v1/admin/users/:id              — delete (422 for first user / network owner)
 *   POST   /api/v1/admin/users/:id/keys         — issue a key for a user (201, full key once)
 *   PATCH  /api/v1/admin/users/:id/keys/:keyId   — edit a key's write rate limit (O8)
 *   DELETE /api/v1/admin/users/:id/keys/:keyId  — revoke a user's key (204)
 *
 * All routes require `requireAdmin`. Mutating routes also use the idempotency
 * preHandler. Protected invariants (06-auth.md §4.3): the first user cannot be
 * deleted or demoted; a user owning networks cannot be deleted.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import type { ApiKeyWithSecret, CreateUserInput, UpdateUserInput } from '@etn/shared';

import { EtnError } from '@etn/shared';

import { generateApiKey } from '../auth/api-key.js';
import { sendCreated, sendList, sendSuccess } from '../http/responses.js';
import { parseMaxWritesPerMinute } from './me.js';

/** Path params for `:id` routes. */
interface UserIdParams {
  id: string;
}

/** Path params for `DELETE /admin/users/:id/keys/:keyId`. */
interface UserKeyIdParams {
  id: string;
  keyId: string;
}

/** Body of `POST /admin/users/:id/keys`. */
interface CreateKeyForUserBody {
  label?: string | null;
  read_only?: boolean;
  max_writes_per_minute?: number | null;
}

/** Body of `PATCH /admin/users/:id/keys/:keyId`. */
interface UpdateKeyForUserBody {
  max_writes_per_minute?: number | null;
}

/** Reusable DTO without secrets for user listings. */
function userDto(u: {
  id: string;
  username: string;
  display_name: string | null;
  is_admin: boolean;
  is_first_user: boolean;
  disabled: boolean;
  created_at: string;
  updated_at: string;
}) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    is_admin: u.is_admin,
    is_first_user: u.is_first_user,
    disabled: u.disabled,
    created_at: u.created_at,
    updated_at: u.updated_at,
  };
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

/** `/api/v1/admin/users*` route plugin (admin only). */
export const usersRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const { requireAdmin } = app.accessControl;

  app.get(
    '/admin/users',
    { preHandler: [app.authPreHandler, requireAdmin] },
    async (_req, reply) => {
      const users = app.systemDb.listUsers();
      const data = users.map(userDto);
      sendList(reply, data, data.length, 0, data.length);
    },
  );

  app.post(
    '/admin/users',
    { preHandler: [app.authPreHandler, requireAdmin, app.idempotency.preHandler] },
    async (req: FastifyRequest, reply) => {
      const body = (req.body ?? {}) as CreateUserInput;
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      if (username.length === 0) {
        throw new EtnError(
          'VALIDATION_ERROR',
          'Поле username обязательно и не может быть пустым.',
          { field: 'username' },
          req.id,
        );
      }
      const displayName =
        typeof body.display_name === 'string' ? body.display_name.trim() || null : null;
      const isAdmin = body.is_admin === true;

      if (app.systemDb.getUserByUsername(username) !== null) {
        throw new EtnError(
          'DUPLICATE',
          `Пользователь "${username}" уже существует.`,
          { field: 'username' },
          req.id,
        );
      }

      const userId = randomUUID();
      const gen = generateApiKey();
      const apiKey = app.systemDb.transaction(() => {
        const u = app.systemDb.createUser({
          id: userId,
          username,
          displayName,
          isAdmin,
        });
        const k = app.systemDb.createApiKey({
          id: randomUUID(),
          userId: u.id,
          label: 'primary',
          keyHash: gen.keyHash,
          keyPrefix: gen.keyPrefix,
        });
        app.systemDb.insertAuditLog({
          actorUserId: req.auth!.user.id,
          category: 'user',
          action: 'user.create',
          targetType: 'user',
          targetId: u.id,
          details: { username, is_admin: isAdmin },
        });
        app.systemDb.insertAuditLog({
          actorUserId: req.auth!.user.id,
          category: 'user',
          action: 'api_key.create',
          targetType: 'api_key',
          targetId: k.id,
          details: { label: 'primary', for_user: u.id },
        });
        return k;
      });

      const dto: ApiKeyWithSecret = { ...keyPublicDto(apiKey), key: gen.key };
      sendCreated(reply, dto);
    },
  );

  app.get(
    '/admin/users/:id',
    { preHandler: [app.authPreHandler, requireAdmin] },
    async (req: FastifyRequest, reply) => {
      const { id } = req.params as UserIdParams;
      const user = app.systemDb.getUserById(id);
      if (user === null) {
        throw new EtnError('NOT_FOUND', 'Пользователь не найден.', undefined, req.id);
      }
      sendSuccess(reply, userDto(user));
    },
  );

  app.patch(
    '/admin/users/:id',
    { preHandler: [app.authPreHandler, requireAdmin, app.idempotency.preHandler] },
    async (req: FastifyRequest, reply) => {
      const { id } = req.params as UserIdParams;
      const user = app.systemDb.getUserById(id);
      if (user === null) {
        throw new EtnError('NOT_FOUND', 'Пользователь не найден.', undefined, req.id);
      }
      const body = (req.body ?? {}) as UpdateUserInput;

      const displayName =
        typeof body.display_name === 'string'
          ? body.display_name.trim() || null
          : body.display_name === null
            ? null
            : user.display_name;
      const isAdmin = body.is_admin === undefined ? user.is_admin : body.is_admin;
      const disabled = body.disabled === undefined ? user.disabled : body.disabled;

      // First user cannot be demoted or disabled (06-auth.md §4.3).
      if (user.is_first_user && (!isAdmin || disabled)) {
        throw new EtnError(
          'PROTECTED_ENTITY',
          'Первого пользователя нельзя понизить или отключить.',
          { field: 'is_first_user' },
          req.id,
        );
      }

      app.systemDb.updateUser(user.id, { displayName, isAdmin, disabled });
      app.systemDb.insertAuditLog({
        actorUserId: req.auth!.user.id,
        category: 'user',
        action: 'user.update',
        targetType: 'user',
        targetId: user.id,
        details: { display_name: displayName, is_admin: isAdmin, disabled },
      });
      const updated = app.systemDb.getUserById(user.id);
      sendSuccess(reply, userDto(updated!));
    },
  );

  app.delete(
    '/admin/users/:id',
    { preHandler: [app.authPreHandler, requireAdmin, app.idempotency.preHandler] },
    async (req: FastifyRequest, reply) => {
      const { id } = req.params as UserIdParams;
      const user = app.systemDb.getUserById(id);
      if (user === null) {
        throw new EtnError('NOT_FOUND', 'Пользователь не найден.', undefined, req.id);
      }
      if (user.is_first_user) {
        throw new EtnError(
          'PROTECTED_ENTITY',
          'Первого пользователя нельзя удалить.',
          undefined,
          req.id,
        );
      }
      const owned = app.systemDb.countOwnedNetworks(user.id);
      if (owned > 0) {
        throw new EtnError(
          'VALIDATION_ERROR',
          'Нельзя удалить пользователя, владеющего сетями: передайте владение.',
          { owned_networks: owned },
          req.id,
        );
      }
      app.systemDb.insertAuditLog({
        actorUserId: req.auth!.user.id,
        category: 'user',
        action: 'user.delete',
        targetType: 'user',
        targetId: user.id,
        details: { username: user.username },
      });
      // FK ON DELETE CASCADE removes api_keys & network_members automatically.
      app.systemDb.deleteUser(user.id);
      reply.code(204).send();
    },
  );

  app.post(
    '/admin/users/:id/keys',
    { preHandler: [app.authPreHandler, requireAdmin, app.idempotency.preHandler] },
    async (req: FastifyRequest, reply) => {
      const { id } = req.params as UserIdParams;
      const user = app.systemDb.getUserById(id);
      if (user === null) {
        throw new EtnError('NOT_FOUND', 'Пользователь не найден.', undefined, req.id);
      }
      const body = (req.body ?? {}) as CreateKeyForUserBody;
      const label = typeof body.label === 'string' ? body.label.trim() || null : null;
      const readOnly = body.read_only === true;
      const maxWritesPerMinute =
        body.max_writes_per_minute === undefined
          ? null
          : parseMaxWritesPerMinute(body.max_writes_per_minute, req.id);

      const gen = generateApiKey();
      const apiKey = app.systemDb.createApiKey({
        id: randomUUID(),
        userId: user.id,
        label,
        keyHash: gen.keyHash,
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
        details: { label, read_only: readOnly, max_writes_per_minute: maxWritesPerMinute, for_user: user.id },
      });
      const dto: ApiKeyWithSecret = { ...keyPublicDto(apiKey), key: gen.key };
      sendCreated(reply, dto);
    },
  );

  app.patch(
    '/admin/users/:id/keys/:keyId',
    { preHandler: [app.authPreHandler, requireAdmin, app.idempotency.preHandler] },
    async (req: FastifyRequest, reply) => {
      const { id, keyId } = req.params as UserKeyIdParams;
      const key = app.systemDb.getApiKeyById(keyId);
      if (key === null || key.user_id !== id) {
        throw new EtnError('NOT_FOUND', 'Ключ не найден.', undefined, req.id);
      }
      const body = (req.body ?? {}) as UpdateKeyForUserBody;
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
        details: { max_writes_per_minute: maxWritesPerMinute, for_user: id },
      });
      const updated = app.systemDb.getApiKeyById(keyId)!;
      sendSuccess(reply, keyPublicDto(updated));
    },
  );

  app.delete(
    '/admin/users/:id/keys/:keyId',
    { preHandler: [app.authPreHandler, requireAdmin, app.idempotency.preHandler] },
    async (req: FastifyRequest, reply) => {
      const { id, keyId } = req.params as UserKeyIdParams;
      const key = app.systemDb.getApiKeyById(keyId);
      if (key === null || key.user_id !== id) {
        throw new EtnError('NOT_FOUND', 'Ключ не найден.', undefined, req.id);
      }
      app.systemDb.disableApiKey(keyId);
      app.systemDb.insertAuditLog({
        actorUserId: req.auth!.user.id,
        category: 'user',
        action: 'api_key.revoke',
        targetType: 'api_key',
        targetId: keyId,
        details: { for_user: id },
      });
      reply.code(204).send();
    },
  );
};
