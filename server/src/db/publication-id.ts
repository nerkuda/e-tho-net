/**
 * Детерминированные id строк подсистемы публикаций (0.11.1, задача 8178e007).
 *
 * Логическая идентичность строк-«деталей» публикации — естественный ключ, а не
 * суррогатный `id`:
 *   * `publication_order` — `(publication_id, node_key)`;
 *   * `publication_exclusions` — `(publication_id, thought_id)` (исключение
 *     действует на мысль целиком, во всех вхождениях);
 *   * `shelf_items` — `(shelf_id, publication_id)`.
 *
 * Механизм слоёв (`db/layer-chain.ts`, `db/layer-write.ts`) применяет правило
 * «ближайший слой побеждает» ПО `id`, поэтому id выводится детерминированно
 * через {@link uuidV5}: независимые первые записи одного естественного ключа
 * в разных слоях всегда сходятся в один id. Прецедент — `property_values`
 * (ошибка dc119240, миграция 036).
 *
 * Разделитель `:` безопасен: все компоненты — UUID (без двоеточий).
 */

import { uuidV5 } from './uuid-v5.js';

/** Namespace UUIDv5 строк `publication_order`. Никогда не менять. */
export const PUBLICATION_ORDER_ID_NAMESPACE = '1c9c5b4e-6d41-4a4c-9f2a-3b7e5d1c8f01';

/** Namespace UUIDv5 строк `publication_exclusions`. Никогда не менять. */
export const PUBLICATION_EXCLUSION_ID_NAMESPACE = '2d8f6a75-7e52-4b5d-8a3b-4c8f6e2d9a12';

/** Namespace UUIDv5 строк `shelf_items`. Никогда не менять. */
export const SHELF_ITEM_ID_NAMESPACE = '3e9a7b86-8f63-4c6e-9b4c-5d9a7f3eab23';

/** id строки `publication_order` от `(publication_id, node_key)`. */
export function publicationOrderId(publicationId: string, nodeKey: string): string {
  return uuidV5(PUBLICATION_ORDER_ID_NAMESPACE, `${publicationId}:${nodeKey}`);
}

/** id строки `publication_exclusions` от `(publication_id, thought_id)`. */
export function publicationExclusionId(publicationId: string, thoughtId: string): string {
  return uuidV5(PUBLICATION_EXCLUSION_ID_NAMESPACE, `${publicationId}:${thoughtId}`);
}

/** id строки `shelf_items` от `(shelf_id, publication_id)`. */
export function shelfItemId(shelfId: string, publicationId: string): string {
  return uuidV5(SHELF_ITEM_ID_NAMESPACE, `${shelfId}:${publicationId}`);
}
