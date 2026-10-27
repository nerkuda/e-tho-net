/**
 * Чистая логика диалога «Изменить значение свойства…» панели выделения
 * (0.14.1, задача 6ebcd8d6; спека панели 2fc9d85c, сценарий a6b54f0f).
 *
 * Проверяется без DOM и сети: сбор строк по снимку чтения (union по
 * «свойство + сторона»), общее значение / «разные значения», счётчик
 * присутствия, план применения (галочка + значение / пусто / снята) и
 * dirty-снимок формы. Сценарий a6b54f0f, шаги 2–9 — прямой источник кейсов.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LinkPropertyValues, PropertyValue } from '@etn/shared';

import {
  buildBulkPropertyRows,
  bulkLinkEditorValue,
  bulkRowFromRegistry,
  bulkRowKey,
  clearingThoughtCount,
  commonBulkValue,
  emptyBulkPlanReason,
  isBulkFormDirty,
  planBulkApply,
  skippedBulkRows,
  splitMultiText,
  type BulkLinkType,
  type BulkPropertyRow,
  type BulkRegistryProperty,
  type BulkRowSelection,
  type BulkThought,
} from '../src/renderer/selection/property-bulk.js';

// ---------------------------------------------------------------------------
// Сборка DTO снимка
// ---------------------------------------------------------------------------

const THOUGHTS: BulkThought[] = [
  { id: 't-a', title: 'A' },
  { id: 't-b', title: 'B' },
  { id: 't-c', title: 'C' },
];

const LINK_TYPES: BulkLinkType[] = [
  { id: 'lt-attach', name_forward: 'Прикреплено', name_reverse: 'Прикреплено к' },
  { id: 'lt-sym', name_forward: 'см. также', name_reverse: 'см. также' },
];

function registry(
  overrides: Partial<BulkRegistryProperty> & Pick<BulkRegistryProperty, 'id' | 'name'>,
): BulkRegistryProperty {
  return {
    value_type: 'text',
    config: null,
    description: null,
    ...overrides,
  };
}

const REGISTRY: BulkRegistryProperty[] = [
  registry({ id: 'p-status', name: 'Статус' }),
  registry({ id: 'p-owner', name: 'Ответственный' }),
  registry({
    id: 'p-attach',
    name: 'Прикреплено',
    value_type: 'link',
    config: { link_type_id: 'lt-attach' },
    binding_source_type_ids: ['tt-person'],
    binding_target_type_ids: ['tt-org'],
  }),
  registry({
    id: 'p-sym',
    name: 'см. также',
    value_type: 'link',
    config: { link_type_id: 'lt-sym' },
  }),
  registry({ id: 'p-urls', name: 'Ссылки', value_type: 'url', config: { multiple: true } }),
  registry({ id: 'p-tags', name: 'Теги', value_type: 'text', config: { multiple: true } }),
  registry({ id: 'p-flag', name: 'Флаг', value_type: 'bool' }),
  // Структурное свойство-связь есть в реестре: строку отсекает признак
  // `entry.structural` чтения, а не промах «свойства нет в реестре».
  registry({
    id: 'p-structural',
    name: 'Родители',
    value_type: 'link',
    config: { structural: true },
  }),
];

/** Скалярное значение свойства. */
function scalar(
  ownerId: string,
  propertyId: string,
  propertyName: string,
  value: PropertyValue['value'],
  valueType: PropertyValue['value_type'] = 'text',
): PropertyValue {
  return {
    id: `pv-${ownerId}-${propertyId}`,
    owner_type: 'thought',
    owner_id: ownerId,
    property_id: propertyId,
    outside_type: true,
    property_name: propertyName,
    value_type: valueType,
    value,
    updated_at: '2026-10-23T00:00:00.000Z',
  };
}

