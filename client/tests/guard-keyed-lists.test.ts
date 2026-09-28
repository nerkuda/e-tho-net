/**
 * Сторож инкрементального рендера списков (задача 6952c619, уровень 2
 * тех.проекта `1d48df6d`, ADR «Keyed-обновление списков»).
 *
 * Правило: списки в `screens/**` и `lib/ui/**` обновляются инкрементально
 * (`reconcileKeyed`, `lib/ui/keyed-list.ts`), а не полной пересборкой коллекции.
 * Две части сторожа:
 *
 * (а) **юнит-гарант API** `reconcileKeyed` — identity неизменённых узлов и
 *     корректность вставки/удаления/перемещения/обновления (глубокие тесты —
 *     `keyed-list.test.ts`);
 * (б) **греп-сторож**: полная пересборка (`replaceChildren` по коллекции,
 *     пустой `replaceChildren()`, `clear(host)` из `lib/dom.ts`) в
 *     `screens/**` и `lib/ui/**` разрешена только файлам из белого списка ниже.
 *     Новый файл вне списка краснеет — автор обязан либо перевести список на
 *     `reconcileKeyed`, либо добавить файл в список с обоснованием.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';
import { assertGuardClean } from './guard-helpers.js';
import {
  reconcileKeyed,
  type KeyedRenderSpec,
} from '../src/renderer/lib/ui/keyed-list.js';

const RENDERER_ROOT = path.resolve(import.meta.dirname, '..', 'src', 'renderer');
const CHRONICLE = fs.readFileSync(
  path.join(RENDERER_ROOT, 'screens', 'chronicle', 'chronicle.ts'),
  'utf8',
);
const STRUCTURES = fs.readFileSync(
  path.join(RENDERER_ROOT, 'screens', 'structures', 'structures.ts'),
  'utf8',
);
// Таблица «Свойства» редактора — вне греп-области сторожа (`screens/**`,
// `lib/ui/**`), но переведена на `reconcileKeyed` задачей 90b2256e; проверяем
// факт положительной проверкой, а не расширением области сканирования.
const EDITOR_PROPERTIES = fs.readFileSync(
  path.join(RENDERER_ROOT, 'editor', 'properties.ts'),
  'utf8',
);
// Дерево `lib/ui/tree.ts` переведено на keyed-сверку задачей d59fdfb9:
// коллекция строк — `reconcileKeyed`, полной пересборки контейнера нет.
const TREE = fs.readFileSync(path.join(RENDERER_ROOT, 'lib', 'ui', 'tree.ts'), 'utf8');

/** Комментарий — упоминание конструкции в пояснении не является нарушением. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('#')
  );
}

/**
 * Белый список легитимных точек полной пересборки. Значение — обоснование.
 * Пополняется вместе с новым местом: либо не-список (форма/слот), либо
 * монтирование экрана, либо перевод на `reconcileKeyed` ещё впереди.
 */
const REBUILD_WHITELIST: ReadonlyMap<string, string> = new Map([
  // lib/ui — фасады.
  ['lib/ui/comment.ts', 'внутренние слоты оболочки комментария (tools/foot)'],
  ['lib/ui/table-grid.ts', 'разовая сборка колонок Grid при монтировании'],
  [
    'lib/ui/tree.ts',
    'коллекция строк — reconcileKeyed; replaceChildren — шапка/пустое состояние ' +
      'и содержимое ОДНОЙ изменившейся строки (общая сборка и keyed-обновление)',
  ],
  ['lib/ui/chip-list.ts', 'точечная пересборка чипов/селекта при смене набора'],
  [
    'lib/ui/table.ts',
    'слот пустого состояния (не список); строки — вендорский Vaadin Grid ' +
      '(items), выделение синхронизируется точечно (syncSelection)',
  ],
  ['lib/ui/collapsible.ts', 'одиночный слот тела секции'],
  // screens — монтирование экранов, слоты форм/панелей.
  ['screens/screens.ts', 'монтирование экрана целиком (смена сущности)'],
  ['screens/workspace.ts', 'точечная метка масштаба холста'],
  ['screens/onboarding.ts', 'список профилей экрана входа (монтирование/смена профиля)'],
  ['screens/networks.ts', 'список сетей экрана входа'],
  ['screens/tabs/picker.ts', 'список пикера вкладок, пересборка по запросу'],
  ['screens/property-manager.ts', 'форма-редактор свойства: слоты значений и таблица-привязка'],
  ['screens/type-manager.ts', 'менеджер типов: слоты редактора и наследования'],
  ['screens/thought-type/views-tab.ts', 'вкладка отборов типа: точечные состояния таблицы'],
  ['screens/activity/activity.ts', 'лента активности: монтирование и слоты таблицы'],
  ['screens/settings.ts', 'панели настроек, пересборка контента по разделу'],
  ['screens/settings-logs.ts', 'просмотр логов — слоты блоков'],
  ['screens/history-bar.ts', 'панель истории — слоты по смене контекста'],
  ['screens/pinned-bar.ts', 'закреплённые мысли — слоты панели'],
  ['screens/layers.ts', 'панель диффа слоёв, пересборка по запросу'],
  ['screens/workspace-menus.ts', 'выпадающие меню — слоты'],
  ['screens/chronicle/filter-panel.ts', 'панель отбора — пересборка формы'],
  ['screens/chronicle/chronicle.ts', 'монтирование вида и точечные слоты; лента — на reconcileKeyed'],
  ['screens/structures/filter-panel.ts', 'панель отбора — пересборка формы'],
  ['screens/structures/structures.ts', 'монтирование вида и наполнение строки; дерево — на reconcileKeyed'],
]);

