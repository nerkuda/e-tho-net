/**
 * Тесты виджетов значений условия (задача 3a1f0570, ТП 11b2509a; элементы
 * интерфейса 21955e84/27b2a011/af7bdee2/9ecf405b; требования 9bdddad6/0882f8d5;
 * сторож `guard-value-editor` — значение свойства строит общий редактор).
 *
 * Проверяется то, за что отвечает модуль `lib/filter-value.ts`:
 *   • вид редактора выбирается по оператору и операнду: «между» — две границы,
 *     `is_empty` — ничего, булевы предикаты — триада, ссылочные операнды — живой
 *     поиск, датовые операнды — ячейка с опорами, ЗНАЧЕНИЕ СВОЙСТВА — общий
 *     редактор (`editor/value-editor.ts`, вид значения — данные реестра);
 *   • ссылочный операнд: одиночный оператор — комбо, множественный — чип-поле;
 *     режим «в иерархии» — переключателем В ЯЧЕЙКЕ, а не пунктом операторов;
 *   • «Есть слова»: области инлайн-чекбоксами, ни одной — условие отключено;
 *   • «количество»: числовой инпут с подписью единицы;
 *   • опоры дат — из словаря периода, недоступные профилю (время) отсеиваются,
 *     подпись — человекочитаемая композиция опоры и сдвига;
 *   • конверсия значения модель ↔ общий редактор (токен, список, пусто).
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.js`), как в
 * `filter-tree.test.ts`; модуль импортируется ПОСЛЕ установки шима.
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
  // `window.etn` — контракт preload: модули живого поиска/пикеров читают его
  // на этапе сборки виджета. Разрешающий заглушечный прокси: любой вызов даёт
  // пустой список (тесты проверяют разметку ячейки, а не выдачу сервера).
  const sharedWindow = (globalThis as any).window as Record<string, unknown>;
  sharedWindow['etn'] = etnStub();
}

/** Разрешающий заглушечный `window.etn`: любой путь — вызываемое значение. */
function etnStub(): unknown {
  const target = async (): Promise<unknown[]> => [];
  return new Proxy(target as unknown as Record<string, unknown>, {
    get: (obj, prop) =>
      prop === 'then' ? undefined : prop in obj ? (obj as any)[prop] : etnStub(),
    apply: () => Promise.resolve([]),
  });
}

type FilterValueModule = typeof import('../src/renderer/lib/filter-value.js');

// Шим ставится ДО импорта модуля: фасады дизайн-системы и модули полей читают
// `document`/`window` уже на этапе загрузки.
installShim();
const mod: FilterValueModule = await import('../src/renderer/lib/filter-value.js');

/** Строка реестра свойства для контекста. */
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

const REGISTRY = new Map<string, NetworkProperty>([
  ['p-text', prop('p-text', 'Заметка', 'text')],
  ['p-num', prop('p-num', 'Вес', 'number')],
  ['p-date', prop('p-date', 'Срок', 'date')],
  ['p-bool', prop('p-bool', 'Флаг', 'bool')],
  ['p-link', prop('p-link', 'Место', 'link')],
]);

function ctx(overrides: Record<string, unknown> = {}): any {
  return {
    networkId: 'net-1',
    profile: 'thoughts',
    data: { registry: REGISTRY, linkTypes: [], thoughtTypes: [] },
    ...overrides,
  };
}

/** Лист модели с операндом/оператором/значением. */
function leaf(entity: any, operator: any, value: any = { kind: 'none' }, extra: any = {}): any {
  return { kind: 'leaf', entity, operator, value, ...extra };
}

/** API слота: запоминает записанные значения. */
function slot(): { api: any; writes: any[] } {
  const writes: any[] = [];
  return { api: { setValue: (v: any) => writes.push(v) }, writes };
}

/** Сборка ячейки значения (шим-узел). */
function render(leafNode: any, api: any, context: any = ctx()): ShimElement {
  return mod.renderFilterValue(leafNode, api, context) as unknown as ShimElement;
}

/** Все потомки с точным классом. */
function all(root: ShimElement, cls: string): ShimElement[] {
  return root.findAll((node) => node.classList.contains(cls));
}

/** Первый потомок с точным классом. */
function one(root: ShimElement, cls: string): ShimElement | null {
  return all(root, cls)[0] ?? null;
}

/** Кнопки ряда сегментов (триада, режим иерархии). */
function buttons(root: ShimElement): ShimElement[] {
  return root.findAll((node) => node.tagName.toUpperCase() === 'BUTTON');
}

// ---------------------------------------------------------------------------
// 1. Классификация редактора значения
// ---------------------------------------------------------------------------

