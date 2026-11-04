/**
 * Серверная модель наследования языков (ADR daab6ac4 «Язык серверных
 * поверхностей», тех.проект 3690fc8f, задача f99f0542).
 *
 * Три уровня:
 *
 *   * **сервер** — настройка L1 `server.language` (`SETTING_KEY.SERVER_LANGUAGE`),
 *     по умолчанию `en`; меняет администратор;
 *   * **сеть** — колонка `networks.language`: `null` — «использовать язык
 *     сервера», строка — конкретный тег, зафиксированный за сетью; меняет
 *     владелец сети;
 *   * **пользователь** — настройка L3s `app_language`
 *     (`USER_SETTING_KEY.APP_LANGUAGE`): `null` — «использовать язык сетей»,
 *     строка — конкретный тег, действующий на всех клиентах пользователя.
 *
 * Эффективный язык пары «пользователь × сеть» резолвит сервер (ADR §2);
 * результат всегда конкретный тег плюс источник. Каталогов сообщений на
 * сервере нет — сервер проверяет только синтаксис тега.
 */

import {
  DEFAULT_SERVER_LANGUAGE,
  SETTING_KEY,
  USER_SETTING_KEY,
  normalizeLanguageTag,
  resolveEffectiveLanguage,
  type EffectiveLanguage,
  type LanguageSource,
  type UserLanguageSettings,
} from '@etn/shared';

import type { SystemDb } from '../db/system-db.js';

/** Источник значения `language` в методах ниже — открытая `_system.db`. */
type Db = Pick<
  SystemDb,
  'getSetting' | 'setSetting' | 'getUserSetting' | 'setUserSetting' | 'getNetworkById' | 'listNetworksForUser'
>;

/**
 * Язык сервера по умолчанию. Отсутствующее или повреждённое значение
 * трактуется как {@link DEFAULT_SERVER_LANGUAGE}: настройка не должна ронять
 * соединение и не должна отдавать наружу `null` (ADR §2).
 */
export function getServerLanguage(systemDb: Pick<Db, 'getSetting'>): string {
  const raw = systemDb.getSetting(SETTING_KEY.SERVER_LANGUAGE);
  if (raw === null) return DEFAULT_SERVER_LANGUAGE;
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Значение записано не JSON-ом (ручная правка БД) — проверим как строку.
  }
  return normalizeLanguageTag(parsed) ?? DEFAULT_SERVER_LANGUAGE;
}

/** Записать язык сервера (значение уже канонизировано вызывающим). */
export function setServerLanguage(systemDb: Pick<Db, 'setSetting'>, language: string): void {
  systemDb.setSetting(SETTING_KEY.SERVER_LANGUAGE, JSON.stringify(language));
}

/**
 * «Язык приложения» пользователя: `null` — наследовать язык сетей; строка —
 * конкретный тег. Повреждённое хранимое значение трактуется как наследование.
 */
export function getUserAppLanguage(
  systemDb: Pick<Db, 'getUserSetting'>,
  userId: string,
): string | null {
  const row = systemDb.getUserSetting(userId, USER_SETTING_KEY.APP_LANGUAGE);
  if (row === null) return null;
  return normalizeLanguageTag(row.value);
}

/** Записать «язык приложения» пользователя (`null` — наследование). */
export function setUserAppLanguage(
  systemDb: Pick<Db, 'setUserSetting'>,
  userId: string,
  language: string | null,
): void {
  systemDb.setUserSetting(userId, USER_SETTING_KEY.APP_LANGUAGE, language);
}

/**
 * Эффективный язык для пары «пользователь × сеть». Сеть обязана существовать —
 * вызывающий уже проверил доступ; неизвестная сеть трактуется как наследование
 * серверной ступени (защита от гонки удаления).
 */
export function resolveLanguageForUserNetwork(
  systemDb: Pick<Db, 'getUserSetting' | 'getSetting' | 'getNetworkById'>,
  userId: string,
  networkId: string,
): EffectiveLanguage {
  const network = systemDb.getNetworkById(networkId);
  return resolveEffectiveLanguage({
    user: getUserAppLanguage(systemDb, userId),
    network: network?.language ?? null,
    server: getServerLanguage(systemDb),
  });
}

/**
 * Контракт настроек языка клиента (`GET /users/me/language-settings`, ADR §3):
 * язык приложения пользователя и эффективный язык по каждой доступной ему
 * сети. `can_edit` — владелец сети или администратор сервера.
 */
export function readUserLanguageSettings(
  systemDb: Db,
  userId: string,
  isAdmin: boolean,
): UserLanguageSettings {
  const language = getUserAppLanguage(systemDb, userId);
  const server = getServerLanguage(systemDb);
  const networks = systemDb.listNetworksForUser(userId).map((network) => ({
    network_id: network.id,
    language: network.language,
    effective: resolveEffectiveLanguage({
      user: language,
      network: network.language,
      server,
    }),
    can_edit: isAdmin || network.role === 'owner',
  }));
  return { language, networks };
}

/** Проверка источника для внешних потребителей (WS-кадры). */
export function isLanguageSource(value: unknown): value is LanguageSource {
  return value === 'user' || value === 'network' || value === 'server';
}
