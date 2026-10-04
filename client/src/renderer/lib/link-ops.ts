/**
 * Пакетные операции над структурными рёбрами (0.8.1, ошибка 6dcd6db7):
 * `POST /links` и `DELETE /links/{id}` сняты требованием 3ea5c6af — жестовые
 * потоки холста (drag облаков/эллипсов), диалоги добавления и вставка текста
 * собираются из живых пакетных операций `POST /thoughts/batch`.
 *
 * Все операции идемпотентны на уровне пары мыслей: уже связанная пара не
 * дублируется и не меняет тип. Ошибки отдельных мыслей возвращаются списком
 * `failures` (транспортные ошибки — исключением, как раньше).
 */

import type { ThoughtBatchResult } from '@etn/shared';

import { etn } from './etn.js';
import { signalPublicationCompositionChanged } from './live/index.js';

/** Создать ребро source→target (тип null — нетипизированное). */
export async function ensureLink(
  networkId: string,
  sourceId: string,
  targetId: string,
  linkTypeId: string | null = null,
): Promise<ThoughtBatchResult> {
  const result = await etn.thoughts.batch(networkId, {
    ids: [targetId],
    op: 'link_parents',
    args: { parent_ids: [sourceId], link_type_id: linkTypeId },
  });
  // Своё ребро меняет состав публикации: сигнал слоя (до B1) с концами ребра —
  // рабочая область не зажжёт stale, если ни один из них не в её сборке.
  signalPublicationCompositionChanged([sourceId, targetId]);
  return result;
}

/** Удалить все рёбра parent→id для перечисленных родителей (любого типа). */
export async function unlinkParents(
  networkId: string,
  id: string,
  parentIds: string[],
): Promise<ThoughtBatchResult> {
  const result = await etn.thoughts.batch(networkId, {
    ids: [id],
    op: 'unlink_parents',
    args: { parent_ids: parentIds },
  });
  signalPublicationCompositionChanged([id, ...parentIds]);
  return result;
}

/** Удалить все рёбра id→child для перечисленных детей (любого типа). */
export async function unlinkChildren(
  networkId: string,
  id: string,
  childIds: string[],
): Promise<ThoughtBatchResult> {
  const result = await etn.thoughts.batch(networkId, {
    ids: [id],
    op: 'unlink_children',
    args: { child_ids: childIds },
  });
  signalPublicationCompositionChanged([id, ...childIds]);
  return result;
}

/**
 * Оставить перечисленных родителей единственными: чужие входящие рёбра
 * удаляются, недостающие создаются с `linkTypeId` (существующая связь
 * родителя не меняет тип — перенос типа отдельной операцией PATCH).
 */
export async function setOnlyParents(
  networkId: string,
  id: string,
  parentIds: string[],
  linkTypeId: string | null = null,
): Promise<ThoughtBatchResult> {
  const result = await etn.thoughts.batch(networkId, {
    ids: [id],
    op: 'set_only_parents',
    args: { parent_ids: parentIds, link_type_id: linkTypeId },
  });
  signalPublicationCompositionChanged([id, ...parentIds]);
  return result;
}

/** Бросает первую ошибку из `failures` — для потоков с try/catch. */
export function throwOnFailures(result: ThoughtBatchResult): void {
  const first = result.failures[0];
  if (first !== undefined) {
    throw new Error(first.message);
  }
}
