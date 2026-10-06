/**
 * Слой серверных пользовательских настроек уровня «пользователь × сервер»
 * (L3s, ADR `3a829d25`, задача `d534eb35`, ТП1 «Команды редактирования
 * комментария»; серверное хранение — задача `f57524ab`).
 *
 * Это «связка настроек ↔ диспетчера»: значения читаются с сервера
 * (`GET /api/v1/users/me/settings`), применяются к диспетчеру сочетаний
 * `lib/keymap.ts` (`setKeymapOverrides`) и записываются обратно
 * (`PUT /api/v1/users/me/settings/{key}`). Модуль не знает про UI диалога —
 * им пользуются и загрузка при подключении (`app.ts`), и диалог настройки.
 *
 * Первый (и пока единственный) ключ — `comment_hotkeys` (JSON-карта
 * «команда → сочетание»). Локальное хранение этих значений запрещено
 * (ADR `3a829d25`): они общие для всех сетей и устройств пользователя.
 */

import { USER_SETTING_KEY } from '@etn/shared';

import { etn } from './etn.js';
import { setKeymapOverrides, type KeymapOverrides } from './keymap.js';

/**
 * Разбирает серверное значение `comment_hotkeys` в переопределения сочетаний.
 * Допустима только карта «строка → непустая строка»: постороннее значение
 * (не объект, массив, нестроковые/пустые сочетания) отбрасывается — слой
 * настроек не должен ломать диспетчер чужой формой.
 */
export function parseCommentHotkeys(value: unknown): KeymapOverrides {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const overrides: Record<string, string> = {};
  for (const [command, chord] of Object.entries(value as Record<string, unknown>)) {
    if (command === '' || typeof chord !== 'string' || chord.trim() === '') continue;
    overrides[command] = chord;
  }
  return overrides;
}

/**
 * Загружает серверные пользовательские настройки и применяет их к диспетчеру
 * сочетаний. Вызывается после успешного подключения (общая точка —
 * `restoreSession`, см. `app.ts`); ошибку загрузки обрабатывает вызывающий —
 * недоступные настройки не должны блокировать подключение.
 */
export async function loadUserSettings(): Promise<void> {
  const settings = await etn.me.getSettings();
  setKeymapOverrides(parseCommentHotkeys(settings[USER_SETTING_KEY.COMMENT_HOTKEYS]));
}

/** Сбрасывает пользовательские сочетания к умолчаниям (без записи на сервер). */
export function resetUserSettings(): void {
  setKeymapOverrides({});
}

/**
 * Сохраняет пользовательские сочетания комментария на сервере
 * (`PUT /users/me/settings/comment_hotkeys`). Пустые/нестроковые значения не шлём —
 * сервер принимает только карту «команда → непустая строка». Локально набор
 * применяет вызывающий (`setKeymapOverrides`), чтобы не расходиться с тем, что
 * реально уехало на сервер.
 */
export async function saveCommentHotkeys(overrides: KeymapOverrides): Promise<void> {
  const payload: Record<string, string> = {};
  for (const [command, chord] of Object.entries(overrides)) {
    if (typeof chord === 'string' && chord.trim() !== '') payload[command] = chord;
  }
  await etn.me.setSetting(USER_SETTING_KEY.COMMENT_HOTKEYS, payload);
}
