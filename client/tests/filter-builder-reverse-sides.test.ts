/**
 * Тесты адресации обеих сторон свойства-связи в условиях отбора (задача
 * df992826, доработка по замечаниям приёмки).
 *
 * Хелпер `withReverseLinkPropertySides` живёт в едином конструкторе
 * (`lib/filter-builder.ts`) — он общий для двух потребителей: диалога отбора
 * типа мысли и панели «Структур» (стандарт S4 «Клиент: условия отбора — только
 * через общий конструктор»). Проверяется то, ради чего хелпер переписан:
 *
 *  1. каждая связь РЕЕСТРА (а не только цепочка редактируемого типа) даёт в
 *     списке имён условий ОБЕ стороны — прямую (запись по registry id) и
 *     обратную (синтетическая запись с ЧИСТЫМ именем, без служебных
 *     суффиксов);
 *  2. исключения: структурные свойства, связи без типа связи, совпадающие
 *     стороны и уже занятые имена;
 *  3. реестр с обратными сторонами пригоден для wire-конвертера: условие по
 *     обратному имени не выпадает из запроса (панель «Структур»).
 *
 * Чистые функции без DOM — обычный Node-прогон (как `filter-builder-shared`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LinkType, NetworkProperty } from '@etn/shared';

import {
  buildConditionsWire,
  defaultFilterCriteriaState,
  withReverseLinkPropertySides,
} from '../src/renderer/lib/filter-builder.js';

/** Строка реестра свойства-связи с минимально нужными полями. */
function linkProperty(id: string, name: string, linkTypeId: string): NetworkProperty {
  return {
    id,
    name,
    value_type: 'link',
    config: { link_type_id: linkTypeId },
    description: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  } as unknown as NetworkProperty;
}

/** Тип связи по паре имён. */
function linkType(id: string, forward: string, reverse: string): LinkType {
  return { id, name_forward: forward, name_reverse: reverse } as unknown as LinkType;
}

