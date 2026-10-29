/**
 * Панель «Структур»: дефолты видимости (`active`/`trashed`) ВСЕГДА сужают отбор
 * (ошибка 7f55e8ac; тот же класс, что a65d27d9 у отбора типа мысли).
 *
 * Прежде `withVisibilityDefaults` вливал дефолты в корневую группу любой
 * операции: при корне «ИЛИ» выдача расширялась до всех живых мыслей
 * (`(A ИЛИ B) ИЛИ активные ИЛИ непомеченные`), а при корне «НЕ» группа получала
 * второго ребёнка и нарушала аричность AST. Теперь группа «И» впитывает
 * дефолты, а «ИЛИ»/«НЕ» и одиночное условие оборачиваются.
 *
 * Мутационная проба: вернуть в `withVisibilityDefaults` безусловную вставку
 * (`if ('children' in filter) return { ...filter, children: [...filter.children, ...extra] }`)
 * — краснеют кейсы «ИЛИ-корень» (дефолт окажется внутри «ИЛИ») и «НЕ-корень»
 * (у «НЕ» станет два ребёнка).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FilterAstNode } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

type Dict = Record<string, unknown>;

function installShims(): void {
  (globalThis as Dict).HTMLElement = ShimElement;
  (globalThis as Dict).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    body: new ShimElement('body'),
    documentElement: { style: {}, classList: new ShimElement('html').classList },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
    getSelection: () => null,
  } satisfies Dict;
  const win = ((globalThis as Dict).window ?? ((globalThis as Dict).window = {})) as Dict;
  win.innerWidth = 1400;
  win.innerHeight = 900;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.setInterval = setInterval;
  win.clearInterval = clearInterval;
  win.requestAnimationFrame = (fn: () => void) => {
    fn();
    return 1;
  };
  win.cancelAnimationFrame = () => undefined;
  win.etn = {
    ui: { getState: async () => null, setState: async () => undefined },
    tabs: { updateState: async () => undefined, list: async () => [] },
    propertyRegistry: { list: async () => [] },
    structures: { query: async () => ({ items: [], total: 0, directions: {}, next_cursor: null }) },
    savedFilters: {
      list: async () => [],
      create: async () => ({}),
      update: async () => ({}),
      remove: async () => undefined,
    },
    thoughts: { resolve: async () => [], findDuplicates: async () => [] },
    history: { list: async () => [] },
  };
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.dispatchEvent = () => undefined;
  win.matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  win.localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  (globalThis as Dict).ResizeObserver = class {
    observe(): void {
      /* раскладки в шиме нет */
    }
    unobserve(): void {
      /* раскладки в шиме нет */
    }
    disconnect(): void {
      /* раскладки в шиме нет */
    }
  };
  (globalThis as Dict).requestAnimationFrame = win.requestAnimationFrame;
  (globalThis as Dict).localStorage = win.localStorage;
}

installShims();

const panelMod = await import('../src/renderer/screens/structures/filter-panel.js');

type TreeLeaf = Parameters<typeof panelMod.withVisibilityDefaults>[1];

function keywordLeaf(text: string): any {
  return {
    kind: 'leaf',
    entity: { kind: 'keywords', scope: ['title', 'synonyms'] },
    operator: 'matches',
    value: { kind: 'scalar', value: text },
  };
}

function astLeaf(text: string): FilterAstNode {
  return {
    entity: { kind: 'keywords', scope: ['title', 'synonyms'] },
    operator: 'matches',
    value: text,
  };
}

function orRoot(): FilterAstNode {
  return { op: 'or', children: [astLeaf('альфа'), astLeaf('бета')] };
}

/** Виды листьев группы в порядке появления: `op` у групп, `kind` у условий. */
function shape(node: FilterAstNode): any {
  if (Array.isArray((node as any).children)) {
    const group = node as any;
    return { op: group.op, kids: group.children.map(shape) };
  }
  return (node as any).entity.kind;
}

