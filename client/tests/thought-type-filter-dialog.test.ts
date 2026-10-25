/**
 * Tests for the thought-type view editor dialog (задача e37f3f04, спека
 * e0257ca5, 0.7.3; пересобран на единый редактор — задача cfbe8c74, требование
 * a049bb40, ADR fc23f9c1).
 *
 * Covered behaviours (pure-function checks, no DOM harness):
 *   * Определение отбора типа мысли — AST (форма 0.13.1): сборка единым
 *     конструктором (`buildViewAstDefinition`) и ЧТЕНИЕ старой плоской
 *     `definition v1` с компиляцией в дерево на входе (`parseViewDefinition` →
 *     `compileFlatCriteriaToAst`). Round-trip AST → модель → AST не теряет
 *     условий (критерий приёмки «тот же результат до/после»).
 *   * Компилятор плоских критериев в AST: `type_ids` → «Тип в иерархии»,
 *     `parent_ids` → «Родители в иерархии», `trashed`-дефолт → явный лист
 *     «Помечено на удаление = нет», типизация значений свойств.
 *   * Токен-пикер значений контекста (`buildTokensForField`): `$today`/`$now`
 *     для дат, `$thought` для ссылочных операндов, свойства цепочки типов, и
 *     helper живого поиска `filterTokenOptions`.
 *
 * The dialog's full DOM harness is exercised visually in the renderer (the
 * focus-filter-strip.test.ts follows the same «no DOM» convention): the static
 * shape of the AST definition and the token builder is enough to lock the
 * public contract.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import type {
  EffectiveTypeProperty,
  FilterAst,
  FilterAstGroup,
  FilterAstLeaf,
  FilterAstNode,
  LinkType,
  NetworkProperty,
  ThoughtType,
} from '@etn/shared';

import {
  compileFlatCriteriaToAst,
  stripServiceLeavesAtRoot,
  withReverseLinkPropertySides,
  type FilterCriteriaState,
  type FilterTreeLeaf,
  type FilterTreeNode,
} from '../src/renderer/lib/filter-builder.js';

import { store } from '../src/renderer/state.js';

const FOCUS_TYPE_ID = '11111111-1111-4111-8111-111111111111';
const ANCESTOR_TYPE_ID = '22222222-2222-4222-8222-222222222222';
const PROP_VERSION_ID = 'p-version';
const PROP_LABEL_ID = 'p-label';
const PROP_TAGS_ID = 'p-tags';

const REGISTRY: NetworkProperty[] = [
  {
    id: PROP_VERSION_ID,
    name: 'версия',
    value_type: 'thought_ref',
    config: { multiple: false },
    description: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  {
    id: PROP_LABEL_ID,
    name: 'метка',
    value_type: 'text',
    config: null,
    description: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  {
    id: PROP_TAGS_ID,
    name: 'теги',
    value_type: 'thought_ref',
    config: { multiple: true },
    description: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
];

const TYPES: ThoughtType[] = [
  {
    id: FOCUS_TYPE_ID,
    name: 'Работа',
    parent_id: ANCESTOR_TYPE_ID,
    is_root: false,
    icon: null,
    icon_kind: 'emoji',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    description: null,
    comment_template_md: null,
    version: 1,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    created_by: '00000000-0000-4000-8000-000000000001',
  },
  {
    id: ANCESTOR_TYPE_ID,
    name: 'Версия',
    parent_id: null,
    is_root: true,
    icon: null,
    icon_kind: 'emoji',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    description: null,
    comment_template_md: null,
    version: 1,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    created_by: '00000000-0000-4000-8000-000000000001',
  },
];

const TYPE_PROPS: Record<string, EffectiveTypeProperty[]> = {
  [FOCUS_TYPE_ID]: [
    {
      id: 'tp-version',
      property_id: PROP_VERSION_ID,
      owner_type: 'thought_type',
      owner_id: FOCUS_TYPE_ID,
      key: 'версия',
      value_type: 'thought_ref',
      config: { multiple: false },
      required: false,
      position: 0,
      description: null,
      inherited: false,
      defined_on: FOCUS_TYPE_ID,
      defined_on_name: 'Работа',
      default_value: null,
      overridden_here: false,
      description_overridden: false,
    },
  ],
  [ANCESTOR_TYPE_ID]: [
    {
      id: 'tp-label',
      property_id: PROP_LABEL_ID,
      owner_type: 'thought_type',
      owner_id: ANCESTOR_TYPE_ID,
      key: 'метка',
      value_type: 'text',
      config: null,
      required: false,
      position: 0,
      description: null,
      inherited: false,
      defined_on: ANCESTOR_TYPE_ID,
      defined_on_name: 'Версия',
      default_value: null,
      overridden_here: false,
      description_overridden: false,
    },
    {
      id: 'tp-tags',
      property_id: PROP_TAGS_ID,
      owner_type: 'thought_type',
      owner_id: ANCESTOR_TYPE_ID,
      key: 'теги',
      value_type: 'thought_ref',
      config: { multiple: true },
      required: false,
      position: 1,
      description: null,
      inherited: false,
      defined_on: ANCESTOR_TYPE_ID,
      defined_on_name: 'Версия',
      default_value: null,
      overridden_here: false,
      description_overridden: false,
    },
  ],
};

function installShim(): void {
  (globalThis as any).document = {
    createElement: () => ({ classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, append() {}, appendChild() {}, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; }, getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; } }),
  };
  (globalThis as any).window = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: (fn: () => void) => {
      fn();
      return 1;
    },
    clearTimeout: () => undefined,
    innerWidth: 1200,
    innerHeight: 800,
    localStorage: { getItem: () => null, setItem: () => undefined },
  };
  store.update({ networkId: 'n-1', thoughtTypes: TYPES, linkTypes: [] });
}

before(() => {
  installShim();
});

/** Плоское состояние отбора с переопределениями (полное — из чистого модуля). */
function flatState(
  mod: typeof import('../src/renderer/screens/thought-type/filter-dialog-pure.js'),
  overrides: Partial<FilterCriteriaState>,
): FilterCriteriaState {
  return { ...mod.defaultDialogCriteriaState(), tree: null, ...overrides };
}

