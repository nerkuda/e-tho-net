/**
 * Удаление значения свойства-связи с выбором способа (задача 96d27fc0, 0.8.2).
 *
 * До этой задачи любое снятие рёбер значения свойства-связи (крестик «✕»
 * чипа, его команда «Убрать из значения», очистка набора крестиком ячейки,
 * очистка внетиповых) всегда клало рёбра в корзину — сервер помечал их
 * (`markLinkForDeletion` в property-service), и пользователь не получал выбора,
 * как при обычном удалении мысли (08-ui-spec.md §5a.1). Теперь у снятия
 * значения-связи тот же выбор: «В корзину» (по умолчанию) / «Удалить совсем».
 *
 * «Удалить совсем» — физическое удаление рёбер. Отдельного `DELETE /links/{id}`
 * в проекте НЕТ и не будет: требование 3ea5c6af (0.8.1) сняло операции
 * создания/удаления связей в пользу операций над свойствами-связями, а
 * физическая чистка ребра идёт через корзину — точечный
 * `POST /trash/purge { ids }` (ошибка 8b4b7a7e, см. `purgeLinkCompletely` в
 * `trash.ts`). Тот же путь использует и это меню: сначала обычная запись
 * значения (сервер помечает отозванные рёбра), затем точечный purge по id.
 *
 * Скаляры (в т.ч. внетиповые) меню не касается — они не восстанавливаемы и
 * никого не блокируют, их удаление остаётся как было (без корзины).
 */

import type { LinkPropertyValues } from '@etn/shared';

import { div, el, errText } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { showDialog } from '../lib/dialog.js';
import { notice } from '../lib/notice.js';

/** Выбор пользователя у диалога снятия значения-связи. */
export type LinkValueRemovalChoice = 'trash' | 'purge';

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
  /**
   * Обычная запись значения без снятых целей. Сервер сам помечает отозванные
   * рёбра (корзина) — это и есть «В корзину». Возвращает `false`, когда запись
   * не удалась (тогда purge не запускается).
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

/**
 * Диалог способа снятия значения-связи: «В корзину» (по умолчанию, primary),
 * «Удалить совсем» (danger) и «Отмена». Резолвится выбранным способом либо
 * `null` при любом пути закрытия (Esc/×/«Отмена»).
 */
export function askLinkValueRemoval(count: number): Promise<LinkValueRemovalChoice | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: LinkValueRemovalChoice | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const body = div('form-stack');
    const what =
      count === 1 ? 'Убрать связь из значения?' : `Убрать связи из значения (${count})?`;
    body.append(el('p', 'dialog-text', what));
    body.append(
      el(
        'p',
        'dialog-text muted',
        '«В корзину» — связь останется восстановимой; «Удалить совсем» — физически удалит её.',
      ),
    );
    showDialog({
      title: 'Удалить значение свойства-связи',
      body,
      buttons: [
        { label: 'В корзину', primary: true, onClick: () => finish('trash') },
        { label: 'Удалить совсем', danger: true, onClick: () => finish('purge') },
        { label: 'Отмена', onClick: () => finish(null) },
      ],
      // Esc и × — отмена (контракт «`null` on cancel», как у confirmDialog).
      onClose: () => finish(null),
    });
  });
}

/**
 * Снять рёбра значения-связи с выбором способа. Возвращает `true`, когда
 * запись применена (выбор сделан и commit прошёл), `false` — при отмене или
 * неудаче записи: вызывающий по этому признаку решает, обновлять ли UI.
 *
 * При «Удалить совсем» id рёбер добываются ДО записи (свежий `properties.get`);
 * если id не нашлись (владелец/свойство без рёбер), рёбра всё равно помечены —
 * сообщаем, что полное удаление не удалось, а состояние осталось «в корзине».
 * Заблокированные удерживающим слоем рёбра purge пропускает — о них сообщаем.
 */
export async function removeLinkValueEdges(
  opts: LinkValueRemovalOptions,
): Promise<boolean> {
  const choice = await askLinkValueRemoval(opts.removedTargetIds.length);
  if (choice === null) return false;

  let linkIds: string[] = [];
  if (choice === 'purge') {
    try {
      const values = await etn.properties.get(opts.networkId, opts.ownerType, opts.ownerId);
      linkIds = pickRemovedLinkIds(
        values,
        { propertyKey: opts.propertyKey, propertyId: opts.propertyId },
        opts.removedTargetIds,
      );
    } catch {
      linkIds = [];
    }
  }

  const committed = await opts.commit();
  if (!committed) return false;
  if (choice === 'trash') return true;

  if (linkIds.length === 0) {
    notice('Связи помещены в корзину: рёбра для полного удаления не найдены.', 'error');
    return true;
  }
  try {
    const { purged } = await etn.trash.purge(opts.networkId, linkIds);
    if (purged < linkIds.length) {
      notice('Часть связей заблокирована и осталась в корзине.', 'error');
    }
  } catch (err) {
    notice(`Не удалось удалить связи совсем: ${errText(err)}`, 'error');
  }
  return true;
}
