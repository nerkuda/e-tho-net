/**
 * Regression tests for the unified «Свойство / связь» dialog apply path
 * (карточка ошибки 9f579e69 — «Не сохраняется комментарий свойства»;
 * модель дефолтов 0.8.2 — тех.проект 43870285).
 *
 * Покрытие:
 *
 * 1. Поле «Описание» не зеркалило ввод в черновик — PATCH уходил со старым
 *    описанием. Теперь textarea строит {@link buildDescriptionField}, и его
 *    слушатель копирует ввод в `draft.description` на каждый `input`.
 * 2. Тело PATCH собиралось инлайн в `apply` — перенесено в чистую
 *    {@link buildUpdateChanges}: описание, имена сторон, оформление и оба
 *    общих значения свойства-связи попадают в changes ровно тогда, когда
 *    изменились.
 * 3. Дефолты привязок (0.8.2): приёмочный пример тех.проекта — чистая
 *    {@link collectDefaultOverrideOps} конвертирует черновик в операции
 *    `setPropertyDefaultOverride` (заполненные строки → значение, пустые →
 *    ничего, снятое значение существующей строки → `null`).
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { LinkStyle, LinkType } from '@etn/shared';

import {
  buildDescriptionField,
  buildUpdateChanges,
  collectDefaultOverrideOps,
  defaultValueChanged,
  isEmptyDefault,
  scalarDefaultPayload,
  syncLinkTypeParent,
  type PropertyDraft,
  type RegistryRow,
  type TypeRowDraft,
} from '../src/renderer/screens/property-manager.js';
import { store } from '../src/renderer/state.js';

// ---------------------------------------------------------------------------
// Фикстуры
// ---------------------------------------------------------------------------

function makeDraft(overrides: Partial<PropertyDraft> = {}): PropertyDraft {
  return {
    name: 'приоритет',
    description: 'старое описание',
    valueType: 'text',
    config: null,
    scalarKind: 'text',
    choiceOn: false,
    optionsText: '',
    multipleOn: false,
    nameForward: '',
    nameReverse: '',
    parentLinkTypeId: null,
    linkColor: null,
    linkStyle: null,
    linkWidth: null,
    showOnMap: false,
    blocksTargetDeletion: false,
    defaultValue: null,
    defaultValueTarget: null,
    typeRows: [],
    ...overrides,
  };
}

function makeCurrent(overrides: Partial<RegistryRow> = {}): RegistryRow {
  const base: RegistryRow = {
    id: 'prop-1',
    name: 'приоритет',
    value_type: 'text',
    config: null,
    description: 'старое описание',
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    types_count: 0,
    values_count: 0,
    ...overrides,
  };
  return base;
}

function makeRow(overrides: Partial<TypeRowDraft> = {}): TypeRowDraft {
  return {
    id: 'bind-1',
    thoughtTypeId: 'tt-1',
    required: false,
    defaultValue: null,
    side: 'source',
    dirty: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Поле «Описание» — зеркалирование ввода в черновик
// ---------------------------------------------------------------------------

/** Минимальный textarea-шим: value + addEventListener/dispatch. */
class ShimTextarea {
  value = '';
  rows = 0;
  placeholder = '';
  readonly listeners = new Map<string, Array<() => void>>();
  addEventListener(type: string, handler: () => void): void {
    let list = this.listeners.get(type);
    if (list === undefined) {
      list = [];
      this.listeners.set(type, list);
    }
    list.push(handler);
  }
  dispatch(type: string): void {
    const list = this.listeners.get(type);
    if (list === undefined) return;
    for (const handler of list) handler();
  }
}

describe('buildDescriptionField — input listener (9f579e69)', () => {
  const prevDocument = (globalThis as { document?: unknown }).document;

  afterEach(() => {
    (globalThis as { document?: unknown }).document = prevDocument;
  });

  it('ввод в textarea зеркалится в draft.description на каждый input', () => {
    (globalThis as { document?: unknown }).document = {
      createElement: (tag: string) => {
        assert.equal(tag, 'textarea');
        return new ShimTextarea();
      },
    };
    const draft = makeDraft();
    const field = buildDescriptionField(draft) as unknown as ShimTextarea;

    assert.equal(field.value, 'старое описание', 'поле предзаполнено из черновика');

    field.value = 'новое описание';
    field.dispatch('input');
    assert.equal(draft.description, 'новое описание');

    field.value = '';
    field.dispatch('input');
    assert.equal(draft.description, '', 'очистка поля тоже доходит до черновика');
  });
});

// ---------------------------------------------------------------------------
// Сборка тела PATCH
// ---------------------------------------------------------------------------

