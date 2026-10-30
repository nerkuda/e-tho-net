/**
 * Admin-эндпоинты обновления сервера (компонент
 * `server/src/routes/system-update.ts`, задача 0a27a63b; тех.проект 2d9f5cc7).
 *
 *   GET  /api/v1/system/update           — кеш проверки + режим развёртывания
 *                                          + инструкция обновления;
 *   POST /api/v1/system/update/check     — принудительная проверка канала;
 *   POST /api/v1/system/update/apply     — создать задание и запустить установщик;
 *   GET  /api/v1/system/update/progress  — последнее задание (`job` или `null`).
 *
 * Все четыре требуют администратора (`requireAdmin`); формат ответа —
 * канонический конверт `{ data }` (`http/responses.ts`), ошибки —
 * `{ error: { code, message, details } }` (`http/errors.ts`).
 *
 * Маршрут только валидирует запрос, проверяет права и передаёт управление
 * `app.updateChecker` / `app.updateApply`; скачивание, хеш, обслуживание,
 * запуск установщика и прогресс живут в `update/apply.ts` и `update/runner`'е.
 *
 * HTTPS-only. Применение обновления идёт только по HTTPS: runner отклоняет
 * `download_url` с другим протоколом (`InstallerTargetError` → `502`). Чтобы
 * администратор видел причину заранее, `GET`/`POST /check` добавляют
 * предупреждение в `check_error` ответа (кеш при этом не меняется), а текст
 * ошибки `apply` приходит из runner'а.
 *
 * Docker-инструкция (`docker compose pull && docker compose up -d`) — задача
 * c79afe43: здесь `instruction` всегда `null`, `apply` в Docker отдаёт `409`.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { EtnError } from '@etn/shared';

import { sendSuccess } from '../http/responses.js';
import { UpdateCheckInProgressError, type UpdateCache } from '../update/checker.js';
import {
  UpdateApplyConflictError,
  UpdateApplyNoUpdateError,
  UpdateInstallerFailureError,
} from '../update/apply.js';

/**
 * Ответ `GET /api/v1/system/update` (и `POST /check`): поля кеша проверки
 * обновлений (сущность 6f79610d) плюс инструкция обновления.
 * `deployment` уже входит в кеш; `instruction` отдаётся всегда (`null`, пока
 * Docker-инструкция не реализована — задача c79afe43).
 */
export interface SystemUpdateStatus extends UpdateCache {
  instruction: string | null;
}

/** Текст предупреждения о ссылке на установщик не по HTTPS. */
export const INSTALLER_HTTPS_WARNING =
  'Ссылка на установщик получена не по HTTPS: настраиваемый фид должен отдавать ' +
  'ассет по https — иначе обновление будет отклонено.';

/**
 * Предупреждение для ответа: `download_url` есть, но не https (или не URL).
 * `null` — ссылки нет либо она https. Кеш не меняется: это снимок ответа.
 */
export function installerHttpsWarning(downloadUrl: string | null): string | null {
  if (downloadUrl === null || downloadUrl.trim() === '') {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(downloadUrl);
  } catch {
    return INSTALLER_HTTPS_WARNING;
  }
  return parsed.protocol === 'https:' ? null : INSTALLER_HTTPS_WARNING;
}

/** Снимок ответа GET/check: кеш + инструкция + HTTPS-предупреждение. */
function statusPayload(app: FastifyInstance): SystemUpdateStatus {
  const cache = app.updateChecker.getCache();
  const warning = installerHttpsWarning(cache.download_url);
  const checkError =
    warning === null
      ? cache.check_error
      : [cache.check_error, warning].filter((part) => part !== null && part !== '').join(' ');
  return { ...cache, check_error: checkError, instruction: null };
}

/** Тело `POST /apply` — `{ target_version }` (операция 8a2972c2). */
function targetVersionFromBody(req: FastifyRequest): string {
  const body: unknown = req.body;
  const raw =
    typeof body === 'object' && body !== null
      ? (body as { target_version?: unknown }).target_version
      : undefined;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Поле target_version обязательно и должно быть строкой версии (например, "0.15.1").',
      { field: 'target_version' },
      req.id,
    );
  }
  return raw;
}

/**
 * Доменный отказ задания → каноническая ошибка транспорта:
 *   * конфликт (активное задание, installer alive, Docker, downgrade,
 *     сменившийся кеш) — `409 VERSION_CONFLICT`, `details.job` с текущим
 *     заданием (клиент показывает прогресс, а не ошибку);
 *   * обновлять нечего / цель непригодна — `422 VALIDATION_ERROR`;
 *   * установщик не скачался/не проверился/не запустился — `502` с заданием и
 *     причиной; сервер продолжает работать на текущей версии.
 */
function mapApplyError(err: unknown, requestId: string): unknown {
  if (err instanceof UpdateApplyConflictError) {
    return new EtnError(
      'VERSION_CONFLICT',
      err.message,
      { reason: err.reason, job: err.job },
      requestId,
    );
  }
  if (err instanceof UpdateApplyNoUpdateError) {
    return new EtnError('VALIDATION_ERROR', err.message, { reason: err.reason }, requestId);
  }
  if (err instanceof UpdateInstallerFailureError) {
    // HTTP 502 «Bad Gateway»: ассет/процесс отказал на стороне поставки, а
    // сервер жив. Кода ошибки под 502 в каталоге нет, поэтому канонический
    // код — INTERNAL, а явный статус задан в details.status (как у
    // ATTACHMENT_OWNER_IS_ICON с 409).
    return new EtnError(
      'INTERNAL',
      err.message,
      { status: 502, reason: err.reason, job: err.job },
      requestId,
    );
  }
  return err;
}

/** `/api/v1/system/update*` (admin only). */
export const systemUpdateRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const { requireAdmin } = app.accessControl;
  const adminOnly = { preHandler: [app.authPreHandler, requireAdmin] };

  app.get('/system/update', adminOnly, async (_req, reply) => {
    sendSuccess(reply, statusPayload(app));
  });

  app.post('/system/update/check', adminOnly, async (req, reply) => {
    try {
      await app.updateChecker.checkNow();
    } catch (err) {
      if (err instanceof UpdateCheckInProgressError) {
        throw new EtnError('RATE_LIMITED', 'Проверка обновлений уже идёт.', undefined, req.id);
      }
      throw err;
    }
    // Ошибка фида не роняет запрос: она уже в `check_error`, последняя удачная
    // версия сохранена (инвариант кеша 6f79610d).
    sendSuccess(reply, statusPayload(app));
  });

  app.post('/system/update/apply', adminOnly, async (req, reply) => {
    const targetVersion = targetVersionFromBody(req);
    try {
      const job = await app.updateApply.apply({ targetVersion });
      sendSuccess(reply, job, undefined, 201);
    } catch (err) {
      throw mapApplyError(err, req.id);
    }
  });

  app.get('/system/update/progress', adminOnly, async (_req, reply) => {
    sendSuccess(reply, { job: app.updateApply.getProgress() });
  });
};
