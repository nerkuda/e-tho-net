/**
 * Секция сортировки редактора отбора (задача c74f17a0 ТП 11b2509a; элемент
 * интерфейса 3f0bf221; требования 3e47f52a «многоуровневая, направление на
 * каждый ключ», 8334b54a «набор полей общий с конструктором»).
 *
 * Проверяется `lib/filter-sort.ts`: чипы `[поле ↑/↓]` над единой моделью
 * (`FilterCriteriaState.sortKeys`), кнопка «+» со списком свободных полей,
 * порядок уровней и диагностика ключа (`sort[i]`).
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.js`), как в
 * `filter-tree.test.ts`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';

import type { FilterAstSortKey, LinkType, NetworkProperty } from '@etn/shared';

import type { FilterIssue } from '../src/renderer/lib/filter-diagnostics.js';
import { ShimElement } from './dom-shim.js';

const RENDERER = path.resolve(import.meta.dirname, '..', 'src', 'renderer');

let mod: typeof import('../src/renderer/lib/filter-sort.js');

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

function exact(root: ShimElement, cls: string): ShimElement[] {
  return root.findAll((node) => node.classList.contains(cls));
}

function exactOne(root: ShimElement, cls: string): ShimElement | null {
  return exact(root, cls)[0] ?? null;
}

const CITY = {
  id: 'p-city',
  name: 'Город',
  value_type: 'text',
  config: null,
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

const LINK_TYPE = {
  id: 'lt-1',
  name_forward: 'Место покупки',
  name_reverse: 'Покупки здесь',
} as unknown as LinkType;

const DATA = {
  registry: new Map<string, NetworkProperty>([
    [CITY.id, CITY],
    [PLACE.id, PLACE],
  ]),
  linkTypes: [LINK_TYPE],
};

/** Стенд секции: модель ключей + записанные правки и диагностика. */
function buildSection(initial: FilterAstSortKey[] = []): {
  handle: ReturnType<typeof mod.buildFilterSortSection>;
  state: { keys: FilterAstSortKey[]; changes: number; issues: any[] };
} {
  const state = { keys: [...initial], changes: 0, issues: [] as any[] };
  const handle = mod.buildFilterSortSection({
    getKeys: () => state.keys,
    setKeys: (keys) => {
      state.keys = keys;
    },
    options: () => mod.filterSortKeyOptions(DATA),
    data: DATA,
    issues: () => state.issues,
    onChange: () => {
      state.changes += 1;
    },
  });
  return { handle, state };
}

