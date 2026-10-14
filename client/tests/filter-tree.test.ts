/**
 * Рендер-слой дерева условий отбора (задача ТП 11b2509a, элемент интерфейса
 * fc65b647; требования 5ef1bce1 «тонированная вложенность и маркер НЕ»,
 * 502f1922 «сгруппированные списки операторов»; ADR 30ff83bb, ADR 4154811f).
 *
 * Проверяется то, за что отвечает модуль `lib/filter-tree.ts`:
 *   • группы-блоки, тонированная вложенность циклом палитры и токены тонов;
 *   • связаторы-индикаторы перед строками и смена коннекции селектором группы;
 *   • НЕ-переключатель (нет на корне, обёртка `not` вокруг группы);
 *   • сворачивание группы, крестики строки/группы, «+ условие»/«+ группа»;
 *   • список «Что» (профиль — параметр, группировка, поиск, обратные стороны);
 *   • сгруппированный список операторов «способ × утверждение/отрицание»;
 *   • правки идут в ЕДИНУЮ модель (`FilterCriteriaState.tree`) — состояние
 *     дерева не дублируется, и сборка в AST видит правки.
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.js`), как в
 * `filter-condition-list-values.test.ts`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';

import type { LinkType, NetworkProperty } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const RENDERER = path.resolve(import.meta.dirname, '..', 'src', 'renderer');

/** Минимальный DOM/window-шим, которого требуют фасады и модуль. */
function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    activeElement: null,
    querySelector: () => null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win['innerWidth'] = 1200;
  win['innerHeight'] = 800;
  win['setTimeout'] = (fn: () => void) => {
    fn();
    return 1;
  };
  win['clearTimeout'] = () => undefined;
  win['addEventListener'] = () => undefined;
  win['removeEventListener'] = () => undefined;
  win['matchMedia'] = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
}

/** Все потомки с ТОЧНЫМ классом (подстрока ловит и `ft-group__*`). */
function exact(root: ShimElement, cls: string): ShimElement[] {
  return root.findAll((node) => node.classList.contains(cls));
}

/** Первый потомок с точным классом. */
function exactOne(root: ShimElement, cls: string): ShimElement | null {
  return exact(root, cls)[0] ?? null;
}

/** Свой заголовок-рамка группы (не вложенных). */
function headOf(group: ShimElement): ShimElement {
  return group.children.find((c) => c.classList.contains("ft-group__head"))!;
}

/** Своё тело группы (не вложенных). */
function bodyOf(group: ShimElement): ShimElement {
  return group.children.find((c) => c.classList.contains("ft-group__body"))!;
}

/** Свои кнопки «+ условие»/«+ группа» группы (не вложенных). */
function ownActions(group: ShimElement): ShimElement {
  const body = bodyOf(group);
  return body.children.find((c) => c.classList.contains("ft-group__actions"))!;
}

/** Кнопка-потомок с точным текстом; класс — точный для `ft-*`, иначе подстрокой. */
function buttonByText(root: ShimElement, cls: string, text: string): ShimElement | null {
  const nodes = cls.startsWith('ft-')
    ? root.findAll((node) => node.classList.contains(cls))
    : root.findAll(cls);
  return nodes.find((node) => node.flatText().trim() === text) ?? null;
}

/** Пункт списка коннекции из открытой панели (в `document.body`). */
function pickConnectorOption(label: string): ShimElement | null {
  const body = (globalThis as any).document.body as ShimElement;
  const menu = body.findAll((node: ShimElement) => node.classList.contains('ft-choice'))[0];
  if (menu === undefined) return null;
  return (
    menu
      .findAll((node: ShimElement) => node.classList.contains('ft-choice__item'))
      .find((node) => node.flatText().trim() === label) ?? null
  );
}

/** Дерево из `levels` вложенных групп с условием в глубине. */
function nestedTree(builder: any, levels: number): any {
  let node: any = builder.defaultFilterTreeLeaf({ kind: 'property', property_id: CITY.id });
  for (let i = 0; i < levels; i += 1) node = { kind: 'group', op: 'and', children: [node] };
  return node;
}

// ---------------------------------------------------------------------------
// Данные сети для тестов (свойства + тип связи с обратной стороной)
// ---------------------------------------------------------------------------

const CITY = {
  id: 'p-city',
  name: 'Город',
  value_type: 'text',
  config: { options: ['Москва'], multiple: false },
  description: null,
  created_at: '',
  updated_at: '',
} as unknown as NetworkProperty;

const PLACE = {
  id: 'p-place',
  name: 'Место покупки',
  value_type: 'link',
  config: { link_type_id: 'lt-1', multiple: true },
  description: null,
  created_at: '',
  updated_at: '',
} as unknown as NetworkProperty;

const DATE = {
  id: 'p-date',
  name: 'Дата',
  value_type: 'date',
  config: null,
  description: null,
  created_at: '',
  updated_at: '',
} as unknown as NetworkProperty;

const LINK_TYPE = {
  id: 'lt-1',
  name_forward: 'Место покупки',
  name_reverse: 'Покупки здесь',
} as unknown as LinkType;

const REGISTRY: ReadonlyMap<string, NetworkProperty> = new Map([
  [CITY.id, CITY],
  [PLACE.id, PLACE],
  [DATE.id, DATE],
]);

const DATA = { registry: REGISTRY, linkTypes: [LINK_TYPE] };

/** Лист дерева из единой модели конструктора (импорт — в тесте). */
let leafOf: (entity: Record<string, unknown>) => any = () => null;

// ---------------------------------------------------------------------------

