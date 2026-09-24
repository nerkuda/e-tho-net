/**
 * Снятие значения свойства-связи без диалога (задача 0d4f793a, 0.8.3).
 *
 * До этой задачи любое снятие рёбер значения свойства-связи (крестик «✕»
 * чипа, её команды меню, очистка набора крестиком ячейки, очистка внетиповых)
 * открывало модальный диалог «В корзину / Удалить совсем»
 * (задача 96d27fc0, 0.8.2). При массовых удалениях диалог раздражал и
 * замедлял работу, поэтому выбор заменён автоматическим:
 *
 * - крестик без Shift (`mode: 'auto'`) — проверяем возможность физического
 *   удаления рёбер; возможно — удаляем совсем (всплывашка «связь удалена»),
 *   невозможно — помещаем в корзину (всплывашка «связь помещена в корзину»);
 * - Shift+крестик и команда меню «Поместить связь в корзину»
 *   (`mode: 'trash'`) — всегда корзина;
 * - команда меню «Удалить связь с мыслью» — то же, что крестик без Shift.
 *
 * Возможность удаления даёт `POST /links/deletion-check-batch`
 * (`etn.links.deletionCheck`, 03-server-api.md §6.5a): ребро блокирует лишь
 * удерживающий слой (у связей нет использования в свойствах и потомков), тогда
 * «удалить совсем» недоступно и остаётся корзина. Проверка идёт ДО записи.
 *
 * «Удалить совсем» — физическое удаление рёбер. Отдельного `DELETE /links/{id}`
 * в проекте НЕТ и не будет: требование 3ea5c6af (0.8.1) сняло операции
 * создания/удаления связей в пользу операций над свойствами-связями, а
 * физическая чистка ребра идёт через корзину — точечный
 * `POST /trash/purge { ids }` (ошибка 8b4b7a7e). Последовательность такая:
 * свежие значения дают id рёбер, запись значения отзывает рёбра (сервер
 * помечает их корзиной), затем точечный purge по id.
 *
 * Скаляры (в т.ч. внетиповые) сюда не попадают — они не восстанавливаемы и
 * никого не блокируют, их удаление остаётся как было (без корзины).
 */

import type { LinkPropertyValues } from '@etn/shared';

import { errText } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';

/**
 * Способ снятия рёбер: `auto` — проверить и удалить совсем либо в корзину,
 * `trash` — всегда в корзину (осознанное действие).
 */
export type LinkValueRemovalMode = 'auto' | 'trash';

/**
 * Режим снятия по модификатору клика: Shift — осознанная корзина, иначе
 * автоматический выбор. Чистая — юнит-тест.
 */
export function removalModeForClick(shiftKey: boolean): LinkValueRemovalMode {
  return shiftKey ? 'trash' : 'auto';
}

/** Параметры {@link removeLinkValueEdges}. */
export interface LinkValueRemovalOptions {
  networkId: string;
  ownerType: 'thought' | 'link';
  ownerId: string;
  /** Имя свойства (или display-имя стороны у внетипового ребра). */
  propertyKey: string;
  /** Id реестрового свойства; пусто/`undefined` — внетиповой ключ по имени. */
  propertyId?: string | undefined;
  /** Снимаемые цели: по их рёбрам ищется физическое удаление. */
  removedTargetIds: readonly string[];
  /** Способ снятия: авто-выбор или принудительная корзина. */
  mode: LinkValueRemovalMode;
  /**
   * Обычная запись значения без снятых целей. Сервер сам помечает отозванные
   * рёбра (корзина). Возвращает `false`, когда запись не удалась (тогда purge
   * не запускается и всплывашки об успехе нет).
   */
  commit: () => Promise<boolean>;
}

/** Форма `LinkPropertyValues` (без поля `.value`, зато со списком рёбер). */
function isLinkValues(v: unknown): v is LinkPropertyValues {
  return (
    typeof v === 'object' &&
    v !== null &&
    'values' in v &&
    'count' in v &&
    Array.isArray((v as { values: unknown }).values)
  );
}

