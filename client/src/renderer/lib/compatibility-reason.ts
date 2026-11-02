/**
 * Человеческий текст несовместимости версий (задача 0afec967, требование
 * 4d3be6ca, сущность 89aad200).
 *
 * Одна точка выбора формулировки для ДВУХ потребителей:
 *
 *  - блокирующий диалог (`lib/compatibility-dialog.ts`, элемент 8623b9ff);
 *  - строка отказа подключения (`lib/connect-failure.ts`): на экране
 *    подключения причина — «версии несовместимы…», а не технический текст
 *    main-процесса.
 *
 * Причина выбирается по машиночитаемым полям результата проверки, а не по
 * разбору серверного сообщения: статус (`server-outdated` — сервер старше
 * клиента) и `serverReason` — словарь `CLIENT_VERSION_ERROR_REASON` из
 * `@etn/shared` (`version-missing` / `version-invalid` / `version-out-of-range`).
 * Неизвестное/чужое значение `serverReason` даёт общую формулировку
 * `client-outdated`: словарь — закрытый, унаследованные ключи объекта
 * (`toString`, `__proto__`) причиной не считаются (тот же класс, что ошибка
 * 2edf8494 в `connect-failure.ts`).
 */

import { CLIENT_VERSION_ERROR_REASON, type ClientVersionErrorReason } from '@etn/shared';

import type { CompatibilityResult } from '../../main/ipc/contract.js';
import { t, type MessageKey } from './i18n.js';

/** Причина отказа сервера `426` → ключ словаря. */
const SERVER_REASON_KEYS: Readonly<Record<ClientVersionErrorReason, MessageKey>> = {
  [CLIENT_VERSION_ERROR_REASON.missing]: 'compatibility.reason.versionMissing',
  [CLIENT_VERSION_ERROR_REASON.invalid]: 'compatibility.reason.versionInvalid',
  [CLIENT_VERSION_ERROR_REASON.outOfRange]: 'compatibility.reason.versionOutOfRange',
};

/**
 * Ключ причины несовместимости: сервер старше клиента — своя формулировка,
 * иначе — причина из `details.reason` сервера либо общее «клиент не подходит».
 */
export function compatibilityReasonKey(result: CompatibilityResult): MessageKey {
  if (result.status === 'server-outdated') return 'compatibility.reason.serverOutdated';
  const raw = result.serverReason;
  if (typeof raw === 'string' && Object.hasOwn(SERVER_REASON_KEYS, raw)) {
    return SERVER_REASON_KEYS[raw as ClientVersionErrorReason];
  }
  return 'compatibility.reason.clientOutdated';
}

/** Причина несовместимости готовым текстом. */
export function compatibilityReasonText(result: CompatibilityResult): string {
  return t(compatibilityReasonKey(result));
}

/**
 * Строка версий для человека и для передачи администратору: клиент, сервер,
 * требуемый диапазон. Неизвестное значение называется «неизвестно», а не
 * пустотой.
 *
 * «Требуется» — диапазон той стороны, которой не соответствует вторая
 * (ошибка ff1c5e44):
 *
 *  - `server-outdated` — встроенный диапазон клиента (`>=0.15.0 <0.16.0`):
 *    какого сервера клиент требует; у старого сервера `serverCompatibility`
 *    здесь наоборот — диапазон КЛИЕНТОВ, которые он принимает (`>=0.1.0`),
 *    подставлять его нельзя;
 *  - `client-outdated` (включая `426`) — `serverCompatibility`: какого клиента
 *    принимает сервер.
 */
export function compatibilityFactsText(result: CompatibilityResult): string {
  const unknown = t('compatibility.value.unknown');
  const text = (value: unknown): string =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : unknown;
  return t('compatibility.facts', [
    text(result.clientVersion),
    text(result.serverVersion),
    text(requiredRangeOf(result)),
  ]);
}

/** Требуемый диапазон по статусу вердикта (см. {@link compatibilityFactsText}). */
function requiredRangeOf(result: CompatibilityResult): string | null {
  return result.status === 'server-outdated'
    ? result.clientCompatibility
    : result.serverCompatibility;
}