/** Все листья AST-дерева (для проверки формы компиляции). */
function collectLeaves(node: FilterAstNode): FilterAstLeaf[] {
  if ('op' in node) return node.children.flatMap(collectLeaves);
  return [node];
}

/** Все ГРУППЫ AST-дерева (включая корень), включая вложенные. */
function collectGroups(node: FilterAstNode): Array<{ op: string; children: FilterAstNode[] }> {
  if (!('op' in node)) return [];
  const self = { op: node.op, children: node.children };
  return [self, ...node.children.flatMap(collectGroups)];
}

/** Лист по виду операнда и оператору в пределах набора узлов. */
function findLeafIn(nodes: readonly FilterAstNode[], kind: string, operator: string): FilterAstLeaf | undefined {
  return nodes.flatMap(collectLeaves).find((leaf) => leaf.entity.kind === kind && leaf.operator === operator);
}

/** Все листья МОДЕЛИ дерева (модель хранит значение дискриминантом). */
function collectTreeLeaves(node: FilterTreeNode): FilterTreeLeaf[] {
  if (node.kind === 'group') return node.children.flatMap(collectTreeLeaves);
  return [node];
}

/** Лист по виду операнда и оператору. */
function findLeaf(ast: FilterAst, kind: string, operator: string): FilterAstLeaf | undefined {
  return collectLeaves(ast.filter).find(
    (leaf) => leaf.entity.kind === kind && leaf.operator === operator,
  );
}

const REGISTRY_MAP = new Map(REGISTRY.map((p) => [p.id, p]));