/** Проекция рёбер свойства-связи. */
function linkValues(args: {
  ownerId: string;
  propertyId: string;
  propertyName: string;
  linkTypeId: string | null;
  side: 'source' | 'target';
  targets: Array<{ id: string; title?: string | null }>;
  structural?: boolean;
}): LinkPropertyValues {
  const direction = args.side === 'source' ? 'out' : 'in';
  return {
    id: args.propertyId,
    owner_type: 'thought',
    owner_id: args.ownerId,
    property_id: args.propertyId,
    outside_type: true,
    property_name: args.propertyName,
    value_type: 'link',
    direction,
    side: args.side,
    link_type_id: args.linkTypeId,
    structural: args.structural === true,
    count: args.targets.length,
    values: args.targets.map((target, index) => ({
      link_id: `l-${args.ownerId}-${args.propertyId}-${index}`,
      target_id: target.id,
      target_title: target.title === undefined ? target.id : target.title,
      target_type_id: null,
      comment: null,
    })),
  };
}

type Entry = PropertyValue | LinkPropertyValues;

function valueMap(entries: Record<string, Entry[]>): Map<string, Entry[]> {
  return new Map(Object.entries(entries));
}

/** Снимок из предусловий сценария a6b54f0f (шаг 2). */
function scenarioSnapshot(): Map<string, Entry[]> {
  return valueMap({
    't-a': [
      scalar('t-a', 'p-status', 'Статус', 'в работе'),
      linkValues({
        ownerId: 't-a',
        propertyId: 'p-attach',
        propertyName: 'Прикреплено',
        linkTypeId: 'lt-attach',
        side: 'source',
        targets: [{ id: 't-m', title: 'M' }],
      }),
    ],
    't-b': [
      scalar('t-b', 'p-status', 'Статус', 'в работе'),
      scalar('t-b', 'p-owner', 'Ответственный', 'Иван'),
    ],
    't-c': [scalar('t-c', 'p-owner', 'Ответственный', 'Пётр')],
  });
}

function rowsOf(snapshot: Map<string, Entry[]>): BulkPropertyRow[] {
  return buildBulkPropertyRows({
    thoughts: THOUGHTS,
    registry: REGISTRY,
    linkTypes: LINK_TYPES,
    values: snapshot,
  });
}

function rowByKey(rows: BulkPropertyRow[], key: string): BulkPropertyRow {
  const row = rows.find((candidate) => candidate.key === key);
  assert.ok(row !== undefined, `строка ${key} есть в таблице`);
  return row!;
}

function mark(rows: BulkPropertyRow[], key: string, checked: boolean, value: unknown | null): BulkRowSelection {
  const row = rowByKey(rows, key);
  assert.equal(row.key, bulkRowKey(row.propertyId, row.side), 'ключ строки канонический');
  return { key, checked, value };
}

// ---------------------------------------------------------------------------
// Сбор строк
// ---------------------------------------------------------------------------