describe('дерево условий: группы, тона, связаторы (элемент fc65b647)', () => {
  before(async () => {
    installShim();
    const builder = await import('../src/renderer/lib/filter-builder.js');
    leafOf = (entity) => builder.defaultFilterTreeLeaf(entity as any);
  });

  it('тона: цикл из четырёх, соседние уровни различаются, значения — токены тем', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    assert.equal(mod.FILTER_TREE_TONE_COUNT, 4, 'минимум требования 5ef1bce1');
    const classes = [0, 1, 2, 3, 4, 5].map((d) => mod.filterTreeToneClass(d));
    assert.deepEqual(classes.slice(0, 4), ['ft-tone-1', 'ft-tone-2', 'ft-tone-3', 'ft-tone-4']);
    assert.equal(classes[4], 'ft-tone-1', 'пятый уровень — снова первый тон');
    for (let d = 1; d < classes.length; d += 1) {
      assert.notEqual(classes[d], classes[d - 1], `уровень ${d} не повторяет тон предыдущего`);
    }

    // Тона объявлены токенами обеих тем, в модуле и его CSS нет hex.
    const tokens = fs.readFileSync(path.join(RENDERER, 'styles', 'tokens.css'), 'utf8');
    for (let n = 1; n <= 4; n += 1) {
      const declarations = tokens.match(new RegExp(`--ft-tone-${n}:`, 'g')) ?? [];
      assert.equal(declarations.length, 2, `тон ${n} объявлен в обеих темах`);
    }
    for (const file of ['lib/filter-tree.ts', 'styles/filter-tree.css']) {
      const source = fs.readFileSync(path.join(RENDERER, file), 'utf8');
      assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, `нет hex в ${file}`);
    }
  });

  it('CSS тонов: все четыре правила .ft-tone-N красят фон своим токеном', async () => {
    const css = fs.readFileSync(path.join(RENDERER, 'styles', 'filter-tree.css'), 'utf8');
    for (let n = 1; n <= 4; n += 1) {
      const rule = new RegExp(`\\.ft-tone-${n}\\s*\\{[^}]*background:\\s*var\\(--ft-tone-${n}\\)`, 's');
      assert.match(css, rule, `правило .ft-tone-${n} красит фон токеном --ft-tone-${n}`);
    }
  });

  it('корневая группа не удаляется, НЕ на корне не предлагается, вложенная — с крестиком и НЕ', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const { defaultFilterCriteriaState } = await import('../src/renderer/lib/filter-builder.js');

    const state = defaultFilterCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [{ kind: 'group', op: 'and', children: [] }],
    };
    const tree = mod.buildFilterTree({ profile: 'thoughts', getState: () => state, data: DATA });
    const root = tree.root as unknown as ShimElement;

    const groups = exact(root, 'ft-group');
    assert.equal(groups.length, 2, 'корень + вложенная группа');
    const [rootGroup, nested] = groups;
    assert.equal(exact(headOf(rootGroup!), 'ft-group__remove').length, 0, 'корень не удаляется');
    assert.equal(exact(headOf(rootGroup!), 'ft-group__not').length, 0, 'НЕ на корне не предлагается');
    assert.equal(exact(headOf(nested!), 'ft-group__remove').length, 1, 'вложенная группа удаляется крестиком');
    assert.equal(exact(headOf(nested!), 'ft-group__not').length, 1, 'у вложенной группы есть НЕ');
    assert.equal(rootGroup!.dataset['path'], '', 'корень адресуется пустым путём');
    assert.equal(nested!.dataset['path'], '0');
    assert.match(rootGroup!.className, /ft-tone-1/);
    assert.match(nested!.className, /ft-tone-2/, 'вложенность тонируется по глубине');
  });

  it('пустая группа помечена, а связаторы-индикаторы стоят ПЕРЕД каждым условием', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const { defaultFilterCriteriaState } = await import('../src/renderer/lib/filter-builder.js');

    const state = defaultFilterCriteriaState();
    state.tree = { kind: 'group', op: 'or', children: [] };
    const tree = mod.buildFilterTree({ profile: 'thoughts', getState: () => state, data: DATA });
    let root = tree.root as unknown as ShimElement;
    assert.match(exactOne(root, 'ft-group__empty')!.flatText(), /группа пуста/);
    assert.equal(exact(root, 'ft-connector').length, 0, 'в пустой группе связаторов нет');

    // Две строки → ДВА связатора (перед каждой строкой), текст — коннектор группы.
    state.tree.children = [
      leafOf({ kind: 'property', property_id: CITY.id }),
      leafOf({ kind: 'property', property_id: DATE.id }),
    ];
    tree.rerender();
    root = tree.root as unknown as ShimElement;
    const connectors = exact(root, 'ft-connector');
    assert.equal(connectors.length, 2, 'связатор-индикатор перед КАЖДЫМ условием');
    assert.equal(connectors[0]!.flatText(), 'ИЛИ', 'индикатор показывает коннектор группы');
    assert.equal(connectors[0]!.getAttribute('aria-hidden'), 'true', 'связатор — индикатор');
    assert.equal(exact(root, 'ft-row').length, 2);
  });

  it('коннекцию меняет селектор группы, а не связатор', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const { defaultFilterCriteriaState, buildFilterAst } = await import(
      '../src/renderer/lib/filter-builder.js'
    );

    const state = defaultFilterCriteriaState();
    const inner = {
      kind: 'group',
      op: 'and',
      children: [leafOf({ kind: 'property', property_id: CITY.id })],
    };
    state.tree = { kind: 'group', op: 'and', children: [inner] } as any;
    const tree = mod.buildFilterTree({ profile: 'thoughts', getState: () => state, data: DATA });
    let root = tree.root as unknown as ShimElement;

    const nested = exact(root, 'ft-group')[1]!;
    assert.equal(exactOne(nested, 'ft-group__connector-label')!.flatText(), 'все условия (И)');
    exactOne(nested, 'ft-group__connector')!.emit('click', {});
    pickConnectorOption('любое из условий (ИЛИ)')!.emit('click', {});

    assert.equal(((state.tree as any).children[0] as any).op, 'or', 'коннекция изменена в МОДЕЛИ');
    root = tree.root as unknown as ShimElement;
    assert.equal(
      exactOne(exact(root, 'ft-group')[1]!, 'ft-group__connector-label')!.flatText(),
      'любое из условий (ИЛИ)',
    );
    assert.equal(
      (buildFilterAst(state).filter as any).children[0].op,
      'or',
      'AST (единый конвертер) видит правку',
    );
  });

  it('коннекцию КОРНЕВОЙ группы меняет селектор — state.tree.op меняется на месте', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const { defaultFilterCriteriaState } = await import('../src/renderer/lib/filter-builder.js');

    // Новый отбор: корень — единственная группа (поле дерева пусто).
    const state = defaultFilterCriteriaState();
    state.tree = null;
    const tree = mod.buildFilterTree({ profile: 'thoughts', getState: () => state, data: DATA });
    let root = tree.root as unknown as ShimElement;

    const rootGroup = exact(root, 'ft-group')[0]!;
    exactOne(rootGroup, 'ft-group__connector')!.emit('click', {});
    pickConnectorOption('любое из условий (ИЛИ)')!.emit('click', {});
    assert.equal((state.tree as any).op, 'or', 'выбор ИЛИ у корня меняет КОРНЕВУЮ группу модели');
    root = tree.root as unknown as ShimElement;
    assert.equal(
      exactOne(exact(root, 'ft-group')[0]!, 'ft-group__connector-label')!.flatText(),
      'любое из условий (ИЛИ)',
    );

    exactOne(exact(root, 'ft-group')[0]!, 'ft-group__connector')!.emit('click', {});
    pickConnectorOption('все условия (И)')!.emit('click', {});
    assert.equal((state.tree as any).op, 'and', 'обратная смена И у корня тоже меняет модель');
  });

  it('НЕ оборачивает группу, сохраняет коннектор и снимается повторно', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const { defaultFilterCriteriaState } = await import('../src/renderer/lib/filter-builder.js');

    const state = defaultFilterCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        {
          kind: 'group',
          op: 'or',
          children: [leafOf({ kind: 'property', property_id: CITY.id })],
        },
      ],
    };
    const tree = mod.buildFilterTree({ profile: 'thoughts', getState: () => state, data: DATA });
    let root = tree.root as unknown as ShimElement;

    exactOne(headOf(exact(root, 'ft-group')[1]!), 'ft-group__not')!.emit('click');

    const wrapped: any = state.tree.children[0];
    assert.equal(wrapped.op, 'not', 'отрицание — узел `not` модели');
    assert.equal(wrapped.children[0].op, 'or', 'коннектор сохранён внутри обёртки');

    root = tree.root as unknown as ShimElement;
    const nested = exact(root, 'ft-group')[1]!;
    assert.equal(nested.dataset['negated'], '1', 'вид помечает отрицание');
    assert.match(nested.className, /ft-tone-2/, 'обёртка не добавляет уровень тона');
    assert.equal(
      exactOne(nested, 'ft-group__connector-label')!.flatText(),
      'любое из условий (ИЛИ)',
      'селектор коннекции остался у видимой группы',
    );

    exactOne(headOf(nested), 'ft-group__not')!.emit('click');
    assert.equal((state.tree.children[0] as any).op, 'or', 'повторное нажатие снимает отрицание');
  });

  it('сворачивание скрывает тело группы, крестики и кнопки правят модель', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const { defaultFilterCriteriaState } = await import('../src/renderer/lib/filter-builder.js');

    const state = defaultFilterCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        {
          kind: 'group',
          op: 'and',
          children: [leafOf({ kind: 'property', property_id: CITY.id })],
        },
      ],
    };
    const tree = mod.buildFilterTree({ profile: 'thoughts', getState: () => state, data: DATA });
    let root = tree.root as unknown as ShimElement;
    assert.equal(exact(root, 'ft-row').length, 1, 'условие вложенной группы видно');

    exactOne(exact(root, 'ft-group')[1]!, 'ft-group__caret')!.emit('click');
    root = tree.root as unknown as ShimElement;
    const collapsed = exact(root, 'ft-group')[1]!;
    assert.equal(collapsed.dataset['collapsed'], '1');
    assert.equal(exact(collapsed, 'ft-row').length, 0, 'тело свёрнутой группы скрыто');
    assert.equal(exactOne(collapsed, 'ft-group__caret')!.getAttribute('aria-expanded'), 'false');

    exactOne(collapsed, 'ft-group__caret')!.emit('click');
    root = tree.root as unknown as ShimElement;
    assert.equal(exact(root, 'ft-row').length, 1, 'разворот возвращает тело');

    // «+ условие» пишет лист в модель, «+ группа» — вложенную группу.
    exactOne(ownActions(exact(root, 'ft-group')[0]!), 'ft-add-condition')!.emit('click');
    assert.equal(state.tree.children.length, 2, 'условие дописано в корень');
    assert.equal(state.tree.children[1]!.kind, 'leaf');

    root = tree.root as unknown as ShimElement;
    const innerGroup = exact(root, 'ft-group')[1]!;
    const before = (state.tree.children[0] as any).children.length;
    exactOne(ownActions(innerGroup), 'ft-add-group')!.emit('click');
    assert.equal(
      (state.tree.children[0] as any).children.length,
      before + 1,
      'группа дописана в первую группу',
    );

    root = tree.root as unknown as ShimElement;
    const deepest = exact(root, 'ft-group').at(-1)!;
    exactOne(headOf(deepest), 'ft-group__remove')!.emit('click');
    assert.equal(
      (state.tree.children[0] as any).children.filter((c: any) => c.kind === 'group').length,
      0,
      'крестик удаляет группу из модели',
    );

    root = tree.root as unknown as ShimElement;
    exactOne(root, 'ft-row__remove')!.emit('click');
    assert.equal(
      (state.tree.children[0] as any).children.filter((c: any) => c.kind === 'leaf').length,
      0,
      'крестик строки удаляет условие из модели',
    );
  });

  it('вложенность 4+ тонируется циклом, а глубина не ограничена', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const builder = await import('../src/renderer/lib/filter-builder.js');

    const state = builder.defaultFilterCriteriaState();
    state.tree = nestedTree(builder, 5);
    const tree = mod.buildFilterTree({ profile: 'thoughts', getState: () => state, data: DATA });
    const root = tree.root as unknown as ShimElement;
    const groups = exact(root, 'ft-group');
    assert.equal(groups.length, 5, 'пять уровней групп (вложенность 4+ требования 5ef1bce1)');
    const tones = groups.map((g) => g.className.match(/ft-tone-(\d)/)?.[1]);
    assert.deepEqual(tones, ['1', '2', '3', '4', '1'], 'цикл палитры по глубине');
  });

  it('ячейка оператора скрыта у «Найти слова» и наличия коллекций/свойств (требование заказчика)', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const { defaultFilterCriteriaState } = await import('../src/renderer/lib/filter-builder.js');

    // Правило «оператор скрыт» защищено явно: мутация набора обязана краснить тест.
    for (const kind of ['keywords', 'attachments', 'chronology', 'comment', 'properties'] as const) {
      assert.ok(
        mod.FILTER_TREE_OPERATOR_HIDDEN_KINDS.has(kind),
        `«${kind}» в наборе скрытых ячеек оператора`,
      );
    }
    assert.ok(
      !mod.FILTER_TREE_OPERATOR_HIDDEN_KINDS.has('property'),
      'свойство ячейку оператора НЕ скрывает',
    );

    const hiddenKinds = ['keywords', 'attachments', 'chronology', 'comment', 'properties'] as const;
    const state = defaultFilterCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        ...hiddenKinds.map((kind) => ({ kind: 'leaf', entity: { kind }, operator: 'eq', value: { kind: 'none' } })),
        leafOf({ kind: 'property', property_id: CITY.id }),
      ],
    };
    const tree = mod.buildFilterTree({ profile: 'thoughts', getState: () => state, data: DATA });
    const root = tree.root as unknown as ShimElement;
    const rows = exact(root, 'ft-row');
    assert.equal(rows.length, hiddenKinds.length + 1);
    for (let i = 0; i < hiddenKinds.length; i += 1) {
      assert.equal(
        exactOne(rows[i]!, 'ft-row__op'),
        null,
        `у «${hiddenKinds[i]}» ячейки оператора нет`,
      );
    }
    assert.ok(exactOne(rows[hiddenKinds.length]!, 'ft-row__op') !== null, 'у свойства ячейка оператора есть');
  });

  it('заголовок — «Показать <сущность> по условиям:», слот значения — заглушка или виджет хоста', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const { defaultFilterCriteriaState } = await import('../src/renderer/lib/filter-builder.js');

    assert.equal(mod.filterTreeTitle('thoughts'), 'Показать мысли по условиям:');
    assert.equal(mod.filterTreeTitle('chronicle'), 'Показать записи дневника по условиям:');

    const state = defaultFilterCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        leafOf({ kind: 'property', property_id: CITY.id }),
        {
          kind: 'leaf',
          entity: { kind: 'property', property_id: CITY.id },
          operator: 'is_empty',
          value: { kind: 'none' },
        },
      ],
    };
    const tree = mod.buildFilterTree({ profile: 'thoughts', getState: () => state, data: DATA });
    let root = tree.root as unknown as ShimElement;
    assert.equal(exactOne(root, 'ft-title')!.flatText(), 'Показать мысли по условиям:');
    const values = exact(root, 'ft-value');
    assert.equal(values.length, 2, 'слот значения у каждой строки');
    assert.equal(values[0]!.flatText(), 'задайте значение', 'оператору нужно значение');
    assert.equal(
      values[1]!.flatText(),
      '',
      'у «не заполнено» поле правого операнда не рисуется (п.9)',
    );

    // Виджет значения следующей задачи подменяет заглушку через `renderValue`.
    state.tree.children = [
      {
        kind: 'leaf',
        entity: { kind: 'property', property_id: DATE.id },
        operator: 'gt',
        value: { kind: 'none' },
      },
    ];
    const host = new ShimElement('div', 'host-value');
    const withWidget = mod.buildFilterTree({
      profile: 'thoughts',
      getState: () => state,
      data: DATA,
      renderValue: () => host as unknown as HTMLElement,
    });
    root = withWidget.root as unknown as ShimElement;
    assert.equal(exact(root, 'ft-value').length, 0, 'заглушки нет, когда хост дал виджет');
    assert.equal(exact(root, 'host-value').length, 1, 'виджет хоста отрисован в строке');
  });

  it('переключатель режимов «в иерархии» не рисуется у ТИПОВ мысли/связи (п.3)', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const builder = await import('../src/renderer/lib/filter-builder.js');

    // Ячейка значения отдаёт «переключатель режимов» (как filter-value.ts).
    // У типов каркас строки обязан снять его и не выставлять режим в модели.
    const withMode = (): HTMLElement => {
      const box = new ShimElement('div', 'fv');
      box.append(new ShimElement('div', 'fv-mode'));
      return box as unknown as HTMLElement;
    };
    const build = (entity: unknown, operator: string): { root: ShimElement; leaf: any } => {
      const state = builder.defaultFilterCriteriaState();
      const leaf: any = builder.defaultFilterTreeLeaf(entity as never);
      leaf.operator = operator;
      leaf.value = { kind: 'none' };
      const group = builder.defaultFilterTreeGroup('and');
      group.children = [leaf];
      state.tree = group;
      const tree = mod.buildFilterTree({
        profile: 'thoughts',
        getState: () => state,
        data: DATA,
        renderValue: withMode,
      });
      return { root: tree.root as unknown as ShimElement, leaf };
    };

    // Тип мысли и тип связи: у них единственный (структурный) режим.
    for (const kind of ['type', 'link_type'] as const) {
      const { root, leaf } = build({ kind }, 'in_hierarchy');
      const value = exactOne(root, 'ft-row__value');
      assert.equal(
        exact(value!, 'fv-mode').length,
        0,
        `у ${kind} переключатель режимов «в иерархии» не рисуется (п.3)`,
      );
      assert.equal(leaf.mode, undefined, `у ${kind} режим в модели не выставлен (п.3)`);
    }

    // «Родители»/свойства-связи сохраняют оба режима — переключатель остаётся.
    const parents = build({ kind: 'parents' }, 'in_hierarchy');
    assert.equal(
      exact(parents.root, 'fv-mode').length,
      1,
      'у «Родителей» переключатель режимов остаётся',
    );

    // Тип с НЕиерархическим оператором каркас не трогает.
    const typeEq = build({ kind: 'type' }, 'in');
    assert.equal(exact(typeEq.root, 'fv-mode').length, 1, 'тип без «в иерархии» ячейку не меняет');
  });

  it('хук класса переключателя режимов синхронен с filter-value (п.3)', () => {
    // Каркас строки снимает переключатель по строковому классу-хуку; при
    // переименовании `FILTER_VALUE_MODE_CLASS` правило п.3 сломалось бы молча.
    const treeSrc = fs.readFileSync(path.join(RENDERER, 'lib', 'filter-tree.ts'), 'utf8');
    const valueSrc = fs.readFileSync(path.join(RENDERER, 'lib', 'filter-value.ts'), 'utf8');
    const hook = /const FILTER_VALUE_MODE_HOOK = '([^']+)'/.exec(treeSrc)?.[1];
    const cls = /FILTER_VALUE_MODE_CLASS\s*=\s*'([^']+)'/.exec(valueSrc)?.[1];
    assert.ok(hook !== undefined, 'хук FILTER_VALUE_MODE_HOOK объявлен в filter-tree.ts');
    assert.equal(hook, cls, 'хук совпадает с FILTER_VALUE_MODE_CLASS (filter-value.ts)');
  });
});

