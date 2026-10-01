/**
 * UUIDv5 (RFC 4122, SHA-1) — детерминированный идентификатор строки от её
 * естественного ключа (ошибка dc119240, версия 0.7.2; прецедент —
 * `db/property-value-id.ts`).
 *
 * Механизм слоёв (`layer-chain.ts`, `layer-write.ts`) дедуплицирует строки
 * ветвимой таблицы «ближайший слой побеждает» ПО суррогатному `id`. Если у
 * таблицы естественный ключ (`(owner_type, owner_id, property_id)`,
 * `(publication_id, node_key)` и т.п.), независимые первые записи одного
 * ключа в не видящих друг друга слоях с РАЗНЫМИ случайными id дают двух
 * «видимых победителей» — дубликат/призрак при чтении. Детерминированный id
 * сводит такие записи в один id, и по-id инфраструктура остаётся корректной.
 *
 * Формат обязан оставаться валидным UUID (колонка TEXT, клиенты парсят его
 * как UUID), поэтому используется именно UUIDv5, а не «сырой» хеш.
 */

import { createHash } from 'node:crypto';

/** 16 байтов UUID-строки (без дефисов). */
function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll('-', ''), 'hex');
}

/**
 * UUIDv5(namespace, name): детерминированный UUID от фиксированного
 * namespace и произвольного имени. Namespace задаётся строкой UUID.
 */
export function uuidV5(namespace: string, name: string): string {
  const hash = createHash('sha1').update(uuidBytes(namespace)).update(name, 'utf8').digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8]! & 0x3f) | 0x80; // variant: RFC 4122
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
