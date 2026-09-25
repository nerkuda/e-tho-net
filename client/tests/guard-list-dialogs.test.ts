/**
 * Сторож единых правил диалогов-списков (требование 11ddd910 «Единые правила
 * диалогов-списков», задача 1362e632 «Диалоги-списки по единым правилам»,
 * партия 1: «Типы мыслей», «Типы связей», «Свойства»).
 *
 * Проверяет СТРУКТУРУ диалогов-списков партии 1 по правилам требования:
 *  1. поиск — первая строка диалога, плейсхолдер из словаря (`actions.search`);
 *  2. строка управления под поиском, над списком; «Изменить»/«Удалить»/
 *     «Копировать» действуют на текущую строку и гаснут без неё;
 *  3. футер — только кнопки решения (Отмена/Выбрать/Применить и закрыть/Закрыть);
 *  4. sticky-заголовок колонок дерева (таблица — Vaadin Grid, сторож
 *     `guard-ui-tables`);
 *  6. семантика клика: редактор строки подключён через `onDblActivate`
 *     (юнит-тесты DOM-шимы — `ui-tree-click-semantics.test.ts`);
 *  7. после записи список позиционируется на новой строке (`revealRow`/
 *     `selectRow`).
 *
 * Партия 2 (тот же сторож): «Корзина» (trash.ts), «Сохранённые отборы»
 * (lib/saved-filter-bar.ts), admin-таблицы (admin/admin.ts). Слои — не
 * диалог-список, а меню (`screens/layers.ts`): правила к нему не применимы,
 * это зафиксировано отдельной проверкой-allow-краем.
 *
 * Кликовую семантику и позиционирование на shim проверяют юнит-тесты; здесь —
 * исходная структура, которую иначе не поймать. Сторож входит в обычный
 * прогон `npm -w @etn/client test`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { collectViolations, listSourceFiles, type GuardRule } from './guard-helpers.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

/** Исходник файла рендерера. */
function source(rel: string): string {
  return fs.readFileSync(path.join(RENDERER_ROOT, ...rel.split('/')), 'utf8');
}

/** Тело функции/секции: от маркера начала до маркера конца (конец не входит). */
function section(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `маркер начала не найден: ${startMarker}`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}

/** Секция диалога «Типы мыслей» (type-manager.ts). */
function thoughtTypesDialog(): string {
  return section(
    source('screens/type-manager.ts'),
    'export function showThoughtTypesDialog(): void {',
    '// Parent picker',
  );
}

/** Секция диалога «Типы связей» (property-manager.ts). */
function linkTypesDialog(): string {
  return section(
    source('screens/property-manager.ts'),
    'export function showLinkTypesTreeDialog(): void {',
    '\0', // диалог замыкает файл
  );
}

/** Секция общего списка свойств (property-list.ts). */
function propertyList(): string {
  return section(
    source('lib/property-list.ts'),
    'export function buildPropertyList(opts: {',
    '\0', // до конца файла
  );
}

/** Диалог «Свойства» — потребитель списка (property-manager.ts). */
function propertyManagerDialog(): string {
  return section(
    source('screens/property-manager.ts'),
    'export function showPropertyManagerDialog(): void {',
    '\n  // Realtime:',
  );
}

/** Диалог «Корзина» (trash.ts) — партия 2. */
function trashDialog(): string {
  return section(source('trash.ts'), 'export async function openTrashDialog(', '\0');
}

/** Диалог сохранённых отборов (lib/saved-filter-bar.ts) — партия 2. */
function savedFilterDialog(): string {
  return section(source('lib/saved-filter-bar.ts'), 'export function openSavedFilterDialog(', '\0');
}

/** Вкладка «Участники» admin-панели (admin/admin.ts) — партия 2. */
function adminUsersTab(): string {
  return section(
    source('admin/admin.ts'),
    'async function renderUsers(',
    '/** The add-user form under the table. */',
  );
}

/** Вкладка «Сети» admin-панели (admin/admin.ts) — партия 2. */
function adminNetworksTab(): string {
  return section(
    source('admin/admin.ts'),
    'async function renderNetworks(',
    '/** Удаляет сеть после подтверждения',
  );
}

/** Вкладка «Аудит» admin-панели (admin/admin.ts) — партия 2. */
function adminAuditTab(): string {
  return section(source('admin/admin.ts'), 'function renderAudit(', '\0');
}