describe('дерево условий: сгруппированные списки операторов (502f1922)', () => {
  before(() => {
    installShim();
  });

  it('секции «способ × утверждение/отрицание» и состав — от реестра профиля', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const { filterProfileOperators } = await import('../src/renderer/lib/filter-builder.js');

    const link = mod.filterTreeOperatorMenu('thoughts', 'property', 'link');
    const titles = link.map((s: any) => s.title);
    // Группы «Значение/Несколько/Иерархия» сведены в «Сравнение» (п.7а).
    // Секции «Выборка» нет (требование заказчика 2026-10-14, ошибка 696b3c3b
    // п.7): набор задаёт переключатель «список ↔ выборка», а не операторы.
    assert.deepEqual(titles, ['Сравнение', 'Состояние']);
    const byKey = new Map(link.map((s: any) => [s.key, s]));
    assert.deepEqual(
      (byKey.get('compare') as any).rows[0].cells.map((c: any) => [c.op, c.side, c.label]),
      [
        ['eq', 'yes', '='],
        ['ne', 'no', '≠'],
      ],
      'двухколоночная пара «утверждение | отрицание»; подписи краткие (п.10)',
    );
    // «в списке»/«в иерархии» — в объединённой группе «Сравнение» (п.7а).
    const compareOps = (byKey.get('compare') as any).rows.flatMap((r: any) =>
      r.cells.map((c: any) => c.op),
    );
    for (const op of ['in', 'not_in', 'in_hierarchy', 'not_in_hierarchy']) {
      assert.ok(compareOps.includes(op), `${op} — в группе «Сравнение»`);
    }
    // Операторы группы «Выборка» в списке UI отсутствуют (п.7).
    assert.equal(byKey.has('sets'), false, 'секции «Выборка» в списке операторов нет');
    for (const op of ['any_of', 'all_of', 'none_of']) {
      assert.ok(
        !compareOps.includes(op),
        `под-выборочный оператор ${op} из UI убран (переключатель «список ↔ выборка» заменяет)`,
      );
    }
    assert.deepEqual(
      (byKey.get('state') as any).rows[0].cells.map((c: any) => c.op),
      ['not_empty', 'is_empty'],
    );
    // Тултип каждой ячейки — краткое описание назначения оператора (п.7в).
    for (const section of link) {
      for (const row of section.rows) {
        for (const cell of row.cells) {
          assert.ok(
            typeof cell.description === 'string' && cell.description.trim() !== '',
            `у оператора ${cell.op} есть описание назначения`,
          );
        }
      }
    }

    // Паритет с реестром: редактор не предлагает ничего сверх допустимого набора.
    const allowed = new Set(filterProfileOperators('thoughts', 'property', 'link'));
    for (const section of link) {
      for (const row of section.rows) {
        for (const cell of row.cells) assert.ok(allowed.has(cell.op), `${cell.op} допустим профилем`);
      }
    }

    // Датовый операнд: секция «Сравнение», пары «больше|меньше»,
    // «больше или равно|меньше или равно», «между|не между» (п.8).
    const date = mod.filterTreeOperatorMenu('thoughts', 'created_at', 'date');
    assert.equal(date[0]!.title, 'Сравнение');
    assert.deepEqual(
      (date[0] as any).rows.map((r: any) => r.cells.map((c: any) => c.op)),
      [
        ['gt', 'lt'],
        ['gte', 'lte'],
        ['between', 'not_between'],
      ],
      'датовые пары читаются «мин|макс» (п.8)',
    );
    const dateOps = date.flatMap((s: any) => s.rows.flatMap((r: any) => r.cells.map((c: any) => c.op)));
    for (const op of ['gt', 'lte', 'gte', 'lt', 'between', 'not_between']) {
      assert.ok(dateOps.includes(op), `${op} предложен для датового операнда`);
    }
    assert.ok(!dateOps.includes('contains'), 'подстрока датовому операнду не предлагается');
    assert.ok(!dateOps.includes('eq'), 'равенство датовому операнду не предлагается (набор ядра)');

    // Свойство-дата — набор из реестра по природе свойства.
    const propDate = mod.filterTreeOperatorMenu('thoughts', 'property', 'date');
    assert.equal(propDate[0]!.title, 'Сравнение');
    assert.deepEqual(
      (propDate[0] as any).rows[0].cells.map((c: any) => c.op),
      ['eq', 'ne'],
      'у свойства-даты равенство есть (набор PROPERTY_OPERATOR_SETS)',
    );

    // «Есть слова» — своя секция и единственный оператор (операнд `keywords`).
    const words = mod.filterTreeOperatorMenu('thoughts', 'keywords');
    assert.deepEqual(words.map((s: any) => s.title), ['Слова']);
    assert.deepEqual(words[0]!.rows[0]!.cells.map((c: any) => c.op), ['matches']);

    // Операнд «Тип» — «в иерархии» и «имеет свойство» в своих секциях.
    const type = mod.filterTreeOperatorMenu('thoughts', 'type');
    const typeOps = type.flatMap((s: any) => s.rows.flatMap((r: any) => r.cells.map((c: any) => c.op)));
    assert.ok(typeOps.includes('in_hierarchy') && typeOps.includes('has'));
    assert.ok(!typeOps.includes('all_of'), '«все в выборке» в списке UI отсутствует (п.7)');

    // Профиль хроники — свои операнды и свой набор. У текстовых операндов
    // записи «Есть слова» из списка убран (ошибка 609deba0 п.5): условие строит
    // живая строка поиска, пользователю достаточно «содержит»/«не содержит».
    const record = mod.filterTreeOperatorMenu('chronicle', 'record_title');
    assert.deepEqual(record.map((s: any) => s.title), ['Сравнение']);
    assert.deepEqual(record[0]!.rows[0]!.cells.map((c: any) => c.op), ['eq', 'ne']);
    const recordTitleOps = record.flatMap((s: any) => s.rows.flatMap((r: any) => r.cells.map((c: any) => c.op)));
    assert.ok(
      recordTitleOps.includes('contains') && recordTitleOps.includes('not_contains'),
      'строка ищется «содержит»/«не содержит»',
    );
    assert.ok(!recordTitleOps.includes('matches'), '«Есть слова» в списке операторов заголовка нет (п.5)');
    // «Текст записи» — те же операторы, что у заголовка (п.5), без «Есть слова».
    const recordBody = mod.filterTreeOperatorMenu('chronicle', 'record_body');
    const recordBodyOps = recordBody.flatMap((s: any) => s.rows.flatMap((r: any) => r.cells.map((c: any) => c.op)));
    for (const op of ['eq', 'ne', 'contains', 'not_contains']) {
      assert.ok(recordBodyOps.includes(op), `текст записи: ${op}`);
    }
    assert.ok(!recordBodyOps.includes('matches'), '«Есть слова» в списке операторов текста нет (п.5)');
    // «Цели записи» — список/выборка и «в иерархии» (ошибка 609deba0 п.1).
    const targets = mod.filterTreeOperatorMenu('chronicle', 'targets');
    const targetsOps = targets.flatMap((s: any) => s.rows.flatMap((r: any) => r.cells.map((c: any) => c.op)));
    for (const op of ['in', 'not_in', 'in_hierarchy', 'not_in_hierarchy']) {
      assert.ok(targetsOps.includes(op), `цели записи: ${op}`);
    }
  });

  it('природа для меню операторов: датовый ОПЕРАНД — «date» (п.8)', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const built = await import('../src/renderer/lib/filter-builder.js');
    const dateLeaf = built.defaultFilterTreeLeaf({ kind: 'created_at' } as never);
    assert.equal(
      mod.filterTreeOperatorValueType(dateLeaf, DATA),
      'date',
      'дата создания — датовая природа, пары границ «мин|макс»',
    );
    const propDate = built.defaultFilterTreeLeaf({ kind: 'property', property_id: DATE.id } as never);
    assert.equal(mod.filterTreeOperatorValueType(propDate, DATA), 'date', 'свойство-дата — из реестра');
    const city = built.defaultFilterTreeLeaf({ kind: 'property', property_id: CITY.id } as never);
    assert.equal(mod.filterTreeOperatorValueType(city, DATA), 'text');
    const parents = built.defaultFilterTreeLeaf({ kind: 'parents' } as never);
    assert.equal(mod.filterTreeOperatorValueType(parents, DATA), undefined, 'не датовый операнд — природы нет');
  });

  it('тело выпадающего списка: сетка двух колонок, подсветка текущего, выбор', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const sections = mod.filterTreeOperatorMenu('thoughts', 'property', 'text');
    const picked: string[] = [];
    const body = mod.buildChoiceMenuBody({
      title: 'Оператор',
      grid: true,
      activeKey: 'eq',
      groups: sections.map((s: any) => ({
        label: s.title,
        items: s.rows.flatMap((r: any) =>
          r.cells.map((c: any) => ({ key: c.op, label: c.label, side: c.side })),
        ),
      })),
      onPick: (key: string) => picked.push(key),
    });
    const root = body.root as unknown as ShimElement;
    assert.match(root.className, /ft-choice--grid/, 'список операторов — сетка двух колонок');
    assert.ok(exact(root, 'ft-choice__group').length >= 2, 'секции показаны');
    const items = exact(root, 'ft-choice__item');
    assert.ok(
      items.some((i) => i.dataset['key'] === 'ne' && i.dataset['side'] === 'no'),
      'отрицание помечено колонкой',
    );
    buttonByText(root, 'ft-choice__item', 'не в')!.emit('click');
    assert.deepEqual(picked, ['not_in'], 'выбор строки отдаёт код оператора');
  });
});