describe('строки таблицы: union по (свойство, сторона)', () => {
  it('собирает свойства из значений, а не из типов: scalar + две стороны связи', () => {
    const snapshot = valueMap({
      't-a': [
        scalar('t-a', 'p-status', 'Статус', 'в работе'),
        linkValues({
          ownerId: 't-a',
          propertyId: 'p-attach',
          propertyName: 'Прикреплено',
          linkTypeId: 'lt-attach',
          side: 'source',
          targets: [{ id: 't-m', title: 'M' }],
        }),
      ],
      't-b': [
        scalar('t-b', 'p-status', 'Статус', 'в работе'),
        linkValues({
          ownerId: 't-b',
          propertyId: 'p-attach',
          propertyName: 'Прикреплено',
          linkTypeId: 'lt-attach',
          side: 'target',
          targets: [{ id: 't-n', title: 'N' }],
        }),
      ],
      't-c': [],
    });
    const rows = rowsOf(snapshot);
    assert.deepEqual(
      rows.map((row) => row.key),
      ['p-attach:source', 'p-attach:target', 'p-status'],
      'скаляр и обе стороны одной связи — отдельные строки, стороны подряд',
    );
    assert.deepEqual(
      rows.map((row) => row.name),
      ['Прикреплено', 'Прикреплено к', 'Статус'],
      'у связи имя стороны — из каталога типов связей; сортировка по имени свойства',
    );
    assert.deepEqual(
      rows.find((row) => row.key === 'p-attach:source')!.definition.allowed_opposite_type_ids,
      ['tt-org'],
      'source-строка: допустимые цели — типы привязок стороны назначения',
    );
    assert.deepEqual(
      rows.find((row) => row.key === 'p-attach:target')!.definition.allowed_opposite_type_ids,
      ['tt-person'],
      'target-строка: допустимые источники — типы привязок стороны источника',
    );
  });

  it('исключает структурные «Родители»/«Потомки» и рёбра без реестрового свойства', () => {
    assert.ok(
      REGISTRY.some(
        (property) => property.id === 'p-structural' && property.config?.structural === true,
      ),
      'фикстура: p-structural есть в реестре — строку отсекает entry.structural, а не отсутствие свойства',
    );
    const snapshot = valueMap({
      't-a': [
        linkValues({
          ownerId: 't-a',
          propertyId: 'p-attach',
          propertyName: 'Прикреплено',
          linkTypeId: 'lt-attach',
          side: 'source',
          targets: [{ id: 't-m' }],
        }),
        linkValues({
          ownerId: 't-a',
          propertyId: 'p-structural',
          propertyName: 'Родители',
          linkTypeId: null,
          side: 'source',
          targets: [{ id: 't-b' }],
          structural: true,
        }),
        linkValues({
          ownerId: 't-a',
          propertyId: '',
          propertyName: 'прикреплено',
          linkTypeId: null,
          side: 'source',
          targets: [{ id: 't-c' }],
        }),
        scalar('t-a', '', 'легаси', 'x'),
      ],
    });
    const rows = rowsOf(snapshot);
    assert.deepEqual(
      rows.map((row) => row.key),
      ['p-attach:source'],
      'структурное, ребро без свойства и значение без property_id не попадают в таблицу',
    );
  });

  it('свойство, которого нет в реестре, не показывается (запись по имени невозможна)', () => {
    const snapshot = valueMap({
      't-a': [scalar('t-a', 'p-ghost', 'Призрак', 'x')],
    });
    assert.deepEqual(rowsOf(snapshot), []);
  });

  it('нулевой счётчик рёбер не означает «значение есть»', () => {
    const snapshot = valueMap({
      't-a': [
        linkValues({
          ownerId: 't-a',
          propertyId: 'p-attach',
          propertyName: 'Прикреплено',
          linkTypeId: 'lt-attach',
          side: 'source',
          targets: [],
        }),
      ],
    });
    assert.equal(rowsOf(snapshot).length, 0, 'нет рёбер — нет строки');
  });

  it('сортирует по имени реестрового свойства, стороны подряд', () => {
    const snapshot = valueMap({
      't-a': [
        linkValues({
          ownerId: 't-a',
          propertyId: 'p-attach',
          propertyName: 'Прикреплено',
          linkTypeId: 'lt-attach',
          side: 'target',
          targets: [{ id: 't-m' }],
        }),
        linkValues({
          ownerId: 't-a',
          propertyId: 'p-attach-src',
          propertyName: 'Прикреплено',
          linkTypeId: 'lt-attach',
          side: 'source',
          targets: [{ id: 't-n' }],
        }),
        scalar('t-a', 'p-status', 'Статус', 'x'),
      ],
    });
    const registryWithSecond = [
      ...REGISTRY,
      registry({
        id: 'p-attach-src',
        name: 'Прикреплено',
        value_type: 'link',
        config: { link_type_id: 'lt-attach2' },
      }),
    ];
    const rows = buildBulkPropertyRows({
      thoughts: THOUGHTS,
      registry: registryWithSecond,
      linkTypes: [...LINK_TYPES, { id: 'lt-attach2', name_forward: 'Прикреплено', name_reverse: 'Прикреплено к' }],
      values: snapshot,
    });
    assert.deepEqual(
      rows.map((row) => row.key),
      ['p-attach-src:source', 'p-attach:target', 'p-status'],
      'одинаковое имя реестра — сторона source раньше target',
    );
  });
});

