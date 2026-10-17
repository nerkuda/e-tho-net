/**
 * Вкладка «Рецепты» на едином редакторе отбора (задача a0c071f8, 0.13.1).
 *
 * Проверяются две вещи, за которые отвечает модуль рецепта и общий читатель
 * сохранённого отбора (`lib/filter-builder.ts`):
 *
 *   • **маппинг легаси-определения.** Прежний плоский рецепт («Структур мыслей»)
 *     читается в дерево единого редактора профиля `publications` без потери
 *     условий и **с той же семантикой**: актуальность/корзина (плоское
 *     `show_inactive` против листьев AST), типы («в иерархии»), слова (области),
 *     сортировка (пара `sort`/`order` → `ast.sort`). Критерий сценария b0a50833 —
 *     «заголовок идентичен прежнему» — держится именно на этом равенстве.
 *   • **битый рецепт не теряется молча.** Отброшенные при чтении условия
 *     видны списком потерь (`readFilterDefinitionDetailed.lost`) — место
 *     применения показывает их жёлтой диагностикой, пока пользователь не тронул
 *     отбор; автосохранение перезапишет определение только после правки.
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.js`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FILTER_AST_VERSION, type FilterAst } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

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

installShim();

const builder = await import('../src/renderer/lib/filter-builder.js');
const recipeMod = await import('../src/renderer/screens/publications/recipe.js');

/** Подписи листьев дерева/фильтра: `видОперанда:оператор`. */
function leafSignatures(node: unknown): string[] {
  const out: string[] = [];
  const walk = (current: any): void => {
    if (current === null || typeof current !== 'object') return;
    if (current.kind === 'group') {
      for (const child of current.children) walk(child);
      return;
    }
    if (current.op !== undefined) {
      for (const child of current.children ?? []) walk(child);
      return;
    }
    if (current.entity !== undefined) out.push(`${current.entity.kind}:${current.operator}`);
  };
  walk(node);
  return out;
}

/** Плоское легаси-определение с условием по словам. */
function legacyRecipe(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    keywords: 'слово',
    keyword_scope: ['title', 'synonyms'],
    sort: 'created',
    order: 'asc',
    ...extra,
  };
}

