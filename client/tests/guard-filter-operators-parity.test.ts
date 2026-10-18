/**
 * Сторож паритета наборов операторов отбора (задача 19e7f439, ретро 0.13.1
 * п.5, кластер K2) — клиентская часть. Единый инвариант «один набор
 * операторов в реестре, справке, конструкторе и исполнителе» проверяется
 * двумя частями по пакетам: серверная
 * (`server/tests/guard-guide-filter-operators.test.ts`: справка ↔ реестр ↔
 * исполнитель ↔ ключи сортировки) и эта (конструктор ↔ реестр). Кросс-пакетный
 * импорт запрещён `rootDir` тестовых tsconfig — вместе части закрывают K2.
 *
 * ## Конструктор ↔ реестр
 *
 * Списки операторов AST-редактора читаются из общего реестра
 * (`filterProfileOperands`/`filterProfileOperators` → `@etn/shared`); своего
 * словаря у конструктора нет. Сторож сверяет выдачу конструктора с реестром
 * по КАЖДОМУ операнду и каждой природе свойства: правка реестра не может
 * молча разойтись с тем, что предлагает редактор.
 *
 * Отдельно — словарь плоской формы `OPS_BY_TYPE` (один словарь клиента,
 * `lib/filter-builder.ts`): он вправе быть УЖЕ реестра (легаси-панель
 * структур), но не вправе предлагать оператор, которого нет в наборе природы
 * свойства: «сохранил — исполнитель отверг» (класс 71f547c1/335b23cb).
 *
 * ## Ключи сортировки
 *
 * Секция сортировки строит словарь из единого набора `FILTER_SORTS` +
 * свойства реестра + ОБЕ стороны свойств-связей. Набор `FILTER_SORTS`
 * обязан совпадать с серверным `STRUCTURE_SORTS` (значения, которые
 * принимает `sort`/`order`), а движковые ключи AST — быть ровно
 * `title`/`created_at`/`updated_at` (у «по просмотру» ключа AST нет).
 * Серверная часть сторожа доказывает, что исполнитель принимает эти классы
 * ключей (прецедент 335b23cb).
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import {
  FILTER_PROFILES,
  PROPERTY_OPERATOR_SETS,
  SORT_ORDERS,
  STRUCTURE_SORTS,
  type LinkType,
  type NetworkProperty,
  type FilterAstEntityKind,
  type PropertyValueType,
} from '@etn/shared';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

type FilterBuilder = typeof import('../src/renderer/lib/filter-builder.js');
type FilterSort = typeof import('../src/renderer/lib/filter-sort.js');

let builder: FilterBuilder;
let sort: FilterSort;

/** Минимальный DOM-шим: `filter-sort.ts` тянет фасады дизайн-системы. */
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

before(async () => {
  installShim();
  builder = await import('../src/renderer/lib/filter-builder.js');
  sort = await import('../src/renderer/lib/filter-sort.js');
});

const PROFILE_IDS = Object.keys(FILTER_PROFILES) as Array<keyof typeof FILTER_PROFILES>;
const VALUE_TYPES = Object.keys(PROPERTY_OPERATOR_SETS) as PropertyValueType[];

// ---------------------------------------------------------------------------
// Конструктор AST ↔ реестр
// ---------------------------------------------------------------------------

describe('guard: конструктор AST читает наборы операторов из реестра (19e7f439)', () => {
  it('операнды каждого профиля — ровно реестр', () => {
    for (const profile of PROFILE_IDS) {
      assert.deepEqual(
        [...builder.filterProfileOperands(profile)],
        [...FILTER_PROFILES[profile].operands],
        `операнды профиля ${profile} разошлись с реестром`,
      );
    }
  });

  it('операторы каждого операнда — ровно реестр (все профили)', () => {
    for (const profile of PROFILE_IDS) {
      const sets = FILTER_PROFILES[profile].operand_operators;
      assert.ok(sets !== undefined, `у профиля ${profile} обязан быть набор операторов`);
      for (const [kind, expected] of Object.entries(sets)) {
        if (kind === 'property' && FILTER_PROFILES[profile].operand_operators_by_value_type) {
          // Полиморфный операнд проверяется по природе свойства ниже.
          continue;
        }
        assert.deepEqual(
          [...builder.filterProfileOperators(profile, kind as FilterAstEntityKind)],
          [...expected],
          `${profile}.${kind}: конструктор предлагает не то, что в реестре`,
        );
      }
    }
  });

  it('свойство по природе: конструктор отдаёт набор реестра (9bdddad6)', () => {
    for (const profile of ['thoughts', 'map', 'publications'] as const) {
      for (const valueType of VALUE_TYPES) {
        assert.deepEqual(
          [...builder.filterProfileOperators(profile, 'property', valueType)],
          [...PROPERTY_OPERATOR_SETS[valueType]],
          `${profile}.property:${valueType}: конструктор предлагает не то, что в реестре`,
        );
      }
    }
  });

  it('датовые операнды и свойство-дата несут «равно»/«не равно» (03db4cb0)', () => {
    for (const kind of ['created_at', 'updated_at'] as const) {
      const ops = builder.filterProfileOperators('thoughts', kind);
      assert.ok(ops.includes('eq'), `thoughts.${kind}: eq`);
      assert.ok(ops.includes('ne'), `thoughts.${kind}: ne`);
    }
    for (const kind of ['record_time'] as const) {
      const ops = builder.filterProfileOperators('chronicle', kind);
      assert.ok(ops.includes('eq'), `chronicle.${kind}: eq`);
      assert.ok(ops.includes('ne'), `chronicle.${kind}: ne`);
    }
    for (const kind of ['occurred_at'] as const) {
      const ops = builder.filterProfileOperators('events', kind);
      assert.ok(ops.includes('eq'), `events.${kind}: eq`);
      assert.ok(ops.includes('ne'), `events.${kind}: ne`);
    }
    assert.ok(PROPERTY_OPERATOR_SETS.date.includes('eq'), 'property:date: eq');
    assert.ok(PROPERTY_OPERATOR_SETS.date.includes('ne'), 'property:date: ne');
  });
});

