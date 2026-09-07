/**
 * Детерминированные id строк `property_values` (ошибка dc119240, версия 0.7.2).
 *
 * Логическая идентичность строки `property_values` — естественный ключ
 * `(owner_type, owner_id, property_id)`, а не суррогатный `id`: представления
 * слоёв `*_v` (db/layer-chain.ts) дедуплицируют «ближайший слой побеждает»
 * ПО `id`, поэтому две независимые «первые записи» одного свойства в не
 * видящих друг друга слоях (дочерний слой, затем основа) с РАЗНЫМИ
 * случайными id порождают два «видимых победителя» на один natural key —
 * чтения отдают дубль/призрак, удаление из дочернего слоя оставляет
 * всплывающий дальний дубль.
 *
 * Решение (согласованный вариант 2 карточки ошибки): id строки выводится
 * детерминированно из natural key как UUIDv5 (RFC 4122) от строки
 * `${owner_type}:${owner_id}:${property_id}` в фиксированном namespace. Тогда
 * независимые первые записи в разных слоях всегда сходятся в ОДИН id, и вся
 * существующая по-id инфраструктура (`*_v`, `materializeShadow`,
 * `resolveVisiblePropertyValueId`) корректна без переписывания потребителей.
 * Исторические дубли (несколько случайных id на один natural key) сводит
 * миграция 036 через ту же функцию (SQL-помощник `etn_pv_id`,
 * db/network-db.ts `registerMigrationHelpers`) — миграция и домен
 * гарантированно вычисляют id одинаково, потому что вызывают один и тот же
 * код.
 *
 * Формат обязан оставаться валидным UUID (TEXT-колонка, клиенты парсят его
 * как UUID), поэтому используется именно UUIDv5, а не «сырой» хеш.
 */

import { createHash } from 'node:crypto';

/**
 * Фиксированный namespace UUIDv5 для `property_values`. Никогда не менять:
 * смена namespace молча сменит id всех существующих строк и снова разведёт
 * слои (см. миграцию 036).
 */
export const PROPERTY_VALUE_ID_NAMESPACE = '7c26af25-9294-4e49-bc9d-51dd0d0ff44c';

/** 16 байтов UUID-строки (без дефисов). */
function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll('-', ''), 'hex');
}

/**
 * Детерминированный id строки `property_values` от её natural key:
 * UUIDv5(PROPERTY_VALUE_ID_NAMESPACE, `${owner_type}:${owner_id}:${property_id}`).
 *
 * Разделитель `:` безопасен: `owner_type` — закрытый список ('thought'|'link')
 * без двоеточий, `owner_id`/`property_id` — UUID.
 */
export function propertyValueId(
  ownerType: string,
  ownerId: string,
  propertyId: string,
): string {
  const hash = createHash('sha1')
    .update(uuidBytes(PROPERTY_VALUE_ID_NAMESPACE))
    .update(`${ownerType}:${ownerId}:${propertyId}`, 'utf8')
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8]! & 0x3f) | 0x80; // variant: RFC 4122
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