describe('дерево условий: список «Что» (элемент fc65b647)', () => {
  before(() => {
    installShim();
  });

  it('все свойства сети, обратные стороны, контекстные первыми, поиск', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');

    const entries = mod.filterTreeOperandCatalogue('thoughts', DATA);
    const byKey = new Map(entries.map((e: any) => [e.key, e]));
    assert.ok(byKey.has('type') && byKey.has('keywords'), 'характеристики мыслей в списке');
    assert.ok(byKey.has('property:p-city') && byKey.has('property:p-date'), 'свойства реестра в списке');
    const reverse: any = byKey.get('property:Покупки здесь');
    assert.ok(reverse, 'обратная сторона свойства-связи в общем списке');
    assert.deepEqual(reverse.entity, { kind: 'property', property: 'Покупки здесь', direction: 'in' });
    assert.match(String(reverse.detail), /обратная сторона/);
    assert.deepEqual((byKey.get('property:p-place') as any).entity, {
      kind: 'property',
      property_id: 'p-place',
    });
    assert.equal(
      (byKey.get('property:p-city') as any).detail,
      'строка',
      'подпись типа значения — из общего словаря',
    );
    assert.equal(
      (byKey.get('property:p-date') as any).valueType,
      'date',
      'природа свойства — для списка операторов',
    );

    // Значки (требование заказчика 2026-10-14: п.1 — Родители/Потомки, п.3 —
    // стороны свойства-связи как в списке «Свойства мыслей»).
    assert.equal((byKey.get('parents') as any).icon, 'arrow-down', 'Родителям — стрелка вниз (п.1)');
    assert.equal((byKey.get('children') as any).icon, 'arrow-up', 'Потомкам — стрелка вверх (п.1)');
    assert.equal(
      (byKey.get('property:p-place') as any).icon,
      'arrow-down',
      'свойство в источнике — стрелка вниз (п.3)',
    );
    assert.equal(
      (byKey.get('property:Покупки здесь') as any).icon,
      'arrow-up',
      'свойство в назначении — стрелка вверх (п.3)',
    );
    assert.equal((byKey.get('property:p-city') as any).icon, 'value-text', 'скаляр — значок вида значения');

    // Контекстные — первыми (профиль-параметр). «Мысль» (id) — всегда в верхней
    // группе без заголовка (решение заказчика 2026-10-14, задача a577875b).
    const withContext = mod.filterTreeOperandCatalogue('thoughts', {
      ...DATA,
      contextual: ['property:p-place', 'type'],
    });
    assert.equal((byKey.get('id') as any).label, 'Мысль', 'операнд id подписан «Мысль»');
    assert.equal((byKey.get('id') as any).group, 'context', '«Мысль» — в верхней группе без заголовка');
    assert.deepEqual(
      withContext.filter((e: any) => e.group === 'context').map((e: any) => e.key),
      ['id', 'type', 'property:p-place'],
    );

    const body = mod.buildChoiceMenuBody({
      title: 'Что',
      search: true,
      activeKey: 'property:p-city',
      groups: [
        {
          label: mod.FILTER_TREE_OPERAND_GROUPS.context,
          items: withContext
            .filter((e: any) => e.group === 'context')
            .map((e: any) => ({ key: e.key, label: e.label })),
        },
        {
          label: mod.FILTER_TREE_OPERAND_GROUPS.properties,
          items: withContext
            .filter((e: any) => e.group === 'properties')
            .map((e: any) => ({ key: e.key, label: e.label })),
        },
      ],
      onPick: () => undefined,
    });
    const menu = body.root as unknown as ShimElement;
    assert.ok(menu.querySelector('.ft-choice__search'), 'у списка «Что» есть поиск');
    assert.equal(
      exact(menu, 'ft-choice__group').some((g) => g.flatText() === 'В этом месте'),
      false,
      'заголовок «В этом месте» убран — первая группа без заголовка',
    );

    // Поиск фильтрует строки.
    body.setQuery('город');
    const visible = exact(menu, 'ft-choice__item');
    assert.equal(visible.length, 1, 'поиск оставил одно свойство');
    assert.equal(visible[0]!.dataset['key'], 'property:p-city');
    body.setQuery('нет такого');
    assert.equal(exact(menu, 'ft-choice__empty').length, 1, 'пустой результат поиска объяснён');

    // Чистый поиск по каталогу — та же логика без DOM.
    assert.deepEqual(
      mod.filterTreeFilterOperands(entries, 'покуп').map((e: any) => e.key),
      ['property:p-place', 'property:Покупки здесь'],
    );
    assert.equal(mod.filterTreeFilterOperands(entries, '').length, entries.length);
  });

  it('профиль — параметр: чужие операнды в список не попадают', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const chronicle = mod.filterTreeOperandCatalogue('chronicle', DATA);
    const keys = chronicle.map((e: any) => e.key);
    assert.ok(keys.includes('record_title') && keys.includes('record_time'), 'операнды записи дневника');
    assert.ok(!keys.includes('type'), 'типов мыслей в профиле хроники нет');
    assert.equal(
      chronicle.filter((e: any) => e.group === 'properties').length,
      0,
      'свойств мысли хроника не предлагает',
    );
  });
});