describe('buildUpdateChanges — тело PATCH из черновика (9f579e69)', () => {
  it('изменённое описание скалярного свойства попадает в changes.description', () => {
    const draft = makeDraft({ description: 'новое описание' });
    const changes = buildUpdateChanges(draft, makeCurrent());
    assert.equal(changes.name, 'приоритет');
    assert.equal(changes.description, 'новое описание');
    assert.equal('value_type' in changes, false);
  });

  it('без изменений тело содержит только name (ничего лишнего)', () => {
    const changes = buildUpdateChanges(makeDraft(), makeCurrent());
    assert.deepEqual(changes, { name: 'приоритет' });
  });

  it('очищенное описание уходит как null (сброс на сервере)', () => {
    const draft = makeDraft({ description: '   ' });
    const changes = buildUpdateChanges(draft, makeCurrent({ description: 'было' }));
    assert.equal(changes.description, null);
  });

  it('смена скалярного value_type попадает в changes.value_type', () => {
    const draft = makeDraft({ valueType: 'number', scalarKind: 'number' });
    const changes = buildUpdateChanges(draft, makeCurrent({ value_type: 'text' }));
    assert.equal(changes.value_type, 'number');
  });

  it('у свойства-связи имена сторон и оформление попадают в changes', () => {
    const draft = makeDraft({
      valueType: 'link',
      scalarKind: null,
      name: 'состоит в',
      nameForward: 'состоит в',
      nameReverse: 'включает',
      linkColor: '#123456',
      linkStyle: 'dashed' as LinkStyle,
      linkWidth: 3,
    });
    const changes = buildUpdateChanges(
      draft,
      makeCurrent({
        name: 'работает в',
        value_type: 'link',
        config: { direction: 'out', link_type_id: 'lt-1' },
      }),
    );
    assert.equal(changes.name, 'состоит в');
    assert.equal(changes.name_forward, 'состоит в');
    assert.equal(changes.name_reverse, 'включает');
    assert.equal(changes.link_color, '#123456');
    assert.equal(changes.link_style, 'dashed');
    assert.equal(changes.link_width, 3);
  });

  it('пустые/незаданные поля оформления связи в changes не попадают', () => {
    const draft = makeDraft({
      valueType: 'link',
      scalarKind: null,
      name: 'работает в',
      nameForward: 'работает в',
      nameReverse: 'сотрудники',
    });
    const changes = buildUpdateChanges(
      draft,
      makeCurrent({
        value_type: 'link',
        config: { direction: 'out', link_type_id: 'lt-1' },
      }),
    );
    assert.equal('link_color' in changes, false);
    assert.equal('link_style' in changes, false);
    assert.equal('link_width' in changes, false);
  });
});

// ---------------------------------------------------------------------------
// Дефолты привязок: черновик → операции (0.8.2, тех.проект 43870285)
// ---------------------------------------------------------------------------

describe('collectDefaultOverrideOps — дефолты привязок из черновика (0.8.2)', () => {
  it('приёмочный пример тех.проекта: свойство-связь «версия → работы версии»', () => {
    // Источники: задача — «99.99.99», ошибка — пусто, техпроект — «99.99.99»;
    // общее источников — пусто. Назначения: версия — три задачи в работах.
    const rows: TypeRowDraft[] = [
      makeRow({
        id: 'bind-task',
        thoughtTypeId: 'tt-task',
        side: 'source',
        defaultValue: ['v-99'],
        initialDefaultValue: null,
        dirty: true,
      }),
      makeRow({
        id: 'bind-err',
        thoughtTypeId: 'tt-error',
        side: 'source',
        defaultValue: null,
        initialDefaultValue: null,
        dirty: false,
      }),
      makeRow({
        id: 'bind-tp',
        thoughtTypeId: 'tt-techproject',
        side: 'source',
        defaultValue: ['v-99'],
        initialDefaultValue: null,
        dirty: true,
      }),
      makeRow({
        id: 'bind-version',
        thoughtTypeId: 'tt-version',
        side: 'target',
        defaultValue: ['t-1', 't-2', 't-3'],
        initialDefaultValue: null,
        dirty: true,
      }),
    ];
    const ops = collectDefaultOverrideOps(rows, /* isLink */ true);
    assert.deepEqual(
      ops.map((op) => [op.row.thoughtTypeId, op.value]),
      [
        ['tt-task', ['v-99']],
        ['tt-techproject', ['v-99']],
        ['tt-version', ['t-1', 't-2', 't-3']],
      ],
    );
  });

  it('пустые и незатронутые строки операций не порождают', () => {
    const untouched = makeRow({ id: 'bind-1', initialDefaultValue: null, dirty: false });
    const requiredOnly = makeRow({
      id: 'bind-2',
      initialDefaultValue: null,
      defaultValue: null,
      dirty: true,
    });
    assert.deepEqual(collectDefaultOverrideOps([untouched, requiredOnly], true), []);
  });

  it('снятое значение существующей привязки даёт null (сброс override)', () => {
    const ops = collectDefaultOverrideOps(
      [makeRow({ id: 'bind-1', defaultValue: null, initialDefaultValue: ['t-1'], dirty: true })],
      true,
    );
    assert.deepEqual(ops.map((op) => [op.row.id, op.value]), [['bind-1', null]]);
  });

  it('новая строка без id: заполненный дефолт — операция, пустой — нет', () => {
    const filled = makeRow({ id: null, thoughtTypeId: 'tt-a', defaultValue: ['t-1'], dirty: true });
    const empty = makeRow({ id: null, thoughtTypeId: 'tt-b', defaultValue: null, dirty: true });
    const ops = collectDefaultOverrideOps([filled, empty], true);
    assert.deepEqual(
      ops.map((op) => [op.row.thoughtTypeId, op.value]),
      [['tt-a', ['t-1']]],
    );
  });

  it('скаляр: значение по виду свойства, снятое значение — null', () => {
    const ops = collectDefaultOverrideOps(
      [
        makeRow({ id: 'bind-1', defaultValue: 'Москва', initialDefaultValue: null, dirty: true }),
        makeRow({ id: 'bind-2', defaultValue: null, initialDefaultValue: 'Питер', dirty: true }),
      ],
      /* isLink */ false,
    );
    assert.deepEqual(
      ops.map((op) => [op.row.id, op.value]),
      [
        ['bind-1', 'Москва'],
        ['bind-2', null],
      ],
    );
  });
});

