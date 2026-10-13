/**
 * Композер фразы-превью отбора (задача 3cb50258, элемент ca905fbc; сценарии
 * 2a7648d8/3e97b648). Юнит-тесты чистых функций: лист, группы всех трёх
 * коннекций, вложенность со скобками, под-выборка свёрткой, хвост сортировки,
 * обрезка; плюс подключение к футеру (`preview` по умолчанию из композера).
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.js`): композер DOM не
 * трогает, но его соседи (конструктор модели, фасады футера) читают
 * `document`/`window` при сборке.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LinkType, NetworkProperty } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

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

type PhraseModule = typeof import('../src/renderer/lib/filter-phrase.js');

installShim();
const mod: PhraseModule = await import('../src/renderer/lib/filter-phrase.js');

// ---------------------------------------------------------------------------
// Данные сети
// ---------------------------------------------------------------------------

function prop(id: string, name: string, valueType: NetworkProperty['value_type']): NetworkProperty {
  return {
    id,
    network_id: 'n',
    name,
    value_type: valueType,
    config: null,
    description: null,
    created_at: '',
    updated_at: '',
  } as unknown as NetworkProperty;
}

const CITY = prop('p-city', 'Город', 'text');
const TERM = prop('p-term', 'Срок', 'date');
const PLACE = prop('p-place', 'Место', 'link');

/** Контекст композера: реестр свойств, без связей и типов мыслей. */
function ctx(overrides: Record<string, unknown> = {}): any {
  return {
    registry: new Map<string, NetworkProperty>([
      [CITY.id, CITY],
      [TERM.id, TERM],
      [PLACE.id, PLACE],
    ]),
    linkTypes: [] as LinkType[],
    ...overrides,
  };
}

/** Лист модели: операнд/оператор/значение. */
function leaf(entity: any, operator: any, value: any = { kind: 'none' }, extra: any = {}): any {
  return { kind: 'leaf', entity, operator, value, ...extra };
}

/** Группа модели. */
function group(op: 'and' | 'or' | 'not', children: any[]): any {
  return { kind: 'group', op, children };
}

// ---------------------------------------------------------------------------
// 1. Лист: операнд, оператор, значение
// ---------------------------------------------------------------------------

describe('композер фразы: лист условия', () => {
  it('свойство, булево и датовый диапазон читаются человекочитаемо', () => {
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'property', property_id: CITY.id }, 'eq', { kind: 'scalar', value: 'Москва' }), ctx()),
      'Город равно Москва',
    );
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'active' }, 'eq', { kind: 'scalar', value: true }), ctx()),
      'Актуальность равно да',
    );
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'property', property_id: TERM.id }, 'between', {
        kind: 'list',
        items: [{ token: '$monthStart' }, { token: '$monthEnd' }],
      }), ctx()),
      'Срок между начало месяца и конец месяца',
      'пара границ соединяется «и»',
    );
  });

  it('значение не требуется — фраза заканчивается оператором', () => {
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'attachments' }, 'not_empty'), ctx()),
      'Есть вложения заполнено',
    );
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'active' }, 'is_empty'), ctx()),
      'Актуальность не заполнено',
    );
  });

  it('«Найти слова»: оператор не дублируется, области видны', () => {
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'keywords', scope: ['title'] }, 'matches', { kind: 'scalar', value: 'расход' }), ctx()),
      'Найти слова расход (в именах)',
    );
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'keywords', scope: ['title', 'synonyms'] }, 'matches', { kind: 'scalar', value: 'счёт' }), ctx()),
      'Найти слова счёт (в именах)',
      '«в именах» = имена и синонимы вместе, во фразе не дублируется',
    );
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'keywords', scope: [] }, 'matches', { kind: 'scalar', value: 'счёт' }), ctx()),
      'Найти слова счёт (области не выбраны)',
      'ни одной области — условие отключено, это видно во фразе',
    );
  });

  it('режим обхода и количество видны во фразе', () => {
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'children' }, 'gt', { kind: 'scalar', value: 3 }), ctx()),
      'Потомки больше 3',
    );
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'parents' }, 'in_hierarchy', { kind: 'scalar', value: 't-1' }, { mode: 'all_links' }), ctx()),
      'Родители в иерархии t-1 (по всем связям)',
    );
  });

  it('под-выборка сворачивается: оператор листа не дублируется', () => {
    const inner = group('and', [
      leaf({ kind: 'property', property_id: CITY.id }, 'eq', { kind: 'scalar', value: 'Москва' }),
      leaf({ kind: 'active' }, 'eq', { kind: 'scalar', value: true }),
    ]);
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'parents' }, 'in', { kind: 'subquery', operator: 'in', node: inner }), ctx()),
      'Родители в выборке (2 условия)',
    );
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'parents' }, 'not_in', { kind: 'subquery', operator: 'not_in', node: inner }), ctx()),
      'Родители не в выборке (2 условия)',
    );
    const one = group('and', [leaf({ kind: 'active' }, 'eq', { kind: 'scalar', value: true })]);
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'targets' }, 'in', { kind: 'subquery', operator: 'all_in', node: one }), ctx()),
      'Цели записи все в выборке (1 условие)',
      'согласование числа условий',
    );
  });

  it('длинный набор значений сворачивается с остатком', () => {
    const long = leaf({ kind: 'property', property_id: CITY.id }, 'in', {
      kind: 'list',
      items: ['Москва', 'Питер', 'Казань', 'Сочи', 'Тверь'],
    });
    assert.equal(mod.filterPhraseLeaf(long, ctx()), 'Город в списке Москва, Питер, Казань и ещё 2');
  });
});