/** Сканирование только экранов и каталога фасадов. */
const inScope = (rel: string): boolean =>
  rel.startsWith('screens/') || rel.startsWith('lib/ui/');

describe('guard: инкрементальный рендер списков (6952c619)', () => {
  it('(а) reconcileKeyed держит identity неизменённых узлов и меняет только нужное', () => {
    const host = new ShimElement('div') as unknown as HTMLElement;
    const built: HTMLElement[] = [];
    const updated: string[] = [];
    const spec: KeyedRenderSpec<{ id: string; n: number }> = {
      key: (item) => item.id,
      build: (_item) => {
        const node = new ShimElement('div') as unknown as HTMLElement;
        built.push(node);
        return node;
      },
      update: (_el, item) => updated.push(item.id),
    };

    reconcileKeyed(host, [{ id: 'a', n: 1 }, { id: 'b', n: 2 }], spec);
    const [a, b] = host.children as unknown as ShimElement[];

    const same = reconcileKeyed(host, [{ id: 'a', n: 1 }, { id: 'b', n: 2 }], spec);
    assert.deepEqual(same, { added: [], removed: [], moved: false, updated: [] });
    assert.equal((host.children as unknown as ShimElement[])[0], a, 'identity узла «a»');

    const inserted = reconcileKeyed(host, [{ id: 'a', n: 1 }, { id: 'x', n: 9 }, { id: 'b', n: 2 }], spec);
    assert.deepEqual(inserted.added, ['x']);
    assert.equal((host.children as unknown as ShimElement[])[0], a);
    assert.equal((host.children as unknown as ShimElement[])[2], b);

    const removed = reconcileKeyed(host, [{ id: 'a', n: 1 }, { id: 'b', n: 2 }], spec);
    assert.deepEqual(removed.removed, ['x']);

    const moved = reconcileKeyed(host, [{ id: 'b', n: 2 }, { id: 'a', n: 1 }], spec);
    assert.equal(moved.moved, true);
    assert.equal((host.children as unknown as ShimElement[])[0], b);

    const changed = reconcileKeyed(host, [{ id: 'b', n: 3 }, { id: 'a', n: 1 }], spec);
    assert.deepEqual(changed.updated, ['b']);
    assert.deepEqual(updated, ['b']);
    assert.equal(built.length, 3, 'пересоздаётся только новый узел «x»');
  });

  it('(б) полная пересборка списка — только из белого списка файлов', () => {
    assertGuardClean(
      RENDERER_ROOT,
      [
        {
          name: 'no-collection-rebuild',
          description:
            'Полная пересборка списка в screens/** и lib/ui/** запрещена: ' +
            'используйте reconcileKeyed (lib/ui/keyed-list.ts). Легитимные ' +
            'исключения перечислены в REBUILD_WHITELIST с обоснованием.',
          pattern: /\.replaceChildren\(/,
          include: inScope,
          allow: (rel, line) => isCommentLine(line) || REBUILD_WHITELIST.has(rel),
        },
        {
          name: 'no-dom-clear',
          description:
            'Очистка контейнера `clear(host)` (lib/dom.ts) в screens/** и ' +
            'lib/ui/** запрещена: используйте reconcileKeyed или preserveScroll.',
          pattern: /(?<![.\w])clear\([^:)]/,
          include: inScope,
          allow: (rel, line) => isCommentLine(line) || REBUILD_WHITELIST.has(rel),
        },
      ],
    );
  });

  it('(б) сторож краснеет на файле вне белого списка', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-keyed-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'screen.ts'),
        "list.replaceChildren(...nodes);\nclear(host);\n",
        'utf8',
      );
      assert.throws(
        () =>
          assertGuardClean(dir, [
            {
              name: 'no-collection-rebuild',
              description: 'запрет',
              pattern: /\.replaceChildren\(/,
              allow: (rel, line) => isCommentLine(line) || REBUILD_WHITELIST.has(rel),
            },
          ]),
        /Сторож нашёл запрещённые конструкции/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(в) экраны «Дневник» и «Структуры» используют reconcileKeyed', () => {
    assert.match(CHRONICLE, /reconcileKeyed\(list,\s*days,\s*\{/, 'лента «Дневника» — keyed');
    assert.match(
      CHRONICLE,
      /keyAttr:\s*TABLE_ROW_KEY_ATTR/,
      'строки «Дневника» сверяются по ключу записи',
    );
    assert.match(STRUCTURES, /reconcileKeyed\(results,\s*branches,\s*\{/, 'дерево «Структур» — keyed');
    assert.match(
      STRUCTURES,
      /keyAttr:\s*'data-root'/,
      'ветви «Структур» сверяются по ключу корня',
    );
  });

  it('(г) таблица «Свойства» редактора обновляется через reconcileKeyed (90b2256e)', () => {
    assert.match(
      EDITOR_PROPERTIES,
      /reconcileKeyed\(tbody,\s*rows,\s*rowSpec\)/,
      'строки таблицы «Свойства» сверяются по ключу, а не пересобираются коллекцией',
    );
  });

  it('(д) дерево lib/ui сверяет коллекцию строк через reconcileKeyed (d59fdfb9)', () => {
    assert.match(
      TREE,
      /reconcileKeyed\(root,\s*entries,\s*\{/,
      'корень дерева наполняется keyed-сверкой по ключу строки',
    );
    assert.doesNotMatch(
      TREE,
      /root\.replaceChildren\(/,
      'полной пересборки коллекции строк дерева быть не должно',
    );
  });
});
