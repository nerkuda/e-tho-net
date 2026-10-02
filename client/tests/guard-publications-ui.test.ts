/**
 * Сторож UI подсистемы «Публикации» (0.11.1, задача a3cfc018; элемент
 * интерфейса 1eecd988, стандарт «Клиентский UI — только из дизайн-системы»).
 *
 * Правило: экран библиотеки (`screens/publications/**`) и карточка публикации
 * (`editor/publication-card.ts`) собираются ИЗ ФАСАДОВ `lib/ui` и `lib/dialog`:
 *
 * 1. **Не заводят собственных классов под роли `lib/ui`.** Словарные роли
 *    (кнопки `ui-btn*`, поля `ui-field*`, таблицы `ui-table*`, вкладки
 *    `ui-tab*`, состояния `ui-empty*`/`ui-state*`, чипы `ui-chip*`, сегменты
 *    `ui-segmented*`, выборы `ui-choice*`, бейджи `ui-badge*`, дерево
 *    `ui-tree*`) берутся только из фасадов; в код модулей их литералы не
 *    проникают — иначе элемент строится мимо фасада и расходится с
 *    дизайн-системой.
 * 2. **Вендор — только внутри `lib/ui`.** Голые `wa-*`/`vaadin-*` и импорты
 *    вендорских пакетов в этих модулях запрещены (дублирует общий сторож
 *    `guard-ui-facades`, но здесь с явным сообщением о подсистеме).
 * 3. **Диалоги — через `lib/dialog.ts`.** Самодельных окон (`dialog-box`) нет.
 *
 * Дополнительно проверяется положительный факт: списки библиотеки обновляются
 * инкрементально (`reconcileKeyed`) — без этого карточки/строки пересобирались
 * бы целиком (стандарт «Списки рендерятся инкрементально»).
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean } from './guard-helpers.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

/** Файлы подсистемы «Публикации» (относительно рендерера). */
const PUBLICATIONS_SCOPE = (rel: string): boolean =>
  rel.startsWith('screens/publications/') || rel === 'editor/publication-card.ts';

/** Комментарий (JS/CSS) — упоминание в пояснении не является использованием. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('#')
  );
}

/** Литерал класса словарной роли `lib/ui`. */
const UI_ROLE_CLASS =
  /\bui-(?:btn|button|field|table|tab|empty|state|comment|popover|chip|segmented|choice|badge|tree|toggle|splitter)\b/;

/** Литерал имени вендорского custom element (`wa-button`, `vaadin-grid`). */
const VENDOR_ELEMENT = /['"`](?:wa|vaadin)-[a-z][\w-]*['"`]/;

/** Импорт вендорского пакета. */
const VENDOR_IMPORT =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]@(?:awesome\.me\/webawesome|vaadin\/[\w-]+)/;