describe('рецепт публикации: чтение легаси-определения единым конвертером', () => {
  it('плоские критерии ложатся в дерево: слова, типы, видимость', () => {
    const read = builder.readFilterDefinitionDetailed(
      legacyRecipe({ type_ids: ['t1'], active: true }),
      { registry: new Map() },
    );
    assert.deepEqual(read.lost, [], 'чистое легаси-определение читается без потерь');
    const sigs = new Set(leafSignatures(read.state.tree));
    assert.ok(sigs.has('keywords:matches'), 'ключевые слова → лист «Найти слова»');
    assert.ok(sigs.has('type:in_hierarchy'), 'типы мыслей → «Тип в иерархии»');
    assert.ok(sigs.has('active:eq'), 'актуальность → лист «Актуальность»');
    assert.ok(sigs.has('trashed:eq'), 'корзина → лист «Помечено на удаление» (дефолт «только непомеченные»)');
  });

  it('сортировка «по дате создания» уходит в многоуровневый `sortKeys` (не теряется)', () => {
    const read = builder.readFilterDefinitionDetailed(legacyRecipe({ type_ids: ['t1'] }), {
      registry: new Map(),
    });
    assert.deepEqual(read.state.sortKeys, [{ key: 'created_at', order: 'asc' }]);
    const ast = builder.buildFilterAst(read.state, {
      profile: 'publications',
      sort: (read.state.sortKeys ?? []).length > 0,
    });
    assert.deepEqual(ast.sort, [{ key: 'created_at', order: 'asc' }], 'сортировка несётся `ast.sort`');
  });

  it('актуальность/корзина плоского рецепта → ровно как компилирует сервер', () => {
    const leavesOf = (def: Record<string, unknown>): Set<string> =>
      new Set(leafSignatures(builder.readFilterDefinitionDetailed(legacyRecipe(def), { registry: new Map() }).state.tree));

    // `active: true` → «только актуальные»; `active: false` + `show_inactive` →
    // «только неактуальные»; только `show_inactive` → условие по актуальности НЕ
    // ставится (обе категории), как у плоского серверного компилятора.
    assert.ok(leavesOf({ active: true }).has('active:eq'));
    assert.ok(leavesOf({ active: false, show_inactive: true }).has('active:eq'));
    assert.ok(
      !leavesOf({ show_inactive: true }).has('active:eq'),
      '`show_inactive` без явной актуальности — условие не накладывается',
    );
    // `trashed: true` → включать помеченные (условия нет); иначе — «только непомеченные».
    assert.ok(!leavesOf({ trashed: true }).has('trashed:eq'));
    assert.ok(leavesOf({}).has('trashed:eq'));
  });

  it('отсутствие сохранённого рецепта — не потеря', () => {
    const read = builder.readFilterDefinitionDetailed(null, { registry: new Map() });
    assert.deepEqual(read.lost, []);
  });

  it('единственное условие легаси-рецепта не пропадает (одиночный лист → группа)', () => {
    // `trashed: true` снимает дефолтный лист «только непомеченные» — в AST
    // остаётся РОВНО один лист слов. Корень дерева обязан стать группой, иначе
    // каркас редактора заменил бы лист пустой группой и условие исчезло бы.
    const read = builder.readFilterDefinitionDetailed(legacyRecipe({ trashed: true }), {
      registry: new Map(),
    });
    assert.equal(read.state.tree?.kind, 'group', 'корень модели — группа');
    assert.deepEqual(leafSignatures(read.state.tree), ['keywords:matches'], 'условие слов сохранено');
  });

  it('определение из одной пары `sort`/`order` читается чистым: служебный дефолт — не условие', () => {
    // Компилятор плоской формы добавляет на КОРЕНЬ лист «Помечено на удаление = нет»,
    // которого определение не задавало (`trashed` в легаси-записи отсутствует).
    // Это дефолт МЕСТА, а не условие пользователя: он не должен превращать
    // определение без критериев в «отбор с условием» — иначе панель «Структур»
    // уходит с контракта «нет критериев → HOME + сироты» на ветку `ast`
    // (ошибка ca864656), а редактор показывает пустую строку-условие.
    const read = builder.readFilterDefinitionDetailed({ sort: 'created', order: 'asc' }, { registry: new Map() });
    assert.deepEqual(leafSignatures(read.state.tree ?? null), [], 'условий в дереве нет');
    assert.equal(builder.filterTreeHasAnyCriteria(read.state.tree ?? null), false);
    assert.deepEqual(read.lost, [], 'снятие дефолта — не потеря определения');
    assert.deepEqual(
      read.state.sortKeys,
      [{ key: 'created_at', order: 'asc' }],
      'сортировка определения сохранена',
    );
  });

});