describe('дерево условий: адресация и правки модели', () => {
  before(() => {
    installShim();
  });

  it('путь узла — индексы детей; корень не удаляется, узел по пути читается/меняется', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const leaf = { kind: 'leaf', entity: { kind: 'keywords' }, operator: 'matches', value: { kind: 'none' } };
    const root = {
      kind: 'group',
      op: 'and',
      children: [{ kind: 'group', op: 'or', children: [{ ...leaf }] }],
    } as any;

    assert.equal(mod.filterTreePathKey([0, 1]), '0.1');
    assert.equal(mod.filterTreeNodeAt(root, [])!.kind, 'group');
    assert.equal((mod.filterTreeNodeAt(root, [0, 0]) as any).operator, 'matches');
    assert.equal(mod.filterTreeNodeAt(root, [5]), null);
    assert.equal(mod.filterTreeRemoveAt(root, []), false, 'корневая группа не удаляется');
    assert.equal(mod.filterTreeRemoveAt(root, [0, 0]), true);
    assert.equal((root.children[0] as any).children.length, 0);
    assert.equal(
      mod.filterTreeAppendChildAt(root, [0], { kind: 'group', op: 'and', children: [] }),
      true,
    );
    assert.equal((root.children[0] as any).children.length, 1);
    assert.equal(
      mod.filterTreeAppendChildAt(root, [0, 0], { kind: 'group', op: 'and', children: [] }),
      true,
      'вложенная группа принимает детей',
    );
    root.children[0].children[0] = { ...leaf };
    assert.equal(
      mod.filterTreeAppendChildAt(root, [0, 0], { kind: 'group', op: 'and', children: [] }),
      false,
      'лист детей не принимает',
    );
  });

  it('вид группы: `not` вокруг группы показывается одной рамкой, обёртка снимается', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const inner = { kind: 'group', op: 'or', children: [] } as any;
    const root = {
      kind: 'group',
      op: 'and',
      children: [{ kind: 'group', op: 'not', children: [inner] }],
    } as any;
    const view = mod.filterTreeGroupView(root, [0])!;
    assert.equal(view.negated, true);
    assert.equal(view.op, 'or');
    assert.deepEqual([...view.modelPath], [0]);
    assert.deepEqual([...view.opPath], [0, 0]);
    assert.equal(mod.filterTreeToggleNotAt(root, [0]), root, 'замена узла идёт по месту в модели');
    assert.equal((root.children[0] as any).op, 'or', 'снятие отрицания вернуло группу с коннектором');
  });
});

