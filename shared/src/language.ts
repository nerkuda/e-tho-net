/**
 * Языковые настройки сервера: значения, теги и резолвинг эффективного языка
 * (ADR daab6ac4 «Язык серверных поверхностей», тех.проект 3690fc8f
 * «Локализация ETN»).
 *
 * Три уровня наследования:
 *
 *   * сервер — конкретный тег, по умолчанию {@link DEFAULT_SERVER_LANGUAGE};
 *   * сеть — `null` («использовать язык сервера») или конкретный тег;
 *   * пользователь — `null` («использовать язык сетей») или конкретный тег.
 *
 * Эффективный язык пары «пользователь × сеть» — первое конкретное значение по
 * цепочке `пользователь → сеть → сервер`; результат всегда конкретный тег, а
 * вместе с ним отдаётся источник ({@link LanguageSource}). Резолвит сервер;
 * клиент цепочку самостоятельно не собирает (ADR §2).
 *
 * Сервер проверяет только синтаксис тега BCP-47 и НЕ проверяет наличие
 * каталога: каталоги — принадлежность клиента.
 */

import { DEFAULT_SERVER_LANGUAGE } from './constants.js';

/** Источник эффективного языка в цепочке наследования. */
export const LANGUAGE_SOURCE = {
  user: 'user',
  network: 'network',
  server: 'server',
} as const;
export type LanguageSource = (typeof LANGUAGE_SOURCE)[keyof typeof LANGUAGE_SOURCE];

/** Эффективный язык контекста «пользователь × сеть» с источником. */
export interface EffectiveLanguage {
  /** Конкретный тег BCP-47 (канонический вид, например `zh-Hans`). */
  language: string;
  /** Откуда взято значение: профиль пользователя, сеть или сервер. */
  source: LanguageSource;
}

/**
 * Язык сервера по умолчанию — ответ `GET`/`PUT /admin/settings/language`
 * (ADR daab6ac4 §1–2). Тег всегда конкретный: сервер не отдаёт наружу `null`.
 */
export interface ServerLanguageSettings {
  language: string;
}

/**
 * Сетевой срез контракта настроек языка (`GET /users/me/language-settings`,
 * ADR daab6ac4 §3).
 *
 * `language`/`source` — ЭФФЕКТИВНЫЙ язык пары «текущий пользователь × эта
 * сеть» и его источник: та же пара `{ language, source }`, что отдают
 * остальные поверхности. `stored_language` — хранимое значение сети (`null` —
 * «использовать язык сервера»), нужно редактору настроек; `can_edit` —
 * может ли текущий пользователь менять язык этой сети (владелец/админ).
 */
export interface NetworkLanguageSettings extends EffectiveLanguage {
  network_id: string;
  /** Хранимое значение сети: `null` — «использовать язык сервера». */
  stored_language: string | null;
  /** Может ли текущий пользователь менять язык этой сети (владелец/админ). */
  can_edit: boolean;
}

/**
 * Контракт настроек языка клиента (`GET /users/me/language-settings`, ADR §3):
 * язык приложения пользователя (`null` — наследование) и эффективный язык по
 * каждой доступной пользователю сети.
 */
export interface UserLanguageSettings {
  /** Хранимое значение профиля: `null` — «использовать язык сетей». */
  language: string | null;
  networks: NetworkLanguageSettings[];
}

/**
 * Привести тег языка к каноническому виду BCP-47 или вернуть `null`, если
 * значение не является синтаксически корректным тегом.
 *
 * Правила (ADR §2): основной подтег — 2–3 латинские буквы, регистр не важен
 * (канонизируется строчными); варианты допустимы (`zh-Hans`, `en-US`).
 * Неопределённый `und` и private-use-only теги (`x-…`) конкретным языком не
 * считаются и отвергаются. Наличие каталога перевода не проверяется.
 */
export function normalizeLanguageTag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const primary = trimmed.split('-')[0] ?? '';
  if (!/^[A-Za-z]{2,3}$/.test(primary)) return null;
  if (primary.toLowerCase() === 'und') return null;
  try {
    const canonical = Intl.getCanonicalLocales(trimmed);
    return canonical.length === 1 ? (canonical[0] ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Резолвинг эффективного языка по цепочке «пользователь → сеть → сервер»
 * (ADR §2). Некорректные/отсутствующие значения трактуются как наследование:
 * `null` наружу не отдаётся, нижняя ступень — {@link DEFAULT_SERVER_LANGUAGE}.
 */
export function resolveEffectiveLanguage(input: {
  user: string | null;
  network: string | null;
  server: string;
}): EffectiveLanguage {
  const user = normalizeLanguageTag(input.user);
  if (user !== null) return { language: user, source: LANGUAGE_SOURCE.user };
  const network = normalizeLanguageTag(input.network);
  if (network !== null) return { language: network, source: LANGUAGE_SOURCE.network };
  const server = normalizeLanguageTag(input.server) ?? DEFAULT_SERVER_LANGUAGE;
  return { language: server, source: LANGUAGE_SOURCE.server };
}
