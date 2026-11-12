/**
 * Тексты ошибок фоновой картинки карты (0.16.1, задача 80324150; сценарий
 * 88a8879d).
 *
 * Отказы приходят из двух источников:
 *   * подготовка на клиенте (`wallpaper-prepare.ts`) — ключ словаря с
 *     необязательным параметром через `:` (`wallpaperErrorTooLargeResult:5`).
 *     Чистые функции не тащат словарь, поэтому перевод — здесь;
 *   * сервер (`PUT /users/me/wallpaper`) — 422 с `details.field` («файл больше
 *     лимита» и пр.) или сетевой сбой.
 *
 * Кроме перевода, функции решают, ЧТО именно показать в закреплённом футере
 * диалога настроек: сырой текст конверта пользователю не нужен.
 */

import { EtnError } from '@etn/shared';

import type { PickImageResult } from '../../main/ipc/contract.js';
import { errText } from './dom.js';
import { t, type MessageKey } from './i18n.js';

/** Вариант отказа системного выбора изображения. */
export type PickImageError = Extract<PickImageResult, { status: 'error' }>;

/**
 * Текст отказа подготовки картинки. Строка без префикса `wallpaperError`
 * возвращается как есть (защита от случайного перевода чужого сообщения).
 */
export function wallpaperPrepareError(message: string): string {
  const [key, arg] = message.split(':');
  if (key === undefined || !key.startsWith('wallpaperError')) return message;
  // Чистый пайплайн называет ПРИЧИНУ (`wallpaperErrorNotImage`), ключ словаря
  // живёт в разделе настроек — префикс добавляется здесь, в одном месте.
  const fullKey = `settings.${key}` as MessageKey;
  return arg === undefined ? t(fullKey) : t(fullKey, [arg]);
}

/**
 * Текст отказа системного выбора изображения. Главный процесс отдаёт код
 * (`image_too_large` + потолок, `image_unreadable`) — здесь он переводится через
 * словарь, поэтому в en/zh больше не показывается русская строка из main
 * (вердикт проверки 80324150).
 */
export function imagePickErrorText(err: PickImageError): string {
  if (err.code === 'image_unreadable') return t('settings.wallpaperErrorNotImage');
  return t('settings.wallpaperErrorSourceLimit', [
    String(Math.round(err.max_bytes / (1024 * 1024))),
  ]);
}

/**
 * Ошибка загрузки картинки на сервер. 422 с `details.field` — серверная
 * валидация: сообщение называет причину (сверхлимит файла — отдельный текст).
 * Офлайн и прочие сбои — общий `errText` («сервер недоступен, повторите
 * позже»): картинка на сервере не изменена.
 */
export function wallpaperUploadError(err: unknown): string {
  if (err instanceof EtnError && err.code === 'VALIDATION_ERROR') {
    const details = err.details as { field?: unknown } | null | undefined;
    const field = typeof details?.field === 'string' ? details.field : null;
    if (field === 'file_size') return t('settings.wallpaperErrorFileSize');
    return t('settings.wallpaperErrorServer');
  }
  return errText(err);
}