describe('дерево условий: подменю «между» — матрица быстрых периодов (69ac9ff8)', () => {
  before(() => {
    installShim();
  });

  it('матрица 3×4: строка [текущий/прошлый/следующий] × столбец [день/неделя/месяц/год]', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const menu = mod.filterTreePeriodMenu();
    assert.equal(menu.title, 'Период');
    assert.equal(menu.groups.length, 1, 'одна секция — матрица');
    const group = menu.groups[0]!;
    assert.equal(group.columns, 4, 'раскладка в четыре колонки (строка матрицы)');
    assert.equal(group.items[0]!.key, 'between:manual');
    assert.equal(group.items[0]!.label, 'Задать вручную…', 'ручной выбор оператора первым пунктом');
    const cells = group.items.slice(1);
    assert.equal(cells.length, 12, 'три строки по четыре гранулярности');
    assert.deepEqual(
      cells.slice(0, 4).map((i) => i.label),
      ['текущий день', 'текущая неделя', 'текущий месяц', 'текущий год'],
      'первая строка матрицы — текущие периоды в порядке столбцов',
    );
    assert.deepEqual(
      cells.slice(4, 8).map((i) => i.label),
      ['прошлый день', 'прошлая неделя', 'прошлый месяц', 'прошлый год'],
    );
    assert.deepEqual(
      cells.slice(8, 12).map((i) => i.label),
      ['следующий день', 'следующая неделя', 'следующий месяц', 'следующий год'],
    );
    assert.deepEqual(
      cells.map((i) => i.key),
      [
        'period:current:day',
        'period:current:week',
        'period:current:month',
        'period:current:year',
        'period:previous:day',
        'period:previous:week',
        'period:previous:month',
        'period:previous:year',
        'period:next:day',
        'period:next:week',
        'period:next:month',
        'period:next:year',
      ],
      'ключи ячеек устойчивы (данные кнопок)',
    );
  });

  it('выбор ячейки пишет ВИДИМЫЕ границы-токены, а не скрытый период', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const dateLeaf = (): any => ({
      kind: 'leaf',
      entity: { kind: 'created_at' },
      operator: 'gte',
      value: { kind: 'none' },
    });

    const month = dateLeaf();
    const applied = mod.filterTreeApplyPeriod(month, 'period:previous:month');
    assert.equal(applied?.from, '$monthStart-1mo', 'границы — КАНОН camelCase (ревизия 91f8d8dd)');
    assert.equal(month.operator, 'between', 'выбор периода — обычное условие «между»');
    assert.deepEqual(
      month.value,
      { kind: 'list', items: [{ token: '$monthStart-1mo' }, { token: '$monthEnd-1mo' }] },
      'границы периода — реальные токены модели',
    );
    assert.equal(
      mod.filterTreePeriodKeyOf(month),
      'period:previous:month',
      'повторное открытие подсвечивает выбранную ячейку',
    );

    const week = dateLeaf();
    mod.filterTreeApplyPeriod(week, 'period:current:week');
    assert.deepEqual(week.value, { kind: 'list', items: [{ token: '$weekStart' }, { token: '$weekEnd' }] });

    const year = dateLeaf();
    mod.filterTreeApplyPeriod(year, 'period:next:year');
    assert.deepEqual(year.value, { kind: 'list', items: [{ token: '$yearStart+1y' }, { token: '$yearEnd+1y' }] });

    // «Задать вручную…» — оператор «между» без подстановки границ.
    const manual = dateLeaf();
    mod.filterTreeApplyPeriod(manual, 'between:manual');
    assert.equal(manual.operator, 'between');
    assert.deepEqual(manual.value, { kind: 'none' }, 'границы остаются на ручную правку');
    assert.equal(mod.filterTreePeriodKeyOf(manual), null);

    // Неизвестный ключ лист не меняет (и произвольные границы — не ячейка матрицы).
    const foreign = dateLeaf();
    assert.equal(mod.filterTreeApplyPeriod(foreign, 'period:no-such'), null);
    assert.equal(foreign.operator, 'gte');
    assert.deepEqual(foreign.value, { kind: 'none' });
    const custom = dateLeaf();
    custom.value = { kind: 'list', items: [{ token: '$today' }, { token: '$today+10d' }] };
    assert.equal(mod.filterTreePeriodKeyOf(custom), null, 'произвольные границы ячейке не соответствуют');
  });

  it('«между» раскрывает подменю только у датового операнда; «не между» — обычный пункт', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const leaf = (kind: string): any => ({ kind: 'leaf', entity: { kind }, operator: 'gte', value: { kind: 'none' } });

    assert.equal(mod.filterTreeIsDateLeaf(leaf('created_at'), undefined), true);
    assert.equal(mod.filterTreeIsDateLeaf(leaf('occurred_at'), undefined), true);
    assert.equal(mod.filterTreeIsDateLeaf(leaf('property'), 'date'), true, 'свойство-дата — тоже датовый операнд');
    assert.equal(mod.filterTreeIsDateLeaf(leaf('keywords'), undefined), false);
    assert.equal(mod.filterTreeIsDateLeaf(leaf('property'), 'text'), false);

    // Датовый лист + «между» → открыто подменю, оператор ещё не сменён.
    const dateLeaf = leaf('created_at');
    const opened: Array<{ title: string; cells: number }> = [];
    const handled = mod.filterTreeOperatorChoice(dateLeaf, 'between', undefined, (menu: any) => {
      opened.push({ title: menu.title, cells: menu.groups[0].items.length });
    });
    assert.equal(handled, true, 'подменю раскрыто');
    assert.deepEqual(opened, [{ title: 'Период', cells: 13 }]);
    assert.equal(dateLeaf.operator, 'gte', 'до выбора ячейки оператор прежний');

    // Недатовый лист + «между» → обычная установка оператора, подменю не открыто.
    const textLeaf = leaf('property');
    let visitorCalls = 0;
    assert.equal(
      mod.filterTreeOperatorChoice(textLeaf, 'between', 'text', () => {
        visitorCalls += 1;
      }),
      false,
    );
    assert.equal(visitorCalls, 0, 'у недатового операнда подменю не раскрывается');
    assert.equal(textLeaf.operator, 'between');

    // «Не между» у датового лиса — обычный пункт (подменю только у «между»).
    const notBetween = leaf('created_at');
    assert.equal(
      mod.filterTreeOperatorChoice(notBetween, 'not_between', undefined, () => {
        visitorCalls += 1;
      }),
      false,
    );
    assert.equal(notBetween.operator, 'not_between');
    assert.equal(visitorCalls, 0);

    // «Между» у датового операнда есть в списке операторов (пункт-триггер на месте).
    const ops = mod
      .filterTreeOperatorMenu('thoughts', 'created_at', 'date')
      .flatMap((s: any) => s.rows.flatMap((r: any) => r.cells.map((c: any) => c.op)));
    assert.ok(ops.includes('between') && ops.includes('not_between'));
  });

  it('тело подменю: раскладка в четыре колонки и выбор ячейки отдаёт её ключ', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const menu = mod.filterTreePeriodMenu();
    const picked: string[] = [];
    const body = mod.buildChoiceMenuBody({
      title: menu.title,
      groups: menu.groups,
      onPick: (key: string) => picked.push(key),
    });
    const root = body.root as unknown as ShimElement;
    const rows = exact(root, 'ft-choice__rows')[0]!;
    assert.equal(rows.dataset['columns'], '4', 'раздел-матрица помечен числом колонок');
    assert.equal(rows.style.getPropertyValue('grid-template-columns'), 'repeat(4, minmax(0, 1fr))');
    const items = exact(root, 'ft-choice__item');
    assert.equal(items.length, 13, 'ручной пункт + двенадцать ячеек');
    buttonByText(root, 'ft-choice__item', 'прошлый месяц')!.emit('click');
    assert.deepEqual(picked, ['period:previous:month'], 'выбор ячейки отдаёт её ключ');
  });
});

