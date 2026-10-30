/**
 * Контракт обновления сервера для клиента (задача ca26c59d, тех.проект
 * 2d9f5cc7; эндпоинты — задача 0a27a63b).
 *
 * Сервер отдаёт `GET/POST /api/v1/system/update*` конверт с полями кеша
 * проверки (сущность 6f79610d) плюс `instruction`, а прогресс — последнее
 * задание сущности 1f39811c (`UpdateJob` из `@etn/shared`). Эти формы
 * объявлены на сервере (`server/src/update/checker.ts`,
 * `server/src/routes/system-update.ts`), но серверный код клиенту не
 * импортируется; здесь — зеркало того же контракта (стандарт 01268f2d: сервер
 * собирает payload, клиент читает его же).
 *
 * Модуль — только типы и закрытые словари значений: сетевые вызовы живут в
 * `net/rest-client.ts`, IPC-поверхность — в `ipc/contract.ts`.
 */

import type { UpdateJob } from '@etn/shared';

/**
 * Режим развёртывания сервера (`deployment` кеша). Кнопка «Обновить сервер»
 * доступна только для `windows-service`; в `standalone` сервер ответит
 * заданием `failed` («запущен не службой»), в `docker` — `409`.
 */
export const SERVER_UPDATE_DEPLOYMENTS = ['windows-service', 'standalone', 'docker'] as const;

/** Режим развёртывания сервера. */
export type ServerDeployment = (typeof SERVER_UPDATE_DEPLOYMENTS)[number];

/** Каналы обновлений (`ETN_UPDATE_CHANNEL`). */
export const SERVER_UPDATE_CHANNELS = ['stable', 'prerelease'] as const;

/** Канал проверки обновлений. */
export type ServerUpdateChannel = (typeof SERVER_UPDATE_CHANNELS)[number];

/**
 * Ответ `GET /api/v1/system/update` и `POST /api/v1/system/update/check`:
 * кеш проверки (сущность 6f79610d) плюс инструкция обновления.
 *
 * `deployment` определяет доступность кнопки обновления; `instruction` пока
 * всегда `null` (Docker-инструкция — задача c79afe43).
 */
export interface ServerUpdateStatusDto {
  /** Версия работающего сервера. */
  current_version: string;
  /** Доступная версия строго новее текущей; `null` — обновлений нет. */
  available_version: string | null;
  /** Канал проверки. */
  channel: ServerUpdateChannel;
  /** ISO-8601 момента последней завершённой проверки; `null` — проверок не было. */
  checked_at: string | null;
  /** Текст последней ошибки проверки; `null` — последняя проверка успешна. */
  check_error: string | null;
  /** Ссылка на установщик; `null` — нет обновления или Docker. */
  download_url: string | null;
  /** SHA-256 установщика; `null` — нет обновления или Docker. */
  sha256: string | null;
  /** Режим развёртывания сервера. */
  deployment: ServerDeployment;
  /** Инструкция обновления (Docker — задача c79afe43); пока `null`. */
  instruction: string | null;
}

/** Ответ `GET /api/v1/system/update/progress`: последнее задание или `null`. */
export interface ServerUpdateProgressDto {
  job: UpdateJob | null;
}

/** Значение — допустимый режим развёртывания? */
export function isServerDeployment(value: unknown): value is ServerDeployment {
  return (
    typeof value === 'string' &&
    (SERVER_UPDATE_DEPLOYMENTS as readonly string[]).includes(value)
  );
}
