/**
 * Приёмники перетаскиваемых pointer-жестом мыслей (задача d144ef71).
 *
 * Облачка мыслей тянутся ЕДИНЫМ pointer-жестом `canvas/drag-cloud.ts`
 * (HTML5 DataTransfer они не используют осознанно — регрессия модификаторных
 * драгов). Пока жест умел ронять мысль только на карту, панели списков и
 * облачка; этот модуль добавляет ему ДВА класса приёмников вне холста:
 *
 * - **поля значений-связей** (`editor/value-editor.ts`) и **поля выбора
 *   «Родительские мысли» панелей отбора** (`lib/filter-form.ts`): дроп мысли
 *   в такое поле добавляет её значение; перенос из поля-источника убирает
 *   мысль оттуда (Shift — копирование, см. {@link resolveFieldDrop});
 * - **любое облачко мысли** для дропа ИЗ поля: по выбору свойства-связи в
 *   диалоге создаётся связь ({@link openLinkPropertyDropDialog}).
 *
 * Реестр полей — `WeakMap` по элементу-контейнеру поля; поиск идёт по цепочке
 * родителей из точки дропа, поэтому перерисовка DOM (`replaceChildren`/`clear`)
 * не ломает привязку — поле перерегистрируется при пересборке.
 *
 * Собственного pointer-контроллера здесь нет: жест остаётся один — в
 * `canvas/drag-cloud.ts`, как требует ADR `442e7ff5` «drag-логика только в
 * общем фасаде».
 */

import { requireNetworkId, scheduleRefresh } from '../app.js';
import { store } from '../state.js';
import { div, errText } from './dom.js';
import { showDialog } from './dialog.js';
import { buildEntityCombo, type LinkPropertyPick } from './entity-picker.js';
import { addLinkPropertyValue } from './link-property-write.js';
import { etn } from './etn.js';
import { t } from './i18n.js';
import { notice } from './notice.js';
import { notifyPropertyValuesRefreshed } from './property-values-refresh.js';
import {
  buildPropertyListRows,
  ensurePropertyLinkTypes,
  type PropertyListRow,
} from './property-list.js';
import { fieldRow } from './ui/field.js';
import { walkDropField } from './thought-drop-pure.js';

export { resolveFieldDrop, type FieldDropPlan } from './thought-drop-pure.js';

/**
 * Вид поля-приёмника. `link-value` — поле значения свойства-связи (между такими
 * полями мысль ПЕРЕНОСЯТ: исчезает из источника); `filter` — поле
 * «Родительские мысли» панелей отбора и сама панель (туда мысль только
 * ДОБАВЛЯЕТСЯ, источник не трогается — задача d144ef71, претензия проверки).
 */
export type ThoughtDropFieldKind = 'link-value' | 'filter';

/**
 * Приёмник дропа мысли. `accept` синхронно меняет состояние поля и возвращает
 * `true`, если набор изменился (мысль уже была — `false`, чтобы перенос не снял
 * её из поля-источника впустую).
 */
export interface ThoughtDropField {
  kind: ThoughtDropFieldKind;
  accept: (thoughtId: string) => boolean;
}

const dropFields = new WeakMap<HTMLElement, ThoughtDropField>();

/** Регистрирует контейнер поля как приёмник мыслей (перерегистрация перекрывает). */
export function registerThoughtDropField(el: HTMLElement, handlers: ThoughtDropField): void {
  dropFields.set(el, handlers);
}

/**
 * Ищет зарегистрированное поле по цепочке родителей от точки дропа (чистый
 * обход — {@link walkDropField}).
 */
export function resolveThoughtDropField(
  el: HTMLElement | null,
): { el: HTMLElement; handlers: ThoughtDropField } | null {
  const found = walkDropField(el, (node) => dropFields.get(node as HTMLElement));
  return found === null ? null : { el: found.el as HTMLElement, handlers: found.handlers };
}

/** Строки общего списка свойств-связей; не открыть диалог — не повод упасть. */
async function loadPropertyRows(networkId: string): Promise<readonly PropertyListRow[]> {
  try {
    const registry = await etn.propertyRegistry.list(networkId);
    await ensurePropertyLinkTypes(networkId, registry);
    return buildPropertyListRows(registry, store.state.linkTypes);
  } catch {
    return [];
  }
}

/**
 * Дроп мысли A на облачко мысли B: диалог выбора свойства-связи, затем связь
 * A↔B. Владелец значения — ПЕРЕТАСКИВАЕМАЯ мысль A (её свойство получает B,
 * как в диалоге добавления), а сторона ребра определяется выбранным именем
 * свойства (`name_forward` → A→B, `name_reverse` → B→A).
 */
export async function openLinkPropertyDropDialog(opts: {
  draggedId: string;
  targetId: string;
}): Promise<void> {
  let networkId: string;
  try {
    networkId = requireNetworkId();
  } catch {
    return;
  }
  const rows = await loadPropertyRows(networkId);
  let pick: LinkPropertyPick | null = null;
  const combo = buildEntityCombo({
    networkId,
    kind: 'link-properties',
    value: null,
    placeholder: t('linkProperty.empty'),
    emptyLabel: t('linkProperty.empty'),
    pickerTitle: t('linkProperty.pickerTitle'),
    linkPropertyRows: () => rows,
    onChange: () => undefined,
    onChangeEntity: (option) => {
      pick = option?.linkProperty ?? null;
    },
  });
  const body = div('form-stack');
  body.append(
    fieldRow({
      label: t('thoughtDrop.linkPropertyLabel'),
      control: combo.root,
      class: 'thought-drop-property-field',
    }),
  );
  showDialog({
    title: t('thoughtDrop.linkPropertyTitle'),
    body,
    size: 's',
    buttons: [
      { label: t('actions.cancel') },
      {
        label: t('actions.apply'),
        primary: true,
        keepOpen: true,
        onClick: (close) => {
          if (pick === null) {
            notice(t('thoughtDrop.pickProperty'), 'error');
            return;
          }
          const chosen = pick;
          void addLinkPropertyValue(networkId, opts.draggedId, chosen, opts.targetId)
            .then(() => {
              // Общий модуль сигналит о смене состава публикации; здесь —
              // собственное перечитывание значений свойств и обновление карты.
              notifyPropertyValuesRefreshed(chosen.key);
              scheduleRefresh();
              close();
            })
            .catch((err) => notice(`${t('thoughtDrop.linkFailed')}: ${errText(err)}`, 'error'));
        },
      },
    ],
  });
}