describe('вид редактора значения: оператор × операнд', () => {
  it('оператор важнее операнда: «между» — две границы, is_empty/not_empty — ничего', () => {
    assert.equal(mod.filterValueEditor(leaf({ kind: 'created_at' }, 'between'), ctx()), 'bounds');
    assert.equal(mod.filterValueEditor(leaf({ kind: 'created_at' }, 'not_between'), ctx()), 'bounds');
    assert.equal(mod.filterValueEditor(leaf({ kind: 'created_at' }, 'gte'), ctx()), 'date');
    assert.equal(mod.filterValueEditor(leaf({ kind: 'property', property_id: 'p-text' }, 'is_empty'), ctx()), 'none');
    assert.equal(mod.filterValueEditor(leaf({ kind: 'keywords' }, 'not_empty'), ctx()), 'none');
  });

  it('булевы предикаты — триада, наличие коллекций/комментария — предикат, «Есть свойства» — чип-поле', () => {
    assert.equal(mod.filterValueEditor(leaf({ kind: 'active' }, 'eq'), ctx()), 'triad');
    assert.equal(mod.filterValueEditor(leaf({ kind: 'trashed' }, 'ne'), ctx()), 'triad');
    // Наличие коллекций/комментария — вид «(да)(нет)», оператор в ячейке скрыт.
    assert.equal(mod.filterValueEditor(leaf({ kind: 'comment' }, 'eq'), ctx()), 'predicate');
    assert.equal(mod.filterValueEditor(leaf({ kind: 'attachments' }, 'eq'), ctx()), 'predicate');
    assert.equal(mod.filterValueEditor(leaf({ kind: 'chronology' }, 'between'), ctx()), 'predicate');
    assert.equal(mod.filterValueEditor(leaf({ kind: 'attachments' }, 'gt'), ctx()), 'predicate');
    // Вид «(да)(нет)» ЕСТЬ оператор (`not_empty`/`is_empty`), значения у него
    // нет — операторы без значения тоже остаются предикатом, иначе клик по
    // «нет» прятал переключатели (ошибка 23c7d3e9 п. D1).
    for (const kind of ['comment', 'attachments', 'chronology'] as const) {
      assert.equal(mod.filterValueEditor(leaf({ kind }, 'is_empty'), ctx()), 'predicate', `${kind} is_empty`);
      assert.equal(mod.filterValueEditor(leaf({ kind }, 'not_empty'), ctx()), 'predicate', `${kind} not_empty`);
    }
    // «Есть свойства» — чип-поле выбора свойств (не список с чекбоксами).
    assert.equal(mod.filterValueEditor(leaf({ kind: 'properties' }, 'has'), ctx()), 'properties');
  });

  it('ссылочные операнды — живой поиск, пользователи — свой виджет, даты — ячейка опор', () => {
    for (const kind of ['type', 'link_type', 'parents', 'children', 'targets', 'id', 'entity_id'] as const) {
      assert.equal(mod.filterValueEditor(leaf({ kind }, 'in'), ctx()), 'entity', `${kind}`);
    }
    assert.equal(mod.filterValueEditor(leaf({ kind: 'author' }, 'eq'), ctx()), 'user');
    assert.equal(mod.filterValueEditor(leaf({ kind: 'editor' }, 'in'), ctx()), 'user');
    assert.equal(mod.filterValueEditor(leaf({ kind: 'updated_at' }, 'gte'), ctx()), 'date');
  });

  it('значение СВОЙСТВА строит общий редактор — вид значения читается как данные', () => {
    const p = (id: string, op: any): any => leaf({ kind: 'property', property_id: id }, op);
    // Ни одного своего вида по природе: тексты, числа, даты, булево и ссылки
    // уходят в editor/value-editor.ts (сторож guard-value-editor).
    for (const [id, op] of [
      ['p-text', 'contains'],
      ['p-num', 'gt'],
      ['p-date', 'gte'],
      ['p-bool', 'eq'],
      ['p-link', 'eq'],
      ['p-link', 'in'],
    ] as const) {
      assert.equal(mod.filterValueEditor(p(id, op), ctx()), 'value-editor', `${id} ${op}`);
    }
    assert.equal(mod.filterValueEditor(leaf({ kind: 'property', property_id: 'нет-такого' }, 'eq'), ctx()), 'value-editor');
    // Сравнение ссылки — «количество» (число рёбер стороны), а не значение.
    assert.equal(mod.filterValueEditor(p('p-link', 'gt'), ctx()), 'count');
    assert.equal(mod.filterValueEditor(p('p-link', 'between'), ctx()), 'count', '«количество между» — две числовые границы');
  });

  it('«Найти слова» и перечисления: каталог хоста важнее словаря модуля', () => {
    assert.equal(mod.filterValueEditor(leaf({ kind: 'keywords' }, 'matches'), ctx()), 'keywords');
    assert.equal(
      mod.filterValueEditor(leaf({ kind: 'properties' }, 'has'), ctx()),
      'properties',
      '«Есть свойства» — чип-поле выбора свойств',
    );
    assert.equal(mod.filterValueEditor(leaf({ kind: 'kind' }, 'in'), ctx()), 'enum');
    assert.equal(
      mod.filterValueEditor(leaf({ kind: 'action' }, 'eq'), ctx()),
      'value-editor',
      'каталога действий у модуля нет — значение строит общий редактор',
    );
    assert.equal(
      mod.filterValueEditor(
        leaf({ kind: 'action' }, 'eq'),
        ctx({ enumOptions: () => [{ value: 'created', label: 'Создано' }] }),
      ),
      'enum',
    );
  });

  it('«имеет/не имеет свойство» на любом операнде — чип-поле свойств (ошибка п.5)', () => {
    // Оба направления оператора: у «Типа мысли» поле выбора свойства раньше не
    // рисовалось вовсе (значение уходило в перечисление без вариантов).
    for (const kind of ['type', 'properties'] as const) {
      for (const op of ['has', 'not_has'] as const) {
        assert.equal(mod.filterValueEditor(leaf({ kind }, op), ctx()), 'properties', `${kind}/${op}`);
      }
    }
  });

  it('единица «количества» и одиночность значения', () => {
    assert.equal(mod.filterValueUnitLabel(leaf({ kind: 'children' }, 'gt')), 'потомков');
    assert.equal(mod.filterValueUnitLabel(leaf({ kind: 'parents' }, 'gt')), 'родителей');
    assert.equal(mod.filterValueUnitLabel(leaf({ kind: 'attachments' }, 'gt')), 'вложений');
    assert.equal(mod.filterValueUnitLabel(leaf({ kind: 'chronology' }, 'gt')), 'дневниковых записей');
    assert.equal(mod.filterValueUnitLabel(leaf({ kind: 'property', property_id: 'p-link' }, 'gt')), 'значений');

    assert.equal(mod.filterValueIsMultiple('eq'), false);
    assert.equal(mod.filterValueIsMultiple('ne'), false);
    assert.equal(mod.filterValueIsMultiple('in'), true);
    assert.equal(mod.filterValueIsMultiple('all_of'), true);
  });

  it('конверсия значения: модель ↔ общий редактор (токен, список, пусто)', () => {
    assert.deepEqual(mod.filterValueFromEditor(''), { kind: 'none' });
    assert.deepEqual(mod.filterValueFromEditor(null), { kind: 'none' });
    assert.deepEqual(mod.filterValueFromEditor('$today'), { kind: 'token', token: '$today' });
    assert.deepEqual(mod.filterValueFromEditor('2026-01-31'), { kind: 'scalar', value: '2026-01-31' });
    assert.deepEqual(mod.filterValueFromEditor(true), { kind: 'scalar', value: true });
    assert.deepEqual(mod.filterValueFromEditor(7), { kind: 'scalar', value: 7 });
    assert.deepEqual(mod.filterValueFromEditor([]), { kind: 'none' });
    assert.deepEqual(mod.filterValueFromEditor(['a', 'b']), { kind: 'list', items: ['a', 'b'] });

    assert.equal(mod.filterValueToEditor({ kind: 'none' }), null);
    assert.equal(mod.filterValueToEditor({ kind: 'token', token: '$today' }), '$today');
    assert.equal(mod.filterValueToEditor({ kind: 'scalar', value: 5 }), 5);
    assert.deepEqual(mod.filterValueToEditor({ kind: 'list', items: ['a', { token: '$today' }] }), ['a', '$today']);
  });
});

// ---------------------------------------------------------------------------
// 2. Опоры и человекочитаемая композиция дат
// ---------------------------------------------------------------------------