describe('диалог отбора типа мысли — AST-определение (задача cfbe8c74)', () => {
  let mod: typeof import('../src/renderer/screens/thought-type/filter-dialog-pure.js');

  before(async () => {
    mod = await import('../src/renderer/screens/thought-type/filter-dialog-pure.js');
  });

  it('экспортирует те же константы длины, что налагает диалог', () => {
    assert.equal(mod.VIEW_NAME_MAX, 200);
    assert.equal(mod.VIEW_DESCRIPTION_MAX, 1000);
  });

  it('компилятор: плоский type_ids → «Тип в иерархии» (подтипы раскроет исполнитель)', () => {
    const ast = compileFlatCriteriaToAst(
      flatState(mod, { typeIds: [FOCUS_TYPE_ID] }),
      REGISTRY_MAP,
      { activeMode: 'view' },
    );
    assert.ok(ast, 'компилятор обязан вернуть дерево');
    const leaf = findLeaf(ast!, 'type', 'in_hierarchy');
    assert.ok(leaf, 'лист «Тип в иерархии» присутствует');
    assert.deepEqual(leaf!.value, [FOCUS_TYPE_ID], 'значение — переданные корни без заморозки подтипов');
  });

  it('компилятор: связь — «Тип связи в списке», родители — группа ИЛИ(id в корни, родители в иерархии)', () => {
    const ast = compileFlatCriteriaToAst(
      flatState(mod, { linkTypeIds: ['lt-1'], parentIds: ['root-1'] }),
      REGISTRY_MAP,
      { activeMode: 'view' },
    );
    assert.ok(ast);
    assert.deepEqual(findLeaf(ast!, 'link_type', 'in')?.value, ['lt-1']);
    // Прежний фасадный обход включал КОРНИ — их добавляет лист «id в корни»,
    // потомков даёт «Родители в иерархии» (ADR fc23f9c1; итерация 2 cfbe8c74).
    const or = collectGroups(ast!.filter).find((g) => g.op === 'or');
    assert.ok(or, 'родительское условие — группа ИЛИ');
    assert.deepEqual(findLeafIn(or!.children, 'id', 'in')?.value, ['root-1'], 'корни — листом «id в [корни]»');
    assert.deepEqual(
      findLeafIn(or!.children, 'parents', 'in_hierarchy')?.value,
      ['root-1'],
      'потомки — листом «родители в иерархии»',
    );
  });

  it('компилятор: служебный дефолт «Помечено на удаление = нет» впекается явным листом', () => {
    const ast = compileFlatCriteriaToAst(flatState(mod, { keywords: 'foo' }), REGISTRY_MAP, {
      activeMode: 'view',
    });
    assert.ok(ast);
    assert.equal(findLeaf(ast!, 'trashed', 'eq')?.value, false, 'плоский дефолт trashed → явный лист');

    // Пользователь включил помеченные — дефолт-лист не добавляется.
    const withTrash = compileFlatCriteriaToAst(
      flatState(mod, { keywords: 'foo', trashed: true }),
      REGISTRY_MAP,
      { activeMode: 'view' },
    );
    assert.equal(findLeaf(withTrash!, 'trashed', 'eq'), undefined);
  });

  it('компилятор: «Актуальность» — явный лист при значении, отсутствие листа при «не важно»', () => {
    const both = compileFlatCriteriaToAst(
      flatState(mod, { keywords: 'x', active: null }),
      REGISTRY_MAP,
      { activeMode: 'view' },
    );
    assert.equal(findLeaf(both!, 'active', 'eq'), undefined, '«не важно» — условия по актуальности нет');

    const inactive = compileFlatCriteriaToAst(
      flatState(mod, { keywords: 'x', active: false }),
      REGISTRY_MAP,
      { activeMode: 'view' },
    );
    assert.equal(findLeaf(inactive!, 'active', 'eq')?.value, false);
  });

  it('компилятор: «Найти слова» с областью по умолчанию title+synonyms', () => {
    const ast = compileFlatCriteriaToAst(flatState(mod, { keywords: 'счет* -вод*' }), REGISTRY_MAP, {
      activeMode: 'view',
    });
    const leaf = findLeaf(ast!, 'keywords', 'matches');
    assert.ok(leaf);
    assert.equal(leaf!.value, 'счет* -вод*');
    assert.deepEqual((leaf!.entity as { scope?: string[] }).scope, ['title', 'synonyms']);
  });

  it('компилятор: значения свойств типизируются (число), токен остаётся токеном', () => {
    const numeric: NetworkProperty = {
      id: 'p-priority',
      name: 'приоритет',
      value_type: 'number',
      config: null,
      description: null,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };
    const registry = new Map<string, NetworkProperty>([
      ...REGISTRY.map((p) => [p.id, p] as const),
      [numeric.id, numeric] as const,
    ]);
    const ast = compileFlatCriteriaToAst(
      flatState(mod, {
        properties: [
          { propertyId: 'p-priority', op: 'gt', values: ['5'] },
          { propertyId: PROP_VERSION_ID, op: 'eq', values: ['$thought.[версия]'] },
        ],
      }),
      registry,
      { activeMode: 'view' },
    );
    const numLeaf = collectLeaves(ast!.filter).find(
      (l) => l.entity.kind === 'property' && l.entity.property_id === 'p-priority',
    );
    assert.equal(numLeaf?.value, 5);
    assert.equal(typeof numLeaf?.value, 'number');
    const tokenLeaf = collectLeaves(ast!.filter).find(
      (l) => l.entity.kind === 'property' && l.entity.property_id === PROP_VERSION_ID,
    );
    assert.deepEqual(tokenLeaf?.value, { token: '$thought.[версия]' });
  });

  it('компилятор: без условий остаётся только служебный дефолт (или ничего при «включать помеченные»)', () => {
    // Плоский дефолт `trashed=false` — это не «условие», но он выражается
    // явным листом; при пустом отборе в дереве остаётся только он.
    const onlyDefault = compileFlatCriteriaToAst(flatState(mod, {}), REGISTRY_MAP, { activeMode: 'view' });
    assert.ok(onlyDefault);
    const leaves = collectLeaves(onlyDefault!.filter);
    assert.equal(leaves.length, 1);
    assert.equal(leaves[0]!.entity.kind, 'trashed');

    // Пользователь включил помеченные и условий больше нет — отбора нет.
    assert.equal(
      compileFlatCriteriaToAst(flatState(mod, { trashed: true }), REGISTRY_MAP, { activeMode: 'view' }),
      undefined,
    );
  });
});

