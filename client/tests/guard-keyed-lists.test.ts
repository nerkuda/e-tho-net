/**
 * Сторож инкрементального рендера списков (задача 6952c619, уровень 2
 * тех.проекта `1d48df6d`, ADR «Keyed-обновление списков»).
 *
 * Правило: списки в `screens/**`, `lib/ui/**` и `editor/**` обновляются
 * инкрементально (`reconcileKeyed`, `lib/ui/keyed-list.ts`), а не полной
 * пересборкой коллекции. Две части сторожа:
 *
 * (а) **юнит-гарант API** `reconcileKeyed` — identity неизменённых узлов и
 *     корректность вставки/удаления/перемещения/обновления (глубокие тесты —
 *     `keyed-list.test.ts`);
 * (б) **греп-сторож**: полная пересборка (`replaceChildren` по коллекции,
 *     пустой `replaceChildren()`, `clear(host)` из `lib/dom.ts`) в
 *     `screens/**`, `lib/ui/**` и `editor/**` разрешена только файлам из
 *     белого списка ниже. Новый файл вне списка краснеет — автор обязан либо
 *     перевести список на `reconcileKeyed`, либо добавить файл в список с
 *     обоснованием.
 *
 * Область `editor/**` добавлена ошибкой cf903c79: каркас редактора и таблица
 * «Свойства» уже инкрементальны (задача 90b2256e), но без покрытия новая
 * полная пересборка списка в новом файле редактора проходила незамеченной.
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
// Таблица «Свойства» редактора переведена на `reconcileKeyed` задачей
// 90b2256e; файл входит в греп-область сторожа (cf903c79) как файл белого
// списка, поэтому дополнительно проверяем факт положительной проверкой.
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
  [
    'lib/ui/icon.ts',
    'одиночный слот библиотечного значка (icon_kind=icon): renderLibraryIcon ' +
      'кладёт один <svg> в иконный узел, это не коллекция списка',
  ],
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
  [
    'screens/chronicle/record-title.ts',
    'заголовок записи — ОДНА кнопка-группа: `replaceChildren` обновляет только ' +
      'её надпись, сохраняя `svg`-индикатор (задача 472457bf), это не коллекция списка',
  ],
  ['screens/structures/filter-panel.ts', 'панель отбора — пересборка формы'],
  ['screens/structures/structures.ts', 'монтирование вида и наполнение строки; дерево — на reconcileKeyed'],
  // editor — каркас редактора инкрементален (задача 90b2256e), ниже — только
  // легитимные одиночные слоты и пересборка содержимого вкладок.
  [
    'editor/editor.ts',
    'монтирование каркаса (mountEditor), очистка title/scrollBox при полной ' +
      'пересборке (смена позиции/сущности) и подмена содержимого ОДНОЙ панели ' +
      'вкладки в её же узле (retarget/activate)',
  ],
  [
    'editor/properties.ts',
    'слоты групп «Свойства типа» и «Свойства вне типа»: плейсхолдер, ошибка, ' +
      'пустое состояние и разовое монтирование таблиц; строки ОБЕИХ таблиц — ' +
      'reconcileKeyed; чипы внетиповых значений-связей — точечная пересборка ' +
      'набора одного поля',
  ],
  [
    'editor/chrono-tab.ts',
    'содержимое вкладки «Дневник»: слот таблицы (ошибка/монтирование) и область ' +
      'редактора записи; строки таблицы — setRows, не пересборка контейнера',
  ],
  [
    'editor/links-tab.ts',
    'содержимое вкладок связи: слоты корня (загрузка/ошибка/пусто/концы связи) и ' +
      'результатов упоминаний — пересборка при построении вкладки',
  ],
  [
    'editor/attachments.ts',
    'вкладка вложений: слоты списка/просмотрщика (загрузка/ошибка) и результаты ' +
      'поиска вложений — пересборка по запросу (как список пикера в screens)',
  ],
  [
    'editor/value-editor.ts',
    'поля-наборы значений (текст/чипы ссылок): пересборка чипов поля при смене ' +
      'набора — тот же приём, что у chip-list в lib/ui',
  ],
  [
    'editor/resource-picker.ts',
    'одиночные слоты превью источников ресурса (файл/URL); сетку вкладки ' +
      '«Библиотека» рисует reconcileKeyed',
  ],
  ['editor/graph-tab.ts', 'разовое монтирование тела вкладки графа'],
  ['editor/markdown-field.ts', 'одиночные слоты: превью и контейнер markdown-редактора'],
  [
    'editor/recent-icons.ts',
    'строка последних иконок строится ОДИН раз при открытии диалога (задача ' +
      '0fc95a2b): история за сессию диалога неизменна, перерисовки коллекции нет; ' +
      'clear(host) — защита от повторного вызова на том же узле',
  ],
]);

/** Сканирование экранов, каталога фасадов и редактора. */
const inScope = (rel: string): boolean =>
  rel.startsWith('screens/') || rel.startsWith('lib/ui/') || rel.startsWith('editor/');

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
            'Полная пересборка списка в screens/**, lib/ui/** и editor/** ' +
            'запрещена: используйте reconcileKeyed (lib/ui/keyed-list.ts). ' +
            'Легитимные исключения перечислены в REBUILD_WHITELIST с обоснованием.',
          pattern: /\.replaceChildren\(/,
          include: inScope,
          allow: (rel, line) => isCommentLine(line) || REBUILD_WHITELIST.has(rel),
        },
        {
          name: 'no-dom-clear',
          description:
            'Очистка контейнера `clear(host)` (lib/dom.ts) в screens/**, ' +
            'lib/ui/** и editor/** запрещена: используйте reconcileKeyed или preserveScroll.',
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

      // Область редактора (cf903c79): новый файл `editor/**` вне белого списка
      // краснеет так же, как экран вне списка.
      fs.mkdirSync(path.join(dir, 'editor'));
      fs.writeFileSync(
        path.join(dir, 'editor', 'fresh-list.ts'),
        'tbody.replaceChildren(...rows);\n',
        'utf8',
      );
      assert.throws(
        () =>
          assertGuardClean(
            dir,
            [
              {
                name: 'no-collection-rebuild',
                description: 'запрет',
                pattern: /\.replaceChildren\(/,
                include: inScope,
                allow: (rel, line) => isCommentLine(line) || REBUILD_WHITELIST.has(rel),
              },
            ],
            { exclude: ['screen.ts'] },
          ),
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
    // 3df6b477: таблица «Свойства вне типа» переведена тем же приёмом.
    assert.match(
      EDITOR_PROPERTIES,
      /reconcileKeyed\(tbody,\s*outsideRows\(/,
      'строки «Свойства вне типа» сверяются по ключу, а не пересобираются коллекцией',
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
