/**
 * Серверная проверка версии desktop-клиента на изменяющих запросах (задача
 * c3f33e6a, требование 271e3327, ADR 6ded6a87).
 *
 * Клиентская проверка диапазона защищает от старого сервера, но не защищает
 * данные от уже выпущенного старого клиента, который до сервера всё-таки дошёл.
 * Поэтому после успешной аутентификации и ДО обработчика изменяющего запроса
 * (`POST`/`PUT`/`PATCH`/`DELETE`) сервер проверяет заголовок `Client-Version`:
 *
 *  - `Client-Id` отсутствует → запрос считается API-интеграцией/скриптом и
 *    пропускается (осознанное исключение ADR — автоматизацию не ломаем);
 *  - `Client-Version` нет (или он пуст) → `version-missing`;
 *  - заголовок не парсится как версия → `version-invalid`;
 *  - версия вне `client_compatibility` → `version-out-of-range` с версиями,
 *    диапазоном и ссылкой на скачивание.
 *
 * Границы (ADR, «Запрещено»): чтение (`GET`/`HEAD`/`OPTIONS`) не блокируется;
 * MCP (`/mcp`) идёт своим транспортом и эту проверку не проходит; молча
 * пропускать запрос с `Client-Id` без версии нельзя; второго диапазона здесь
 * нет — только `client_compatibility` из `/version`. Во время обслуживания
 * сервера `503 SERVER_UPDATING` приоритетнее: maintenance-проверка ставится
 * `onRequest`-хуком и выполняется раньше этого guard'а (preHandler).
 *
 * Модуль чистый: не пишет в БД, не логирует ключи и не формирует HTTP-ответ —
 * возвращает решение, а канонический конверт отправляет `authPreHandler`.
 */

import type { FastifyRequest } from 'fastify';

import {
  CLIENT_VERSION_ERROR_REASON,
  parseSemver,
  satisfiesRange,
  type ClientVersionErrorDetails,
  type ClientVersionErrorReason,
} from '@etn/shared';

import { CLIENT_ID_HEADER, CLIENT_VERSION_HEADER } from '../http/context.js';
import type { ClientChannel } from '../version.js';

/** HTTP-методы, на которых проверяется версия desktop-клиента. */
const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Отказ guard'а: машиночитаемая причина и полное тело `details`. */
export interface ClientVersionRejection {
  reason: ClientVersionErrorReason;
  details: ClientVersionErrorDetails;
}

/**
 * Проверка одного запроса. `null` — запрос допустим; иначе — отказ `426
 * CLIENT_VERSION_UNSUPPORTED`. Принимает только то, что читает (метод и
 * заголовки), поэтому юнит-тесты не поднимают Fastify.
 */
export type ClientVersionGuardFn = (
  req: Pick<FastifyRequest, 'method' | 'headers'>,
) => ClientVersionRejection | null;

/** Зависимости guard'а. */
export interface ClientVersionGuardOptions {
  /**
   * Эффективный канал обновления клиента — тот же объект, из которого собран
   * `GET /version` (диапазон и ссылка на скачивание). Второго диапазона в
   * проекте быть не должно.
   */
  clientChannel: Pick<ClientChannel, 'client_compatibility' | 'client_download_url'>;
  /** Версия этого сервера — попадает в `details.server_version`. */
  serverVersion: string;
}

/**
 * Создаёт guard версии клиента. Вызывается из `authPreHandler` после успешной
 * аутентификации (см. `auth-middleware.ts`).
 */
export function createClientVersionGuard(options: ClientVersionGuardOptions): ClientVersionGuardFn {
  const { clientChannel, serverVersion } = options;
  const compatibility = clientChannel.client_compatibility;

  return (req) => {
    if (!MUTATING_METHODS.has(req.method)) {
      return null;
    }
    // API-интеграция/скрипт: без `Client-Id` версия desktop-клиента не нужна.
    if (readHeader(req.headers, CLIENT_ID_HEADER) === null) {
      return null;
    }

    const rawVersion = readHeader(req.headers, CLIENT_VERSION_HEADER);
    if (rawVersion === null) {
      return { reason: CLIENT_VERSION_ERROR_REASON.missing, details: { reason: CLIENT_VERSION_ERROR_REASON.missing } };
    }
    if (parseSemver(rawVersion) === null) {
      return {
        reason: CLIENT_VERSION_ERROR_REASON.invalid,
        details: {
          reason: CLIENT_VERSION_ERROR_REASON.invalid,
          client_version: rawVersion,
        },
      };
    }
    if (satisfiesRange(rawVersion, compatibility)) {
      return null;
    }
    return {
      reason: CLIENT_VERSION_ERROR_REASON.outOfRange,
      details: {
        reason: CLIENT_VERSION_ERROR_REASON.outOfRange,
        server_version: serverVersion,
        client_version: rawVersion,
        compatibility,
        download_url: clientChannel.client_download_url,
      },
    };
  };
}

/**
 * Человекочитаемое сообщение отказа (оно же уходит в `error.message`).
 *
 * Клиент НЕ разбирает этот текст: пользовательскую формулировку он выбирает по
 * `error.code`/`details.reason`. Сообщение адресовано API-интеграциям и логам.
 */
export function describeClientVersionRejection(rejection: ClientVersionRejection): string {
  const { details } = rejection;
  switch (rejection.reason) {
    case CLIENT_VERSION_ERROR_REASON.missing:
      return 'Изменяющий запрос desktop-клиента без заголовка Client-Version отклонён. Обновите клиент.';
    case CLIENT_VERSION_ERROR_REASON.invalid:
      return `Заголовок Client-Version ${JSON.stringify(details.client_version ?? '')} не является корректной версией. Обновите клиент.`;
    case CLIENT_VERSION_ERROR_REASON.outOfRange:
      return (
        `Версия клиента ${JSON.stringify(details.client_version ?? '')} не поддерживается сервером ` +
        `(совместимые версии: ${JSON.stringify(details.compatibility ?? '')}). Обновите клиент.`
      );
  }
}

/**
 * Первое непустое значение заголовка.
 *
 * Повторённый заголовок Fastify отдаёт массивом — берём первое значение, как и
 * для `Client-Id`. Пустая строка равнозначна отсутствию заголовка: иначе
 * `Client-Version:` с пустым значением проскочил бы как `version-invalid` и
 * смешал две разные причины отказа.
 */
function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