describe('диалог отбора типа мысли — чтение и запись определения (cfbe8c74)', () => {
  let mod: typeof import('../src/renderer/screens/thought-type/filter-dialog-pure.js');

  before(async () => {
    mod = await import('../src/renderer/screens/thought-type/filter-dialog-pure.js');
  });

  function viewOf(definition: unknown): Parameters<typeof mod.parseViewDefinition>[0] {
    return {
      id: 'v-1',
      thought_type_id: FOCUS_TYPE_ID,
      name: 'Отбор',
      description: null,
      definition: JSON.stringify(definition),
      is_default: false,
      position: 0,
      version: 1,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    } as unknown as Parameters<typeof mod.parseViewDefinition>[0];
  }

  it('старая плоская definition v1 компилируется в дерево на входе', () => {
    const state = mod.parseViewDefinition(
      viewOf({ type_ids: [FOCUS_TYPE_ID], parent_ids: ['root-1'], sort: 'alpha', order: 'desc' }),
      REGISTRY_MAP,
    );
    const tree = state.tree;
    assert.ok(tree !== null && tree !== undefined && tree.kind === 'group', 'дерево заполнено');
    const leaves = collectTreeLeaves(tree);
    assert.ok(leaves.some((l) => l.entity.kind === 'type' && l.operator === 'in_hierarchy'));
    // Прежний обход по связям → группа «ИЛИ(id в корни, родители в иерархии)»:
    // корни входят (фасадный include_roots), потомки — листом иерархии с
    // режимом «по всем связям».
    const orGroup = (tree.children as FilterTreeNode[]).find(
      (n): n is FilterTreeNode & { kind: 'group' } => n.kind === 'group' && n.op === 'or',
    );
    assert.ok(orGroup, 'родительское условие — группа ИЛИ');
    assert.ok(
      orGroup!.children.some((n) => n.kind === 'leaf' && n.entity.kind === 'id' && n.operator === 'in'),
      'корни — листом «id в [корни]»',
    );
    const parents = leaves.find((l) => l.entity.kind === 'parents');
    assert.ok(parents, 'строка «Родители» собрана из parent_ids');
    assert.equal(parents!.operator, 'in_hierarchy');
    assert.equal(parents!.mode, 'all_links');
    // Служебный дефолт места не показывается строкой-условием.
    assert.equal(leaves.some((l) => l.entity.kind === 'trashed'), false, 'дефолт «Помечено на удаление» снят');
    assert.equal(state.sort, 'alpha');
    assert.equal(state.order, 'desc');
  });

  it('новый отбор: дерево пустое, но задано', () => {
    const state = mod.parseViewDefinition(null, REGISTRY_MAP);
    const tree = state.tree;
    assert.ok(tree !== null && tree !== undefined && tree.kind === 'group');
    assert.equal(mod.hasAnyCriteria(state), false);
  });

  it('битый JSON — состояние по умолчанию', () => {
    const state = mod.parseViewDefinition(
      { definition: '{не json', id: 'v', thought_type_id: FOCUS_TYPE_ID } as unknown as Parameters<typeof mod.parseViewDefinition>[0],
      REGISTRY_MAP,
    );
    assert.equal(mod.hasAnyCriteria(state), false);
  });

  it('сборка AST: служебный дефолт «Помечено на удаление = нет» есть, дерево-условие сохранено', () => {
    const state = mod.parseViewDefinition(null, REGISTRY_MAP);
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        { kind: 'leaf', entity: { kind: 'keywords', scope: ['title', 'synonyms'] }, operator: 'matches', value: { kind: 'scalar', value: 'смета' } },
      ],
    };
    const ast = mod.buildViewAstDefinition(state);
    assert.equal(ast.version, 1);
    const leaves = collectLeaves(ast.filter);
    assert.ok(leaves.some((l) => l.entity.kind === 'keywords' && l.value === 'смета'));
    assert.equal(
      leaves.find((l) => l.entity.kind === 'trashed')?.value,
      false,
      'служебный дефолт места записан в AST',
    );
  });

  it('round-trip: AST → модель → AST не теряет условий (совпадение результата)', () => {
    const state = mod.parseViewDefinition(null, REGISTRY_MAP);
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        { kind: 'leaf', entity: { kind: 'type' }, operator: 'in_hierarchy', value: { kind: 'list', items: [FOCUS_TYPE_ID] } },
        { kind: 'leaf', entity: { kind: 'property', property_id: PROP_LABEL_ID }, operator: 'contains', value: { kind: 'scalar', value: 'метка' } },
      ],
    };
    state.sortKeys = [{ key: 'created_at', order: 'desc' }];
    const first = mod.buildViewAstDefinition(state);
    const reopened = mod.parseViewDefinition(viewOf(first), REGISTRY_MAP);
    const second = mod.buildViewAstDefinition(reopened);
    assert.deepEqual(second, first, 'повторное открытие и пересохранение дают то же определение');
  });

  it('условие «Помечено на удаление» переживает переоткрытие AST-отбора (9ddc488e)', () => {
    const state = mod.defaultDialogCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        { kind: 'leaf', entity: { kind: 'trashed' }, operator: 'eq', value: { kind: 'scalar', value: false } },
        { kind: 'leaf', entity: { kind: 'keywords', scope: ['title', 'synonyms'] }, operator: 'matches', value: { kind: 'scalar', value: 'смета' } },
      ],
    };
    const first = mod.buildViewAstDefinition(state);
    const reopened = mod.parseViewDefinition(viewOf(first), REGISTRY_MAP);
    const leaves = collectTreeLeaves(reopened.tree!);
    assert.ok(
      leaves.some((l) => l.entity.kind === 'trashed' && l.value.kind === 'scalar' && l.value.value === false),
      'явное условие пользователя показано при переоткрытии',
    );
    const second = mod.buildViewAstDefinition(reopened);
    assert.deepEqual(second, first, 'условие не потеряно при пересохранении');
  });

  it('явное условие «Помечено на удаление ≠ нет» тоже переживает переоткрытие (9ddc488e)', () => {
    const state = mod.defaultDialogCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        { kind: 'leaf', entity: { kind: 'trashed' }, operator: 'ne', value: { kind: 'scalar', value: false } },
        { kind: 'leaf', entity: { kind: 'keywords', scope: ['title', 'synonyms'] }, operator: 'matches', value: { kind: 'scalar', value: 'смета' } },
      ],
    };
    const first = mod.buildViewAstDefinition(state);
    const reopened = mod.parseViewDefinition(viewOf(first), REGISTRY_MAP);
    const leaves = collectTreeLeaves(reopened.tree!);
    assert.ok(
      leaves.some((l) => l.entity.kind === 'trashed' && l.operator === 'ne'),
      'условие «включать помеченные» не превратилось в служебный дефолт',
    );
    assert.deepEqual(mod.buildViewAstDefinition(reopened), first);
  });

  it('служебный лист помечен в AST и не показывается при переоткрытии (9ddc488e)', () => {
    const state = mod.defaultDialogCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        { kind: 'leaf', entity: { kind: 'keywords', scope: ['title', 'synonyms'] }, operator: 'matches', value: { kind: 'scalar', value: 'смета' } },
      ],
    };
    const first = mod.buildViewAstDefinition(state);
    const service = collectLeaves(first.filter).filter((leaf) => leaf.service === true);
    assert.equal(service.length, 1, 'впечённый дефолт помечен в AST ровно один');
    assert.equal(service[0]!.entity.kind, 'trashed', 'метка стоит на дефолте «Помечено на удаление»');

    const reopened = mod.parseViewDefinition(viewOf(first), REGISTRY_MAP);
    assert.equal(
      collectTreeLeaves(reopened.tree!).some((leaf) => leaf.entity.kind === 'trashed'),
      false,
      'служебный лист не показан строкой условия пользователя',
    );
    assert.equal(mod.hasAnyCriteria(reopened), true, 'пользовательское условие осталось');
  });

  it('после удаления единственного условия отбор снова пуст (запрет пустого отбора, 9ddc488e)', () => {
    const state = mod.defaultDialogCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        { kind: 'leaf', entity: { kind: 'keywords', scope: ['title', 'synonyms'] }, operator: 'matches', value: { kind: 'scalar', value: 'смета' } },
      ],
    };
    const reopened = mod.parseViewDefinition(viewOf(mod.buildViewAstDefinition(state)), REGISTRY_MAP);
    const tree = reopened.tree;
    assert.ok(tree !== null && tree !== undefined && tree.kind === 'group');
    // Удаляем ровно СТРОКУ ПОЛЬЗОВАТЕЛЯ — как кнопка «Удалить условие» в строке:
    // служебный лист, если он просочился в модель (регрессия), остался бы и
    // удовлетворил проверке «есть критерии».
    const only = tree.children.findIndex(
      (child) => child.kind === 'leaf' && child.entity.kind === 'keywords',
    );
    assert.ok(only >= 0, 'пользовательское условие показано при переоткрытии');
    tree.children.splice(only, 1);
    assert.equal(
      mod.hasAnyCriteria(reopened),
      false,
      'впечённый служебный дефолт не считается условием и не обходит запрет пустого отбора',
    );
  });

  it('легаси AST без метки: непомеченный «Помечено на удаление = нет» остаётся условием (9ddc488e)', () => {
    // Определение, сохранённое до появления метки `service`: впечённый лист
    // неотличим от условия пользователя, поэтому читается как условие
    // (обратная совместимость; удалить его пользователь может строкой).
    const legacy = {
      version: 1,
      filter: {
        op: 'and',
        children: [{ entity: { kind: 'trashed' }, operator: 'eq', value: false }],
      },
    };
    const state = mod.parseViewDefinition(viewOf(legacy), REGISTRY_MAP);
    assert.equal(
      collectTreeLeaves(state.tree!).some((leaf) => leaf.entity.kind === 'trashed'),
      true,
      'непомеченный лист читается условием пользователя',
    );
    assert.equal(mod.hasAnyCriteria(state), true);
  });

  it('профиль «мысли»: недопустимый операнд отвергается при сборке (strict)', () => {
    const state = mod.parseViewDefinition(null, REGISTRY_MAP);
    state.tree = {
      kind: 'group',
      op: 'and',
      // «Время события» — операнд профиля «События», в профиле «мысли» недоступен.
      children: [{ kind: 'leaf', entity: { kind: 'occurred_at' }, operator: 'gt', value: { kind: 'scalar', value: 1 } }],
    };
    assert.throws(() => mod.buildViewAstDefinition(state), /профил/i);
  });
});