/** Кнопки решения футера — белый список требования (правило 3). */
const DECISION_LABELS = [
  "t('actions.cancel')",
  "t('actions.select')",
  "t('actions.apply')",
  "t('actions.applyClose')",
  "t('actions.close')",
  "t('actions.confirm')",
];

/** Вытягивает `label: …` из массива `buttons: [ … ]` секции. */
function footerLabels(sectionSrc: string): string[] {
  const labels: string[] = [];
  for (const match of sectionSrc.matchAll(/buttons:\s*\[([\s\S]*?)\]\s*,/g)) {
    const body = match[1] ?? '';
    for (const label of body.matchAll(/label:\s*([^,}]+)/g)) {
      const text = label[1];
      if (text !== undefined) labels.push(text.trim());
    }
  }
  return labels;
}

describe('guard: единые правила диалогов-списков (11ddd910, партия 1)', () => {
  it('R1: поиск — первая строка диалога, плейсхолдер из словаря', () => {
    for (const [name, src, layout] of [
      ['Типы мыслей', thoughtTypesDialog(), 'body.append(searchRow, toolbar, tableWrap)'],
      ['Типы связей', linkTypesDialog(), 'body.append(searchRow, toolbar, tableWrap)'],
      ['Свойства', propertyList(), 'root.append(searchRow'],
    ] as const) {
      assert.ok(
        src.includes("t('actions.search')"),
        `${name}: плейсхолдер поиска обязан приходить из словаря (actions.search)`,
      );
      assert.ok(
        src.includes(layout),
        `${name}: поиск обязан идти первой строкой перед строкой управления и списком`,
      );
      assert.ok(
        !/searchInput\.placeholder\s*=\s*['"]/.test(src),
        `${name}: плейсхолдер поиска не задаётся литералом`,
      );
    }
  });

  it('R2: строка управления под поиском; кнопки текущей строки гаснут без неё', () => {
    for (const [name, src] of [
      ['Типы мыслей', thoughtTypesDialog()],
      ['Типы связей', linkTypesDialog()],
      ['Свойства', propertyList()],
    ] as const) {
      assert.ok(src.includes("t('listActions.edit')"), `${name}: нет кнопки «Изменить»`);
      assert.ok(src.includes("t('listActions.copy')"), `${name}: нет кнопки «Копировать»`);
      assert.ok(
        src.includes('function updateButtons()'),
        `${name}: состояние кнопок управления не привязано к текущей строке`,
      );
      assert.ok(
        src.includes('editBtn.disabled ='),
        `${name}: кнопка «Изменить» не гаснет без текущей строки`,
      );
    }
    // «Удалить» — только там, где удаление допустимо (в «Типах связей» его нет
    // по требованию 09f692ff: путь удаления лежит через список «Свойства»).
    assert.ok(
      thoughtTypesDialog().includes("t('actions.delete')"),
      'Типы мыслей: нет кнопки «Удалить»',
    );
    assert.ok(
      propertyList().includes("t('actions.delete')"),
      'Свойства: нет кнопки «Удалить»',
    );
    assert.ok(
      !linkTypesDialog().includes("t('listActions.deleteHint')"),
      'Типы связей: кнопки «Удалить» быть не должно (требование 09f692ff)',
    );
  });

  it('R3: футер диалога — только кнопки решения', () => {
    for (const [name, src] of [
      ['Типы мыслей', thoughtTypesDialog()],
      ['Типы связей', linkTypesDialog()],
    ] as const) {
      const labels = footerLabels(src);
      assert.ok(labels.length > 0, `${name}: в футере нет кнопок`);
      for (const label of labels) {
        assert.ok(
          DECISION_LABELS.includes(label),
          `${name}: в футере недопустимая кнопка «${label}» — правило 3 требования 11ddd910`,
        );
      }
    }
    // Список «Свойства» собирает каркас потребитель — проверяем его футер.
    assert.match(
      propertyManagerDialog(),
      /buttons:\s*\[\{\s*label:\s*t\('actions\.close'\),\s*primary:\s*true\s*\}\]/,
      'Свойства: футер — только «Закрыть»',
    );
  });

  it('R4: заголовок колонок дерева закреплён (sticky), таблица — фасад Vaadin Grid', () => {
    const css = source('lib/ui/tree.css');
    const start = css.indexOf('.ui-tree-head {');
    assert.ok(start >= 0, 'в tree.css нет правила .ui-tree-head');
    const body = css.slice(css.indexOf('{', start), css.indexOf('}', start));
    assert.match(body, /position:\s*sticky/, 'заголовок дерева не закреплён (правило 4)');
    assert.match(
      body,
      /background:\s*var\(--table-header-bg\)/,
      'под закреплённым заголовком просвечивают строки / фон шапки не из токена',
    );
    // Список «Свойства» рисует табличный фасад (сторож guard-ui-tables
    // запрещает самодельные таблицы) — заголовок грида закрепляет вендор.
    assert.ok(
      propertyList().includes('createTable<'),
      'Свойства: список обязан рисоваться фасадом lib/ui/table',
    );
  });

  it('R6: редактор строки подключён двойным кликом, а не одиночным', () => {
    assert.match(
      thoughtTypesDialog(),
      /onDblActivate:\s*\(item\) => showThoughtTypeEditor/,
      'Типы мыслей: редактор строки не подключён на двойной клик',
    );
    assert.match(
      linkTypesDialog(),
      /onDblActivate:[\s\S]{0,120}openPropertyManagerEditor/,
      'Типы связей: редактор строки не подключён на двойной клик',
    );
  });

  it('R7: после записи список позиционируется на новой строке', () => {
    assert.ok(
      thoughtTypesDialog().includes('tree.revealRow(currentRowId)'),
      'Типы мыслей: нет позиционирования на записанной строке (revealRow)',
    );
    assert.ok(
      linkTypesDialog().includes('pendingCurrentPropertyId') &&
        linkTypesDialog().includes('tree.revealRow('),
      'Типы связей: созданное свойство не становится текущей строкой',
    );
    const manager = source('screens/property-manager.ts');
    assert.ok(
      manager.includes('pendingSelectId') && propertyManagerDialog().includes('list.selectRow'),
      'Свойства: созданное свойство не становится текущей строкой',
    );
  });

  it('R8: команды над строкой — в контекстном меню строки, без построчных крестиков', () => {
    // Каркас дерева умеет контекстное меню строки (правило 8 требования).
    const treeSrc = source('lib/ui/tree.ts');
    assert.ok(treeSrc.includes('rowMenu'), 'lib/ui/tree: нет пунктов меню строки (rowMenu)');
    assert.ok(
      treeSrc.includes("addEventListener('contextmenu'"),
      'lib/ui/tree: строки без контекстного меню',
    );

    // «Типы мыслей»: построчная колонка действий с крестиком удалена, меню есть.
    const tt = thoughtTypesDialog();
    assert.ok(!tt.includes('type-row-actions'), 'Типы мыслей: в строке остался крестик удаления');
    assert.ok(!/label:\s*'✕'/.test(tt), 'Типы мыслей: построчная кнопка удаления в строке');
    assert.ok(tt.includes('rowMenu:'), 'Типы мыслей: строки без контекстного меню');
    assert.ok(tt.includes("t('listActions.copy')"), 'Типы мыслей: в меню строки нет «Копировать»');

    // «Типы связей»: меню строки есть; удаления в диалоге нет (требование 09f692ff).
    const lt = linkTypesDialog();
    assert.ok(lt.includes('rowMenu:'), 'Типы связей: строки без контекстного меню');

    // Корзина: колонка действий удалена, меню строки есть.
    const trash = trashDialog();
    assert.ok(!trash.includes('trash-actions'), 'Корзина: в строке остались построчные кнопки');
    assert.ok(!trash.includes('buildActions'), 'Корзина: построчная колонка действий не удалена');
    assert.ok(trash.includes('rowMenu:'), 'Корзина: строки без контекстного меню');

    // Список «Свойства»: меню строки с «Копировать».
    const pl = propertyList();
    assert.ok(pl.includes('rowMenu:'), 'Свойства: строки без контекстного меню');
    assert.ok(pl.includes("t('listActions.copy')"), 'Свойства: в меню строки нет «Копировать»');
  });

  it('R6b: пикер подтверждает выбор двойным кликом и Enter через общий фасад', () => {
    // Фасад дерева: без `onDblActivate` список — пикер, и двойной клик
    // подтверждает выбор (`onActivate`), как Enter (ошибка d1a009fa).
    assert.ok(
      source('lib/ui/tree.ts').includes('(options.onDblActivate ?? options.onActivate)'),
      'lib/ui/tree: двойной клик пикера не подтверждает выбор (нет фолбэка на onActivate)',
    );
    // Фасад таблицы: без `onDblActivate` двойной клик равен Enter (`activate`).
    assert.ok(
      source('lib/ui/table.ts').includes('spec.onDblActivate !== undefined'),
      'lib/ui/table: потерян фолбэк двойного клика на onActivate',
    );
    // Одиночный пикер сущностей: подтверждение кнопкой «Выбрать».
    const picker = source('lib/entity-picker.ts');
    assert.ok(
      picker.includes("t('actions.select')") && picker.includes('tree.getCurrentId()'),
      'entity-picker: у одиночного пикера нет кнопки «Выбрать» (правило 6)',
    );
  });

  it('R9: размер диалога-списка задан ролью и стабилен (fixedHeight)', () => {
    for (const [name, src] of [
      ['Типы мыслей', thoughtTypesDialog()],
      ['Типы связей', linkTypesDialog()],
      ['Свойства', propertyList()],
      ['Корзина', trashDialog()],
      ['Сохранённые отборы', savedFilterDialog()],
    ] as const) {
      assert.ok(
        src.includes("list-dialog-body"),
        `${name}: тело диалога-списка без раскладки .list-dialog-body`,
      );
    }
    const css = source('styles/dialogs.css');
    assert.match(css, /\.list-dialog-body\s*\{[^}]*display:\s*flex/s, 'нет раскладки .list-dialog-body');
    assert.match(
      css,
      /\.list-dialog-body\s*\{[^}]*gap:\s*var\(--space-\d\)/s,
      'нет отступов между шапкой и списком (правило 8)',
    );
    assert.match(
      css,
      /\.list-dialog-body\s+\.admin-table-wrap[^{]*\{[^}]*flex:\s*1 1 auto/s,
      'область списка не тянется на высоту тела (правило 9)',
    );
  });

  it('правило о плейсхолдере краснеет на умышленной копии', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-list-dialogs-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'screen.ts'),
        "searchInput.placeholder = 'Поиск по имени…';\n",
        'utf8',
      );
      const rules: GuardRule[] = [
        {
          name: 'no-literal-search-placeholder',
          description:
            'Плейсхолдер горячего поиска диалога-списка задаётся словарём ' +
            "(t('actions.search')), литералы запрещены (требование 11ddd910, правило 1).",
          pattern: /searchInput\.placeholder\s*=\s*['"]/,
        },
      ];
      const violations = collectViolations(dir, rules, { extensions: ['.ts'] });
      assert.ok(
        violations.some((v) => v.rule === 'no-literal-search-placeholder'),
        'литеральный плейсхолдер обязан попадать в нарушение',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('guard: единые правила диалогов-списков (11ddd910, партия 2)', () => {
  it('R1: поиск — первая строка над списком, плейсхолдер из словаря', () => {
    for (const [name, src, layout] of [
      ['Корзина', trashDialog(), 'body.append(searchRow, toolbar, listHost)'],
      ['Сохранённые отборы', savedFilterDialog(), 'body.append(search, toolbar, listHost)'],
    ] as const) {
      assert.ok(
        src.includes("t('actions.search')"),
        `${name}: плейсхолдер поиска обязан приходить из словаря (actions.search)`,
      );
      assert.ok(
        src.includes(layout),
        `${name}: поиск обязан идти первой строкой перед управлением и списком`,
      );
    }
    // admin: общий хелпер строки поиска и подключение его в первой строке
    // каждой вкладки (правило 1).
    const admin = source('admin/admin.ts');
    assert.ok(
      admin.includes('function adminSearchRow()') &&
        admin.includes("input.placeholder = t('actions.search')"),
      'admin: нет общей строки поиска с плейсхолдером из словаря',
    );
    for (const [name, tab] of [
      ['Участники', adminUsersTab()],
      ['Сети', adminNetworksTab()],
      ['Аудит', adminAuditTab()],
    ] as const) {
      assert.ok(
        tab.includes('adminSearchRow()'),
        `admin/${name}: таблица без строки поиска (правило 1)`,
      );
      assert.ok(
        tab.includes("searchInput.addEventListener('input'"),
        `admin/${name}: поиск не фильтрует список`,
      );
    }
  });

  it('R2: строка управления над списком; кнопки действуют на текущую строку', () => {
    const trash = trashDialog();
    assert.ok(trash.includes('type-list-toolbar trash-toolbar'), 'Корзина: нет строки управления');
    assert.ok(trash.includes("t('trash.action.restore')"), 'Корзина: нет «Вернуть из корзины»');
    assert.ok(trash.includes("t('actions.deleteForever')"), 'Корзина: нет «Удалить совсем»');
    assert.ok(
      trash.includes('function updateButtons()'),
      'Корзина: состояние кнопок не привязано к текущей строке',
    );
    assert.ok(
      trash.includes('deleteBtn.disabled = row === null || row.blocked'),
      'Корзина: «Удалить совсем» не гаснет без строки / у заблокированной',
    );

    const sfd = savedFilterDialog();
    assert.ok(sfd.includes('type-list-toolbar sfd-toolbar'), 'Отборы: нет строки управления');
    for (const key of ['listActions.edit', 'listActions.copy']) {
      assert.ok(sfd.includes(`t('${key}')`), `Отборы: нет кнопки «${key}»`);
    }
    assert.ok(sfd.includes("t('actions.delete')"), 'Отборы: нет кнопки «Удалить»');
    assert.ok(
      sfd.includes('editBtn.disabled = !has'),
      'Отборы: кнопки управления не гаснут без текущей строки',
    );

    const admin = source('admin/admin.ts');
    assert.ok(admin.includes('function adminToolbar()'), 'admin: нет строки управления');
    assert.ok(
      admin.includes("t('admin.user.key')") && admin.includes("t('admin.network.delete')"),
      'admin: нет кнопок управления текущей строкой',
    );
    assert.ok(
      adminUsersTab().includes('table.getCurrent()?.row'),
      'admin/Участники: действия не по текущей строке',
    );
    assert.ok(
      adminNetworksTab().includes('table.getCurrent()?.row'),
      'admin/Сети: действия не по текущей строке',
    );
    // Журнал аудита — только чтение: над текущей строкой производить нечего,
    // поэтому строки управления у него нет (allow-край правила 2).
    assert.ok(
      !adminAuditTab().includes('adminToolbar()'),
      'admin/Аудит: журнал только для чтения — строки управления быть не должно',
    );
  });

  it('R3: футер диалогов-списков — только кнопки решения', () => {
    assert.match(
      trashDialog(),
      /buttons: \[\{ label: t\('actions\.close'\), primary: true \}\]/,
      'Корзина: футер — только «Закрыть» (массовая очистка ушла в управление)',
    );
    const sfd = savedFilterDialog();
    const labels = footerLabels(sfd);
    assert.ok(labels.length > 0, 'Отборы: в футере нет кнопок');
    for (const label of labels) {
      assert.ok(
        DECISION_LABELS.includes(label),
        `Отборы: в футере недопустимая кнопка «${label}» — правило 3 требования 11ddd910`,
      );
    }
    assert.ok(sfd.includes("t('actions.select')"), 'Отборы: нет решения «Выбрать»');
    assert.match(
      source('admin/admin.ts'),
      /buttons: \[\{ label: t\('actions\.close'\), primary: true \}\]/,
      'admin: футер панели — только «Закрыть»',
    );
  });

  it('R6: двойной клик по строке открывает редактор', () => {
    assert.match(
      trashDialog(),
      /onDblActivate: \(row\) => openRowInEditor\(row\)/,
      'Корзина: редактор строки не подключён на двойной клик',
    );
    assert.ok(
      trashDialog().includes('openThoughtInEditor(row.id)') &&
        trashDialog().includes('openLinkInEditor(link)'),
      'Корзина: двойной клик не открывает мысль/связь в редакторе',
    );
    assert.match(
      savedFilterDialog(),
      /onDblActivate: \(entry\) => void opts\.onRename\(entry\)\.then\(render\)/,
      'Отборы: двойной клик не открывает редактор строки (переименование)',
    );
  });

  it('R7: после создания копии отбора список позиционируется на новой записи', () => {
    const sfd = savedFilterDialog();
    assert.ok(
      sfd.includes('pendingCurrentId = id'),
      'Отборы: созданная копия не становится целью позиционирования (правило 7)',
    );
    assert.ok(
      sfd.includes('table.setCurrent('),
      'Отборы: текущая строка/позиционирование не выставляются фасадом',
    );
  });

  it('Слои: списка-диалога нет — выбор слоя это меню (allow-край)', () => {
    // Диалога-СПИСКА слоёв в клиенте нет: слои выбираются меню «Основа»
    // (`showMenuAt`), а не диалогом-списком. Правила 1–7 к меню не применимы;
    // если однажды диалог-список слоёв появится — его обязан поймать этот ассерт.
    const layers = source('screens/layers.ts');
    assert.ok(layers.includes('showMenuAt('), 'Слои: выбор слоя обязан оставаться меню');
    assert.ok(
      !layers.includes('createTable<') && !layers.includes('createTree<'),
      'Слои: диалога-списка быть не должно (иначе он обязан идти по правилам 1–7)',
    );
  });

  it('правило о подписи кнопки управления краснеет на литерале', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-list-dialogs-p2-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'screen.ts'),
        "const b = uiButton({ label: 'Удалить', role: 'secondary', onClick: () => undefined });\n",
        'utf8',
      );
      const rules: GuardRule[] = [
        {
          name: 'list-action-label-from-dictionary',
          description:
            'Подписи кнопок строки управления диалога-списка берутся из словаря ' +
            "(t('…')), литералы запрещены (требование 11ddd910, правило 2).",
          pattern: /uiButton\(\{[^}]*label:\s*['"][^'"]*['"]/,
        },
      ];
      const violations = collectViolations(dir, rules, { extensions: ['.ts'] });
      assert.ok(
        violations.some((v) => v.rule === 'list-action-label-from-dictionary'),
        'литеральная подпись кнопки управления обязана попадать в нарушение',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Ревизия всех диалогов и панелей (задача 76cd9cf3, 0.9.1): полный перечень
// мест вместо выборочных проверок — новый экран не может «молча выпасть».
// ---------------------------------------------------------------------------

/**
 * Полный перечень модулей рендерера, открывающих модальный диалог вызовом
 * `showDialog(` (сам каркас `lib/dialog.ts` не в счёт — он объявляет функцию).
 * Новый диалог обязан быть добавлен сюда вместе с классификацией: диалог-список
 * — в {@link LIST_DIALOG_FILES}, иначе достаточно записи в этом перечне. Так
 * ревизия фиксирует ВСЕ места, а сторож краснеет на неучтённом новом диалоге.
 */
const DIALOG_FILES = new Set([
  'admin/admin.ts',
  'canvas/add-dialog.ts',
  'editor/attachments.ts',
  'editor/icon-dialog.ts',
  'editor/style-dialog.ts',
  'editor/wiki-link.ts',
  'import-export/export-dialog.ts',
  'import-export/import-dialog.ts',
  'lib/entity-picker.ts',
  'lib/saved-filter-bar.ts',
  'pinned/pins.ts',
  'screens/about-dialog.ts',
  'screens/activity/activity.ts',
  'screens/layers.ts',
  'screens/networks.ts',
  'screens/property-manager.ts',
  'screens/settings.ts',
  'screens/tabs/picker.ts',
  'screens/thought-type/filter-dialog.ts',
  'screens/type-manager.ts',
  'screens/workspace-menus.ts',
  'selection/dialogs.ts',
  'trash.ts',
]);

/**
 * Диалоги-СПИСКИ (основное содержимое — список): их тело обязано нести
 * раскладку `.list-dialog-body` (правило 9 требования 11ddd910). Полный
 * перечень, а не исключения: добавил новый список-диалог — добавь файл и сюда,
 * и в {@link DIALOG_FILES}.
 */
const LIST_DIALOG_FILES = new Set([
  'admin/admin.ts',
  'lib/entity-picker.ts',
  'lib/saved-filter-bar.ts',
  'screens/property-manager.ts',
  'screens/type-manager.ts',
  'trash.ts',
]);

/** Классы рядов управления, которые обязаны быть компактными (правило 12). */
const MANAGEMENT_ROWS = ['.type-list-toolbar', '.chrono-toolbar', '.views-tab-header'];

describe('guard: ревизия всех диалогов и панелей (76cd9cf3, 0.9.1)', () => {
  it('полный перечень диалогов: неучтённого модуля с showDialog нет', () => {
    const found = listSourceFiles(RENDERER_ROOT, { extensions: ['.ts'] })
      .map((abs) => path.relative(RENDERER_ROOT, abs).replace(/\\/g, '/'))
      .filter((rel) => rel !== 'lib/dialog.ts')
      .filter((rel) =>
        fs.readFileSync(path.join(RENDERER_ROOT, rel), 'utf8').includes('showDialog('),
      );
    const unknown = found.filter((rel) => !DIALOG_FILES.has(rel));
    assert.deepEqual(
      unknown,
      [],
      'Новый диалог обязан быть в перечне DIALOG_FILES (сторож «ревизия всех ' +
        'диалогов»): классифицируй его — диалог-список идёт в LIST_DIALOG_FILES ' +
        `и получает \`.list-dialog-body\`. Неучтённые: ${unknown.join(', ')}`,
    );
    const stale = [...DIALOG_FILES].filter((rel) => !found.includes(rel));
    assert.deepEqual(stale, [], `В DIALOG_FILES устаревшие записи: ${stale.join(', ')}`);
  });

  it('каждый диалог-список несёт раскладку .list-dialog-body (правило 9)', () => {
    for (const rel of LIST_DIALOG_FILES) {
      assert.ok(
        source(rel).includes('list-dialog-body'),
        `${rel}: диалог-список без раскладки .list-dialog-body — область списка ` +
          'не тянется на роль и схлопывается (правило 9)',
      );
    }
    const css = source('styles/dialogs.css');
    assert.match(
      css,
      /\.list-dialog-body\s*\{[^}]*height:\s*100%/s,
      'нет раскладки .list-dialog-body на всю высоту тела диалога',
    );
  });

  it('правило 10: ОБА фасада списков несут общий якорь фокуса', () => {
    // Общий атрибут объявлен один раз; фасады и каркас диалога берут его оттуда.
    const anchor = source('lib/ui/focus-anchor.ts');
    assert.match(
      anchor,
      /FOCUS_ANCHOR_ATTR\s*=\s*'data-focus-anchor'/,
      'атрибут якоря фокуса объявляется в lib/ui/focus-anchor.ts',
    );
    for (const [name, file, rootVar] of [
      ['дерево', 'lib/ui/tree.ts', 'root'],
      ['таблица', 'lib/ui/table.ts', 'wrapper'],
    ] as const) {
      const src = source(file);
      assert.ok(
        src.includes("from './focus-anchor.js'"),
        `${name} (${file}): якорь обязан браться из общего модуля focus-anchor`,
      );
      assert.ok(
        src.includes(`${rootVar}.setAttribute(FOCUS_ANCHOR_ATTR`),
        `${name} (${file}): корень списка не помечен якорем фокуса — после закрытия ` +
          'редактора стрелочная навигация не оживает без повторного клика (правило 10)',
      );
    }
    const dialog = source('lib/dialog.ts');
    assert.ok(
      dialog.includes("from './ui/focus-anchor.js'"),
      'каркас диалога обязан читать общий атрибут якоря, а не свой литерал',
    );
  });

  it('правило 12: компактная высота покрывает ВСЕ ряды управления', () => {
    const css = source('styles/dialogs.css');
    for (const cls of MANAGEMENT_ROWS) {
      const re = new RegExp(
        `${cls.replace('.', '\\.')}[^{]*\\{[^}]*height:\\s*var\\(--list-btn-h\\)`,
      );
      assert.match(css, re, `ряд управления ${cls} не покрыт компактной высотой --list-btn-h`);
    }
  });

  it('правило 8: табличные списки админки дают команды в меню строки', () => {
    // Полный перечень табличных списков админки (перенесено из «ячеек действий»
    // в контекстное меню строки — правило 8 требования 11ddd910).
    assert.ok(
      adminUsersTab().includes('rowMenu:'),
      'admin/Участники: у таблицы нет контекстного меню строки (правило 8)',
    );
    assert.ok(
      adminNetworksTab().includes('rowMenu:'),
      'admin/Сети: у таблицы нет контекстного меню строки (правило 8)',
    );
  });
});
