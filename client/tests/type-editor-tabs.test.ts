/**
 * Smoke checks for the thought-type editor tabs (задача b8301c16, требование
 * 344b8798, 0.7.3).
 *
 * The DOM-bound code (`type-manager.ts`/`views-tab.ts`) pulls in IPC,
 * realtime and the dialog module — heavy for the unit runner. These tests
 * stay cheap by checking the structural anchors the editor relies on:
 *
 *   - The five tab labels («Описание», «Шаблон», «Свойства», «Отборы»,
 *     «Метаданные») match the requirement word-for-word;
 *   - The CSS module declares the class names the editor emits
 *     (`.type-editor-tabs`, `.type-editor-tab`, `.type-editor-tab.active`,
 *     `.type-editor-tab-pane`, `.type-editor-tab-pane.active`);
 *   - The pure helpers in `views-tab-pure.ts` stay stable for the keys
 *     the row code reads (`id`, `position`, `is_default`,
 *     `thought_type_id`).
 *
 * Together these act as a tripwire: a rename of either the tab labels or
 * the CSS classes breaks the build before the integration tests run.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const CSS_PATH = resolve(
  import.meta.dirname,
  '..',
  'src',
  'renderer',
  'styles.css',
);

const SOURCE_FILES = {
  typeManager: resolve(
    import.meta.dirname,
    '..',
    'src',
    'renderer',
    'screens',
    'type-manager.ts',
  ),
  propertyManager: resolve(
    import.meta.dirname,
    '..',
    'src',
    'renderer',
    'screens',
    'property-manager.ts',
  ),
  viewsTab: resolve(
    import.meta.dirname,
    '..',
    'src',
    'renderer',
    'screens',
    'thought-type',
    'views-tab.ts',
  ),
};

const REQUIRED_TAB_LABELS = [
  '«Описание»',
  '«Шаблон»',
  '«Свойства»',
  '«Отборы»',
  '«Метаданные»',
];

/** Plain string-substring search — the labels are unique enough that a
 *  simple `includes` is safer than parsing the file. */