describe('дерево условий: диагностика строк (элемент 4e634c9a)', () => {
  before(() => {
    installShim();
  });

  it('красная запись помечает строку, несёт причину; клик по ТЕКСТУ переводит фокус', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const { defaultFilterCriteriaState } = await import('../src/renderer/lib/filter-builder.js');

    const state = defaultFilterCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [leafOf({ kind: 'property', property_id: CITY.id })],
    };
    const fixed: string[] = [];
    const tree = mod.buildFilterTree({
      profile: 'thoughts',
      getState: () => state,
      data: DATA,
      issues: () => [
        {
          severity: 'error',
          source: 'server',
          code: 'entity_deleted',
          path: 'filter.children[0].entity',
          message: 'Свойство «Город» удалено из сети — отбор нельзя применить.',
          label: 'Город',
          deletedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
      onFixPath: (path: string) => fixed.push(path),
    });
    const root = tree.root as unknown as ShimElement;
    const row = exact(root, 'ft-row')[0]!;
    assert.equal(row.dataset['severity'], 'error', 'красная запись помечает строку');
    assert.ok(row.classList.contains('ft-node--error'));
    assert.equal(row.tabIndex, -1, 'строка принимает программный фокус');

    const line = exactOne(row, 'ft-issue')!;
    assert.equal(line.dataset['severity'], 'error');
    assert.equal(line.dataset['path'], 'filter.children[0].entity');
    assert.match(line.flatText(), /удалено 2026-10-01T00:00:00\.000Z/, 'причина с датой удаления');
    // Отдельной кнопки «исправить» нет (п.10): переход — по клику на текст.
    assert.equal(
      line.findAll((n) => n.tagName.toUpperCase() === 'BUTTON').length,
      0,
      'кнопки «исправить» в строке диагностики нет',
    );

    exactOne(line, 'ft-issue__text')!.emit('click', {});
    assert.equal(row.focused, true, 'клик по тексту причины фокусирует строку');
    assert.deepEqual(fixed, ['filter.children[0].entity'], 'хост узнаёт адрес правки');
  });

  it('жёлтая запись красит строку иначе; чужие адреса строк не помечаются', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const { defaultFilterCriteriaState } = await import('../src/renderer/lib/filter-builder.js');

    const state = defaultFilterCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        leafOf({ kind: 'property', property_id: CITY.id }),
        leafOf({ kind: 'property', property_id: DATE.id }),
      ],
    };
    const tree = mod.buildFilterTree({
      profile: 'thoughts',
      getState: () => state,
      data: DATA,
      issues: () => [
        {
          severity: 'warning',
          source: 'server',
          code: 'property_detached',
          path: 'filter.children[1]',
          message: 'свойство отвязано от типа — считается по фактическим значениям',
          label: null,
        },
        {
          severity: 'error',
          source: 'server',
          code: 'build_warning',
          path: '',
          message: 'ошибку нельзя локализовать в строку',
        },
      ],
    });
    const root = tree.root as unknown as ShimElement;
    const rows = exact(root, 'ft-row');
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.dataset['severity'], undefined, 'чужая строка чиста');
    assert.equal(rows[1]!.dataset['severity'], 'warning');
    assert.ok(rows[1]!.classList.contains('ft-node--warning'));
    assert.equal(exact(root, 'ft-issue').length, 1, 'запись без адреса дерево не показывает');
    assert.match(exactOne(rows[1]!, 'ft-issue')!.flatText(), /свойство отвязано у типа|свойство отвязано/);
  });

  it('проверки конструктора показываются строками дерева, а не запретом', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const diag = await import('../src/renderer/lib/filter-diagnostics.js');
    const { defaultFilterCriteriaState } = await import('../src/renderer/lib/filter-builder.js');

    const state = defaultFilterCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        leafOf({ kind: 'property', property_id: CITY.id }),
        { kind: 'group', op: 'and', children: [] },
      ],
    };
    const tree = mod.buildFilterTree({
      profile: 'thoughts',
      getState: () => state,
      data: DATA,
      issues: () => diag.constructorFilterIssues(state.tree as never),
    });
    const root = tree.root as unknown as ShimElement;
    const groups = exact(root, 'ft-group');
    assert.equal(groups[0]!.dataset['severity'], undefined, 'корень чист');
    const nested = groups[1]!;
    assert.equal(nested.dataset['severity'], 'error', 'пустая группа — красное');
    assert.match(exactOne(nested, 'ft-issue')!.flatText(), /группа пуста/);

    // Условие без значения — тоже строка: причина видна сразу.
    state.tree.children = [leafOf({ kind: 'property', property_id: CITY.id })];
    (state.tree.children[0] as any).value = { kind: 'none' };
    tree.rerender();
    const row = exact(root, 'ft-row')[0]!;
    assert.equal(row.dataset['severity'], 'error');
    assert.match(exactOne(row, 'ft-issue')!.flatText(), /условие без значения/);
  });

  it('CSS: краски диагностики строк — токены тревоги и предупреждения', () => {
    const css = fs.readFileSync(path.join(RENDERER, 'styles', 'filter-tree.css'), 'utf8');
    assert.match(css, /\.ft-node--error\s*\{[^}]*var\(--danger\)/s);
    assert.match(css, /\.ft-node--warning\s*\{[^}]*var\(--warn\)/s);
    assert.match(css, /\.ft-row\s*\{[^}]*flex-wrap:\s*wrap/s, 'строка диагностики ложится второй полосой');
    assert.match(css, /\.ft-issue__text--action\s*\{[^}]*cursor:\s*pointer/s);
  });

  it('CSS: layout строки — части по верху, крестик в правом верхнем углу (п.6)', () => {
    const css = fs.readFileSync(path.join(RENDERER, 'styles', 'filter-tree.css'), 'utf8');
    // Все три части прижаты к ВЕРХУ строки, не центрированы.
    assert.match(
      css,
      /\.ft-row\s*\{[^}]*align-items:\s*flex-start/s,
      'части строки выровнены по верхнему краю (п.6)',
    );
    // Строка позиционирована — крестик привязан абсолютно.
    assert.match(css, /\.ft-row\s*\{[^}]*position:\s*relative/s, 'строка — containing block крестика');
    // Значение — блок-колонка (облачка, потом поиск/переключатели).
    assert.match(
      css,
      /\.ft-row__value\s*\{[^}]*flex-direction:\s*column/s,
      'значение — самодостаточная колонка (п.6)',
    );
    // Крестик — ВЕРХНИЙ ПРАВЫЙ УГОЛ, не смещается по высоте при переносе.
    const removeBlock = /\.ft-row__remove\s*\{([^}]*)\}/s.exec(css)?.[1] ?? '';
    assert.match(removeBlock, /position:\s*absolute/, 'крестик строки позиционирован абсолютно');
    assert.match(removeBlock, /top:\s*var\(--space-1\)/, 'крестик прижат к верхнему краю');
    assert.match(removeBlock, /right:\s*var\(--space-1\)/, 'крестик прижат к правому краю');
    assert.doesNotMatch(removeBlock, /align-self/, 'крестик больше не выравнивается потоком');
  });

  it('CSS: переключатели строки компактны — padding вдвое, шрифт 0.84em (п.2)', () => {
    const css = fs.readFileSync(path.join(RENDERER, 'styles', 'filter-tree.css'), 'utf8');
    const rule = /\.ft-row \.ui-segmented \.ui-btn--ghost\s*\{([^}]*)\}/s.exec(css)?.[1] ?? '';
    assert.notEqual(rule, '', 'единое правило компактных переключателей строки найдено');
    assert.match(
      rule,
      /padding:\s*calc\(var\(--control-pad-y\)\s*\/\s*2\)\s*calc\(var\(--space-5\)\s*\/\s*2\)/,
      'padding переключателя уменьшен вдвое (п.2)',
    );
    assert.match(rule, /font-size:\s*0\.84em/, 'шрифт переключателя — 0.84em (п.2)');
  });

  it('CSS: hover-видимость кнопок/крестика и компактный заголовок группы (пп.2,3,4)', () => {
    const css = fs.readFileSync(path.join(RENDERER, 'styles', 'filter-tree.css'), 'utf8');

    // П.2: кнопки «+ условие»/«+ группу» скрыты и показываются по наведению на
    // СВОЮ (глубочайшую) группу — ВИДИМОСТЬ, не удаление из DOM.
    const actions = /\.ft-group__actions\s*\{([^}]*)\}/s.exec(css)?.[1] ?? '';
    assert.match(actions, /opacity:\s*0/, 'кнопки группы скрыты по умолчанию (п.2)');
    assert.doesNotMatch(actions, /display:\s*none/, 'кнопки не удалены из DOM — размеры не прыгают (п.2)');
    assert.match(
      css,
      /\.ft-group:hover:not\(:has\(\.ft-group:hover\)\)\s*>\s*\.ft-group__body\s*>\s*\.ft-group__actions\s*\{[^}]*opacity:\s*1/s,
      'кнопки видны только у глубочайшей наведённой группы (п.2)',
    );

    // П.3: крестик условия виден по наведению на строку ИЛИ фокусу внутри неё.
    const removeBlock = /\.ft-row__remove\s*\{([^}]*)\}/s.exec(css)?.[1] ?? '';
    assert.match(removeBlock, /opacity:\s*0/, 'крестик строки скрыт по умолчанию (п.3)');
    assert.doesNotMatch(removeBlock, /display:\s*none/, 'крестик не удалён из потока (п.3)');
    assert.match(
      css,
      /\.ft-row:hover\s+\.ft-row__remove,\s*\.ft-row:focus-within\s+\.ft-row__remove\s*\{[^}]*opacity:\s*1/s,
      'крестик виден по hover строки и по фокусу внутри (п.3)',
    );

    // П.4: заголовок без своей заливки (фон = фон группы), компактнее по padding-y,
    // шрифт внутри заголовка — полужирный (600).
    const head = /\.ft-group__head\s*\{([^}]*)\}/s.exec(css)?.[1] ?? '';
    assert.match(head, /background:\s*none/, 'фон заголовка = фон группы (п.4)');
    assert.doesNotMatch(head, /background:\s*var\(--surface-2\)/, 'прежняя заливка surface-2 убрана (п.4)');
    assert.match(head, /padding:\s*calc\(var\(--space-1\)\s*\/\s*2\)/, 'вертикальный padding заголовка уменьшен (п.4)');
    assert.match(head, /font-weight:\s*var\(--font-weight-semibold\)/, 'шрифт заголовка толще (п.4)');
    assert.match(
      css,
      /\.ft-group__head\s+\.ft-group__connector[\s\S]{0,220}font-weight:\s*var\(--font-weight-semibold\)/,
      'коннектор/НЕ-чип внутри заголовка — полужирные (п.4)',
    );
  });
});