describe('isEmptyDefault — пустая ячейка колонки дефолта (0.8.2)', () => {
  it('null, undefined, пустая строка и пустой набор — пусто', () => {
    assert.equal(isEmptyDefault(null), true);
    assert.equal(isEmptyDefault(undefined), true);
    assert.equal(isEmptyDefault(''), true);
    assert.equal(isEmptyDefault([]), true);
  });

  it('заполненное скалярное значение и непустой набор — не пусто', () => {
    assert.equal(isEmptyDefault('Москва'), false);
    assert.equal(isEmptyDefault(0), false);
    assert.equal(isEmptyDefault(false), false);
    assert.equal(isEmptyDefault(['t-1']), false);
  });
});

describe('общие значения сторон в PATCH /properties (0.8.2)', () => {
  it('свойство-связь: источники → config.default_value, назначения → config.default_value_target', () => {
    const draft = makeDraft({
      valueType: 'link',
      scalarKind: null,
      name: 'версия',
      nameForward: 'версия',
      nameReverse: 'работы версии',
      defaultValue: ['v-1'],
      defaultValueTarget: ['t-1', 't-2'],
    });
    const changes = buildUpdateChanges(
      draft,
      makeCurrent({ value_type: 'link', config: { direction: 'out', link_type_id: 'lt-1' } }),
    );
    assert.deepEqual(changes.config?.default_value, ['v-1']);
    assert.deepEqual(changes.config?.default_value_target, ['t-1', 't-2']);
  });

  it('очищенные общие значения в конфиг не пишутся (PATCH заменяет конфиг целиком)', () => {
    const draft = makeDraft({
      valueType: 'link',
      scalarKind: null,
      name: 'версия',
      nameForward: 'версия',
      nameReverse: 'работы версии',
      defaultValue: null,
      defaultValueTarget: null,
    });
    const changes = buildUpdateChanges(
      draft,
      makeCurrent({
        value_type: 'link',
        config: { direction: 'out', link_type_id: 'lt-1', default_value: ['v-1'], default_value_target: ['t-1'] },
      }),
    );
    assert.equal('default_value' in (changes.config ?? {}), false);
    assert.equal('default_value_target' in (changes.config ?? {}), false);
  });
});

// ---------------------------------------------------------------------------
// Находки вехи 0, закрытые в вехе 4 (задача 77e7cafd)
// ---------------------------------------------------------------------------

describe('scalarDefaultPayload — скалярный дефолт для override', () => {
  it('строки, числа и булевы проходят; null — сброс', () => {
    assert.equal(scalarDefaultPayload('Москва'), 'Москва');
    assert.equal(scalarDefaultPayload(42), 42);
    assert.equal(scalarDefaultPayload(false), false);
    assert.equal(scalarDefaultPayload(null), null);
  });

  it('пустая строка — тоже сброс (осмысленного дефолта не несёт)', () => {
    assert.equal(scalarDefaultPayload(''), null);
  });

  it('массивы, объекты и undefined — null (недопустимое значение)', () => {
    assert.equal(scalarDefaultPayload(['a']), null);
    assert.equal(scalarDefaultPayload({}), null);
    assert.equal(scalarDefaultPayload(undefined), null);
  });
});

