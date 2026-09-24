/**
 * Кросс-сетевые ссылки значениями свойств (задача 7849008a, ADR ae8346d0).
 *
 * Кросс-сетевая ссылка — отдельный вид значения в реестре свойств
 * (`value_type = 'cross_network_ref'`). Значение хранится в `property_values`
 * как скаляр (адрес `n:<network_id>#<thought_id>`), снапшот наименования цели —
 * в служебной неветбимой таблице (см. server-side migration 044).
 *
 * Ссылка на собственную сеть этим видом запрещена (для внутрисетевых ссылок
 * есть свойство-связь вида `'link'`). Голый id мысли без сети адресом не
 * является. Тип цели не проверяется (осознанное послабление тех.проекта —
 * идентификаторы и имена типов чужих сетей несопоставимы надёжно).
 */

// ---------------------------------------------------------------------------
// Формат адреса
// ---------------------------------------------------------------------------

/** Префикс сети в адресе. Сам адрес имеет вид `n:<network_id>#<thought_id>`. */
export const CROSS_NETWORK_ADDRESS_NETWORK_PREFIX = 'n:';

/** Разделитель между id сети и id мысли внутри адреса. */
export const CROSS_NETWORK_ADDRESS_SEPARATOR = '#';

/** Regex для адреса целиком — `n:<uuid>#<uuid>`. */
const ADDRESS_RE =
  /^n:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})#([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

/**
 * Раскладывает строку-адрес на (network_id, thought_id). Принимает только
 * полный формат `n:<network_id>#<thought_id>`; голые id (например,
 * `<uuid>` без `n:` или `n:<uuid>` без `#<id>`) НЕ считаются адресом и
 * возвращают `null`.
 *
 * @returns `null`, если строка не парсится; иначе пара uuid.
 */
export function parseCrossNetworkAddress(
  raw: string,
): { networkId: string; thoughtId: string } | null {
  const m = ADDRESS_RE.exec(raw);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return { networkId: m[1], thoughtId: m[2] };
}

/** Собрать адрес из двух uuid. Бросает, если один из id — не валидный uuid. */
export function formatCrossNetworkAddress(networkId: string, thoughtId: string): string {
  if (!ADDRESS_RE.test(`${CROSS_NETWORK_ADDRESS_NETWORK_PREFIX}${networkId}${CROSS_NETWORK_ADDRESS_SEPARATOR}${thoughtId}`)) {
    throw new Error(
      `formatCrossNetworkAddress: invalid uuid(s): networkId=${networkId}, thoughtId=${thoughtId}`,
    );
  }
  return `${CROSS_NETWORK_ADDRESS_NETWORK_PREFIX}${networkId}${CROSS_NETWORK_ADDRESS_SEPARATOR}${thoughtId}`;
}

/**
 * Проверить, что строка — валидный адрес кросс-сетевой ссылки. Голые id
 * (без префикса сети или без id мысли) отвергаются.
 */
export function isCrossNetworkAddress(raw: string): boolean {
  return ADDRESS_RE.test(raw);
}

// ---------------------------------------------------------------------------
// DTO для API-контрактов
// ---------------------------------------------------------------------------

/**
 * Один адрес кросс-сетевой ссылки в формате ответа API.
 * `title_snapshot` — кэшированное имя цели на момент последнего живого
 * резолва; `unresolved` — признак, что последний живой резолв отказал
 * (сеть или цель удалены / нет прав). Само значение видно всегда, если
 * вызывающий — участник сети-источника; читать БД чужой сети сервер
 * не открывает (требование 6d4ad9ac).
 */
export interface CrossNetworkRefValue {
  network_id: string;
  thought_id: string;
  /** Снапшот имени цели (всегда заполнен — при записи берётся живым резолвом). */
  title_snapshot: string;
  /** `true`, если живой резолв отказал; имя всё равно видно из снапшота. */
  unresolved: boolean;
  /** Момент последнего резолва (ISO-8601 UTC, `null`, если ещё не резолвился —
   *  в живой системе так не бывает, запись всегда идёт с резолвом; значение
   *  нужно миграциям, переносящим значения, и юнит-тестам). */
  resolved_at: string | null;
}

/**
 * Результат живого резолва для одной записи значения — внутренний контракт
 * между серверной логикой записи и операциями явного резолва
 * (REST cross-resolve, MCP `etn.properties.resolve`).
 */
export type CrossNetworkRefResolveStatus =
  | { kind: 'resolved'; title: string }
  | { kind: 'unresolved'; reason: 'network_not_found' | 'thought_not_found' | 'permission_denied' };

/**
 * Ответ REST `POST …/thoughts|links/{id}/properties/{key}/cross-resolve`
 * и MCP `etn.properties.resolve` (задача 7849008a, спеки 737ed900 и
 * 46df7a8d). Массив `values` — по одной записи на адрес значения
 * (для multiple — массив той же длины, что и набор адресов).
 *
 * Именованная DTO-форма, не inline-объект: сторож
 * `client/tests/guard-rest-response-contracts.test.ts` требует, чтобы тип
 * возврата публичных методов `RestClient` был именованным типом из
 * `@etn/shared` (задача 120385ba, ошибка c83f0215).
 */
export interface PropertyCrossResolveResult {
  values: CrossNetworkRefValue[];
}
