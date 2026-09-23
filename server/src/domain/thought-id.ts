/**
 * Резолвер коротких id мыслей (ошибка d8893a1f-e35e-4b4a-af40-391f992d28fc).
 *
 * Агенты в рассуждениях оперируют усечённой формой id — hex-префиксом полного
 * UUID (например `ec5ba58c` вместо `ec5ba58c-7876-45b4-8e1d-1487eb767023`).
 * Все точки работы с мыслью по id должны принимать обе формы:
 *   * полный UUID (`isFullUuid`) — как раньше, без обращений к БД;
 *   * короткий префикс без дефисов (`isIdPrefix`) — резолвится по префиксу
 *     среди видимых в текущем слое мыслей.
 *
 * Контракт {@link resolveThoughtId}:
 *   * полный UUID → возвращается нормализованным (lowercase) без проверки
 *     существования (её делают вызывающие запросы; так сохраняется прежнее
 *     поведение «неизвестный полный id → null/NOT_FOUND»);
 *   * короткий префикс → ровно одно совпадение = полный id; ноль совпадений =
 *     `null`; два и более = {@link EtnError} `VALIDATION_ERROR` со списком
 *     кандидатов (понятная диагностика вместо угадывания);
 *   * строка, не похожая на id (длиннее/короче/не-hex) → возвращается как есть,
 *     чтобы вызывающий получил свой обычный `null`/`NOT_FOUND`.
 *
 * SQL живёт здесь (домен) — фасады MCP/REST зовут этот модуль, сохраняя
 * сторож `guard-server-layers` («SQL только в домене»).
 */

import { EtnError } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';

/** Полный канонический UUID (любая версия, регистронезависимо). */
const UUID_FULL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Короткая форма id — hex-префикс полного UUID без дефисов. Минимум 4 символа:
 * более короткий фрагмент слишком легко совпадает с обычным словом/значением.
 * 32 hex-символа соответствуют длине UUID без дефисов.
 */
const UUID_PREFIX_RE = /^[0-9a-f]{4,32}$/i;

/** Сколько совпадений показывать в списке кандидатов (диагностика). */
const CANDIDATE_LIMIT = 10;

/** True, если строка — полный UUID. */
export function isFullUuid(value: string): boolean {
  return UUID_FULL_RE.test(value);
}

/**
 * True, если строка похожа на короткий префикс id (hex без дефисов,
 * 4–32 символа). Полный UUID сюда НЕ попадает (в нём есть дефисы).
 */
export function isIdPrefix(value: string): boolean {
  return UUID_PREFIX_RE.test(value);
}

/** Строка похожа на id в любой форме (полной или короткой). */
export function looksLikeThoughtId(value: string): boolean {
  return isFullUuid(value) || isIdPrefix(value);
}

/**
 * Привести id мысли к полному виду (см. контракт модуля). Возвращает `null`,
 * когда короткий префикс не нашёл ни одной видимой мысли; бросает
 * `VALIDATION_ERROR` при неоднозначном префиксе.
 */
export function resolveThoughtId(ndb: NetworkDb, id: string): string | null {
  if (isFullUuid(id)) {
    return id.toLowerCase();
  }
  if (!isIdPrefix(id)) {
    return id;
  }
  const prefix = id.toLowerCase();
  // Префикс — только hex, Like-спецсимволов (`%`/`_`) в нём нет.
  const rows = ndb
    .prepare('SELECT id FROM thoughts_v WHERE id LIKE ? ORDER BY id LIMIT ?')
    .all(`${prefix}%`, CANDIDATE_LIMIT + 1) as { id: string }[];
  if (rows.length === 0) {
    return null;
  }
  if (rows.length > 1) {
    const shown = rows.slice(0, CANDIDATE_LIMIT).map((r) => r.id);
    throw new EtnError(
      'VALIDATION_ERROR',
      `Короткий id «${id}» неоднозначен: подходит ${rows.length} мыслей. ` +
        'Уточните id до однозначного.',
      { id, candidates: shown },
    );
  }
  return rows[0]!.id;
}

/**
 * Как {@link resolveThoughtId}, но отсутствие/неоднозначность — это ошибки
 * (для границы MCP: инструмент должен внятно отказать, а не молча искать
 * дальше). Сообщение при отсутствии совпадает с {@link getThoughtOrThrow}.
 */
export function resolveThoughtIdOrThrow(ndb: NetworkDb, id: string): string {
  const resolved = resolveThoughtId(ndb, id);
  if (resolved === null) {
    throw new EtnError('NOT_FOUND', `thought ${id} not found`, { entity: 'thought', id });
  }
  return resolved;
}