describe('секция сортировки: единый словарь ключей (8334b54a)', () => {
  before(async () => {
    installShim();
    mod = await import('../src/renderer/lib/filter-sort.js');
  });

  it('движковые ключи берутся из единого набора конструктора, свойства — из реестра', async () => {
    const builder = await import('../src/renderer/lib/filter-builder.js');
    const engine = builder.filterSortAstKeys();
    assert.deepEqual(
      engine.map((entry) => entry.key),
      ['title', 'created_at', 'updated_at'],
      '«по просмотру» ключа AST не имеет',
    );

    const options = mod.filterSortKeyOptions(DATA);
    const engineOptions = options.filter((entry) => entry.group === 'engine');
    assert.deepEqual(
      engineOptions.map((entry) => entry.label),
      engine.map((entry) => entry.label),
      'подписи движковых ключей — из единого набора',
    );
    assert.deepEqual(
      options.filter((entry) => entry.group === 'properties').map((entry) => entry.key),
      ['p-city', 'p-place', 'Покупки здесь'],
      'свойства реестра включая обратную сторону свойства-связи',
    );

    assert.equal(mod.filterSortKeyLabel('title', DATA, options), 'по названию');
    assert.equal(mod.filterSortKeyLabel('p-city', DATA, options), 'Город');
    assert.equal(mod.filterSortKeyLabel('неизвестный', DATA, options), 'неизвестный');
  });

  it('список добавления: занятые ключи убраны, разделы сохраняют порядок словаря', () => {
    const options = mod.filterSortKeyOptions(DATA);
    const menu = mod.filterSortAddMenu([{ key: 'title', order: 'asc' }], options);
    assert.equal(menu.search, true, 'живой поиск — общий компонент с операндами (п.6)');
    // Тот же компонент, что список левых операндов: две колонки и значки строк (п.6).
    assert.deepEqual(
      menu.groups.map((group) => [group.label, group.columns]),
      [
        ['Поля отбора', 2],
        ['Свойства сети', 2],
      ],
      'разделы сортировки — двухколоночная сетка, как у операндов',
    );
    assert.deepEqual(
      menu.groups.map((group) => group.label),
      ['Поля отбора', 'Свойства сети'],
    );
    assert.deepEqual(
      menu.groups[0]!.items.map((item) => item.key),
      ['created_at', 'updated_at'],
      'уже занятый ключ в списке не предлагается',
    );
    assert.equal(menu.groups[1]!.items.length, 3);
    // Значки: движковый ключ — значок вида, свойство-связь — сторона (п.3/п.6).
    assert.equal(menu.groups[0]!.items.find((item) => item.key === 'created_at')!.icon, 'value-date');
    assert.equal(
      menu.groups[1]!.items.find((item) => item.key === 'p-place')!.icon,
      'arrow-down',
      'свойство в источнике — стрелка вниз',
    );
    assert.equal(
      menu.groups[1]!.items.find((item) => item.key === 'Покупки здесь')!.icon,
      'arrow-up',
      'свойство в назначении — стрелка вверх',
    );

    const empty = mod.filterSortAddMenu(
      options.filter((option) => option.group === 'engine').map((option) => ({ key: option.key, order: 'asc' as const })),
      options,
    );
    assert.deepEqual(
      empty.groups.map((group) => group.label),
      ['Свойства сети'],
      'пустой раздел не показывается',
    );
  });

  it('направление задаётся на каждый ключ, порядок уровней — порядок чипов', () => {
    const { handle, state } = buildSection([
      { key: 'title', order: 'asc' },
      { key: 'p-city', order: 'desc' },
    ]);
    const root = handle.root as unknown as ShimElement;
    const chips = exact(root, mod.FILTER_SORT_CHIP_CLASS);
    assert.equal(chips.length, 2);
    assert.deepEqual(
      chips.map((chip) => [chip.dataset['key'], chip.dataset['order'], exactOne(chip, 'fs-chip__label')!.flatText()]),
      [
        ['title', 'asc', 'по названию'],
        ['p-city', 'desc', 'Город'],
      ],
      'уровни идут в порядке модели, подписи — из словаря',
    );
    assert.equal(exactOne(chips[0]!, 'fs-chip__order')!.flatText(), '↑');
    assert.equal(exactOne(chips[1]!, 'fs-chip__order')!.flatText(), '↓');
    assert.equal(chips.length, 2, 'кнопка «+» не чип');
    assert.notEqual(exactOne(root, 'fs-add'), null);

    exactOne(chips[0]!, 'fs-chip__order')!.emit('click', {});
    assert.deepEqual(
      state.keys,
      [
        { key: 'title', order: 'desc' },
        { key: 'p-city', order: 'desc' },
      ],
      'переключение направления первой строки не трогает вторую',
    );
    assert.equal(state.changes, 1);

    exactOne(exact(root, mod.FILTER_SORT_CHIP_CLASS)[1]!, 'fs-chip__remove')!.emit('click', {});
    assert.deepEqual(state.keys, [{ key: 'title', order: 'desc' }], 'крестик убирает уровень');
    assert.equal(exact(root, mod.FILTER_SORT_CHIP_CLASS).length, 1, 'секция перерисована из модели');
  });

  it('кнопка «+» открывает список ключей и добавляет уровень возрастания', () => {
    const { handle, state } = buildSection([{ key: 'title', order: 'desc' }]);
    const root = handle.root as unknown as ShimElement;
    exactOne(root, 'fs-add')!.emit('click', {});
    const menu = (globalThis as any).document.body.findAll((node: ShimElement) =>
      node.classList.contains('ft-choice'),
    )[0];
    assert.notEqual(menu, undefined, 'список открылся общей панелью дерева');
    const item = (menu as ShimElement).findAll((node: ShimElement) => node.classList.contains('ft-choice__item'))
      .find((node) => node.flatText().trim() === 'Город')!;
    item.emit('click', {});
    assert.deepEqual(
      state.keys,
      [
        { key: 'title', order: 'desc' },
        { key: 'p-city', order: 'asc' },
      ],
      'новый уровень добавляется в конец и по возрастанию',
    );
  });

  it('неизвестные записи модели отбрасываются (секция показывает только исполнимые ключи)', () => {
    const { handle, state } = buildSection([
      { key: 'title', order: 'asc' },
      { key: '', order: 'asc' },
      { key: 'p-city', order: 'up' as any },
    ]);
    assert.equal(exact(handle.root as unknown as ShimElement, mod.FILTER_SORT_CHIP_CLASS).length, 1);
    exactOne(exact(handle.root as unknown as ShimElement, mod.FILTER_SORT_CHIP_CLASS)[0]!, 'fs-chip__remove')!.emit('click', {});
    assert.deepEqual(state.keys, []);
  });
});

