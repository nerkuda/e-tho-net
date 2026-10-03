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

  /**
   * Требования задачи b02ef1cf: список вложений в диалоге обложки — ТОЛЬКО
   * общий компонент списка (ADR fadf99e0), рецепт строит «Родительские мысли»
   * первым (дополнение C), а стройных «своих» обработчиков стрелок в карточке
   * нет (сторож guard-list-nav).
   *
   * Проверка — не по подстрокам «где-то в файле», а по ФАКТИЧЕСКОМУ
   * использованию в теле `openCoverDialog`: список создаётся фасадом
   * `createListNav` с контрактными аргументами (`entries`/`tokenOf`/`onActivate`)
   * и перерисовывается `reconcileKeyed` по ключу; рукописной обработки стрелок
   * в диалоге нет.
   */
  it('диалог обложки: список — общий компонент, рецепт — родительские мысли первыми', () => {
    const card = fs.readFileSync(
      path.join(RENDERER_ROOT, 'editor', 'publication-card.ts'),
      'utf8',
    );
    const dialog = card.slice(
      card.indexOf('async function openCoverDialog'),
      card.indexOf('function blobToDataUrl'),
    );
    assert.ok(dialog.length > 0, 'тело openCoverDialog найдено');
    // Список создаётся фасадом с контрактными аргументами.
    assert.match(
      dialog,
      /createListNav<CoverRow>\(listHost,\s*\{[\s\S]*?entries:\s*\(\)\s*=>\s*rows[\s\S]*?tokenOf:\s*\(row\)\s*=>\s*row\.key[\s\S]*?onActivate:/,
      'список вложений строится общим фасадом createListNav с entries/tokenOf/onActivate',
    );
    // Строки рисуются keyed-сверкой по id, а не пересборкой.
    assert.match(
      dialog,
      /reconcileKeyed\(listHost,\s*rows,\s*\{[\s\S]*?key:\s*\(row\)\s*=>\s*row\.key/,
      'строки списка рисуются keyed-сверкой reconcileKeyed по id',
    );
    // Никакой рукописной карты стрелок и клавиатуры в диалоге.
    for (const gone of ["'ArrowUp'", "'ArrowDown'", "'ArrowLeft'", "'ArrowRight'"]) {
      assert.ok(!dialog.includes(gone), `в диалоге обложки нет рукописной обработки ${gone}`);
    }
    assert.ok(
      !/addEventListener\(\s*['"]keydown['"]/.test(dialog),
      'навигацию списка ведёт фасад, а не собственный keydown-обработчик',
    );
    // Диалог — через общий каркас (lib/dialog.ts), вкладки — через его API.
    assert.ok(dialog.includes('showDialog('), 'диалог обложки — общий каркас showDialog');
    assert.ok(dialog.includes('tabs:'), 'вкладки диалога обложки заданы API каркаса');
    // Облачка владельцев — общие КОМПОНЕНТЫ (замечание Б2 приёмки b02ef1cf):
    // мысль — общий облачок мысли (тип/оформление), публикация — lib/ui.
    assert.ok(
      dialog.includes('createThoughtCloud('),
      'владелец-мысль рисуется общим компонентом облачка мысли',
    );
    assert.ok(
      dialog.includes('createPublicationCloud('),
      'владелец-публикация рисуется компонентом lib/ui/publication-cloud',
    );
    assert.ok(
      dialog.includes('confirmDialog('),
      'удаление последнего владельца подтверждается общим диалогом confirmDialog',
    );
    assert.ok(
      !dialog.includes('pub-cover-cloud-kind'),
      'самодельных подписей вида владельца («мысль»/«публикация») нет',
    );

    const recipe = fs.readFileSync(
      path.join(RENDERER_ROOT, 'screens', 'publications', 'recipe.ts'),
      'utf8',
    );
    assert.ok(
      recipe.includes('buildParentThoughtsSection'),
      'рецепт использует общий фасад «Родительские мысли»',
    );
    assert.ok(
      recipe.indexOf('buildParentThoughtsSection(ctx') < recipe.indexOf('buildKeywordsSection(ctx'),
      '«Родительские мысли» — первое поле группы «ОТБОР РАЗДЕЛОВ»',
    );
  });

  /**
   * Облачко публикации — КОМПОНЕНТ `lib/ui` (замечание Б2 приёмки b02ef1cf):
   * прямые углы, всегда значок-книга, экспорт из barrel `lib/ui`. Единственное
   * место показа облачка публикации; самодельная разметка запрещена.
   */
  it('облачко публикации — компонент lib/ui с книгой и прямыми углами', () => {
    const cloud = fs.readFileSync(
      path.join(RENDERER_ROOT, 'lib', 'ui', 'publication-cloud.ts'),
      'utf8',
    );
    assert.ok(
      cloud.includes("svgIcon('value-publication'"),
      'значок облачка публикации — книга (value-publication)',
    );
    assert.ok(
      cloud.includes('createPublicationCloud'),
      'фасад createPublicationCloud объявлен в компоненте',
    );
    const css = fs.readFileSync(
      path.join(RENDERER_ROOT, 'lib', 'ui', 'publication-cloud.css'),
      'utf8',
    );
    assert.match(
      css,
      /\.ui-pub-cloud\s*\{[\s\S]*?border-radius:\s*0;/,
      'прямые углы облачка публикации',
    );
    const index = fs.readFileSync(path.join(RENDERER_ROOT, 'lib', 'ui', 'index.ts'), 'utf8');
    assert.ok(
      index.includes('createPublicationCloud'),
      'компонент экспортируется из barrel lib/ui',
    );
  });

  /**
   * Дополнение к задаче b02ef1cf (замечание координатора): у роли
   * «Родительские мысли» — ОДНА реализация (`buildParentThoughtsSection` в
   * `lib/filter-form.ts`). Экраны, применявшие конструктор, обязаны брать
   * фасад, а не держать собственную копию синхронизации облачков/поиска.
   */
  it('роль «Родительские мысли» — одна реализация на всех потребителей', () => {
    const consumers = [
      'screens/structures/filter-panel.ts',
      'screens/chronicle/filter-panel.ts',
      'screens/thought-type/filter-dialog.ts',
      'screens/publications/recipe.ts',
    ] as const;
    for (const rel of consumers) {
      const source = fs.readFileSync(path.join(RENDERER_ROOT, rel), 'utf8');
      assert.ok(
        // Якорь — именно ВЫЗОВ фасада с контекстом, а не импорт: `import {
        // buildParentThoughtsSection }` без применения сторожа не проходит.
        /buildParentThoughtsSection\s*\(/.test(source),
        `${rel} обязан собирать «Родительские мысли» общим фасадом`,
      );
      // Маркеры прежних копий: своя карта облачков и её синхронизация.
      assert.ok(
        !source.includes('parentThoughtOptions'),
        `${rel}: своей копии живого поиска «Родительских мыслей» быть не должно`,
      );
      assert.ok(
        !source.includes('syncParentChips'),
        `${rel}: своей копии синхронизации облачков «Родительских мыслей» быть не должно`,
      );
    }
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

  it('состав контекстного меню публикации: открыть/удалить/читать/экспортировать (b51dbca4)', () => {
    const menu = slice('function publicationMenuItems', 'function openShelfMenu');
    for (const key of [
      'publications.menu.open',
      'publications.menu.delete',
      'publications.menu.read',
      'publications.menu.export',
    ]) {
      assert.ok(menu.includes(key), `в меню публикации обязан быть пункт ${key}`);
    }
    // Управление полками переехало в настройки публикации, актуальность — в
    // редактор: пунктов «На полки» и «Неактуальна/Актуальна» в меню больше нет.
    for (const gone of [
      'publications.menu.shelves',
      'publications.menu.inactive',
      'publications.menu.active',
      'shelfToggle',
      'toggleActive',
    ]) {
      assert.ok(!menu.includes(gone), `из меню публикации убран пункт ${gone}`);
    }
  });

  it('клики по публикации: одиночный — карточка, двойной/Ctrl+Enter — чтение (b51dbca4)', () => {
    const cards = slice('function wireCardEvents', 'function wireEntryEvents');
    const entries = slice('function wireEntryEvents', 'function authorLine');
    for (const [name, body] of [
      ['карточка', cards],
      ['строка списка', entries],
    ] as const) {
      assert.match(body, /addEventListener\(['"]click['"],\s*\(\)\s*=>\s*void openPublicationCard/, `${name}: одиночный клик открывает карточку`);
      assert.match(body, /addEventListener\(['"]dblclick['"],\s*\(\)\s*=>\s*void openPublicationWorkspace/, `${name}: двойной клик открывает чтение`);
    }
    // Ctrl+Enter в навигации библиотеки ведёт в режим чтения.
    const nav = fs.readFileSync(
      path.join(RENDERER_ROOT, 'screens', 'publications', 'library-nav.ts'),
      'utf8',
    );
    assert.ok(nav.includes('onReadPublication'), 'библиотека умеет открывать публикацию на чтение');
    assert.ok(nav.includes('ctrlKey'), 'Ctrl+Enter обрабатывается в контроллере библиотеки');
  });

  it('сортировка передаётся в группировку в обоих видах', () => {
    const calls = SOURCE.match(/groupByShelves\(publications, shelves, viewState\.sort\)/g) ?? [];
    assert.ok(calls.length >= 2, 'оба вида (полки и список) сортируют публикации внутри полок');
  });
});

/**
 * Поведенческие инварианты рабочей области чтения, введённые задачей b51dbca4
 * (заголовок-кнопка, иконочный тулбар, сворачиваемые разделы, навигация тела
 * через общее ядро, Esc не закрывает). Проверяются по исходнику: это связка
 * нескольких модулей, а полноценный DOM-прогон дорог.
 */
describe('guard: рабочая область публикации — шапка, навигация, возврат (b51dbca4)', () => {
  const WS = fs.readFileSync(
    path.join(RENDERER_ROOT, 'screens', 'publications', 'workspace.ts'),
    'utf8',
  );

  it('шапка: иконочный тулбар и кликабельный заголовок, кнопки «Настройки» нет', () => {
    for (const key of [
      'publications.ws.collapseAll',
      'publications.ws.expandAll',
      'publications.ws.rebuild',
      'publications.ws.export',
      'publications.ws.openCard',
    ]) {
      assert.ok(WS.includes(key), `шапка использует строку ${key}`);
    }
    assert.ok(!WS.includes('publications.ws.settings'), 'кнопка «Настройки» из шапки убрана');
    assert.ok(
      /iconButton\(\{[\s\S]*?publications\.ws\.rebuild/.test(WS),
      '«Пересобрать» — иконочная кнопка с подсказкой',
    );
    assert.ok(
      /class: 'pub-ws-title'[\s\S]*?opts\.onOpenCard/.test(WS),
      'заголовок-кнопка открывает карточку публикации в панели редактора',
    );
  });

  it('разделы тела сворачиваются, набор свёрнутых общий с оглавлением', () => {
    assert.ok(WS.includes('setSectionCollapsed'), 'есть переключение свёрнутости раздела');
    assert.ok(WS.includes('setAllCollapsed'), 'тулбар сворачивает/разворачивает все разделы');
    assert.ok(
      WS.includes('documentBlocks(assembly, publication, collapsed)'),
      'тело документа учитывает свёрнутые разделы',
    );
    assert.ok(WS.includes('pub-doc-caret'), 'в заголовке раздела есть каретка-экспандер');
    assert.ok(WS.includes('pub-doc-collapsed'), 'свёрнутый раздел помечается классом');
  });

  it('навигация тела документа — через общий компонент списка, а не свой обработчик', () => {
    assert.match(
      WS,
      /from '\.\.\/\.\.\/lib\/ui\/list\.js'/,
      'тело документа использует общий компонент списка',
    );
    assert.ok(WS.includes('createListNav'), 'навигация тела строится на createListNav');
    assert.ok(!WS.includes("'ArrowUp'") && !WS.includes("'ArrowDown'"), 'своей карты стрелок в модуле нет');
  });

  it('Esc просмотр не закрывает; возврат — Ctrl+Backspace (когда поля не правятся)', () => {
    const keydown = WS.slice(WS.indexOf('const onKeydown'), WS.indexOf('docHost.addEventListener'));
    assert.ok(!keydown.includes('Escape'), 'Esc больше не закрывает просмотр');
    assert.ok(keydown.includes("'Backspace'") && keydown.includes('ctrlKey'), 'Ctrl+Backspace закрывает');
    assert.ok(keydown.includes('isEditingTarget'), 'Ctrl+Backspace молчит, когда правится поле');
  });
});
