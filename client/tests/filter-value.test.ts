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

import type { NetworkProperty } from '@etn/shared';

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

  it('булевы предикаты и коллекции — триада, числовые сравнения коллекций — количество', () => {
    assert.equal(mod.filterValueEditor(leaf({ kind: 'active' }, 'eq'), ctx()), 'triad');
    assert.equal(mod.filterValueEditor(leaf({ kind: 'trashed' }, 'ne'), ctx()), 'triad');
    assert.equal(mod.filterValueEditor(leaf({ kind: 'comment' }, 'eq'), ctx()), 'triad');
    assert.equal(mod.filterValueEditor(leaf({ kind: 'attachments' }, 'eq'), ctx()), 'triad');
    assert.equal(mod.filterValueEditor(leaf({ kind: 'chronology' }, 'between'), ctx()), 'count');
    assert.equal(mod.filterValueEditor(leaf({ kind: 'attachments' }, 'gt'), ctx()), 'count');
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

  it('«Есть слова» и перечисления: каталог хоста важнее словаря модуля', () => {
    assert.equal(mod.filterValueEditor(leaf({ kind: 'keywords' }, 'matches'), ctx()), 'keywords');
    assert.equal(mod.filterValueEditor(leaf({ kind: 'properties' }, 'has'), ctx()), 'enum');
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
  it('«значение не требуется» — подсказка без полей ввода', () => {
    const box = render(leaf({ kind: 'keywords' }, 'is_empty'), slot().api);
    assert.equal(box.dataset['editor'], 'none');
    assert.ok(one(box, mod.FILTER_VALUE_HINT_CLASS) !== null);
    assert.equal(box.findAll((n) => n.tagName.toUpperCase() === 'INPUT').length, 0);
  });

  it('триада: активный сегмент по значению, «нет» и «не важно» пишут модель', () => {
    const { api, writes } = slot();
    const box = render(leaf({ kind: 'active' }, 'eq', { kind: 'scalar', value: true }), api);
    const segs = buttons(box);
    assert.equal(segs.length, 3, 'три сегмента: да/нет/не важно');
    segs[1]!.fire('click');
    segs[2]!.fire('click');
    assert.deepEqual(writes[0], { kind: 'scalar', value: false });
    assert.deepEqual(writes[1], { kind: 'none' });
  });

  it('«Есть слова»: области инлайн, ни одной — условие приглушено', () => {
    const { api } = slot();
    const leafNode = leaf({ kind: 'keywords', scope: [] }, 'matches', { kind: 'scalar', value: 'счёт' });
    const touched: number[] = [];
    const box = render(leafNode, api, ctx({ touch: () => touched.push(1) }));
    assert.equal(box.dataset['editor'], 'keywords');
    assert.ok(box.classList.contains(mod.FILTER_VALUE_OFF_CLASS), 'ни одной области — условие отключено');
    const scopes = all(box, 'ui-choice-row');
    assert.equal(scopes.length, 3, 'три области поиска');
    const checkbox = scopes[0]!.findAll((n) => n.tagName.toUpperCase() === 'INPUT')[0]!;
    checkbox.checked = true;
    checkbox.fire('change');
    assert.equal(touched.length, 1, 'правка вне значения уведомляет хост');
    assert.deepEqual(leafNode.entity.scope, ['title'], 'область записана в модель операнда');
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

  it('автор: одиночно — выбор пользователя, кратно — мультивыбор', () => {
    const single = render(leaf({ kind: 'author' }, 'eq'), slot().api);
    assert.ok(one(single, 'user-select-row') !== null);
    const many = render(leaf({ kind: 'author' }, 'in'), slot().api);
    assert.ok(one(many, 'user-chip-field') !== null);
  });

  it('датовый операнд: ячейка из опоры, сдвига и единицы с человекочитаемой подписью', () => {
    const box = render(leaf({ kind: 'created_at' }, 'gte', { kind: 'token', token: '$weekStart' }), slot().api);
    assert.equal(box.dataset['editor'], 'date');
    const anchor = box.findAll((n) => n.dataset['part'] === 'anchor')[0];
    assert.equal(anchor?.value, '$weekStart', 'опора — канонический токен (элемент 27b2a011)');
    assert.equal(box.findAll((n) => n.dataset['part'] === 'shift')[0]?.value, '', 'нулевой сдвиг — пустое поле');
    assert.equal(box.findAll((n) => n.dataset['part'] === 'unit')[0]?.value, 'd');
    assert.equal(one(box, mod.FILTER_VALUE_HINT_LABEL_CLASS)?.textContent, 'начало недели (пн)', 'показ — человекочитаемый');
    const options = all(box, mod.FILTER_VALUE_ANCHOR_CLASS)[0]?.findAll((n) => n.tagName.toUpperCase() === 'OPTION') ?? [];
    assert.ok(options.length > 0, 'список опор заполнен');
    assert.ok(one(box, 'date-field') !== null, 'точная дата — общее поле даты');
    // Легаси-ввод остаётся читаемым и приводится к канону (селект находит опору).
    const legacy = render(leaf({ kind: 'created_at' }, 'gte', { kind: 'token', token: '$week.start' }), slot().api);
    assert.equal(legacy.findAll((n) => n.dataset['part'] === 'anchor')[0]?.value, '$weekStart');
    assert.equal(one(legacy, mod.FILTER_VALUE_HINT_LABEL_CLASS)?.textContent, 'начало недели (пн)');
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

  it('перечисление: чекбоксы каталога, выбор собирает список кодов', () => {
    const { api, writes } = slot();
    const box = render(leaf({ kind: 'kind' }, 'in'), api);
    assert.equal(box.dataset['editor'], 'enum');
    const rows = all(box, 'ui-choice-row');
    assert.equal(rows.length, 2, 'файл/ссылка');
    const checkbox = rows[1]!.findAll((n) => n.tagName.toUpperCase() === 'INPUT')[0]!;
    checkbox.checked = true;
    checkbox.fire('change');
    assert.deepEqual(writes[0], { kind: 'list', items: ['url'] });
  });
});