describe('defaultValueChanged — override только при реальном изменении', () => {
  it('изменённое значение — true', () => {
    assert.equal(
      defaultValueChanged(makeRow({ defaultValue: 'Москва', initialDefaultValue: null })),
      true,
    );
    assert.equal(
      defaultValueChanged(makeRow({ defaultValue: null, initialDefaultValue: 'Москва' })),
      true,
    );
  });

  it('неизменённое значение — false', () => {
    assert.equal(
      defaultValueChanged(makeRow({ defaultValue: 'Москва', initialDefaultValue: 'Москва' })),
      false,
    );
    assert.equal(
      defaultValueChanged(makeRow({ defaultValue: null, initialDefaultValue: null })),
      false,
    );
  });

  it('без снимка (строка добавлена вручную) — false', () => {
    const row = makeRow({ defaultValue: 'Москва' });
    assert.equal(row.initialDefaultValue, undefined, 'fixture has no snapshot');
    assert.equal(defaultValueChanged(row), false);
  });
});

describe('syncLinkTypeParent — родительский тип связи (d56c1ae4)', () => {
  interface UpdateCall {
    id: string;
    input: unknown;
    version: number;
  }

  /** Ставит мок etn.types с фиксацией PATCH-вызовов (Proxy читает window.etn). */
  function installEtn(
    calls: UpdateCall[],
    extra: { getLinkType?: LinkType } = {},
  ): void {
    (globalThis as { window?: unknown }).window = {
      etn: {
        types: {
          updateLinkType: async (
            _nid: string,
            id: string,
            input: unknown,
            version: number,
          ) => {
            calls.push({ id, input, version });
            return {};
          },
          getLinkType: async () => {
            if (extra.getLinkType !== undefined) return extra.getLinkType;
            throw new Error('getLinkType не должен вызываться');
          },
        },
      },
    };
  }

  function makeLinkType(id: string, parentId: string | null, version: number): LinkType {
    return {
      id,
      name_forward: 'состоит в',
      name_reverse: 'включает',
      parent_id: parentId,
      is_root: false,
      color: null,
      style: null,
      width: null,
      description: null,
      version,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      created_by: 'u1',
    };
  }

  afterEach(() => {
    store.update({ linkTypes: [] });
    delete (globalThis as { window?: unknown }).window;
  });

  it('при изменении родителя шлёт PATCH /link-types/{id} с parent_id и версией из каталога', async () => {
    const calls: UpdateCall[] = [];
    installEtn(calls);
    store.update({ linkTypes: [makeLinkType('lt-1', null, 3)] });
    const draft = makeDraft({ valueType: 'link', parentLinkTypeId: 'lt-root' });
    await syncLinkTypeParent(
      'n1',
      makeCurrent({ value_type: 'link', config: { direction: 'out', link_type_id: 'lt-1' } }),
      draft,
    );
    assert.deepEqual(calls, [
      { id: 'lt-1', input: { parent_id: 'lt-root' }, version: 3 },
    ]);
  });

  it('родитель не менялся — PATCH не шлётся', async () => {
    const calls: UpdateCall[] = [];
    installEtn(calls);
    store.update({ linkTypes: [makeLinkType('lt-1', 'lt-root', 3)] });
    const draft = makeDraft({ valueType: 'link', parentLinkTypeId: 'lt-root' });
    await syncLinkTypeParent(
      'n1',
      makeCurrent({ value_type: 'link', config: { direction: 'out', link_type_id: 'lt-1' } }),
      draft,
    );
    assert.deepEqual(calls, []);
  });

  it('не свойство-связь или нет link_type_id — PATCH не шлётся', async () => {
    const calls: UpdateCall[] = [];
    installEtn(calls);
    await syncLinkTypeParent('n1', makeCurrent(), makeDraft({ valueType: 'text' }));
    await syncLinkTypeParent(
      'n1',
      makeCurrent({ value_type: 'link', config: { direction: 'out' } }),
      makeDraft({ valueType: 'link' }),
    );
    assert.deepEqual(calls, []);
  });

  it('типа нет в каталоге — догрузка getLinkType, затем PATCH', async () => {
    const calls: UpdateCall[] = [];
    installEtn(calls, { getLinkType: makeLinkType('lt-9', null, 7) });
    store.update({ linkTypes: [] });
    const draft = makeDraft({ valueType: 'link', parentLinkTypeId: 'lt-root' });
    await syncLinkTypeParent(
      'n1',
      makeCurrent({ value_type: 'link', config: { direction: 'out', link_type_id: 'lt-9' } }),
      draft,
    );
    assert.deepEqual(calls, [
      { id: 'lt-9', input: { parent_id: 'lt-root' }, version: 7 },
    ]);
  });
});