describe('список: клавиатурная навигация многоколоночного списка (п.4)', () => {
  before(() => {
    installShim();
  });

  it('↓/↑ — внутри столбца, ←/→ — между столбцами, Home/End, PgUp/PgDn — выделением', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const body = mod.buildChoiceMenuBody({
      title: 'Что',
      groups: [
        {
          label: '',
          columns: 2,
          items: Array.from({ length: 6 }, (_v, i) => ({ key: `k${i}`, label: `пункт ${i}` })),
        },
      ],
      onPick: () => undefined,
    });
    const root = body.root as unknown as ShimElement;
    const items = exact(root, 'ft-choice__item');
    assert.equal(items.length, 6, 'шесть пунктов в двух колонках');
    const cursorIndex = (): number =>
      items.findIndex((item) => item.classList.contains('ft-choice__item--cursor'));
    const press = (key: string): void => {
      root.emit('keydown', { key, preventDefault: () => undefined });
    };

    // ↓ из пункта 0: следующая СТРОКА того же столбца (2), а не соседний столбец (1).
    press('ArrowDown');
    assert.equal(cursorIndex(), 0, 'первое ↓ выделяет первый пункт');
    press('ArrowDown');
    assert.equal(cursorIndex(), 2, '↓ внутри столбца: 0 → 2, не 1');
    press('ArrowDown');
    assert.equal(cursorIndex(), 4, '↓ внутри столбца: 2 → 4');
    press('ArrowDown');
    assert.equal(cursorIndex(), 4, '↓ в конце столбца не перескакивает в другой столбец');

    // →/← — между столбцами.
    press('ArrowRight');
    assert.equal(cursorIndex(), 5, '→ переводит в правый столбец той же строки');
    press('ArrowUp');
    assert.equal(cursorIndex(), 3, '↑ внутри правого столбца: 5 → 3');

    // Home/End — начало/конец списка.
    press('Home');
    assert.equal(cursorIndex(), 0, 'Home — первый пункт списка');
    press('End');
    assert.equal(cursorIndex(), 5, 'End — последний пункт списка');

    // PgUp/PgDn двигают ВЫДЕЛЕНИЕ (а не только прокрутку).
    press('Home');
    press('PageDown');
    assert.ok(cursorIndex() > 0, 'PgDn сдвигает выделение на страницу, а не оставляет на месте');
    press('PageUp');
    assert.equal(cursorIndex(), 0, 'PgUp возвращает выделение к началу');
  });
});