// ---------------------------------------------------------------------------
// Плоский словарь конструктора (OPS_BY_TYPE) ⊆ реестр
// ---------------------------------------------------------------------------

describe('guard: словарь плоской формы не предлагает оператор вне реестра (19e7f439)', () => {
  it('покрывает ровно все виды значения', () => {
    assert.deepEqual(Object.keys(builder.OPS_BY_TYPE).sort(), [...VALUE_TYPES].sort());
  });

  it('оператор каждого вида значения входит в набор реестра этой природы', () => {
    for (const valueType of VALUE_TYPES) {
      const registry = new Set<string>(PROPERTY_OPERATOR_SETS[valueType]);
      const offered = builder.OPS_BY_TYPE[valueType].map((entry) => entry.op as string);
      assert.ok(offered.length > 0, `OPS_BY_TYPE.${valueType}: пустой список операторов`);
      for (const op of offered) {
        assert.ok(
          registry.has(op),
          `OPS_BY_TYPE.${valueType} предлагает «${op}», которого нет в наборе реестра`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Сортировка: конструктор ↔ единый набор
// ---------------------------------------------------------------------------

describe('guard: ключи сортировки конструктора совпадают с единым набором (335b23cb)', () => {
  it('FILTER_SORTS — ровно серверный STRUCTURE_SORTS', () => {
    assert.deepEqual(
      [...builder.FILTER_SORTS.map((option) => option.v)].sort(),
      [...STRUCTURE_SORTS].sort(),
      'конструктор и исполнитель разошлись в наборе сортировок',
    );
  });

  it('FILTER_ORDERS — ровно SORT_ORDERS', () => {
    assert.deepEqual(
      [...builder.FILTER_ORDERS.map((option) => option.v)].sort(),
      [...SORT_ORDERS].sort(),
    );
  });

  it('движковые ключи AST — title/created_at/updated_at, «по просмотру» невыразим', () => {
    assert.deepEqual(
      builder.filterSortAstKeys().map((entry) => entry.key).sort(),
      ['created_at', 'title', 'updated_at'],
    );
    for (const entry of builder.filterSortAstKeys()) {
      assert.notEqual(
        builder.filterSortFromAstKey(entry.key),
        null,
        `ключ ${entry.key} не читается обратно как сортировка панели`,
      );
    }
    assert.equal(builder.filterSortFromAstKey('viewed'), null, '«по просмотру» ключа AST не имеет');
    assert.equal(builder.filterSortFromAstKey('guard-unknown'), null);
  });

  it('словарь секции сортировки = движковые ключи + реестр + обе стороны свойств-связей', () => {
    const linkType = {
      id: 'lt-guard',
      name_forward: 'Готово',
      name_reverse: 'Сделано',
    } as unknown as LinkType;
    const text = {
      id: 'p-text',
      name: 'Заметка',
      value_type: 'text',
      config: null,
    } as unknown as NetworkProperty;
    const link = {
      id: 'p-link',
      name: 'Готово',
      value_type: 'link',
      config: { link_type_id: linkType.id },
    } as unknown as NetworkProperty;
    const registry = new Map<string, NetworkProperty>([
      [text.id, text],
      [link.id, link],
    ]);

    const options = sort.filterSortKeyOptions({ registry, linkTypes: [linkType] });
    const keys = options.map((option) => option.key);

    // Движковые ключи единого набора.
    for (const entry of builder.filterSortAstKeys()) {
      assert.ok(keys.includes(entry.key), `словарь сортировки потерял движковый ключ ${entry.key}`);
    }
    assert.ok(!keys.includes('viewed'), '«по просмотру» невыразим в AST и не должен попадать в словарь');
    // Свойства реестра и обратная сторона свойства-связи.
    assert.ok(keys.includes(text.id), 'словарь сортировки потерял свойство реестра');
    assert.ok(keys.includes(link.id), 'словарь сортировки потерял свойство-связь');
    assert.ok(keys.includes('Сделано'), 'словарь сортировки потерял обратную сторону свойства-связи');

    // Лишних ключей нет: ровно движковые + расширенный реестр.
    const extended = builder.withReverseLinkPropertySides(registry, [linkType]);
    const expected = new Set<string>([
      ...builder.filterSortAstKeys().map((entry) => entry.key),
      ...extended.keys(),
    ]);
    for (const key of keys) {
      assert.ok(expected.has(key), `словарь сортировки предлагает ключ вне единого набора: ${key}`);
    }
    assert.equal(keys.length, expected.size, 'словарь сортировки содержит не все ключи единого набора');
  });
});