/**
 * Семантика служебного дефолта при корне «ИЛИ»/«НЕ» (ошибка a65d27d9):
 * служебное условие «живые» ВСЕГДА сужает выдачу, поэтому в ИЛИ-группу оно не
 * вливается, а оборачивает корень пользователя.
 *
 * Мутационная проба: вернуть в `withViewDefaults` старое впекание
 * (`if (tree.kind === 'group') … children: [...tree.children, leaf]`) — тест
 * «ИЛИ-корень» краснеет: корень станет `or` с тремя детьми, и выдача расширится.
 */
describe('служебный дефолт «живые» при корне не-«И» (a65d27d9)', () => {
  let mod: typeof import('../src/renderer/screens/thought-type/filter-dialog-pure.js');

  before(async () => {
    mod = await import('../src/renderer/screens/thought-type/filter-dialog-pure.js');
  });

  function viewOf(definition: unknown): Parameters<typeof mod.parseViewDefinition>[0] {
    return {
      id: 'v-1',
      thought_type_id: FOCUS_TYPE_ID,
      name: 'Отбор',
      description: null,
      definition: JSON.stringify(definition),
      is_default: false,
      position: 0,
      version: 1,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    } as unknown as Parameters<typeof mod.parseViewDefinition>[0];
  }

  function keywordsLeaf(text: string): FilterTreeNode {
    return {
      kind: 'leaf',
      entity: { kind: 'keywords', scope: ['title', 'synonyms'] },
      operator: 'matches',
      value: { kind: 'scalar', value: text },
    };
  }

  function orState(): FilterCriteriaState {
    const state = mod.defaultDialogCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'or',
      children: [keywordsLeaf('смета'), keywordsLeaf('акт')],
    };
    return state;
  }

  it('ИЛИ-корень: определение = ((A ИЛИ B) И (живые)), лист не влит в ИЛИ', () => {
    const ast = mod.buildViewAstDefinition(orState());
    const root = ast.filter as FilterAstGroup;
    assert.equal(root.op, 'and', 'корень — обёртка «И»');
    assert.equal(root.children.length, 2, 'обёртка: корень пользователя + служебный лист');
    const user = root.children[0] as FilterAstGroup;
    assert.equal(user.op, 'or', 'группа пользователя сохранена отдельным ребёнком');
    assert.equal(user.children.length, 2, 'в ней ровно условия пользователя — дефолт не влит');
    assert.equal(
      user.children.some((c) => collectLeaves(c).some((l) => l.entity.kind === 'trashed')),
      false,
      'внутри «ИЛИ» служебного листа нет',
    );
    const service = root.children[1] as FilterAstLeaf;
    assert.equal(service.entity.kind, 'trashed');
    assert.equal(service.value, false);
    assert.equal(service.service, true, 'лист помечен service: true');
  });

  it('И-корень: служебный лист по-прежнему вливается в корневую группу (без обёртки)', () => {
    const state = mod.defaultDialogCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [keywordsLeaf('смета'), keywordsLeaf('акт')],
    };
    const ast = mod.buildViewAstDefinition(state);
    const root = ast.filter as FilterAstGroup;
    assert.equal(root.op, 'and');
    assert.equal(root.children.length, 3, 'два условия + служебный лист в одной группе');
    const service = root.children[2] as FilterAstLeaf;
    assert.equal(service.entity.kind, 'trashed');
    assert.equal(service.service, true);
  });

  it('НЕ-корень: лист не ломает аричность — корень обёрнут, «НЕ» остаётся одним ребёнком', () => {
    const state = mod.defaultDialogCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'not',
      children: [keywordsLeaf('смета')],
    };
    const ast = mod.buildViewAstDefinition(state);
    const root = ast.filter as FilterAstGroup;
    assert.equal(root.op, 'and');
    const notGroup = root.children[0] as FilterAstGroup;
    assert.equal(notGroup.op, 'not');
    assert.equal(notGroup.children.length, 1, 'у «НЕ» ровно один ребёнок');
    assert.equal((root.children[1] as FilterAstLeaf).service, true);
  });

  it('round-trip ИЛИ-корня: переоткрытие возвращает корень «ИЛИ» и все условия', () => {
    const first = mod.buildViewAstDefinition(orState());
    const reopened = mod.parseViewDefinition(viewOf(first), REGISTRY_MAP);
    const tree = reopened.tree;
    assert.ok(tree !== null && tree !== undefined && tree.kind === 'group');
    assert.equal(tree.op, 'or', 'обёртка снята — пользователь видит свой корень «ИЛИ»');
    assert.equal(tree.children.length, 2, 'условия пользователя не потеряны');
    assert.equal(
      collectTreeLeaves(tree).some((leaf) => leaf.entity.kind === 'trashed'),
      false,
      'служебный лист не показан строкой условия',
    );
    assert.equal(mod.hasAnyCriteria(reopened), true);
    assert.deepEqual(
      mod.buildViewAstDefinition(reopened),
      first,
      'пересохранение даёт то же определение — roundtrip не регрессирует',
    );
  });

  it('round-trip НЕ-корня: корень «НЕ» восстанавливается без лишнего уровня', () => {
    const state = mod.defaultDialogCriteriaState();
    state.tree = { kind: 'group', op: 'not', children: [keywordsLeaf('смета')] };
    const first = mod.buildViewAstDefinition(state);
    const reopened = mod.parseViewDefinition(viewOf(first), REGISTRY_MAP);
    const tree = reopened.tree;
    assert.ok(tree !== null && tree !== undefined && tree.kind === 'group');
    assert.equal(tree.op, 'not');
    assert.deepEqual(mod.buildViewAstDefinition(reopened), first);
  });

  /**
   * Ошибка ff11075a: корень «И» с ЕДИНСТВЕННОЙ подгруппой «ИЛИ» при
   * переоткрытии показывался как «ИЛИ». Впечённый служебный лист делал такой
   * корень неотличимым от обёртки места; теперь «И» с единственной подгруппой
   * оборачивается (лист — отдельным ребёнком), а читатель разворачивает только
   * форму ровно `[группа, служебный лист]`.
   *
   * Мутационные пробы: вернуть в `withViewDefaults` впекание в такой корень —
   * краснеет кейс 1 (переоткрытие станет «ИЛИ»); снять в
   * `stripServiceLeavesAtRoot` строгую форму обёртки — тоже краснеет кейс 1.
   */
  it('И-корень с единственной подгруппой «ИЛИ»: переоткрытие показывает «И» (ff11075a)', () => {
    const state = mod.defaultDialogCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        {
          kind: 'group',
          op: 'or',
          children: [keywordsLeaf('смета'), keywordsLeaf('акт')],
        },
      ],
    };
    const first = mod.buildViewAstDefinition(state);
    const root = first.filter as FilterAstGroup;
    assert.equal(root.op, 'and', 'определение — обёртка «И»');
    assert.equal(root.children.length, 2, 'обёртка: корень пользователя + служебный лист');
    const userRoot = root.children[0] as FilterAstGroup;
    assert.equal(userRoot.op, 'and', 'корень пользователя «И» сохранён отдельным ребёнком');
    assert.equal((root.children[1] as FilterAstLeaf).service, true);

    const reopened = mod.parseViewDefinition(viewOf(first), REGISTRY_MAP);
    const tree = reopened.tree;
    assert.ok(tree !== null && tree !== undefined && tree.kind === 'group');
    assert.equal(tree.op, 'and', 'переоткрытие показывает корень пользователя «И», а не «ИЛИ»');
    assert.equal(tree.children.length, 1, 'обёртка снята — лишнего уровня нет');
    const inner = tree.children[0]!;
    assert.equal(inner.kind, 'group', 'подгруппа пользователя сохранена');
    assert.equal(inner.kind === 'group' ? inner.op : null, 'or');
    assert.deepEqual(
      mod.buildViewAstDefinition(reopened),
      first,
      'пересохранение идемпотентно: та же обёртка',
    );
  });

  it('снятие служебных листьев не разворачивает «И» без листа вторым ребёнком (ff11075a)', () => {
    const orGroup: FilterTreeNode = {
      kind: 'group',
      op: 'or',
      children: [keywordsLeaf('смета'), keywordsLeaf('акт')],
    };
    // Пользовательское определение без обёртки места: служебных листьев нет —
    // форма не меняется, корень «И» пользователя остаётся «И».
    const userAnd: FilterTreeNode = { kind: 'group', op: 'and', children: [orGroup] };
    const read = stripServiceLeavesAtRoot(userAnd);
    assert.equal(read.kind, 'group');
    assert.equal(read.kind === 'group' ? read.op : null, 'and', 'корень «И» пользователя сохранён');

    // Служебный лист есть, но форма НЕ обёртки (лист не второй/их два): группа
    // «И» не разворачивается — снимается только служебный лист.
    const serviceLeaf: FilterTreeLeaf = {
      kind: 'leaf',
      entity: { kind: 'trashed' },
      operator: 'eq',
      value: { kind: 'scalar', value: false },
      service: true,
    };
    const odd: FilterTreeNode = {
      kind: 'group',
      op: 'and',
      children: [orGroup, serviceLeaf, { ...serviceLeaf }],
    };
    const oddRead = stripServiceLeavesAtRoot(odd);
    assert.equal(oddRead.kind, 'group');
    assert.equal(oddRead.kind === 'group' ? oddRead.op : null, 'and', 'не-обёртка не разворачивается');
    assert.equal(
      oddRead.kind === 'group' ? oddRead.children.length : 0,
      1,
      'служебные листья сняты, подгруппа пользователя осталась',
    );
  });

  it('пустой отбор с ИЛИ-корнем остаётся пустым: служебная обёртка не даёт критериев', () => {
    const state = mod.defaultDialogCriteriaState();
    state.tree = { kind: 'group', op: 'or', children: [] };
    assert.equal(mod.hasAnyCriteria(state), false, 'обёртка не обходит запрет пустого отбора');
    const ast = mod.buildViewAstDefinition(state);
    assert.equal((ast.filter as FilterAstGroup).op, 'and', 'минимальное условие «живые» есть');
    const reopened = mod.parseViewDefinition(viewOf(ast), REGISTRY_MAP);
    const tree = reopened.tree;
    assert.ok(tree !== null && tree !== undefined && tree.kind === 'group');
    assert.equal(tree.op, 'or', 'пользовательский пустой корень «ИЛИ» восстановлен');
    assert.equal(tree.children.length, 0);
    assert.equal(mod.hasAnyCriteria(reopened), false, 'после переоткрытия отбор тоже пуст');
  });
});