describe('даты: опоры, сдвиг и человекочитаемая подпись', () => {
  it('токены времени отсеиваются в профиле без времени и остаются в хронике', () => {
    const calendar = mod.filterValueTokenOptions({ profile: 'thoughts' }).map((p: any) => p.text);
    assert.ok(calendar.includes('$today'));
    assert.ok(!calendar.includes('$now'), 'профиль без времени — $now недоступен');
    const withTime = mod.filterValueTokenOptions({ profile: 'chronicle' }).map((p: any) => p.text);
    assert.ok(withTime.includes('$now'));
  });

  it('человекочитаемая композиция: опора со сдвигом, точная дата и пара границ', () => {
    assert.equal(mod.filterValueHumanLabel({ kind: 'token', token: '$today' }), 'сегодня');
    assert.equal(mod.filterValueHumanLabel({ kind: 'token', token: '$today+1d' }), 'завтра');
    assert.equal(mod.filterValueHumanLabel({ kind: 'token', token: '$week.start-1w' }), 'начало прошлой недели');
    assert.equal(mod.filterValueHumanLabel({ kind: 'token', token: '$today+3d' }), 'сегодня + 3 дн.', 'составная опора без пресета');
    assert.equal(mod.filterValueHumanLabel({ kind: 'scalar', value: '2026-01-31' }), '2026-01-31');
    assert.equal(
      mod.filterValueHumanLabel({ kind: 'list', items: [{ token: '$month.start' }, { token: '$month.end' }] }),
      'начало месяца — конец месяца',
    );
  });

  it('границы «между»: чтение пары по индексу', () => {
    const value = { kind: 'list', items: [{ token: '$week.start' }, ''] } as any;
    assert.deepEqual(mod.filterValueBoundAt(value, 0), { kind: 'token', token: '$week.start' });
    assert.deepEqual(mod.filterValueBoundAt(value, 1), { kind: 'scalar', value: '' });
    assert.deepEqual(mod.filterValueBoundAt({ kind: 'none' } as any, 1), { kind: 'none' });
  });

  it('источник подсказок отбора отдаёт опоры с человекочитаемой подписью', () => {
    const source = mod.filterValueTokenSource(ctx());
    const rows = source.load('недел') as Array<{ value: string; label: string }>;
    assert.ok(rows.length > 0, 'поиск по подписи находит опоры');
    assert.ok(rows.every((row) => row.value.startsWith('$') && row.label.includes('—')));
  });
});

// ---------------------------------------------------------------------------
// 3. Сборка ячейки значения (DOM-шим)
// ---------------------------------------------------------------------------