describe('рецепт публикации: потерянные при чтении условия видны (битый рецепт)', () => {
  it('условие по отсутствующему в реестре свойству — потеря, а не молчание', () => {
    const read = builder.readFilterDefinitionDetailed(
      legacyRecipe({ properties: [{ property_id: 'pX', op: 'eq', value: 'v' }] }),
      { registry: new Map() },
    );
    assert.equal(read.lost.length, 1, 'потерянное условие описано один раз');
    assert.match(read.lost[0]!, /pX/, 'сообщение называет свойство');
  });

  it('нераспознанная запись условия — потеря', () => {
    const read = builder.readFilterDefinitionDetailed(
      legacyRecipe({ properties: [{ op: 'eq', value: 'v' }] }),
      { registry: new Map() },
    );
    assert.equal(read.lost.length, 1);
    assert.match(read.lost[0]!, /не распознано/);
  });

  it('сортировка «по просмотру» не выражается — потеря видна', () => {
    const read = builder.readFilterDefinitionDetailed(legacyRecipe({ sort: 'viewed' }), {
      registry: new Map(),
    });
    assert.equal(read.lost.length, 1);
    assert.match(read.lost[0]!, /по просмотру/);
  });

  it('нечитаемое AST-тело — потеря, дерево пустое', () => {
    const broken: FilterAst = {
      version: FILTER_AST_VERSION,
      filter: { entity: { kind: 'неизвестный' }, operator: 'eq' } as any,
    };
    const read = builder.readFilterDefinitionDetailed(broken, { registry: new Map() });
    assert.equal(read.lost.length, 1);
    assert.match(read.lost[0]!, /не читается/);
    assert.equal(builder.filterTreeHasAnyCriteria(read.state.tree ?? null), false);
  });

  it('читаемое AST-тело потерь не даёт', () => {
    const ok: FilterAst = {
      version: FILTER_AST_VERSION,
      filter: {
        op: 'and',
        children: [
          { entity: { kind: 'active' }, operator: 'eq', value: true },
          { entity: { kind: 'keywords', scope: ['title', 'synonyms'] }, operator: 'matches', value: 'к' },
        ],
      },
    };
    const read = builder.readFilterDefinitionDetailed(ok, { registry: new Map() });
    assert.deepEqual(read.lost, []);
    assert.equal(builder.filterTreeHasAnyCriteria(read.state.tree ?? null), true);
  });
});

describe('рецепт публикации: билдер отдаёт AST-определение профиля «публикации»', () => {
  it('легаси-определение читается, `getDefinition` возвращает AST с сортировкой', () => {
    const builderHandle = recipeMod.buildRecipeBuilder({
      registry: new Map(),
      initial: legacyRecipe({ type_ids: ['t1'] }) as never,
    });
    const def = builderHandle.getDefinition() as any;
    assert.equal(def.version, FILTER_AST_VERSION, 'форма записи — AST-тело ядра');
    assert.match(JSON.stringify(def), /слово/, 'условие по словам сохранено');
    assert.deepEqual(def.sort, [{ key: 'created_at', order: 'asc' }], 'сортировка сохранена в `ast.sort`');
    assert.ok(
      (builderHandle.root.className ?? '').includes('fe'),
      'корень — единый редактор отбора',
    );
  });

  it('у рецепта без сохранённого определения — чистое дерево (без дефолтов видимости)', () => {
    const handle = recipeMod.buildRecipeBuilder({ registry: new Map(), initial: null });
    const def = handle.getDefinition() as any;
    assert.deepEqual(
      leafSignatures(def.filter),
      [],
      'ни одного условия, в т.ч. дефолтного `trashed` плоского компилятора',
    );
    assert.equal(def.sort, undefined, 'сортировки нет');
  });

  it('пустая секция сортировки не воскрешает легаси-пару `sort`/`order` (32fd6125)', () => {
    // Ключей сортировки нет — плоская пара модели НЕ пишется (иначе «невидимый»
    // ключ из легаси-поля сортировал бы отбор вхолостую: класс дефектов
    // ca864656/32fd6125). Ключи чипов — единственный источник сортировки.
    const state = {
      ...builder.defaultFilterCriteriaState(),
      tree: builder.defaultFilterTreeGroup('and'),
      sort: 'created' as const,
      order: 'asc' as const,
    };
    assert.equal(
      builder.buildFilterAst(state, { profile: 'publications', sort: false }).sort,
      undefined,
    );
    const withKeys = builder.buildFilterAst(
      { ...state, sortKeys: [{ key: 'title', order: 'desc' }] },
      { profile: 'publications', sort: true },
    );
    assert.deepEqual(withKeys.sort, [{ key: 'title', order: 'desc' }]);
  });
});
