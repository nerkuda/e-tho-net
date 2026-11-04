/**
 * Языковые настройки: сервер, сеть, профиль пользователя
 * (ADR daab6ac4 «Язык серверных поверхностей», задача f99f0542).
 *
 *   GET /admin/settings/language       — язык сервера по умолчанию (админ)
 *   PUT /admin/settings/language       — сменить язык сервера (админ)
 *   GET /users/me/language-settings    — язык приложения и эффективный язык
 *                                        по каждой доступной сети
 *
 * Язык сети меняется существующим `PATCH /networks/{id}` полем `language`
 * (владелец сети или администратор, см. `routes/networks.ts`); «язык
 * приложения» пользователя — существующей настройкой L3s
 * `PUT /users/me/settings/app_language` (сам пользователь, `routes/me.ts`).
 * Отдельных маршрутов для них нет: одна настройка — одна точка записи.
 *
 * Резолвинг эффективного языка — только на сервере (`domain/language-service.ts`);
 * `null` наружу не отдаётся: контракт всегда несёт конкретный тег и источник.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { EtnError, normalizeLanguageTag } from '@etn/shared';

import { parseRest, RestAdminLanguageSetting } from '../contracts.js';
import {
  getServerLanguage,
  readUserLanguageSettings,
  setServerLanguage,
} from '../domain/language-service.js';
import { sendSuccess } from '../http/responses.js';

/** `/api/v1/admin/settings/language*` и `/users/me/language-settings`. */
export const languageRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const { requireAdmin, requireAuth } = app.accessControl;

  app.get(
    '/admin/settings/language',
    { preHandler: [app.authPreHandler, requireAdmin] },
    async (_req: FastifyRequest, reply) => {
      sendSuccess(reply, { language: getServerLanguage(app.systemDb) });
    },
  );

  app.put(
    '/admin/settings/language',
    { preHandler: [app.authPreHandler, requireAdmin, app.idempotency.preHandler] },
    async (req: FastifyRequest, reply) => {
      const input = parseRest(RestAdminLanguageSetting, req);
      const language = normalizeLanguageTag(input.language);
      if (language === null) {
        throw new EtnError(
          'VALIDATION_ERROR',
          'language must be a valid BCP-47 language tag.',
          { field: 'language', value: input.language },
          req.id,
        );
      }
      const previous = getServerLanguage(app.systemDb);
      if (language !== previous) {
        setServerLanguage(app.systemDb, language);
        app.systemDb.insertAuditLog({
          actorUserId: req.auth!.user.id,
          category: 'system',
          action: 'settings.language.update',
          targetType: 'setting',
          targetId: 'server.language',
          details: { previous_language: previous, language },
        });
        // ADR §3: при смене языка сервера затронутые сокеты получают
        // типизированное событие `settings.language` без перезапуска.
        app.realtimeGateway.notifyServerLanguageChanged(previous);
      }
      sendSuccess(reply, { language });
    },
  );

  app.get(
    '/users/me/language-settings',
    { preHandler: [app.authPreHandler, requireAuth] },
    async (req: FastifyRequest, reply) => {
      const me = req.auth!.user;
      sendSuccess(reply, readUserLanguageSettings(app.systemDb, me.id, me.is_admin));
    },
  );
};