describe('ячейка значения: сборка виджета и правки единой модели', () => {
  it('«значение не требуется» — поле правого операнда не рисуется (п.9)', () => {
    const box = render(leaf({ kind: 'keywords' }, 'is_empty'), slot().api);
    assert.equal(box.dataset['editor'], 'none');
    assert.equal(
      one(box, mod.FILTER_VALUE_HINT_CLASS),
      null,
      'подписи «значение не требуется» в ячейке нет',
    );
    assert.equal(box.flatText(), '', 'ячейка значения пуста');
    assert.equal(box.findAll((n) => n.tagName.toUpperCase() === 'INPUT').length, 0);
  });

  it('триада: активный сегмент по значению, «нет» пишет модель (без «не важно»)', () => {
    const { api, writes } = slot();
    const box = render(leaf({ kind: 'active' }, 'eq', { kind: 'scalar', value: true }), api);
    const segs = buttons(box);
    assert.equal(segs.length, 2, 'два сегмента: да/нет');
    segs[1]!.fire('click');
    assert.deepEqual(writes[0], { kind: 'scalar', value: false });
    segs[0]!.fire('click');
    assert.deepEqual(writes[1], { kind: 'scalar', value: true });
  });

  it('наличие коллекции: «да/нет» остаются в обоих состояниях, оба переключаемы (ошибка 23c7d3e9 п. D1)', () => {
    for (const kind of ['comment', 'attachments', 'chronology'] as const) {
      // «Нет» (оператор `is_empty`) — переключатели обязаны быть на месте:
      // раньше ячейка выбирала вид `none` и вернуть «да» было нельзя.
      const off = render(leaf({ kind }, 'is_empty'), slot().api);
      assert.equal(off.dataset['editor'], 'predicate', `${kind}: вид ячейки после «нет»`);
      assert.equal(buttons(off).length, 2, `${kind}: два переключателя после «нет»`);
      const offSegs = buttons(off);
      assert.equal(offSegs[0]!.getAttribute('aria-pressed'), 'false', `${kind}: «да» не выбран`);
      assert.equal(offSegs[1]!.getAttribute('aria-pressed'), 'true', `${kind}: «нет» выбран`);

      // «Да» (оператор `not_empty`) — так же.
      const on = render(leaf({ kind }, 'not_empty'), slot().api);
      assert.equal(on.dataset['editor'], 'predicate', `${kind}: вид ячейки после «да»`);
      assert.equal(buttons(on)[0]!.getAttribute('aria-pressed'), 'true', `${kind}: «да» выбран`);

      // Клик по «да» ИЗ состояния «нет» возвращает выбор оператором, а не значением.
      const node = leaf({ kind }, 'is_empty');
      const { api, writes } = slot();
      const box = render(node, api);
      buttons(box)[0]!.fire('click');
      assert.equal(node.operator, 'not_empty', `${kind}: «да» — это оператор not_empty`);
      assert.deepEqual(writes[0], { kind: 'none' }, `${kind}: значение у предиката не задаётся`);
    }
  });

  it('«Найти слова»: три области инлайн, ни одной — условие приглушено', () => {
    const { api } = slot();
    const leafNode = leaf({ kind: 'keywords', scope: [] }, 'matches', { kind: 'scalar', value: 'счёт' });
    const touched: number[] = [];
    const box = render(leafNode, api, ctx({ touch: () => touched.push(1) }));
    assert.equal(box.dataset['editor'], 'keywords');
    assert.ok(box.classList.contains(mod.FILTER_VALUE_OFF_CLASS), 'ни одной области — условие отключено');
    const scopes = all(box, 'ui-choice-row');
    assert.deepEqual(
      scopes.map((row) => one(row, 'ui-choice-row-label')?.textContent),
      ['в именах', 'в комментарии', 'в дневниках'],
      'три области в порядке словаря: имена, комментарий, дневники (элемент 9ecf405b)',
    );
    const checkbox = scopes[0]!.findAll((n) => n.tagName.toUpperCase() === 'INPUT')[0]!;
    checkbox.checked = true;
    checkbox.fire('change');
    assert.equal(touched.length, 1, 'правка вне значения уведомляет хост');
    assert.deepEqual(leafNode.entity.scope, ['title', 'synonyms'], '«в именах» = имена и синонимы вместе');
  });

  it('«в дневниках» пишет `diary` в область листа, и она уезжает в AST (ошибка 2bc251de)', async () => {
    const { filterTreeToAst } = await import('../src/renderer/lib/filter-builder.js');
    const { api } = slot();
    const leafNode = leaf({ kind: 'keywords', scope: ['title'] }, 'matches', { kind: 'scalar', value: 'счёт' });
    const box = render(leafNode, api);
    const rows = all(box, 'ui-choice-row');
    const diary = rows[2]!.findAll((n) => n.tagName.toUpperCase() === 'INPUT')[0]!;
    diary.checked = true;
    diary.fire('change');
    assert.deepEqual(leafNode.entity.scope, ['title', 'diary'], 'чекбокс «в дневниках» даёт код diary');
    assert.equal(mod.filterValueIsOff(leafNode), false, 'отмеченная область — условие включено');

    const ast = filterTreeToAst(leafNode) as unknown as { entity: { scope?: string[] } };
    assert.deepEqual(ast.entity.scope, ['title', 'diary'], 'область листа доходит до AST как есть');
  });

  it('снятие всех областей «Найти слова» отключает условие', () => {
    const { api } = slot();
    const leafNode = leaf(
      { kind: 'keywords', scope: ['comment', 'diary'] },
      'matches',
      { kind: 'scalar', value: 'счёт' },
    );
    const box = render(leafNode, api);
    for (const row of all(box, 'ui-choice-row')) {
      const input = row.findAll((n) => n.tagName.toUpperCase() === 'INPUT')[0]!;
      input.checked = false;
      input.fire('change');
    }
    assert.deepEqual(leafNode.entity.scope, [], 'все области сняты');
    assert.equal(mod.filterValueIsOff(leafNode), true, 'ни одной области — условие отключено');
    assert.ok(box.classList.contains(mod.FILTER_VALUE_OFF_CLASS), 'строка приглушена');
  });

  it('«количество»: числовой инпут и подпись единицы', () => {
    const box = render(leaf({ kind: 'children' }, 'gt', { kind: 'scalar', value: 3 }), slot().api);
    assert.equal(box.dataset['editor'], 'count');
    assert.equal(one(box, mod.FILTER_VALUE_UNIT_CLASS)?.textContent, 'потомков');
    const input = box.findAll((n) => n.dataset['input'] === 'number')[0];
    assert.equal(input?.value, '3');
  });

  it('ссылочный операнд: одиночный оператор — комбо, множественный — чип-поле и режим иерархии', () => {
    const single = render(leaf({ kind: 'parents' }, 'eq'), slot().api);
    assert.equal(one(single, 'fv-entity')?.dataset['multiple'], 'no', '«равно» — одиночное значение');
    const many = render(leaf({ kind: 'children' }, 'in'), slot().api);
    assert.equal(one(many, 'fv-entity')?.dataset['multiple'], 'yes', '«в списке» — кратное значение');

    const hierLeaf = leaf({ kind: 'parents' }, 'in_hierarchy', { kind: 'scalar', value: 't-1' });
    const hier = render(hierLeaf, slot().api, ctx({ touch: () => undefined }));
    assert.ok(one(hier, mod.FILTER_VALUE_MODE_CLASS) !== null, 'режим иерархии — в ячейке');
    const modeButtons = buttons(one(hier, mod.FILTER_VALUE_MODE_CLASS)!);
    modeButtons[1]!.fire('click');
    assert.equal(hierLeaf.mode, 'all_links', 'режим записан в модель листа');
  });

  it('«Мысль» (id) в иерархии: значение — чип-поле (список корней), режима связей нет', () => {
    const leafNode = leaf({ kind: 'id' }, 'in_hierarchy', { kind: 'list', items: ['t-1', 't-2'] });
    const box = render(leafNode, slot().api, ctx({ touch: () => undefined }));
    const wrap = one(box, 'fv-entity');
    assert.equal(wrap?.dataset['multiple'], 'yes', '«в иерархии» по «Мысли» — список корней чип-полем');
    assert.equal(
      one(box, mod.FILTER_VALUE_MODE_CLASS),
      null,
      'режим связей для «Мысли» неприменим — переключателя нет (задача a577875b)',
    );
  });

  it('иерархические операторы — множественный выбор корней у всех ссылочных операндов (п.4)', () => {
    // «В иерархии»/«не в иерархии» раньше давали одиночное значение; сервер
    // принимает массив корней (a577875b) — ячейка обязана быть чип-полем.
    for (const kind of ['id', 'parents', 'children', 'targets', 'type', 'link_type'] as const) {
      const box = render(leaf({ kind }, 'in_hierarchy', { kind: 'list', items: ['t-1', 't-2'] }), slot().api, ctx({ touch: () => undefined }));
      assert.equal(one(box, 'fv-entity')?.dataset['multiple'], 'yes', `${kind}: in_hierarchy — чип-поле`);
    }
    for (const kind of ['id', 'parents', 'children'] as const) {
      const box = render(leaf({ kind }, 'not_in_hierarchy', { kind: 'list', items: ['t-1'] }), slot().api, ctx({ touch: () => undefined }));
      assert.equal(one(box, 'fv-entity')?.dataset['multiple'], 'yes', `${kind}: not_in_hierarchy — чип-поле`);
    }
  });

  it('имя чипа — из СИНХРОННЫХ источников (снапшот labels), не дожидаясь резолва; сбой резолва имя не сбрасывает', async () => {
    // Ошибка f4e99090 (замер верификатора): чип показывал голый UUID ~37 мс до
    // ответа `etn.thoughts.resolve`, а при сбое резолва оставался им навсегда.
    // Снапшот имён самой модели (`labels.values`, механизм 5bf3d291) обязан
    // дать имя сразу при построении ячейки.
    const saved = (globalThis as any).window.etn;
    let resolveCalls = 0;
    (globalThis as any).window.etn = {
      thoughts: {
        // Резолв облачков (значок) не удался — имя обязано уцелеть.
        resolve: async () => {
          resolveCalls += 1;
          throw new Error('сеть недоступна');
        },
      },
    };
    try {
      const leafNode = leaf(
        { kind: 'parents' },
        'in_hierarchy',
        { kind: 'list', items: ['uuid-1', 'uuid-2'] },
        { labels: { values: { 'uuid-1': 'Мысль о кофе', 'uuid-2': 'Мысль о чае' } } },
      );
      const box = render(leafNode, slot().api, ctx({ touch: () => undefined }));
      // БЕЗ ожидания микрозадач: имя обязано быть в разметке уже при построении
      // (резолв ещё не ответил — и вообще падает).
      const chips = all(box, 'prop-ref-cloud');
      assert.equal(chips.length, 2, 'два чипа-корня');
      assert.deepEqual(
        chips.map((chip) => one(chip, 'prc-title')?.textContent),
        ['Мысль о кофе', 'Мысль о чае'],
        'имя чипа — из снапшота модели, а не сырой id',
      );
      assert.ok(
        chips.every((chip) => !chip.flatText().includes('uuid-')),
        'ни одного голого id в подписи чипа',
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(resolveCalls >= 1, 'значок догружается резолвом даже при известном имени');
      assert.deepEqual(
        all(box, 'prop-ref-cloud').map((chip) => one(chip, 'prc-title')?.textContent),
        ['Мысль о кофе', 'Мысль о чае'],
        'сбой резолва оставляет последнее известное имя, а не id',
      );
    } finally {
      (globalThis as any).window.etn = saved;
    }
  });

  it('чипы ссылочного операнда: ИМЯ, значок и предпросмотр — единый вид с редактором значения (п.5)', async () => {
    // Ошибка f4e99090 п.5: чипы редактора отбора показывали голые id. Теперь
    // облачко догружается пакетным resolve (имя+значок), а поведение чипа —
    // общее с чипом значения свойства-связи (role=button + Ctrl+hover).
    const saved = (globalThis as any).window.etn;
    const NAMES: Record<string, string> = { 'uuid-1': 'Мысль о кофе', 'uuid-2': 'Мысль о чае' };
    const requested: string[][] = [];
    (globalThis as any).window.etn = {
      thoughts: {
        resolve: async (_n: string, ids: string[]) => {
          requested.push([...ids]);
          return ids.map((id) => ({ id, title: NAMES[id] ?? id, icon: '☕', icon_kind: 'emoji' }));
        },
      },
    };
    try {
      const box = render(
        leaf({ kind: 'parents' }, 'in_hierarchy', { kind: 'list', items: ['uuid-1', 'uuid-2'] }),
        slot().api,
        ctx({ touch: () => undefined }),
      );
      await new Promise((resolve) => setImmediate(resolve));
      const chips = all(box, 'prop-ref-cloud');
      assert.equal(chips.length, 2, 'два чипа-корня');
      assert.deepEqual(requested, [['uuid-1', 'uuid-2']], 'пакетный резолв — один вызов на набор');
      assert.deepEqual(
        chips.map((chip) => one(chip, 'prc-title')?.textContent),
        ['Мысль о кофе', 'Мысль о чае'],
        'чип показывает ИМЯ, а не id',
      );
      assert.ok(
        chips.every((chip) => one(chip, 'mini-icon')?.textContent === '☕'),
        'значок типа — из данных мысли (общая фабрика облачка)',
      );
      assert.ok(
        chips.every((chip) => chip.dataset['hpKind'] === 'comment'),
        'Ctrl+hover-предпросмотр — как у чипа значения свойства-связи',
      );
      assert.ok(chips.every((chip) => chip.getAttribute('role') === 'button'), 'чип доступен как кнопка');
    } finally {
      (globalThis as any).window.etn = saved;
    }
  });

  it('«Мысль»: выбор мысли записывает снапшот имени (labels.value) — фраза покажет имя, не id', async () => {
    // Ошибка 4258e694 п.12б: выбор мысли в чип-поле раньше не писал labels.value,
    // и фраза-превью показывала обрезанный id вместо имени мысли. Диалог «…»
    // возвращает только id — имя догружается резолвом (живой поиск отдаёт имя
    // сразу, см. `rememberOptions`).
    const saved = (globalThis as any).window.etn;
    (globalThis as any).window.etn = {
      thoughts: { resolve: async () => [{ id: 't-1', title: 'Мысль о кофе' }] },
    };
    try {
      const leafNode = leaf({ kind: 'id' }, 'in');
      // API, как у каркаса дерева: правка значения пишется в модель листа
      // (резолв имени сверяет, что лист держит то же единственное значение).
      const writes: any[] = [];
      const api = {
        setValue: (value: any): void => {
          leafNode.value = value;
          writes.push(value);
        },
      };
      const box = render(
        leafNode,
        api,
        ctx({ picker: { label: 'Выбрать мысли', open: async () => ['t-1'] } }),
      );
      one(box, 'link-value-corner-btn')!.fire('click'); // диалог «…» чип-поля
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(writes.at(-1), { kind: 'list', items: ['t-1'] }, 'значение записано чипом');
      assert.equal(leafNode.labels?.value, 'Мысль о кофе', 'снапшот имени записан в модель листа');
      const { composeFilterPhrase } = await import('../src/renderer/lib/filter-phrase.js');
      const phrase = composeFilterPhrase({ tree: leafNode }, { registry: REGISTRY });
      assert.match(phrase, /Мысль о кофе/, 'фраза-превью показывает имя, а не id');
      assert.doesNotMatch(phrase, /t-1/, 'id во фразе не остаётся');
      assert.deepEqual(
        leafNode.labels?.values,
        { 't-1': 'Мысль о кофе' },
        'карта имён labels.values ведётся и для одиночного значения',
      );
    } finally {
      (globalThis as any).window.etn = saved;
    }
  });

  it('«Мысль»: набор из ТРЁХ мыслей — карта имён, фраза показывает все имена (не id)', async () => {
    // Ошибка 4258e694 п.12б: множественный выбор — основной кейс «Мысль в
    // списке»/«в иерархии»; фраза обязана показывать имена КАЖДОГО значения,
    // а не id. Имена догружаются ПАКЕТНЫМ `etn.thoughts.resolve`.
    const saved = (globalThis as any).window.etn;
    const resolved: string[][] = [];
    (globalThis as any).window.etn = {
      thoughts: {
        resolve: async (_n: string, ids: string[]) => {
          resolved.push([...ids]);
          return ids.map((id) => ({ id, title: NAMES[id] ?? id }));
        },
      },
    };
    const NAMES: Record<string, string> = { aaa: 'Мысль А', bbb: 'Мысль Б', ccc: 'Мысль В' };
    try {
      const leafNode = leaf({ kind: 'id' }, 'in');
      const writes: any[] = [];
      const api = {
        setValue: (value: any): void => {
          leafNode.value = value;
          writes.push(value);
        },
      };
      const box = render(
        leafNode,
        api,
        ctx({ picker: { label: 'Выбрать мысли', open: async () => ['aaa', 'bbb', 'ccc'] } }),
      );
      one(box, 'link-value-corner-btn')!.fire('click'); // диалог «…» чип-поля
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(writes.at(-1), { kind: 'list', items: ['aaa', 'bbb', 'ccc'] }, 'набор записан');
      assert.deepEqual(
        leafNode.labels?.values,
        { aaa: 'Мысль А', bbb: 'Мысль Б', ccc: 'Мысль В' },
        'карта имён ведётся для всего набора',
      );
      assert.equal(leafNode.labels?.value, undefined, 'одиночный снапшот не пишется для набора');
      assert.deepEqual(resolved, [['aaa', 'bbb', 'ccc']], 'резолв — один пакетный вызов');
      const { composeFilterPhrase } = await import('../src/renderer/lib/filter-phrase.js');
      const phrase = composeFilterPhrase({ tree: leafNode }, { registry: REGISTRY });
      assert.match(phrase, /Мысль А, Мысль Б, Мысль В/, 'фраза показывает все имена');
      assert.doesNotMatch(phrase, /aaa|bbb|ccc/, 'ни одного id во фразе');
    } finally {
      (globalThis as any).window.etn = saved;
    }
  });

  it('ссылочные ОПЕРАНДЫ рендерятся без исключения: имя dataset допустимо для DOMStringMap', () => {
    // Регресс 0.13.1: `wrap.dataset['entity-kind'] = kind` бросал
    // `SyntaxError: Failed to set a named property 'entity-kind' on 'DOMStringMap'`
    // (DOMStringMap принимает только имена-идентификаторы) и ронял рендер дерева
    // «Дневника» при вводе слова в поиске — лист «Цели в выборке». Проверяем
    // каждый ссылочный операнд в обеих формах (одиночной и кратной) и валидность
    // имён, записанных модулем в dataset обёртки.
    for (const kind of ['targets', 'parents', 'children', 'type', 'link_type'] as const) {
      for (const op of ['eq', 'in'] as const) {
        const box = render(leaf({ kind }, op), slot().api);
        const wrap = one(box, 'fv-entity');
        assert.ok(wrap !== null, `${kind}/${op}: обёртка ссылочного операнда построена`);
        for (const key of Object.keys(wrap!.dataset)) {
          assert.ok(
            /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key),
            `${kind}/${op}: dataset['${key}'] недопустим для DOMStringMap (бросает SyntaxError)`,
          );
        }
      }
    }
  });

  it('«Цели в выборке» с под-выборкой (слово в поиске «Дневника») рендерится без падения', () => {
    // Двухпутевая группа ключевых слов «Дневника»: мыслевый путь — лист
    // `targets` (оператор `in`) со значением-под-выборкой, внутри — «Есть слова».
    const inner = leaf({ kind: 'keywords', scope: ['comment'] }, 'matches', { kind: 'scalar', value: 'кофе' });
    const targets = leaf(
      { kind: 'targets' },
      'in',
      { kind: 'subquery', operator: 'and', node: inner },
    );
    const box = render(targets, slot().api, ctx({ profile: 'chronicle' }));
    const wrap = one(box, 'fv-entity');
    assert.ok(wrap !== null, 'строка «Цели в выборке» построена, значение — редактор ссылочного операнда');
    assert.equal(wrap!.dataset['multiple'], 'yes');
    assert.equal(Object.prototype.hasOwnProperty.call(wrap!.dataset, 'entityKind'), true);
  });

  it('автор: одиночно — выбор пользователя, кратно — мультивыбор', () => {
    const single = render(leaf({ kind: 'author' }, 'eq'), slot().api);
    assert.ok(one(single, 'user-select-row') !== null);
    const many = render(leaf({ kind: 'author' }, 'in'), slot().api);
    assert.ok(one(many, 'user-chip-field') !== null);
  });

  it('датовый операнд: одна рамка — период (первым «Точная дата»), количество и тип (п.11)', () => {
    const box = render(leaf({ kind: 'created_at' }, 'gte', { kind: 'token', token: '$weekStart' }), slot().api);
    assert.equal(box.dataset['editor'], 'date');
    // Одна общая рамка строки; отдельных рамок у полей нет (п.11д).
    assert.ok(one(box, mod.FILTER_VALUE_DATE_FRAME_CLASS) !== null, 'общая рамка полей');
    const anchor = box.findAll((n) => n.dataset['part'] === 'anchor')[0];
    assert.equal(anchor?.value, '$weekStart', 'опора — канонический токен (элемент 27b2a011)');
    assert.equal(box.findAll((n) => n.dataset['part'] === 'shift')[0]?.value, '', 'нулевой сдвиг — пустое поле');
    assert.equal(box.findAll((n) => n.dataset['part'] === 'unit')[0]?.value, 'd', 'тип количества — дни');
    assert.equal(one(box, mod.FILTER_VALUE_HINT_LABEL_CLASS)?.textContent, 'начало недели', 'показ — человекочитаемый');
    const options =
      all(box, mod.FILTER_VALUE_ANCHOR_CLASS)[0]?.findAll((n) => n.tagName.toUpperCase() === 'OPTION') ?? [];
    assert.equal(options[0]?.value, 'exact', 'первый пункт списка периода — «Точная дата» (п.11в)');
    assert.equal(options[0]?.textContent, 'Точная дата');
    assert.ok(options.some((o) => o.value === '$weekStart'), 'опоры — под «Относительные даты»');
    assert.equal(one(box, 'date-field'), null, 'в режиме опоры поля точной даты в строке нет (п.11г)');
    // Легаси-ввод остаётся читаемым и приводится к канону (селект находит опору).
    const legacy = render(leaf({ kind: 'created_at' }, 'gte', { kind: 'token', token: '$week.start' }), slot().api);
    assert.equal(legacy.findAll((n) => n.dataset['part'] === 'anchor')[0]?.value, '$weekStart');
    assert.equal(one(legacy, mod.FILTER_VALUE_HINT_LABEL_CLASS)?.textContent, 'начало недели');
  });

  it('точная дата: вместо количества и типа — поле даты с кнопкой календаря (п.11г)', () => {
    const box = render(leaf({ kind: 'created_at' }, 'gte', { kind: 'scalar', value: '2026-03-04' }), slot().api);
    const anchor = box.findAll((n) => n.dataset['part'] === 'anchor')[0]!;
    assert.equal(anchor.value, 'exact', 'выбрана «Точная дата»');
    assert.equal(box.findAll((n) => n.dataset['part'] === 'shift').length, 0, 'поля количества нет');
    assert.equal(box.findAll((n) => n.dataset['part'] === 'unit').length, 0, 'поля типа количества нет');
    const field = one(box, 'date-field');
    assert.ok(field !== null, 'поле даты показано');
    assert.ok(one(field!, 'date-field-pick') !== null, 'кнопка календаря — существующий диалог');
    assert.equal(one(field!, 'date-field-clear'), null, 'свой крестик поля убран: очистка одна (в рамке)');
    assert.ok(
      one(box, mod.FILTER_VALUE_DATE_FRAME_CLASS)!.classList.contains(mod.FILTER_VALUE_DATE_FRAME_EXACT_CLASS),
      'рамка помечена режимом точной даты',
    );
    // Выбор «Точной даты» в списке периода переключает значение на сегодня.
    const { api, writes } = slot();
    const wrap = render(leaf({ kind: 'created_at' }, 'gte', { kind: 'token', token: '$today' }), api);
    const sel = wrap.findAll((n) => n.dataset['part'] === 'anchor')[0]!;
    sel.value = 'exact';
    sel.fire('change');
    assert.equal(writes[0]?.kind, 'scalar');
    assert.match(String(writes[0]?.value), /^\d{4}-\d{2}-\d{2}$/, 'точная дата — сегодняшняя дата');
  });

  it('тип количества — сокращённые подписи: дн/нед/мес/год/час/мин (п.11б)', () => {
    assert.deepEqual(
      mod.filterValueShiftUnits({ profile: 'chronicle' }).map((u: any) => u.label),
      ['дн', 'нед', 'мес', 'год', 'час', 'мин'],
    );
  });

  it('сдвиг: одно поле со знаком и единица собирают канонический токен опоры', () => {
    const { api, writes } = slot();
    const box = render(leaf({ kind: 'created_at' }, 'gte', { kind: 'token', token: '$today' }), api);
    const shift = box.findAll((n) => n.dataset['part'] === 'shift')[0]!;
    const unit = box.findAll((n) => n.dataset['part'] === 'unit')[0]!;
    // «−30» (Unicode-минус, как показывает поле) + «день» → сегодняя опора со сдвигом.
    shift.value = '−30';
    shift.fire('change');
    assert.deepEqual(writes[0], { kind: 'token', token: '$today-30d' }, 'знак минуса сохраняется');
    // Смена единицы пересобирает тот же сдвиг в новой единице (количество не теряется).
    unit.value = 'mo';
    unit.fire('change');
    assert.deepEqual(writes[1], { kind: 'token', token: '$today-30mo' });
    // Смена опоры сохраняет сдвиг.
    const anchor = box.findAll((n) => n.dataset['part'] === 'anchor')[0]!;
    anchor.value = '$monthStart';
    anchor.fire('change');
    assert.deepEqual(writes[2], { kind: 'token', token: '$monthStart-30mo' });
    // Ноль/пусто возвращают голую опору.
    shift.value = '0';
    shift.fire('change');
    assert.deepEqual(writes[3], { kind: 'token', token: '$monthStart' });
  });

  it('сдвиг: разбор и сборка канонических токенов (чистые функции)', () => {
    assert.deepEqual(mod.filterValueShiftParts('$today+3d'), { anchor: '$today', amount: 3, unit: 'd' });
    assert.deepEqual(mod.filterValueShiftParts('$monthStart-1mo'), { anchor: '$monthStart', amount: -1, unit: 'mo' });
    assert.deepEqual(mod.filterValueShiftParts('$today'), { anchor: '$today', amount: 0, unit: 'd' });
    assert.equal(mod.filterValueShiftParts('2026-01-31'), null, 'точная дата — не опора со сдвигом');
    assert.equal(mod.filterValueComposeShift('$today', 3, 'd'), '$today+3d');
    assert.equal(mod.filterValueComposeShift('$today', -30, 'd'), '$today-30d');
    assert.equal(mod.filterValueComposeShift('$today', 0, 'd'), '$today', 'нулевой сдвиг — голая опора');
  });

  it('опоры и единицы: время доступно только профилю со временем', () => {
    const anchors = mod.filterValueDateAnchors({ profile: 'thoughts' }).map((a: any) => a.text);
    assert.ok(anchors.includes('$today') && anchors.includes('$monthStart'));
    assert.ok(!anchors.includes('$now'), 'календарный профиль без $now');
    assert.ok(!anchors.includes('$month.start'), 'легаси-точка не предлагается к генерации');
    assert.deepEqual(
      mod.filterValueShiftUnits({ profile: 'thoughts' }).map((u: any) => u.key),
      ['d', 'w', 'mo', 'y'],
    );
    assert.deepEqual(
      mod.filterValueShiftUnits({ profile: 'chronicle' }).map((u: any) => u.key),
      ['d', 'w', 'mo', 'y', 'h', 'mi'],
      'хроника несёт часы и минуты',
    );
  });

  it('канон и легаси: генерация camelCase, точечные написания читаются', () => {
    // Генерация — канон (ревизия 0.13.1 требования 91f8d8dd).
    assert.equal(mod.filterValueComposeShift('$monthStart', -1, 'mo'), '$monthStart-1mo');
    assert.equal(mod.filterValueShiftParts('$yearStart+1y')?.anchor, '$yearStart');
    // Легаси-синонимы продолжают читаться: разбор, подпись, поиск пресета.
    assert.deepEqual(mod.filterValueShiftParts('$month.start-1mo'), {
      anchor: '$month.start',
      amount: -1,
      unit: 'mo',
    });
    assert.equal(
      mod.filterValueHumanLabel({ kind: 'token', token: '$month.start-1mo' }),
      'начало прошлого месяца',
      'легаси-токен получает ту же человекочитаемую подпись',
    );
    assert.equal(
      mod.filterValueHumanLabel({ kind: 'token', token: '$weekStart-1w' }),
      'начало прошлой недели',
    );
    assert.equal(mod.filterValueHumanLabel({ kind: 'token', token: '$yearStart+1y' }), 'начало года + 1 г.');
    assert.equal(mod.filterValueHumanLabel({ kind: 'token', token: '$now+2h' }), 'сейчас + 2 ч.', 'часы в контексте со временем');
  });

  it('«✕» сбрасывает границу даты к «сегодня, 0»', () => {
    const { api, writes } = slot();
    const box = render(leaf({ kind: 'created_at' }, 'gte', { kind: 'token', token: '$month.start-1mo' }), api);
    assert.equal(
      one(box, mod.FILTER_VALUE_HINT_LABEL_CLASS)?.textContent,
      'начало прошлого месяца',
      'опора со сдвигом показана человекочитаемо (пресет словаря)',
    );
    const reset = one(box, mod.FILTER_VALUE_DATE_RESET_CLASS);
    assert.ok(reset !== null, 'кнопка сброса в ячейке');
    reset!.fire('click');
    assert.deepEqual(writes[0], { kind: 'token', token: '$today' });
  });

  it('границы «между» у свойства — две границы общего редактора', () => {
    const box = render(
      leaf({ kind: 'property', property_id: 'p-date' }, 'between', { kind: 'list', items: ['2026-01-01', '2026-02-01'] }),
      slot().api,
    );
    assert.equal(box.dataset['editor'], 'bounds');
    assert.equal(box.findAll((n) => n.dataset['bound'] === 'from').length, 1);
    assert.equal(box.findAll((n) => n.dataset['bound'] === 'to').length, 1);
  });

  it('«между» у датового операнда: правка одной границы не пишет пустую строку (99e7889d)', () => {
    // Значение-одиночный токен — так выглядит «между» из сохранённого определения
    // и после смены оператора на «между»: ячейки границ показывают опору
    // «$today», но в модели её нет. Правка одной ячейки раньше уходила на сервер
    // как `[{token:"$weekStart"}, ""]` — сервер отвечал «Граница даты должна быть
    // непустой строкой ISO-8601». Теперь незаполненная датовая ячейка пишется в
    // модель своей ВИДИМОЙ опорой.
    const { api, writes } = slot();
    const box = render(leaf({ kind: 'updated_at' }, 'between', { kind: 'token', token: '$today' }), api);
    assert.equal(box.dataset['editor'], 'bounds');
    const fromBox = box.findAll((n) => n.dataset['bound'] === 'from')[0]!;
    const fromAnchor = fromBox.findAll((n) => n.dataset['part'] === 'anchor')[0]!;
    fromAnchor.value = '$weekStart';
    fromAnchor.fire('change');
    assert.deepEqual(
      writes[0],
      { kind: 'list', items: [{ token: '$weekStart' }, { token: '$today' }] },
      'вторая граница — видимая опора «$today», а не пустая строка',
    );
    assert.ok(
      !(writes[0] as { items: unknown[] }).items.some((item) => item === ''),
      'пустых элементов в списке границ нет',
    );
  });

  it('«между» у свойства-даты: та же подстановка видимой опоры', () => {
    const { api, writes } = slot();
    const box = render(
      leaf({ kind: 'property', property_id: 'p-date' }, 'between', { kind: 'token', token: '$today' }),
      api,
    );
    const toBox = box.findAll((n) => n.dataset['bound'] === 'to')[0]!;
    const toAnchor = toBox.findAll((n) => n.dataset['part'] === 'anchor')[0]!;
    toAnchor.value = '$weekEnd';
    toAnchor.fire('change');
    assert.deepEqual(writes[0], {
      kind: 'list',
      items: [{ token: '$today' }, { token: '$weekEnd' }],
    });
  });

  it('«между» у недатового значения пустую границу выдумкой не заменяет', () => {
    const { api, writes } = slot();
    const box = render(
      leaf({ kind: 'property', property_id: 'p-num' }, 'between', { kind: 'token', token: '$today' }),
      api,
    );
    // Ячейка общего редактора показывает пустое поле — незаполненную границу
    // подставляет проверка конструктора «условие без значения» (см.
    // `filter-diagnostics`), а не выдуманное число: литерала-пустышки в модель нет.
    assert.equal(box.dataset['editor'], 'bounds');
    assert.ok(box.findAll((n) => n.tagName.toUpperCase() === 'INPUT').length > 0, 'две границы построены');
    assert.equal(writes.length, 0, 'без правки модель не меняется');
  });

  it('«между» у дат: ввод «С» позже «По» подтягивает конец к началу (2882c25f)', () => {
    const { api, writes } = slot();
    // Обе границы — конкретные даты, значит ячейка рисует поля даты: правим «С».
    const box = render(
      leaf({ kind: 'created_at' }, 'between', { kind: 'list', items: ['2026-01-10', '2026-01-20'] }),
      api,
    );
    const fromInput = box
      .findAll((n) => n.dataset['bound'] === 'from')[0]!
      .findAll((n) => n.tagName.toUpperCase() === 'INPUT')[0]!;
    fromInput.value = '2026-02-01';
    fromInput.fire('change');
    assert.deepEqual(
      writes[0],
      { kind: 'list', items: ['2026-02-01', '2026-02-01'] },
      'конец интервала подтянут к началу — пустого (перевёрнутого) периода не остаётся',
    );
  });

  it('«между» у дат: ввод «По» раньше «С» подтягивает начало к концу (2882c25f)', () => {
    const { api, writes } = slot();
    const box = render(
      leaf({ kind: 'created_at' }, 'between', { kind: 'list', items: ['2026-01-10', '2026-01-20'] }),
      api,
    );
    const toInput = box
      .findAll((n) => n.dataset['bound'] === 'to')[0]!
      .findAll((n) => n.tagName.toUpperCase() === 'INPUT')[0]!;
    toInput.value = '2025-12-31';
    toInput.fire('change');
    assert.deepEqual(writes[0], { kind: 'list', items: ['2025-12-31', '2025-12-31'] });
  });

  it('авто-выравнивание границ — общее правило порядка дат, токены не сравниваются', () => {
    // Точка правды — `lib/dates.ts` (setPeriodFrom/setPeriodTo), та же, что у
    // диалога даты/периода: ячейка границ второго правила не заводит.
    assert.deepEqual(mod.filterValueAlignDateBounds('2026-02-01', '2026-01-01', 0), {
      from: '2026-02-01',
      to: '2026-02-01',
    });
    assert.deepEqual(mod.filterValueAlignDateBounds('2026-02-01', '2026-01-01', 1), {
      from: '2026-01-01',
      to: '2026-01-01',
    });
    assert.deepEqual(
      mod.filterValueAlignDateBounds('2026-01-01', '2026-02-01', 0),
      { from: '2026-01-01', to: '2026-02-01' },
      'порядок не нарушен — границы остаются как есть',
    );
    assert.deepEqual(
      mod.filterValueAlignDateBounds({ token: '$today' }, '2026-01-01', 1),
      { from: { token: '$today' }, to: '2026-01-01' },
      'границу-токен с датой не сравниваем (резолва токенов в ячейке нет)',
    );
    assert.deepEqual(mod.filterValueAlignDateBounds('', '2026-01-01', 1), { from: '', to: '2026-01-01' });
  });

  it('«между» у дат: граница-токен порядку не подчиняется (2882c25f)', () => {
    const { api, writes } = slot();
    const box = render(
      leaf({ kind: 'created_at' }, 'between', { kind: 'list', items: [{ token: '$today' }, '2026-01-20'] }),
      api,
    );
    const toInput = box
      .findAll((n) => n.dataset['bound'] === 'to')[0]!
      .findAll((n) => n.tagName.toUpperCase() === 'INPUT')[0]!;
    toInput.value = '2020-01-01';
    toInput.fire('change');
    assert.deepEqual(
      writes[0],
      { kind: 'list', items: [{ token: '$today' }, '2020-01-01'] },
      'начало — опора, а не дата: порядок не выравнивается (прежнее поведение)',
    );
  });

  it('перечисление: чип-поле выбранных значений, без «простыни» чекбоксов (п. C2/C3)', () => {
    const { api } = slot();
    const box = render(leaf({ kind: 'kind' }, 'in'), api);
    assert.equal(box.dataset['editor'], 'enum');
    assert.ok(one(box, 'ui-chip-list') !== null, 'перечисление — чип-поле множественных значений');
    assert.equal(all(box, 'ui-choice-row').length, 0, 'чекбоксы ушли в выпадающий список, а не «простынёй»');
    assert.ok(one(box, 'ui-chip-list-add') !== null, 'поле добавления значений');
  });

  it('«не имеет свойство» по «Типу мысли»: чип-поле строится, оператор не переписывается (п.5)', () => {
    const leafNode = leaf({ kind: 'type' }, 'not_has');
    const box = render(leafNode, slot().api);
    assert.equal(box.dataset['editor'], 'properties');
    assert.ok(one(box, 'entity-chip-field') !== null, 'чип-поле выбора свойства построено');
    assert.equal(leafNode.operator, 'not_has', 'рендер не меняет направление предиката');
    assert.equal(leafNode.value.kind, 'none', 'значение не подменяется при построении');
  });

  it('варианты свойств: значок вида значения, тип значения и описание (п.6а/6б)', () => {
    const text = prop('p-text', 'Заметка', 'text') as unknown as { description: string | null };
    text.description = 'Свободный текст';
    const registry = new Map<string, NetworkProperty>([
      ['p-text', text as unknown as NetworkProperty],
      ['p-num', prop('p-num', 'Вес', 'number')],
    ]);
    const options = mod.filterPropertyOptions(registry, []);
    const textOpt = options.find((o: any) => o.id === 'p-text')!;
    assert.equal(textOpt.note, 'строка', 'подпись типа значения рядом с именем');
    assert.equal(textOpt.icon, 'value-text', 'значок вида значения — из эталонного источника');
    assert.equal(textOpt.tooltip, 'Заметка — Свободный текст', 'описание свойства — в подсказке');
    assert.equal(textOpt.searchText, 'Свободный текст', 'описание участвует в живом поиске');
    const numOpt = options.find((o: any) => o.id === 'p-num')!;
    assert.equal(numOpt.icon, 'value-number');
    assert.equal(numOpt.note, 'число');
    assert.equal(numOpt.tooltip, undefined, 'без описания подсказки нет');
  });

  it('варианты свойств-связей: сторона связи — стрелка вниз/вверх (п.6а)', () => {
    const direct = prop('p-fwd', 'Исходящая', 'link') as unknown as { config: unknown };
    direct.config = { link_type_id: 'lt-1' };
    const reverse = prop('p-rev', 'Входящая', 'link') as unknown as { config: unknown };
    reverse.config = { link_type_id: 'lt-1' };
    const linkTypes = [{ id: 'lt-1', name_forward: 'Исходящая', name_reverse: 'Входящая' }] as unknown as LinkType[];
    const options = mod.filterPropertyOptions(
      new Map<string, NetworkProperty>([
        ['p-fwd', direct as unknown as NetworkProperty],
        ['p-rev', reverse as unknown as NetworkProperty],
      ]),
      linkTypes,
    );
    assert.equal(options.find((o: any) => o.id === 'p-fwd')!.icon, 'arrow-down', 'источник — стрелка вниз');
    assert.equal(options.find((o: any) => o.id === 'p-rev')!.icon, 'arrow-up', 'назначение — стрелка вверх');
    assert.ok(options.every((o: any) => o.note === 'связь'));
  });
});