/**
 * Чистый выбор id рёбер, которые снимет запись: среди значений владельца
 * находится свойство по `property_id` (реестровое) либо по `property_name`
 * (внетиповое ребро) и возвращаются `link_id` его целей из `removedTargetIds`.
 *
 * Рёбра ищутся ДО записи: после пометки они исчезают из значений
 * (`getLinkPropertyValues` фильтрует `marked_for_deletion = 0`), и нужный id
 * потерялся бы — физическое удаление стало бы невозможным.
 */
export function pickRemovedLinkIds(
  values: ReadonlyArray<unknown>,
  match: { propertyKey: string; propertyId?: string | undefined },
  removedTargetIds: readonly string[],
): string[] {
  const wanted = new Set(removedTargetIds);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    if (!isLinkValues(entry)) continue;
    const matches =
      match.propertyId !== undefined && match.propertyId !== ''
        ? entry.property_id === match.propertyId
        : entry.property_name === match.propertyKey;
    if (!matches) continue;
    for (const edge of entry.values) {
      if (!wanted.has(edge.target_id)) continue;
      if (edge.link_id === '' || seen.has(edge.link_id)) continue;
      seen.add(edge.link_id);
      ids.push(edge.link_id);
    }
  }
  return ids;
}

/** Свежие id рёбер снимаемых целей; `null` — значения прочитать не удалось. */
async function readRemovedLinkIds(opts: LinkValueRemovalOptions): Promise<string[] | null> {
  try {
    const values = await etn.properties.get(opts.networkId, opts.ownerType, opts.ownerId);
    return pickRemovedLinkIds(
      values,
      { propertyKey: opts.propertyKey, propertyId: opts.propertyId },
      opts.removedTargetIds,
    );
  } catch {
    return null;
  }
}

/** Ни одно ребро из набора не заблокировано удерживающим слоем. */
async function allPurgeable(networkId: string, linkIds: readonly string[]): Promise<boolean> {
  try {
    const checks = await etn.links.deletionCheck(networkId, [...linkIds]);
    return linkIds.every((id) => checks[id]?.blocked !== true);
  } catch {
    // Проверка не удалась — безопасный выбор: корзина.
    return false;
  }
}

/** Всплывашка об успехе: единственная связь или набор. */
function noticeTrashed(count: number): void {
  notice(count > 1 ? `Связи помещены в корзину (${count}).` : 'Связь помещена в корзину.');
}

/**
 * Снять рёбра значения-связи без диалога. Возвращает `true`, когда запись
 * применена, `false` — при неудаче записи (вызывающий по этому признаку решает,
 * обновлять ли UI).
 *
 * `mode: 'trash'` — сразу корзина. `mode: 'auto'` — свежие id рёбер и проверка
 * блокировки до записи: все свободны — после записи точечный purge (удалено
 * совсем); id не нашлись, проверка недоступна или есть блокировка — корзина.
 * Заблокированные/не найденные рёбра purge пропускает — о них сообщаем.
 */
export async function removeLinkValueEdges(opts: LinkValueRemovalOptions): Promise<boolean> {
  const count = opts.removedTargetIds.length;

  if (opts.mode === 'auto') {
    const linkIds = await readRemovedLinkIds(opts);
    if (linkIds !== null && linkIds.length > 0 && (await allPurgeable(opts.networkId, linkIds))) {
      const committed = await opts.commit();
      if (!committed) return false;
      try {
        const { purged } = await etn.trash.purge(opts.networkId, linkIds);
        if (purged < linkIds.length) {
          notice('Часть связей заблокирована и осталась в корзине.', 'error');
          return true;
        }
      } catch (err) {
        notice(`Не удалось удалить связь совсем: ${errText(err)}`, 'error');
        return true;
      }
      notice(count > 1 ? `Связи удалены (${count}).` : 'Связь удалена.');
      return true;
    }
  }

  // Корзина: принудительно (Shift/меню) либо авто-fallback.
  const committed = await opts.commit();
  if (!committed) return false;
  noticeTrashed(count);
  return true;
}