describe('токены контекста отбора типа мысли (buildTokensForField)', () => {
  let mod: typeof import('../src/renderer/screens/thought-type/filter-dialog-pure.js');

  before(async () => {
    mod = await import('../src/renderer/screens/thought-type/filter-dialog-pure.js');
  });

  it('для дат — глобальные $today/$now', () => {
    const chainProps = [{ type: TYPES[0]!, props: TYPE_PROPS[FOCUS_TYPE_ID]! }];
    const texts = mod.buildTokensForField(chainProps, 'date', 'eq').map((t) => t.text);
    assert.ok(texts.includes('$today'));
    assert.ok(texts.includes('$now'));
  });

  it('для ссылочного значения — $thought (ошибка fad9f28c)', () => {
    const chainProps = [{ type: TYPES[0]!, props: TYPE_PROPS[FOCUS_TYPE_ID]! }];
    assert.ok(mod.buildTokensForField(chainProps, 'link', 'eq').some((t) => t.text === '$thought'));
    assert.ok(mod.buildTokensForField(chainProps, 'thought_ref', 'eq').some((t) => t.text === '$thought'));
  });

  it('контекст (без типа значения) даёт поля мысли и свойства цепочки типов', () => {
    const chainProps = [
      { type: TYPES[0]!, props: TYPE_PROPS[FOCUS_TYPE_ID]! },
      { type: TYPES[1]!, props: TYPE_PROPS[ANCESTOR_TYPE_ID]! },
    ];
    const texts = mod.buildTokensForField(chainProps, null, null).map((t) => t.text);
    assert.ok(texts.includes('$thought.title'));
    assert.ok(texts.includes('$thought.type'));
    assert.ok(texts.includes('$thought.author'));
    assert.ok(texts.includes('$thought.[метка]'), 'свойство предка');
    assert.ok(texts.includes('$thought.[версия]'), 'свойство типа');
  });

  it('множественное текстовое свойство помечено listOnly для скалярной операции', () => {
    const multiText: EffectiveTypeProperty = {
      id: 'tp-multiText',
      property_id: 'p-multiText',
      owner_type: 'thought_type',
      owner_id: ANCESTOR_TYPE_ID,
      key: 'теги-текст',
      value_type: 'text',
      config: { multiple: true },
      required: false,
      position: 2,
      description: null,
      inherited: false,
      defined_on: ANCESTOR_TYPE_ID,
      defined_on_name: 'Версия',
      default_value: null,
      overridden_here: false,
      description_overridden: false,
    };
    const chainProps = [
      { type: TYPES[0]!, props: TYPE_PROPS[FOCUS_TYPE_ID]! },
      { type: TYPES[1]!, props: [...TYPE_PROPS[ANCESTOR_TYPE_ID]!, multiText] },
    ];
    const token = mod
      .buildTokensForField(chainProps, 'thought_ref', 'eq')
      .find((t) => t.text === '$thought.[теги-текст]');
    assert.equal(token?.listOnly, true);
  });

  it('filterTokenOptions ищет по подписи и значению, пустой запрос — весь список', () => {
    const options = [
      { text: '$today', label: '$today — сегодня', section: 'Глобальные' },
      { text: '$thought.type', label: '$thought.type — тип мысли в фокусе' },
    ];
    assert.deepEqual(
      mod.filterTokenOptions(options, 'СЕГОДНЯ').map((o) => o.text),
      ['$today'],
    );
    assert.deepEqual(
      mod.filterTokenOptions(options, 'thought.type').map((o) => o.text),
      ['$thought.type'],
    );
    assert.equal(mod.filterTokenOptions(options, 'нет совпадений').length, 0);
    assert.equal(mod.filterTokenOptions(options, '   ').length, 2);
  });
});