describe('guard: UI публикаций (a3cfc018)', () => {
  it('экраны публикаций не заводят собственных классов ролей lib/ui', () => {
    assertGuardClean(
      RENDERER_ROOT,
      [
        {
          name: 'no-ui-role-class-literals',
          description:
            'Модули «Публикаций» не содержат литералов классов ролей `lib/ui` ' +
            '(кнопки/поля/таблицы/вкладки/состояния/чипы/сегменты): ' +
            'соответствующие элементы строятся только фасадами `lib/ui`.',
          pattern: UI_ROLE_CLASS,
          include: PUBLICATIONS_SCOPE,
          allow: (_rel, line) => isCommentLine(line),
        },
      ],
    );
  });

  it('вендорские элементы и пакеты не проникают в модули публикаций', () => {
    assertGuardClean(
      RENDERER_ROOT,
      [
        {
          name: 'no-vendor-elements',
          description: 'Вендорские custom elements (`wa-*`/`vaadin-*`) в модулях «Публикаций» запрещены.',
          pattern: VENDOR_ELEMENT,
          include: PUBLICATIONS_SCOPE,
          allow: (_rel, line) => isCommentLine(line),
        },
        {
          name: 'no-vendor-imports',
          description: 'Вендорские пакеты импортируются только фасадами `lib/ui`.',
          filePattern: VENDOR_IMPORT,
          include: PUBLICATIONS_SCOPE,
        },
      ],
    );
  });

  it('диалоги публикаций идут через lib/dialog.ts, а не своим окном', () => {
    assertGuardClean(
      RENDERER_ROOT,
      [
        {
          name: 'no-own-dialog-box',
          description: 'Самодельное окно диалога (`dialog-box`) в модулях «Публикаций» запрещено.',
          pattern: /dialog-box/,
          include: PUBLICATIONS_SCOPE,
          allow: (_rel, line) => isCommentLine(line),
        },
      ],
    );
  });

  it('списки библиотеки обновляются инкрементально (reconcileKeyed)', () => {
    const source = fs.readFileSync(
      path.join(RENDERER_ROOT, 'screens', 'publications', 'publications.ts'),
      'utf8',
    );
    assert.ok(
      source.includes('reconcileKeyed'),
      'library lists must be reconciled incrementally with reconcileKeyed',
    );
    assert.ok(
      !source.includes('replaceChildren('),
      'library screen must not rebuild collections with replaceChildren',
    );
  });

  it('вид «список» — двухстрочные строки, без таблиц с колонками', () => {
    assertGuardClean(
      RENDERER_ROOT,
      [
        {
          name: 'no-custom-list-row-classes',
          description:
            'Строки «Списка» — двухстрочные записи `.pub-entry` на keyed-сверке ' +
            '(задача 55ee3c85); самодельные классы строк (`pub-row*`) запрещены.',
          pattern: /\bpub-row/,
          include: PUBLICATIONS_SCOPE,
          allow: (_rel, line) => isCommentLine(line),
        },
      ],
    );
    const source = fs.readFileSync(
      path.join(RENDERER_ROOT, 'screens', 'publications', 'publications.ts'),
      'utf8',
    );
    assert.ok(
      !source.includes('createTable'),
      'вид «список» больше не строится таблицей с колонками (прямое требование задачи 55ee3c85)',
    );
    assert.ok(
      source.includes('pub-entry'),
      'строки «Списка» — двухстрочные записи `.pub-entry`',
    );
  });

  it('оба вида — секции-группы и общий контроллер навигации', () => {
    const source = fs.readFileSync(
      path.join(RENDERER_ROOT, 'screens', 'publications', 'publications.ts'),
      'utf8',
    );
    assert.ok(source.includes('LIB_GROUP_CLASS'), 'секции обоих видов несут общий класс группы');
    assert.ok(
      source.includes('attachLibraryNav'),
      'клавиатурная навигация обоих видов — общий контроллер `library-nav.ts`',
    );
    assert.ok(source.includes('collapsedShelves'), 'свёрнутость полок — единое состояние обоих видов');
  });

  it('тулбар: у «Полки» иконка `+` и подсказки у кнопок', () => {
    const source = fs.readFileSync(
      path.join(RENDERER_ROOT, 'screens', 'publications', 'publications.ts'),
      'utf8',
    );
    assert.ok(
      source.includes("newShelfButton.prepend(svgIcon('plus'"),
      'у кнопки «Полка» иконка `+`, как у «+ Публикация»',
    );
    for (const key of ['publications.newShelfHint', 'publications.newHint', 'publications.sort.hint']) {
      assert.ok(source.includes(key), `подсказка ${key} обязана быть на кнопке тулбара`);
    }
  });

  it('карточку публикации импортирует только общая панель редактора (ADR eb687eea)', () => {
    assertGuardClean(
      RENDERER_ROOT,
      [
        {
          name: 'publication-card-only-from-editor',
          description:
            'Карточка публикации — третий EditorTarget общей панели: её модуль ' +
            '`editor/publication-card.ts` импортирует только `editor/editor.ts` ' +
            '(ADR eb687eea запрещает отдельный хост/панель карточки).',
          filePattern: /(?:from\s+|import\s*\(\s*)['"][^'"]*publication-card(?:\.js)?['"]/,
          allow: (rel) =>
            rel === 'editor/editor.ts' || rel.endsWith('editor/publication-card.ts'),
        },
      ],
    );
  });
});

/**
 * Поведенческие инварианты экрана, введённые ошибкой 28fbdb59 и задачей
 * 00160da1. Проверяются по исходнику: они связывают несколько модулей
 * (`model.ts` + `publications.ts` + общий фасад диалога) и легко откатываются
 * при рефакторинге, а полноценный DOM-прогон этих мест дорог.
 */
describe('guard: экран «Публикации» — пустое состояние, inline-rename, меню (28fbdb59, 00160da1)', () => {
  const SOURCE = fs.readFileSync(
    path.join(RENDERER_ROOT, 'screens', 'publications', 'publications.ts'),
    'utf8',
  );
  const MODEL = fs.readFileSync(
    path.join(RENDERER_ROOT, 'screens', 'publications', 'model.ts'),
    'utf8',
  );
  const slice = (from: string, to: string): string =>
    SOURCE.slice(SOURCE.indexOf(from), SOURCE.indexOf(to));

  it('глобальное пустое состояние — по предикату, а не по числу публикаций', () => {
    assert.ok(
      !SOURCE.includes('publications.length === 0'),
      'голое `publications.length === 0` больше не решает пустое состояние',
    );
    assert.ok(
      SOURCE.includes('publicationsEmptyKind'),
      'экран решает пустое состояние предикатом publicationsEmptyKind (полки видны при 0 публикаций)',
    );
    assert.ok(MODEL.includes('export function publicationsEmptyKind'));
  });

  it('inline-переименование полки: двойной клик, PATCH, без пункта меню «Переименовать»', () => {
    assert.ok(SOURCE.includes('dblclick'), 'имя полки открывает inline-правку по двойному клику');
    assert.ok(SOURCE.includes('nextShelfTitle'), 'итог rename нормализует nextShelfTitle');
    assert.ok(SOURCE.includes('updateShelf'), 'сохранение имени — PATCH updateShelf');
    const menu = slice('function openShelfMenu', 'function publicationBlockedLines');
    assert.ok(
      !menu.includes('publications.shelf.rename'),
      'из контекстного меню полки пункт «Переименовать полку» убран',
    );
  });

  it('удаление публикации и полки — общий фасад диалога + deletion-check', () => {
    assert.ok(SOURCE.includes('openEntityDeleteDialog'), 'удаление переиспользует общий диалог');
    assert.ok(!SOURCE.includes('confirmDialog'), 'своих confirm-окон удаления у экрана нет');
    assert.ok(
      SOURCE.includes('publications.deletionCheck') && SOURCE.includes('shelfDeletionCheck'),
      '«Удалить совсем» решается серверным deletion-check',
    );
    assert.ok(
      SOURCE.includes('etn.publications.purge') && SOURCE.includes('purgeShelf'),
      'есть физическое удаление публикации и полки',
    );
  });

  it('состав контекстного меню публикации: открыть/читать/удалить/экспорт + сохранённые пункты', () => {
    const menu = slice('function publicationMenuItems', 'function openShelfMenu');
    for (const key of [
      'publications.menu.open',
      'publications.menu.read',
      'publications.menu.delete',
      'publications.menu.export',
      'publications.menu.shelves',
      'publications.menu.inactive',
    ]) {
      assert.ok(menu.includes(key), `в меню публикации обязан быть пункт ${key}`);
    }
  });

  it('сортировка передаётся в группировку в обоих видах', () => {
    const calls = SOURCE.match(/groupByShelves\(publications, shelves, viewState\.sort\)/g) ?? [];
    assert.ok(calls.length >= 2, 'оба вида (полки и список) сортируют публикации внутри полок');
  });
});