// ---------------------------------------------------------------------------
// Общее значение / «разные значения» / счётчик
// ---------------------------------------------------------------------------

describe('общее значение и счётчик присутствия', () => {
  it('отсутствие у части мыслей не делает значение «разным» (шаг 2 сценария)', () => {
    const rows = rowsOf(scenarioSnapshot());
    const status = rowByKey(rows, 'p-status');
    assert.equal(status.presentCount, 2);
    assert.equal(status.totalCount, 3);
    assert.equal(status.uniform, true);
    assert.equal(status.value, 'в работе', 'наличные одинаковы — значение в поле');
    assert.deepEqual(status.presentIds, ['t-a', 't-b'], 'адресаты очистки — только где было');
  });

  it('разные наличные — «разные значения» (поле пустое), у единственного наличного значение есть', () => {
    const rows = rowsOf(scenarioSnapshot());
    const owner = rowByKey(rows, 'p-owner');
    assert.equal(owner.presentCount, 2);
    assert.equal(owner.uniform, false);
    assert.equal(owner.value, null, 'разные значения — поле пустое');
    assert.equal(owner.presentIds.length, 2);

    const attach = rowByKey(rows, 'p-attach:source');
    assert.equal(attach.presentCount, 1);
    assert.equal(attach.uniform, true);
    assert.deepEqual(attach.value, ['t-m'], 'единственное наличное значение показывается');
    assert.equal(attach.linkTitles.get('t-m'), 'M', 'подпись цели для чипа');
  });

  it('множественные url сравниваются как множества без учёта порядка', () => {
    const snapshot = valueMap({
      't-a': [scalar('t-a', 'p-urls', 'Ссылки', ['https://a', 'https://b'], 'url')],
      't-b': [scalar('t-b', 'p-urls', 'Ссылки', ['https://b', 'https://a'], 'url')],
      't-c': [],
    });
    const row = rowByKey(rowsOf(snapshot), 'p-urls');
    assert.equal(row.uniform, true, 'порядок не значим');
    assert.deepEqual(row.value, ['https://a', 'https://b'], 'отдаётся хранимая форма первого');
  });

  it('множественный text (comma-joined) сравнивается как множество', () => {
    const snapshot = valueMap({
      't-a': [scalar('t-a', 'p-tags', 'Теги', 'один, два')],
      't-b': [scalar('t-b', 'p-tags', 'Теги', 'два, один')],
    });
    const row = rowByKey(rowsOf(snapshot), 'p-tags');
    assert.equal(row.uniform, true);
    assert.deepEqual(splitMultiText('один, два'), ['один', 'два']);
  });

  it('наборы целей связи сравниваются без учёта порядка', () => {
    const snapshot = valueMap({
      't-a': [
        linkValues({
          ownerId: 't-a',
          propertyId: 'p-attach',
          propertyName: 'Прикреплено',
          linkTypeId: 'lt-attach',
          side: 'source',
          targets: [{ id: 't-m' }, { id: 't-n' }],
        }),
      ],
      't-b': [
        linkValues({
          ownerId: 't-b',
          propertyId: 'p-attach',
          propertyName: 'Прикреплено',
          linkTypeId: 'lt-attach',
          side: 'source',
          targets: [{ id: 't-n' }, { id: 't-m' }],
        }),
      ],
    });
    const row = rowByKey(rowsOf(snapshot), 'p-attach:source');
    assert.equal(row.uniform, true, 'тот же набор целей в другом порядке — общее значение');
  });

  it('bool false — значение, а не «пусто»', () => {
    const common = commonBulkValue('bool', null, [false, false]);
    assert.equal(common.uniform, true);
    assert.equal(common.value, false);
    assert.equal(commonBulkValue('bool', null, [false, true]).uniform, false);
  });

  it('строка (+), добавленная из справочника: связь несёт ограничение по привязкам (f8f8fa49)', () => {
    const row = bulkRowFromRegistry(
      REGISTRY.find((property) => property.id === 'p-attach')!,
      'source',
      LINK_TYPES,
      3,
    );
    assert.deepEqual(row.definition.allowed_opposite_type_ids, ['tt-org']);
    assert.equal(
      'allowed_target_type_ids' in (row.definition.config ?? {}),
      false,
      'legacy-ключи config к определению не примешиваются',
    );
  });

  it('ограничение цели строки — с ПРОТИВОПОЛОЖНОЙ стороны, своей у каждой (уточнение d9bc6012)', () => {
    // Живой поиск цели массового диалога фильтруется по
    // `allowed_opposite_type_ids` выбранной стороны (уточнение заказчика:
    // «редактируешь версию — поиск показывает только версии»; ограничение
    // относится к ЦЕЛИ, не к владельцу — ADR cb95fb4e).
    const both = registry({
      id: 'p-version',
      name: 'версия',
      value_type: 'link',
      config: { link_type_id: 'lt-attach' },
      binding_source_type_ids: ['tt-task'],
      binding_target_type_ids: ['tt-version'],
    });
    const forward = bulkRowFromRegistry(both, 'source', LINK_TYPES, 3);
    const reverse = bulkRowFromRegistry(both, 'target', LINK_TYPES, 3);
    assert.deepEqual(
      forward.definition.allowed_opposite_type_ids,
      ['tt-version'],
      'прямая строка: допустимые цели — типы target-привязок',
    );
    assert.deepEqual(
      reverse.definition.allowed_opposite_type_ids,
      ['tt-task'],
      'обратная строка: допустимые источники — типы source-привязок',
    );
  });

  it('строка, добавленная через (+), пустая и с нулевым присутствием', () => {
    const row = bulkRowFromRegistry(
      REGISTRY.find((property) => property.id === 'p-owner')!,
      null,
      LINK_TYPES,
      3,
    );
    assert.equal(row.key, 'p-owner');
    assert.equal(row.presentCount, 0);
    assert.equal(row.presentIds.length, 0);
    assert.equal(row.value, null);
    assert.equal(row.totalCount, 3);
  });
});

