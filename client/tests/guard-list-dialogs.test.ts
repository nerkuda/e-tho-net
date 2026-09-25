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

import { collectViolations, type GuardRule } from './guard-helpers.js';

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
    assert.match(body, /background:\s*var\(--surface\)/, 'под закреплённым заголовком просвечивают строки');
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