describe('реестр условий: обе стороны связи реестра (задача df992826)', () => {
  it('обратная сторона добавляется по чистому имени, включая чужую связь', () => {
    const linkTypes = [
      { id: 'lt-1', name_forward: 'организации категории', name_reverse: 'категория организации' },
      { id: 'lt-2', name_forward: 'работники/контакты', name_reverse: 'место работы' },
    ] as unknown as LinkType[];
    const registry = new Map<string, NetworkProperty>([
      [
        'p-link',
        {
          id: 'p-link',
          name: 'организации категории',
          value_type: 'link',
          config: { link_type_id: 'lt-1' },
          description: null,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
      [
        'p-jobs',
        {
          id: 'p-jobs',
          name: 'работники/контакты',
          value_type: 'link',
          config: { link_type_id: 'lt-2' },
          description: null,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
    ]);

    const withSides = withReverseLinkPropertySides(registry, linkTypes);
    assert.equal(withSides.get('p-link')?.name, 'организации категории');
    assert.equal(withSides.get('категория организации')?.name, 'категория организации');
    assert.ok(withSides.get('место работы'), 'обратная сторона чужой связи присутствует');
    assert.equal(registry.size, 2, 'входной реестр не мутируется');
  });

  it('структурные свойства не дают обратной стороны', () => {
    const structural = {
      id: 'p-children',
      name: 'Потомки',
      value_type: 'link',
      config: { structural: true, direction: 'out' },
      description: null,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    } as unknown as NetworkProperty;
    const registry = new Map<string, NetworkProperty>([[structural.id, structural]]);
    const linkTypes = [
      { id: 'lt-1', name_forward: 'родители', name_reverse: 'потомки' },
    ] as unknown as LinkType[];
    assert.equal(withReverseLinkPropertySides(registry, linkTypes).size, 1);
  });
});