// ---------------------------------------------------------------------------
// План применения
// ---------------------------------------------------------------------------

describe('план применения (галочка × строка)', () => {
  it('галочка + значение — set ВСЕМ, включая мысли без свойства', () => {
    const rows = rowsOf(scenarioSnapshot());
    const ops = planBulkApply(rows, [mark(rows, 'p-status', true, 'готово')], THOUGHTS.map((t) => t.id));
    assert.equal(ops.length, 3, 'по операции на каждую выделенную мысль');
    assert.ok(ops.every((op) => op.kind === 'set' && op.value === 'готово'));
    assert.deepEqual(
      ops.map((op) => op.thoughtId),
      ['t-a', 't-b', 't-c'],
      'значение получает и C, у которой свойства не было (станет внетиповым)',
    );
    assert.equal(ops[0]!.propertyKey, 'Статус', 'ключ записи — имя реестрового свойства');
  });

  it('галочка + пусто — remove только там, где было', () => {
    const rows = rowsOf(scenarioSnapshot());
    const ops = planBulkApply(rows, [mark(rows, 'p-owner', true, null)], THOUGHTS.map((t) => t.id));
    assert.equal(ops.length, 2, 'B и C, у A значения не было');
    assert.ok(ops.every((op) => op.kind === 'remove'));
    assert.deepEqual(ops.map((op) => op.thoughtId), ['t-b', 't-c']);
  });

  it('снятая галочка — ничего не применяется', () => {
    const rows = rowsOf(scenarioSnapshot());
    const ops = planBulkApply(rows, [mark(rows, 'p-status', false, 'архив')], THOUGHTS.map((t) => t.id));
    assert.deepEqual(ops, []);
  });

  it('связь: set получает набор целей, remove — сторону строки', () => {
    const rows = rowsOf(scenarioSnapshot());
    const setOps = planBulkApply(
      rows,
      [mark(rows, 'p-attach:source', true, ['t-n'])],
      ['t-a'],
    );
    assert.equal(setOps[0]!.kind, 'set');
    assert.deepEqual(setOps[0]!.value, ['t-n']);
    assert.equal(setOps[0]!.side, 'source');

    const removeOps = planBulkApply(
      rows,
      [mark(rows, 'p-attach:source', true, null)],
      ['t-a', 't-b'],
    );
    assert.deepEqual(removeOps.map((op) => op.thoughtId), ['t-a'], 'у B этого значения не было');
    assert.equal(removeOps[0]!.side, 'source', 'очистка адресует сторону');
  });

  it('связь-сторона target: план адресует сторону, ключ — имя ЭТОЙ стороны (d9bc6012)', () => {
    const snapshot = valueMap({
      't-b': [
        linkValues({
          ownerId: 't-b',
          propertyId: 'p-attach',
          propertyName: 'Прикреплено к',
          linkTypeId: 'lt-attach',
          side: 'target',
          targets: [{ id: 't-m' }],
        }),
      ],
    });
    const rows = rowsOf(snapshot);
    const row = rowByKey(rows, 'p-attach:target');
    assert.equal(row.name, 'Прикреплено к', 'имя строки — обратное имя стороны');
    assert.equal(row.definition.key, 'Прикреплено к', 'ключ определения — имя той же стороны');

    const ops = planBulkApply(rows, [mark(rows, 'p-attach:target', true, ['t-n'])], ['t-b']);
    assert.equal(ops[0]!.side, 'target', 'запись адресует сторону строки');
    assert.equal(
      ops[0]!.propertyKey,
      'Прикреплено к',
      'пара «имя + сторона» согласована: реестровое «Прикреплено» адресовало бы source',
    );
    assert.deepEqual(ops[0]!.value, ['t-n']);
  });

  it('обе стороны одной связи: ключ записи каждой строки совпадает с её видимым именем', () => {
    const rows = [
      ...rowsOf(
        valueMap({
          't-a': [
            linkValues({
              ownerId: 't-a',
              propertyId: 'p-attach',
              propertyName: 'Прикреплено',
              linkTypeId: 'lt-attach',
              side: 'source',
              targets: [{ id: 't-n' }],
            }),
          ],
        }),
      ),
    ];
    const sourceRow = rowByKey(rows, 'p-attach:source');
    const targetRow = bulkRowFromRegistry(
      REGISTRY.find((property) => property.id === 'p-attach')!,
      'target',
      LINK_TYPES,
      3,
    );
    assert.equal(sourceRow.definition.key, 'Прикреплено');
    assert.equal(sourceRow.side, 'source');
    assert.equal(targetRow.definition.key, 'Прикреплено к');
    assert.equal(targetRow.side, 'target');

    const ops = planBulkApply(
      [...rows, targetRow],
      [
        mark(rows, 'p-attach:source', true, ['t-n']),
        { key: targetRow.key, checked: true, value: ['t-m'] },
      ],
      ['t-a'],
    );
    assert.deepEqual(
      ops.map((op) => [op.propertyKey, op.side]),
      [
        ['Прикреплено', 'source'],
        ['Прикреплено к', 'target'],
      ],
      'имя и сторона каждой операции берутся из одной строки',
    );
  });

  it('пустая строка из (+) с галочкой ничего не удаляет: K = 0', () => {
    const row = bulkRowFromRegistry(REGISTRY[0]!, null, LINK_TYPES, 3);
    const ops = planBulkApply([row], [{ key: row.key, checked: true, value: null }], ['t-a', 't-b']);
    assert.deepEqual(ops, []);
    assert.equal(clearingThoughtCount([row], [{ key: row.key, checked: true, value: null }]), 0);
  });

  it('типовое и внетиповое свойства планируются одинаково: происхождение в плане не участвует (bba5a7ce)', () => {
    // «Теги» — multiple text с наличным значением у одной мысли, «Статус» —
    // скаляр у другой. Признак «типовое/внетиповое» живёт только в чтении
    // (`outside_type`) и на план влиять не должен: заказчик видел потерю
    // именно типового multiple-свойства, но причиной была потеря значения
    // чип-редактора, а не фильтр по происхождению.
    const snapshot = valueMap({
      't-a': [scalar('t-a', 'p-tags', 'Теги', '+7 900, +7 901')],
      't-b': [scalar('t-b', 'p-status', 'Статус', 'в работе')],
    });
    const rows = rowsOf(snapshot);
    const ops = planBulkApply(
      rows,
      [
        mark(rows, 'p-tags', true, '+7 900, +7 901, +7 902'),
        mark(rows, 'p-status', true, 'готово'),
      ],
      THOUGHTS.map((thought) => thought.id),
    );
    const tags = ops.filter((op) => op.propertyKey === 'Теги');
    assert.equal(tags.length, 3, 'set — всем выделенным, независимо от наличия значения');
    assert.ok(tags.every((op) => op.kind === 'set' && op.value === '+7 900, +7 901, +7 902'));
    assert.equal(tags[0]!.propertyId, 'p-tags');
    assert.equal(tags[0]!.side, null);

    const status = ops.filter((op) => op.propertyKey === 'Статус');
    assert.equal(status.length, 3, 'скаляр ведёт себя так же');
    assert.ok(status.every((op) => op.kind === 'set' && op.value === 'готово'));
  });

  it('multiple url: набор массивом уходит в план как есть', () => {
    const snapshot = valueMap({
      't-a': [scalar('t-a', 'p-urls', 'Ссылки', ['https://a.test'], 'url')],
    });
    const rows = rowsOf(snapshot);
    const ops = planBulkApply(
      rows,
      [mark(rows, 'p-urls', true, ['https://a.test', 'https://b.test'])],
      ['t-a'],
    );
    assert.equal(ops.length, 1);
    assert.equal(ops[0]!.kind, 'set');
    assert.deepEqual(ops[0]!.value, ['https://a.test', 'https://b.test']);
  });

  it('multiple text: очистка снимает значение только там, где оно было', () => {
    const snapshot = valueMap({
      't-a': [scalar('t-a', 'p-tags', 'Теги', '+7 900')],
    });
    const rows = rowsOf(snapshot);
    const ops = planBulkApply(rows, [mark(rows, 'p-tags', true, null)], ['t-a', 't-b', 't-c']);
    assert.deepEqual(ops.map((op) => op.thoughtId), ['t-a']);
    assert.equal(ops[0]!.kind, 'remove');
  });

  it('пропущенные строки: отмечена, значение пусто, очищать нечего (K = 0)', () => {
    const rows = rowsOf(scenarioSnapshot());
    const emptyRow = bulkRowFromRegistry(REGISTRY[0]!, null, LINK_TYPES, 3);
    const skipped = skippedBulkRows([...rows, emptyRow], [
      mark(rows, 'p-status', true, 'готово'),
      { key: emptyRow.key, checked: true, value: null },
    ]);
    assert.deepEqual(skipped.map((row) => row.key), [emptyRow.key]);

    const selectionWithValue = [mark(rows, 'p-owner', true, null)];
    assert.equal(skippedBulkRows(rows, selectionWithValue).length, 0, 'K > 0 — будет очистка');
    assert.equal(
      skippedBulkRows(rows, [mark(rows, 'p-owner', false, null)]).length,
      0,
      'снятая галочка не пропущенная строка',
    );
    assert.equal(
      skippedBulkRows(rows, [mark(rows, 'p-owner', true, 'Пётр')]).length,
      0,
      'значение есть — строка применяется',
    );
  });

  it('счётчик очистки суммирует K отмеченных пустых строк', () => {
    const rows = rowsOf(scenarioSnapshot());
    const selection = [
      mark(rows, 'p-owner', true, null),
      mark(rows, 'p-status', false, null),
      mark(rows, 'p-attach:source', true, null),
    ];
    assert.equal(clearingThoughtCount(rows, selection), 3, '2 (Ответственный) + 1 (Прикреплено)');
  });

  it('причина пустого плана: мысли, строки, пустые значения (ошибка eca9f6d5)', () => {
    const rows = rowsOf(scenarioSnapshot());
    // Плана нет без выделенных мыслей — применять не к кому.
    assert.equal(emptyBulkPlanReason([mark(rows, 'p-status', true, 'готово')], 0), 'no-thoughts');
    // Плана нет без отмеченных строк (грязная только значением форма).
    assert.equal(emptyBulkPlanReason([mark(rows, 'p-status', false, 'архив')], 3), 'no-rows');
    // Строка отмечена, значение пусто, очищать нечего — K = 0.
    const emptyRow = bulkRowFromRegistry(REGISTRY[0]!, null, LINK_TYPES, 3);
    assert.equal(
      emptyBulkPlanReason([{ key: emptyRow.key, checked: true, value: null }], 3),
      'no-values',
    );
    // Среди отмеченных есть значение — план не пуст.
    assert.equal(emptyBulkPlanReason([mark(rows, 'p-status', true, 'готово')], 3), null);
    assert.equal(
      emptyBulkPlanReason(
        [mark(rows, 'p-owner', true, null), mark(rows, 'p-status', true, 'готово')],
        3,
      ),
      null,
      'пустая строка рядом со значением план не обнуляет',
    );
  });
});