// ---------------------------------------------------------------------------
// 2. Группы: коннекции, вложенность, скобки
// ---------------------------------------------------------------------------

describe('композер фразы: группы и вложенность', () => {
  const a = leaf({ kind: 'active' }, 'eq', { kind: 'scalar', value: true });
  const b = leaf({ kind: 'trashed' }, 'eq', { kind: 'scalar', value: false });

  it('«И», «ИЛИ» и «кроме» — подписи коннекции', () => {
    assert.equal(mod.filterPhraseNode(group('and', [a, b]), ctx()), 'все условия: Актуальность равно да и Помечено на удаление равно нет');
    assert.equal(mod.filterPhraseNode(group('or', [a, b]), ctx()), 'любое условие: Актуальность равно да или Помечено на удаление равно нет');
    assert.equal(mod.filterPhraseNode(group('not', [a]), ctx()), 'кроме Актуальность равно да');
  });

  it('вложенная группа с другой коннекцией берётся в скобки', () => {
    const nested = group('and', [group('or', [a, b]), leaf({ kind: 'comment' }, 'not_empty')]);
    assert.equal(
      mod.filterPhraseNode(nested, ctx()),
      'все условия: (любое условие: Актуальность равно да или Помечено на удаление равно нет) и Есть комментарий заполнено',
    );
    // Та же коннекция — без лишних скобок.
    const same = group('and', [group('and', [a, b]), leaf({ kind: 'comment' }, 'not_empty')]);
    assert.equal(
      mod.filterPhraseNode(same, ctx()),
      'все условия: все условия: Актуальность равно да и Помечено на удаление равно нет и Есть комментарий заполнено',
    );
  });

  it('пустая группа фразы не даёт', () => {
    assert.equal(mod.filterPhraseNode(group('and', []), ctx()), '');
    assert.equal(mod.composeFilterPhrase({ tree: group('and', []) }, ctx()), '');
    assert.equal(mod.composeFilterPhrase({ tree: null }, ctx()), '');
  });
});

// ---------------------------------------------------------------------------
// 3. Сортировка, обрезка, определение отбора
// ---------------------------------------------------------------------------

