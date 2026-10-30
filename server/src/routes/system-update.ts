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
 * c79afe43: при `deployment = docker` поле `instruction` несёт команду и
 * пояснение о сохранности данных (текст — `update/deployment.ts`), а `apply`
 * отвечает `409` со ссылкой на ту же инструкцию и не запускает установщик.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { EtnError, type SystemUpdateProgress, type SystemUpdateStatus } from '@etn/shared';

import { sendSuccess } from '../http/responses.js';
import { UpdateCheckInProgressError } from '../update/checker.js';
import { DOCKER_UPDATE_INSTRUCTION } from '../update/deployment.js';
import {
  UpdateApplyConflictError,
  UpdateApplyNoUpdateError,
  UpdateInstallerFailureError,
} from '../update/apply.js';

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

/**
 * Снимок ответа GET/check — общий контракт `SystemUpdateStatus` из
 * `@etn/shared` (стандарт 01268f2d): кеш проверки (сущность 6f79610d) плюс
 * инструкция и HTTPS-предупреждение. `instruction` — только Docker (команда
 * обновления контейнера, задача c79afe43); для `windows-service` и
 * `standalone` — `null`: там обновление идёт через клиент или установщик.
 */
function statusPayload(app: FastifyInstance): SystemUpdateStatus {
  const cache = app.updateChecker.getCache();
  const warning = installerHttpsWarning(cache.download_url);
  const checkError =
    warning === null
      ? cache.check_error
      : [cache.check_error, warning].filter((part) => part !== null && part !== '').join(' ');
  return {
    ...cache,
    check_error: checkError,
    instruction: cache.deployment === 'docker' ? DOCKER_UPDATE_INSTRUCTION : null,
  } satisfies SystemUpdateStatus;
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
 *   * установщик не скачался/не проверился/не запустился — `502
 *     UPDATE_INSTALLER_FAILED` с этапом, причиной, заданием и
 *     `retryable: false`; сервер продолжает работать на текущей версии.
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
    // сервер жив. Отдельный код каталога (а не INTERNAL + details.status)
    // нужен рендереру для осмысленного текста и клиенту — для отказа от
    // автоповтора: `retryable: false` + `status: 502` едут в details, статус
    // также выводится из кода в `http/errors.ts`. Прецедент явного статуса
    // для кода с другим каноническим HTTP (ATTACHMENT_OWNER_IS_ICON) не
    // тронут.
    return new EtnError(
      'UPDATE_INSTALLER_FAILED',
      err.message,
      { status: 502, stage: err.stage, reason: err.reason, retryable: false, job: err.job },
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

  /**
   * `POST /system/update/apply` — создать задание и запустить установщик.
   *
   * **Синхронный ответ — до конца скачивания и проверки SHA-256** (до 10 минут
   * по конфигурации runner'а), а не сразу после создания задания: `201` уходит
   * в момент запуска установщика, `502 UPDATE_INSTALLER_FAILED` — если ассет не
   * скачался/не сошёлся по хешу/процесс не стартовал (DoD: отказ на этой фазе
   * не переводит службу в обслуживание и не останавливает сервер).
   *
   * **Обязанность клиента** (`ca26c59d`): у `rest-client` тайм-аут ответа 30 с,
   * то есть apply заведомо может «оборваться» на живом обновлении. Обрыв
   * соединения/тайм-аут, `409` (задание уже идёт) и `503` (обслуживание)
   * трактуются как «обновление идёт», а не как отказ: фактическое состояние
   * читается из `GET /system/update/progress`. Поэтому вызов идёт с
   * `retry: false` (`RestClient.systemUpdateApply`) — автоматический повтор
   * создал бы второе задание и второе скачивание установщика; `502` с
   * `details.retryable: false` повторять нельзя тем более.
   */
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
    sendSuccess(reply, { job: app.updateApply.getProgress() } satisfies SystemUpdateProgress);
  });
};
