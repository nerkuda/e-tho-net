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
 * Приёмник дропа мысли — поле значений-связей. `accept` синхронно меняет
 * состояние поля и возвращает `true`, если набор изменился (мысль уже была —
 * `false`, чтобы перенос не снял её из поля-источника впустую).
 */
export interface ThoughtDropField {
  accept: (thoughtId: string) => boolean;
}

const dropFields = new WeakMap<HTMLElement, ThoughtDropField>();

/** Регистрирует контейнер поля как приёмник мыслей (перерегистрация перекрывает). */
export function registerThoughtDropField(el: HTMLElement, handlers: ThoughtDropField): void {
  dropFields.set(el, handlers);
}

/** Снимает поле с учёта (нужно, если контейнер переиспользуется вне пересборки). */
export function unregisterThoughtDropField(el: HTMLElement): void {
  dropFields.delete(el);
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
 * Записывает якорь в значение свойства-связи владельца (паритет с диалогом
 * добавления, ошибка 1dd08949): набор ЧИТАЕТСЯ и объединяется с якорем —
 * `properties.set` заменяет набор целиком.
 */
export async function applyLinkPropertyValue(
  networkId: string,
  ownerId: string,
  pick: LinkPropertyPick,
  anchorId: string,
): Promise<void> {
  let existing: string[] = [];
  try {
    const values = await etn.properties.get(networkId, 'thought', ownerId);
    const entry = values.find((v) => 'values' in v && v.property_id === pick.propertyId);
    if (entry !== undefined && 'values' in entry) {
      existing = entry.values.map((it) => it.target_id);
    }
  } catch {
    /* набор не прочитался — пишем только якорь (лучше связь, чем отказ) */
  }
  const targets = existing.includes(anchorId) ? existing : [...existing, anchorId];
  await etn.properties.set(networkId, 'thought', ownerId, pick.key, targets);
  notifyPropertyValuesRefreshed(pick.key);
  scheduleRefresh();
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
          void applyLinkPropertyValue(networkId, opts.draggedId, chosen, opts.targetId)
            .then(() => close())
            .catch((err) => notice(`${t('thoughtDrop.linkFailed')}: ${errText(err)}`, 'error'));
        },
      },
    ],
  });
}