describe('композер фразы: хвост сортировки, обрезка и определение', () => {
  it('сортировка идёт хвостом через «;»', () => {
    assert.equal(
      mod.filterPhraseSort([
        { key: 'title', order: 'asc' },
        { key: 'created_at', order: 'desc' },
        { key: 'unknown_key', order: 'asc' },
      ]),
      'сортировка: по названию, по дате создания (убыв.), unknown_key',
    );
    assert.equal(mod.filterPhraseSort([]), '');
    assert.equal(mod.filterPhraseSort(undefined), '');
    const tree = group('and', [leaf({ kind: 'active' }, 'eq', { kind: 'scalar', value: true })]);
    assert.equal(
      mod.composeFilterPhrase({ tree, sortKeys: [{ key: 'created_at', order: 'desc' }] }, ctx()),
      'все условия: Актуальность равно да; сортировка: по дате создания (убыв.)',
    );
  });

  it('длинная фраза обрезается по пределу с «…» (по границе слова)', () => {
    const tree = group('and', [
      leaf({ kind: 'property', property_id: CITY.id }, 'eq', { kind: 'scalar', value: 'Москва' }),
      leaf({ kind: 'property', property_id: TERM.id }, 'eq', { kind: 'scalar', value: '2026-01-31' }),
    ]);
    const full = mod.composeFilterPhrase({ tree }, ctx());
    const short = mod.composeFilterPhrase({ tree }, ctx({ limit: 30 }));
    assert.ok(short.length <= 30, 'предел соблюдён');
    assert.ok(short.endsWith('…'), 'обрезка помечена');
    assert.ok(full.startsWith(short.slice(0, -1).trimEnd()), 'обрезана именно та же фраза');
    assert.equal(mod.truncateFilterPhrase('короткая фраза', 50), 'короткая фраза');
    assert.equal(mod.truncateFilterPhrase('один два три четыре', 10), 'один два…');
  });

  it('фраза строится и из wire-определения отбора', () => {
    const definition = {
      version: 1,
      filter: {
        op: 'and',
        children: [
          { entity: { kind: 'active' }, operator: 'eq', value: true },
          { entity: { kind: 'property', property_id: CITY.id }, operator: 'eq', value: 'Москва' },
        ],
      },
      sort: [{ key: 'title', order: 'asc' }],
    };
    assert.equal(
      mod.composeFilterPhraseFromDefinition(definition, ctx()),
      'все условия: Актуальность равно да и Город равно Москва; сортировка: по названию',
    );
    assert.equal(mod.composeFilterPhraseFromDefinition(null, ctx()), '');
    assert.equal(mod.composeFilterPhraseFromDefinition({}, ctx()), '');
  });
});

// ---------------------------------------------------------------------------
// 4. Потребитель: футер — preview по умолчанию из композера
// ---------------------------------------------------------------------------

describe('композер фразы: футер берёт preview из композера', () => {
  it('фраза рисуется в превью футера, пустой отбор превью не подписывает', async () => {
    const { buildFilterFooter } = await import('../src/renderer/lib/filter-footer.js');
    const state: any = { tree: null, sortKeys: [] };
    const handle = buildFilterFooter({
      getName: () => 'мой отбор',
      setName: () => undefined,
      savedName: () => null,
      baseline: () => null,
      current: () => state,
      phrase: { state: () => state, phrase: ctx() },
      onSave: () => undefined,
      onApply: () => undefined,
      onClear: () => undefined,
    });
    const root = handle.root as unknown as ShimElement;
    const text = () => root.findAll((n) => n.classList.contains('ff-preview__text'))[0]!;
    assert.equal(text().flatText(), '', 'пустой отбор — превью не подписано');

    state.tree = group('and', [
      leaf({ kind: 'property', property_id: CITY.id }, 'eq', { kind: 'scalar', value: 'Москва' }),
    ]);
    state.sortKeys = [{ key: 'title', order: 'asc' }];
    handle.refresh();
    assert.equal(text().flatText(), 'все условия: Город равно Москва; сортировка: по названию');

    state.tree = null;
    state.sortKeys = [];
    handle.refresh();
    assert.equal(text().flatText(), '', 'очистка отбора снимает фразу');
  });

  it('явный preview хоста сильнее композера', async () => {
    const { buildFilterFooter } = await import('../src/renderer/lib/filter-footer.js');
    const state: any = { tree: group('and', [leaf({ kind: 'active' }, 'eq', { kind: 'scalar', value: true })]) };
    const handle = buildFilterFooter({
      getName: () => '',
      setName: () => undefined,
      savedName: () => null,
      baseline: () => null,
      current: () => state,
      preview: () => ({ text: 'фраза хоста' }),
      phrase: { state: () => state, phrase: ctx() },
      onSave: () => undefined,
      onApply: () => undefined,
      onClear: () => undefined,
    });
    const root = handle.root as unknown as ShimElement;
    assert.equal(root.findAll((n) => n.classList.contains('ff-preview__text'))[0]!.flatText(), 'фраза хоста');
  });
});