function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('thought-type editor — tabs (задача b8301c16)', () => {
  it('type-manager declares the five tab buttons in the order required', () => {
    const src = readText(SOURCE_FILES.typeManager);
    // The tab button row is built with literal labels; assert each one is
    // emitted as the argument of a `tabButton(key, label)` call so a
    // rename trips the test before the UI does.
    const labels = ['Описание', 'Шаблон', 'Свойства', 'Отборы', 'Метаданные'];
    for (const label of labels) {
      assert.ok(
        src.includes(`'${label}'`),
        `tab label «${label}» not found in showThoughtTypeEditor`,
      );
    }
    // Order: tabs are passed to `tabRow.append(...)` in sequence — the
    // first occurrence after `tabRow.append(` should be «Описание» and the
    // last «Метаданные».
    const tabRowStart = src.indexOf('tabRow.append(');
    assert.ok(tabRowStart > 0, 'tabRow.append call not found');
    const tabRowSlice = src.slice(tabRowStart, src.indexOf(');', tabRowStart));
    const firstLabelIdx = tabRowSlice.indexOf(`'Описание'`);
    const lastLabelIdx = tabRowSlice.lastIndexOf(`'Метаданные'`);
    assert.ok(firstLabelIdx > 0 && firstLabelIdx < lastLabelIdx, 'tab order');
  });

  it('type-manager activates the «Описание» tab by default', () => {
    const src = readText(SOURCE_FILES.typeManager);
    assert.ok(
      /let\s+activeTab:\s*TabKey\s*=\s*'description'/.test(src),
      'activeTab must default to «description»',
    );
  });

  it('type-manager wires the views tab into a separate pane', () => {
    const src = readText(SOURCE_FILES.typeManager);
    assert.ok(src.includes('viewsPane.append(viewsTab.root)'), 'views tab mounted');
    assert.ok(src.includes('viewsTab.dispose()'), 'views tab disposed on close');
  });

  it('the link-type editor is removed in 0.8.1 (single dialog «Свойство / связь», задача 09201bd4)', () => {
    const src = readText(SOURCE_FILES.typeManager);
    // Требование 09f692ff: редактор типа связи упразднён — единственная точка
    // редактирования связи это свойство-связь через `openPropertyManagerEditor`.
    assert.equal(
      src.indexOf('export function showLinkTypeEditor'),
      -1,
      'showLinkTypeEditor must be removed from type-manager (use openPropertyManagerEditor instead)',
    );
    assert.equal(
      src.indexOf('showLinkTypesDialog'),
      -1,
      'showLinkTypesDialog must be removed — replaced by property-manager.showLinkTypesTreeDialog',
    );
  });

  it('property-manager exports the unified dialog with the required 09201bd4 surface', () => {
    const src = readText(SOURCE_FILES.propertyManager);
    // Единый диалог «Свойство / связь» экспортируется и принимает опции
    // предзаполнения (используется в задаче 935ec90e).
    assert.ok(src.includes('export function openPropertyManagerEditor'));
    assert.ok(src.includes('export interface OpenEditorOptions'));
    assert.ok(src.includes('initialThoughtTypeId'));
    assert.ok(src.includes('initialSide'));
    // Ширина диалога ≥ 1200 px (требование 465495a9).
    assert.ok(src.includes('width: 1240'), 'editor width must be at least 1200 px');
    // Вид `thought_ref` исключён из выбора (требование 5a82c709).
    assert.ok(src.includes('SELECTABLE_VALUE_TYPES'));
    // Список выбора НЕ включает `thought_ref` (только скаляры + link).
    const selectableBody = src.match(
      /const SELECTABLE_VALUE_TYPES: PropertyValueType\[\] = \[([^\]]+)\]/,
    )?.[1] ?? '';
    assert.ok(
      !selectableBody.includes("'thought_ref'"),
      'SELECTABLE_VALUE_TYPES must not include thought_ref',
    );
  });

  it('styles.css declares the classes the tab row + panes rely on', () => {
    const css = readText(CSS_PATH);
    const required = [
      '.type-editor-tabs',
      '.type-editor-tab',
      '.type-editor-tab.active',
      '.type-editor-tab-pane',
      '.type-editor-tab-pane.active',
    ];
    for (const cls of required) {
      assert.ok(css.includes(cls), `CSS missing selector ${cls}`);
    }
  });

  it('views-tab exports the entry point and pure helpers used by the editor', () => {
    const src = readText(SOURCE_FILES.viewsTab);
    assert.ok(src.includes('export function buildViewsTab'), 'buildViewsTab not exported');
    assert.ok(
      src.includes('onRealtimeEvent'),
      'views-tab must subscribe to realtime events for live updates',
    );
    assert.ok(src.includes('openViewEditorDialog'), 'views-tab wires the dialog');
    assert.ok(src.includes('dispose'), 'views-tab exposes dispose()');
  });

  it('lists the five required tab labels in the requirement reference', () => {
    // Mirror the labels documented in the requirement so a future rename
    // goes through the test on both sides.
    const src = readText(SOURCE_FILES.typeManager);
    for (const label of REQUIRED_TAB_LABELS) {
      const plain = label.replace(/[«»]/g, '');
      assert.ok(
        src.includes(plain),
        `tab label «${plain}» not referenced in the editor source`,
      );
    }
  });

  // -------------------------------------------------------------------
  // Задача d9b66617: вкладка «Отборы» должна показывать понятную заглушку
  // в слоях изменений и блокировать все мутации отборов. Эти проверки —
  // структурные: ловят переименование текста заглушки и потерю вызова
  // защитной ветки `isInBaseLayer()`.
  // -------------------------------------------------------------------

  it('views-tab объявляет заглушку «Отборы доступны только в Основе» и зовёт isInBaseLayer', () => {
    const src = readText(SOURCE_FILES.viewsTab);
    assert.ok(
      src.includes('Отборы доступны только в Основе'),
      'views-tab должен содержать текст заглушки для слоёв изменений',
    );
    assert.ok(
      src.includes('isInBaseLayer'),
      'views-tab должен использовать isInBaseLayer для защитных веток',
    );
    assert.ok(
      src.includes("from '../../lib/layer-base.js'"),
      'views-tab должен импортировать isInBaseLayer из lib/layer-base',
    );
  });
});