describe('дефолты видимости панели «Структур» всегда сужают (7f55e8ac)', () => {
  const tree: TreeLeaf = { kind: 'group', op: 'or', children: [keywordLeaf('альфа'), keywordLeaf('бета')] };

  it('ИЛИ-корень: дефолты оборачивают корень, а не вливаются в «ИЛИ»', () => {
    const out = panelMod.withVisibilityDefaults(orRoot(), tree, { showInactive: false });
    const group = out as any;
    assert.equal(group.op, 'and', 'корень — обёртка «И»');
    assert.equal(group.children.length, 3, 'корень пользователя + «активные» + «непомеченные»');
    const user = group.children[0] as any;
    assert.equal(user.op, 'or', 'группа пользователя сохранена отдельным ребёнком');
    assert.equal(user.children.length, 2, 'в «ИЛИ» нет служебных дефолтов — выдача не расширяется');
    assert.deepEqual(
      group.children.slice(1).map((child: any) => child.entity.kind),
      ['active', 'trashed'],
      'дефолты стоят рядом с корнем, то есть сужают его',
    );
  });

  it('НЕ-корень: дефолты не ломают аричность — у «НЕ» остаётся один ребёнок', () => {
    const notRoot: FilterAstNode = { op: 'not', children: [astLeaf('альфа')] };
    const out = panelMod.withVisibilityDefaults(notRoot, tree, { showInactive: false });
    const group = out as any;
    assert.equal(group.op, 'and');
    const notGroup = group.children[0] as any;
    assert.equal(notGroup.op, 'not');
    assert.equal(notGroup.children.length, 1, '«НЕ» ровно с одним ребёнком');
    assert.deepEqual(
      group.children.slice(1).map((child: any) => child.entity.kind),
      ['active', 'trashed'],
    );
  });

  it('И-корень: дефолты по-прежнему вливаются в корневую группу', () => {
    const andRoot: FilterAstNode = { op: 'and', children: [astLeaf('альфа'), astLeaf('бета')] };
    const out = panelMod.withVisibilityDefaults(andRoot, tree, { showInactive: false });
    assert.deepEqual(shape(out), {
      op: 'and',
      kids: ['keywords', 'keywords', 'active', 'trashed'],
    });
  });

  it('одиночное условие: оборачивается группой «И» с дефолтами', () => {
    const out = panelMod.withVisibilityDefaults(astLeaf('альфа'), keywordLeaf('альфа'), {
      showInactive: false,
    });
    assert.deepEqual(shape(out), { op: 'and', kids: ['keywords', 'active', 'trashed'] });
  });

  it('явное условие дерева по «Помечено на удаление» снимает только его дефолт', () => {
    const trashedTree: any = {
      kind: 'group',
      op: 'or',
      children: [
        keywordLeaf('альфа'),
        { kind: 'leaf', entity: { kind: 'trashed' }, operator: 'eq', value: { kind: 'scalar', value: true } },
      ],
    };
    const out = panelMod.withVisibilityDefaults(orRoot(), trashedTree, { showInactive: false });
    assert.deepEqual(shape(out), { op: 'and', kids: [{ op: 'or', kids: ['keywords', 'keywords'] }, 'active'] });
  });

  it('«Показывать неактуальные» снимает только дефолт по «Актуальность»', () => {
    const out = panelMod.withVisibilityDefaults(orRoot(), tree, { showInactive: true });
    assert.deepEqual(shape(out), { op: 'and', kids: [{ op: 'or', kids: ['keywords', 'keywords'] }, 'trashed'] });
  });

  it('buildQueryFilter панели отдаёт исполнимую обёртку для корня «ИЛИ»', () => {
    panelMod.setFilterState({
      ...panelMod.getFilterState(),
      tree,
      sortKeys: [],
    } as any);
    const query = panelMod.buildQueryFilter();
    assert.ok(query.ast !== undefined, 'отбор с условиями идёт AST-формой');
    assert.deepEqual(shape(query.ast!.filter), {
      op: 'and',
      kids: [{ op: 'or', kids: ['keywords', 'keywords'] }, 'active', 'trashed'],
    });
  });
});
