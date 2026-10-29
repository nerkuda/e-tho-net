/**
 * Детерминированный id строки `thought_property_order` (0.14.1, задача
 * 3948af62; ADR 75a79109 п. 1, прецедент — ADR 60cc28da).
 *
 * Натуральный ключ строки порядка — `(thought_id, property_id, side)`, где
 * `side` у скаляра нормализуется в пустую строку. UUID v5 от него даёт один и
 * тот же логический id при независимых «первых записях» в не видящих друг
 * друга слоях: прослойка наследует id основы, а `*_v`-представления,
 * дедуплицирующие по id, видят одну строку на натуральный ключ.
 *
 * Пространство имён — своё, отдельное от `propertyValueId`: это разные
 * сущности, и совпадение ключей между ними не должно схлопывать строки.
 */

import { uuidV5 } from './uuid-v5.js';

/** Fixed namespace UUID for `thought_property_order` logical ids. */
export const THOUGHT_PROPERTY_ORDER_ID_NAMESPACE = '6b0f4d9e-2c71-4a58-9e3d-8f1a2b3c4d5e';

/**
 * id строки порядка: UUID v5 от `thoughtId:propertyId:side` (`side` —
 * `''` у скаляра, `source`/`target` у свойства-связи).
 */
export function thoughtPropertyOrderId(
  thoughtId: string,
  propertyId: string,
  side: string | null,
): string {
  return uuidV5(
    THOUGHT_PROPERTY_ORDER_ID_NAMESPACE,
    `${thoughtId}:${propertyId}:${side ?? ''}`,
  );
}
