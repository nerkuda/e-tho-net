/**
 * Regression tests for the unified «Свойство / связь» dialog apply path
 * (карточка ошибки 9f579e69 — «Не сохраняется комментарий свойства»).
 *
 * Три слома, покрытые здесь со стороны клиента (серверную часть —
 * приём `name_forward`/`name_reverse` в PATCH /properties и `side` в
 * POST …/types/{id}/properties — покрывают серверные тесты):
 *
 * 1. Поле «Описание» не зеркалило ввод в черновик — PATCH уходил со старым
 *    описанием. Теперь textarea строит {@link buildDescriptionField}, и его
 *    слушатель копирует ввод в `draft.description` на каждый `input`.
 * 2. Тело PATCH собиралось инлайн в `apply` — перенесено в чистую
 *    {@link buildUpdateChanges}, которую можно проверить юнитом: описание,
 *    имена сторон и оформление попадают в changes ровно тогда, когда
 *    изменились.
 * 3. `applyTypeRows` вызывал `setPropertyDefaultOverride` для СОБСТВЕННОЙ
 *    привязки — сервер отвечает 422 «собственные свойства правятся в
 *    справочнике», apply падал и кнопка «Применить и закрыть» не давала
 *    эффекта. Предикат {@link shouldSetLinkDefaultOverride} разрешает
 *    override только для унаследованных строк.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { LinkStyle, LinkType } from '@etn/shared';

import {
  buildDescriptionField,
  buildUpdateChanges,
  defaultValueChanged,
  scalarDefaultPayload,
  shouldSetLinkDefaultOverride,
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
    definedOn: 'tt-1',
    dirty: false,
    overriddenHere: false,
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
// Дефолт целей: override допустим только для унаследованных привязок
// ---------------------------------------------------------------------------

describe('shouldSetLinkDefaultOverride — только для унаследованных привязок (9f579e69)', () => {
  it('собственная привязка (definedOn === тип) — false', () => {
    assert.equal(
      shouldSetLinkDefaultOverride(makeRow({ thoughtTypeId: 'tt-1', definedOn: 'tt-1' })),
      false,
    );
  });

  it('унаследованная привязка (definedOn — другой тип) — true', () => {
    assert.equal(
      shouldSetLinkDefaultOverride(makeRow({ thoughtTypeId: 'tt-1', definedOn: 'tt-ancestor' })),
      true,
    );
  });

  it('новая, ещё не сохранённая строка (definedOn: null) — false', () => {
    assert.equal(
      shouldSetLinkDefaultOverride(makeRow({ id: null, definedOn: null })),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Находки вехи 0, закрытые в вехе 4 (задача 77e7cafd)
// ---------------------------------------------------------------------------

describe('scalarDefaultPayload — скалярный дефолт для override (2d4b43df)', () => {
  it('строки, числа и булевы проходят; null — сброс', () => {
    assert.equal(scalarDefaultPayload('Москва'), 'Москва');
    assert.equal(scalarDefaultPayload(42), 42);
    assert.equal(scalarDefaultPayload(false), false);
    assert.equal(scalarDefaultPayload(null), null);
  });

  it('массивы, объекты и undefined — null (недопустимое значение)', () => {
    assert.equal(scalarDefaultPayload(['a']), null);
    assert.equal(scalarDefaultPayload({}), null);
    assert.equal(scalarDefaultPayload(undefined), null);
  });
});

describe('defaultValueChanged — override только при реальном изменении (2d4b43df)', () => {
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
