/**
 * Объединённый диалог каталога типов и свойств (задача 979761cd).
 *
 * Три списка, до 0.10.2 жившие тремя отдельными диалогами — «Типы мыслей»
 * (`buildThoughtTypesPanel`, type-manager.ts), «Свойства мыслей»
 * (`buildPropertiesPanel`, property-manager.ts) и «Типы связей»
 * (`buildLinkTypesPanel`, property-manager.ts), — показываются вкладками ОДНОГО
 * диалога. Переключение между списком свойств и списком типов больше не требует
 * закрывать один диалог и открывать другой.
 *
 * Команды меню «Мыслесеть» («Типы мыслей», «Свойства мыслей», «Типы связей»)
 * остались на месте, но открывают общую форму на СВОЕЙ вкладке
 * ({@link TypeCatalogueTab}); выбор значений из этих списков (пикеры
 * `lib/entity-picker.ts` / `lib/property-list.ts` в режиме `picker`) не затронут
 * и общую форму не использует.
 *
 * **Панели — те же списки, что были в отдельных диалогах.** Списки не
 * дублируются: экран лишь собирает их в вкладки (`lib/ui/tabs.ts` через
 * `DialogOptions.tabs` каркаса `lib/dialog.ts`). Панель ленива и строится при
 * первом показе вкладки, поэтому её состояние (строка поиска, раскрытость
 * дерева, текущая строка) переживает переключение вкладок в рамках открытого
 * диалога. По закрытию диалога каркас зовёт `onClose` — здесь панели
 * освобождают свои realtime-подписки.
 */

import { t } from '../lib/i18n.js';
import { footerErrorLine } from '../lib/ui/messages.js';
import { showDialog, type DialogTab } from '../lib/dialog.js';
import { buildPropertiesPanel, buildLinkTypesPanel } from './property-manager.js';
import { buildThoughtTypesPanel } from './type-manager.js';

/** Вкладка каталога — цель команды меню «Мыслесеть». */
export type TypeCatalogueTab = 'thought-types' | 'properties' | 'link-types';

/**
 * Панель вкладки — тело одного списка. `root` вставляется в панель вкладки,
 * `dispose` освобождает подписки панели при закрытии диалога, `focus` ставит
 * фокус в стартовый элемент панели (строка поиска или список).
 */
export interface CataloguePanel {
  root: HTMLElement;
  dispose: () => void;
  focus: () => void;
}

/**
 * Открывает объединённый диалог каталога на вкладке `initialTab`.
 *
 * Каркас диалога прокручивает тело только активной вкладки, высота стабильна
 * ролью (`l`), а стек диалогов и клавиатуру (Esc, Tab-ловушка, стрелки по
 * вкладкам) ведёт `lib/dialog.ts` — своих обработчиков клавиш экран не заводит.
 */
export function showTypeCatalogueDialog(initialTab: TypeCatalogueTab = 'thought-types'): void {
  // Ошибки записи панели свойств — в панель кнопок диалога (требование
  // 397c5a56): строка в футере видна при активной любой вкладке.
  const errorLine = footerErrorLine();
  const panels: CataloguePanel[] = [];
  const host = (build: () => CataloguePanel): (() => HTMLElement) => () => {
    const panel = build();
    panels.push(panel);
    return panel.root;
  };

  const tabs: DialogTab[] = [
    {
      id: 'thought-types',
      label: t('catalogue.tab.thoughtTypes'),
      content: host(() => buildThoughtTypesPanel()),
    },
    {
      id: 'properties',
      label: t('catalogue.tab.properties'),
      content: host(() => buildPropertiesPanel({ errorLine })),
    },
    {
      id: 'link-types',
      label: t('catalogue.tab.linkTypes'),
      content: host(() => buildLinkTypesPanel()),
    },
  ];

  showDialog({
    title: t('catalogue.title'),
    size: 'l',
    tabs,
    activeTab: initialTab,
    footerError: errorLine,
    buttons: [{ label: t('actions.close'), primary: true }],
    // Порядок панелей в `panels` совпадает с порядком первого показа, поэтому
    // первой построена АКТИВНАЯ вкладка — ей и отдаём стартовый фокус.
    onMount: () => panels[0]?.focus(),
    // Панели держат realtime-подписки: явная очистка по закрытию диалога
    // (событие `remove` в Chromium не срабатывает — см. lib/dialog.ts).
    onClose: () => {
      for (const panel of panels) panel.dispose();
    },
  });
}