describe('withReverseLinkPropertySides — обе стороны связи в условиях отбора (задача df992826)', () => {
  it('каждая связь реестра даёт прямую и обратную стороны с чистыми именами', () => {
    // Сценарий приёмки (полигон, «Персональная KB №2»): в списке имён условий
    // были видны только прямые имена чужих связей.
    const linkTypes = [
      linkType('lt-cat', 'организации категории', 'категория организации'),
      linkType('lt-jobs', 'работники/контакты', 'место работы'),
      linkType('lt-place', 'что тут находится', 'местонахождение'),
    ];
    const registry = new Map<string, NetworkProperty>([
      ['p-cat', linkProperty('p-cat', 'организации категории', 'lt-cat')],
      ['p-jobs', linkProperty('p-jobs', 'работники/контакты', 'lt-jobs')],
      ['p-place', linkProperty('p-place', 'что тут находится', 'lt-place')],
    ]);

    const withSides = withReverseLinkPropertySides(registry, linkTypes);
    const names = [...withSides.values()].map((p) => p.name);

    // Прямые стороны — прежними записями по registry id (сохранённые отборы
    // не меняются).
    assert.equal(withSides.get('p-cat')?.name, 'организации категории');
    assert.equal(withSides.get('p-jobs')?.name, 'работники/контакты');
    assert.equal(withSides.get('p-place')?.name, 'что тут находится');

    // Обратные стороны присутствуют с ЧИСТЫМ именем свойства, без суффикса
    // «· обратная сторона», и адресуются по имени (сервер `resolveConditionPropertyRef`
    // резолвит сторону и берёт направление рёбер из имени).
    for (const [id, name] of [
      ['категория организации', 'категория организации'],
      ['место работы', 'место работы'],
      ['местонахождение', 'местонахождение'],
    ] as const) {
      const entry = withSides.get(id);
      assert.ok(entry, `обратная сторона «${name}» добавлена`);
      assert.equal(entry!.name, name, 'имя обратной стороны — чистое имя свойства');
      assert.equal(entry!.value_type, 'link');
      assert.ok(!entry!.name.includes('обратная сторона'), 'служебного суффикса нет');
    }
    // Обе записи каждой связи в списке имён.
    for (const name of ['организации категории', 'категория организации', 'работники/контакты', 'место работы']) {
      assert.ok(names.includes(name), `«${name}» в списке имён условий`);
    }
    // Входной реестр не мутируется.
    assert.equal(registry.size, 3);
    assert.equal(withSides.size, 6);
  });

  it('связь, чья запись реестра — обратное имя (direction in), даёт прямое имя', () => {
    // Реестр хранит имя стороны по `config.direction`: у `in` это `name_reverse`.
    // Обратная сторона в условии — прямое имя связи.
    const registry = new Map<string, NetworkProperty>([
      [
        'p-rev',
        {
          id: 'p-rev',
          name: 'категория организации',
          value_type: 'link',
          config: { link_type_id: 'lt-cat', direction: 'in' },
          description: null,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        } as unknown as NetworkProperty,
      ],
    ]);
    const withSides = withReverseLinkPropertySides(registry, [
      linkType('lt-cat', 'организации категории', 'категория организации'),
    ]);
    assert.equal(withSides.get('p-rev')?.name, 'категория организации');
    assert.equal(withSides.get('организации категории')?.name, 'организации категории');
  });

  it('совпадающие имена сторон не порождают дубля', () => {
    const registry = new Map<string, NetworkProperty>([
      ['p-sym', linkProperty('p-sym', 'связано', 'lt-sym')],
    ]);
    const withSides = withReverseLinkPropertySides(registry, [
      linkType('lt-sym', 'связано', 'связано'),
    ]);
    assert.equal(withSides.size, 1, 'имя-дубль не добавляется');
  });

  it('пропускает структурные свойства и связи без типа связи', () => {
    const structural = {
      id: 'p-children',
      name: 'Потомки',
      value_type: 'link',
      config: { structural: true, direction: 'out' },
      description: null,
      created_at: '',
      updated_at: '',
    } as unknown as NetworkProperty;
    const orphan = {
      id: 'p-orphan',
      name: 'повисшая связь',
      value_type: 'link',
      config: { link_type_id: 'lt-missing' },
      description: null,
      created_at: '',
      updated_at: '',
    } as unknown as NetworkProperty;
    const scalar = {
      id: 'p-text',
      name: 'заметка',
      value_type: 'text',
      config: null,
      description: null,
      created_at: '',
      updated_at: '',
    } as unknown as NetworkProperty;
    const registry = new Map<string, NetworkProperty>([
      [structural.id, structural],
      [orphan.id, orphan],
      [scalar.id, scalar],
    ]);

    const withSides = withReverseLinkPropertySides(registry, [
      linkType('lt-cat', 'организации категории', 'категория организации'),
    ]);
    assert.equal(withSides.size, 3, 'ни структурное, ни бестиповое, ни скаляр обратной стороны не дают');
  });

  it('не подменяет имя, уже занятое другой записью реестра', () => {
    // Обратное имя связи совпало с именем чужого свойства: коллизию сервер
    // отвергнет как неоднозначную — синтетическую запись не предлагаем.
    const registry = new Map<string, NetworkProperty>([
      ['p-jobs', linkProperty('p-jobs', 'работники/контакты', 'lt-jobs')],
      ['p-other', linkProperty('p-other', 'место работы', 'lt-other')],
    ]);
    const withSides = withReverseLinkPropertySides(registry, [
      linkType('lt-jobs', 'работники/контакты', 'место работы'),
      linkType('lt-other', 'место работы', 'нанят кем'),
    ]);
    // «место работы» остаётся записью чужака (`p-other`), а не подменяется
    // синтетической стороной `lt-jobs` — синтетического ключа нет вовсе.
    assert.equal(withSides.has('место работы'), false, 'занятое имя не перекрыто записью по имени');
    assert.equal(withSides.get('p-other')?.name, 'место работы');
    // Обратная сторона чужака добавлена по имени.
    assert.equal(withSides.get('нанят кем')?.id, 'нанят кем');
    assert.equal(withSides.get('нанят кем')?.config?.link_type_id, 'lt-other');
  });

  it('реестр с обратными сторонами пригоден wire-конвертеру (панель «Структур»)', () => {
    // Панель строит условие по имени обратной стороны; wire-конвертер обязан
    // найти свойство в реестре, иначе условие молча выпадет из запроса.
    const registry = withReverseLinkPropertySides(
      new Map<string, NetworkProperty>([['p-jobs', linkProperty('p-jobs', 'работники/контакты', 'lt-jobs')]]),
      [linkType('lt-jobs', 'работники/контакты', 'место работы')],
    );
    const state = {
      ...defaultFilterCriteriaState(),
      properties: [{ propertyId: 'место работы', op: 'eq' as const, values: ['$thought'] }],
    };
    const wire = buildConditionsWire(state, registry);
    assert.equal(wire.length, 1, 'условие по обратному имени сохранено');
    assert.equal(wire[0]!.property_id, 'место работы');
  });
});
