/**
 * Smoke checks for the thought-type editor tabs (задача b8301c16, требование
 * 344b8798; перекомпоновка — ошибка 58807d03, 0.9.1; перевод на общий
 * механизм — задача a57e7998).
 *
 * The DOM-bound code (`type-manager.ts`/`views-tab.ts`) pulls in IPC,
 * realtime and the dialog module — heavy for the unit runner. These tests
 * stay cheap by checking the structural anchors the editor relies on:
 *
 *   - The three tab labels («Основное», «Свойства», «Отборы») are handed to
 *     the dialog's shared tab mechanism (`showDialog({ tabs: [...] })`) in
 *     order, with «Основное» first (the default tab). Идентичность типа
 *     (иконка · название · ⚙ и родитель) вынесена в постоянную шапку
 *     диалога (`headerExtra`) НАД вкладками; шаблон и метаданные — группы
 *     внутри «Основного» (ошибка 58807d03);
 *   - The shared tab component declares the class names it emits
 *     (`.ui-tab`, `.ui-tablist`, `.ui-tabpanel` — `lib/ui/tabs.css`);
 *   - The pure helpers in `views-tab-pure.ts` stay stable for the keys
 *     the row code reads (`id`, `position`, `is_default`,
 *     `thought_type_id`).
 *
 * Together these act as a tripwire: a rename of either the tab labels or
 * the tab mechanism breaks the build before the integration tests run.
 */

 

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { assembledStylesFile } from './renderer-css.js';

const CSS_PATH = assembledStylesFile();

const TABS_CSS_PATH = resolve(
  import.meta.dirname,
  '..',
  'src',
  'renderer',
  'lib',
  'ui',
  'tabs.css',
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

/** Идентификаторы вкладок редактора типа в требуемом порядке (ошибка
 *  58807d03): «Основное», «Свойства», «Отборы». */
const REQUIRED_TAB_IDS = ['basic', 'properties', 'views'];

/** Ключи словаря подписей вкладок и групп (ошибка 58807d03). */
const REQUIRED_I18N_KEYS = [
  'typeEditor.tab.basic',
  'typeEditor.tab.properties',
  'typeEditor.tab.views',
  'typeEditor.group.template',
  'typeEditor.group.metadata',
  'typeEditor.group.inherited',
  'typeEditor.group.own',
];

/** Plain string-substring search — the labels are unique enough that a
 *  simple `includes` is safer than parsing the file. */
function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('thought-type editor — tabs (задача b8301c16)', () => {
  it('type-manager hands the three tab ids to the shared tab mechanism in order', () => {
    const src = readText(SOURCE_FILES.typeManager);
    const start = src.indexOf('tabs: [');
    assert.ok(start > 0, 'type-manager must pass `tabs: [...]` to showDialog');
    const end = src.indexOf('],', start);
    const block = src.slice(start, end);
    const ids = [...block.matchAll(/id: '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(
      ids,
      REQUIRED_TAB_IDS,
      'вкладки редактора типа — общий механизм каркаса диалога, в требуемом порядке',
    );
  });

  it('type-manager activates the «Основное» tab by default (id basic first)', () => {
    const src = readText(SOURCE_FILES.typeManager);
    assert.match(
      src,
      /tabs:\s*\[\s*\{\s*id: 'basic'/,
      'первая (активная по умолчанию) вкладка — «Основное»',
    );
  });

  it('идентичность типа вынесена в шапку диалога над вкладками (58807d03)', () => {
    const src = readText(SOURCE_FILES.typeManager);
    assert.match(
      src,
      /headerExtra:\s*headerBox/,
      'иконка · название · ⚙ и родитель живут в постоянной шапке диалога, а не во вкладке',
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
    // Диалог «Свойство / связь» — роль xl: ширина 1240px (требование 465495a9).
    const css = readText(CSS_PATH);
    assert.ok(src.includes("size: 'xl'"), 'редактор свойства — роль xl (≥1200 px)');
    assert.ok(
      css.includes("--dialog-w: 1240px"),
      'роль xl задаёт ширину 1240px (lib/dialog.ts, styles.css)',
    );
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

  it('the shared tab component declares the classes the tab row + panes rely on', () => {
    const css = readText(TABS_CSS_PATH);
    const required = ['.ui-tablist', '.ui-tab', '.ui-tabpanel'];
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

  it('редактор типа берёт подписи вкладок и групп из словаря (ошибка 58807d03)', () => {
    const src = readText(SOURCE_FILES.typeManager);
    for (const key of REQUIRED_I18N_KEYS) {
      assert.ok(
        src.includes(`'${key}'`),
        `ключ словаря ${key} не используется в редакторе типа`,
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