describe('секция сортировки: диагностика ключа (3e47f52a)', () => {
  before(async () => {
    installShim();
    mod = await import('../src/renderer/lib/filter-sort.js');
  });

  it('красная диагностика по `sort[i]` красит чип и несёт причину', () => {
    const state = {
      keys: [{ key: 'p-city', order: 'asc' }] as FilterAstSortKey[],
      issues: [
        {
          severity: 'error',
          source: 'server',
          code: 'entity_deleted',
          path: 'sort[0]',
          message: 'Свойство «Город» сортировки удалено из реестра сети — отбор нельзя применить.',
          label: 'Город',
          deletedAt: '2026-10-01T00:00:00.000Z',
        },
      ] as FilterIssue[],
    };
    const handle = mod.buildFilterSortSection({
      getKeys: () => state.keys,
      setKeys: (keys) => {
        state.keys = keys;
      },
      options: () => mod.filterSortKeyOptions(DATA),
      data: DATA,
      issues: () => state.issues,
    });
    const chip = exact(handle.root as unknown as ShimElement, mod.FILTER_SORT_CHIP_CLASS)[0]!;
    assert.equal(chip.dataset['severity'], 'error');
    assert.ok(chip.classList.contains('fs-chip--error'));
    assert.match(chip.title, /удалено 2026-10-01T00:00:00\.000Z/, 'причина с датой удаления');
    assert.match(chip.title, /порядок применения — порядок чипов/, 'базовая подсказка чипа сохранена');

    // Жёлтая диагностика — своя краска, зелёный чип без записи краски не имеет.
    state.issues = [{ ...state.issues[0]!, severity: 'warning', code: 'property_detached' }];
    handle.rerender();
    const chip2 = exact(handle.root as unknown as ShimElement, mod.FILTER_SORT_CHIP_CLASS)[0]!;
    assert.equal(chip2.dataset['severity'], 'warning');
    assert.ok(chip2.classList.contains('fs-chip--warning'));
  });

  it('CSS чипа красит диагностику токенами тревоги/предупреждения', () => {
    const css = fs.readFileSync(path.join(RENDERER, 'styles', 'filter-editor.css'), 'utf8');
    assert.match(css, /\.fs-chip--error\s*\{[^}]*var\(--danger\)/s);
    assert.match(css, /\.fs-chip--warning\s*\{[^}]*var\(--warn\)/s);
    assert.match(css, /\.ff-changed\s*\{[^}]*var\(--warn\)/s, 'маркер ● — токен предупреждения');
  });
});