// ---------------------------------------------------------------------------
// Dirty
// ---------------------------------------------------------------------------

describe('dirty формы от исходного снимка', () => {
  it('свежая форма не грязная', () => {
    const rows = rowsOf(scenarioSnapshot());
    const selection = rows.map((row) => ({ key: row.key, checked: false, value: row.value }));
    assert.equal(isBulkFormDirty(rows, selection), false);
  });

  it('галочка делает форму грязной', () => {
    const rows = rowsOf(scenarioSnapshot());
    const selection = [
      mark(rows, 'p-status', true, 'в работе'),
      mark(rows, 'p-owner', false, null),
    ];
    assert.equal(isBulkFormDirty(rows, selection), true);
  });

  it('введённое при снятой галочке значение — грязно; равное исходному — нет', () => {
    const rows = rowsOf(scenarioSnapshot());
    const edited = [
      mark(rows, 'p-status', false, 'архив'),
      mark(rows, 'p-owner', false, null),
    ];
    assert.equal(isBulkFormDirty(rows, edited), true, 'введённое без галочки потеряется');
    const unchanged = [
      mark(rows, 'p-status', false, 'в работе'),
      mark(rows, 'p-owner', false, null),
    ];
    assert.equal(isBulkFormDirty(rows, unchanged), false, 'значение равно общему');
  });

  it('порядок целей связи не делает форму грязной', () => {
    const snapshot = valueMap({
      't-a': [
        linkValues({
          ownerId: 't-a',
          propertyId: 'p-attach',
          propertyName: 'Прикреплено',
          linkTypeId: 'lt-attach',
          side: 'source',
          targets: [{ id: 't-m' }, { id: 't-n' }],
        }),
      ],
    });
    const rows = rowsOf(snapshot);
    const selection = [{ key: 'p-attach:source', checked: false, value: ['t-n', 't-m'] }];
    assert.equal(isBulkFormDirty(rows, selection), false);
  });
});

// ---------------------------------------------------------------------------
// Значение редактора связи
// ---------------------------------------------------------------------------

describe('значение редактора связи', () => {
  it('отдаёт рёбра-заготовки с подписями из чтения', () => {
    const row = rowByKey(rowsOf(scenarioSnapshot()), 'p-attach:source');
    const items = bulkLinkEditorValue(row, row.value);
    assert.deepEqual(
      items.map((item) => ({ target_id: item.target_id, target_title: item.target_title })),
      [{ target_id: 't-m', target_title: 'M' }],
      'редактор получает цель и её подпись',
    );
  });
});
