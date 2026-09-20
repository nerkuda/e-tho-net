/**
 * Тесты списка «Добавить свойство» редактора типа (задача 298fe6f3 —
 * «Добавление свойства-связи в типе мысли: выбор конкретного имени без
 * диалога стороны привязки»; задача 6ebde54e — список переведён на общий
 * компонент `lib/property-list.ts` в режиме пикера).
 *
 * Было (ошибка 4251fbe5): строка списка — свойство реестра, и ПОСЛЕ выбора
 * свойства-связи открывался диалог «Сторона привязки» с техническими именами
 * `name_forward`/`name_reverse`.
 *
 * Стало: строка списка — конкретное ИМЯ свойства; у свойства-связи строк две —
 * прямое имя (`name_forward`, сторона `source`) и обратное (`name_reverse`,
 * сторона `target`). Выбранное имя однозначно задаёт сторону, диалога стороны
 * нет вовсе. Модель строк общая с менеджером свойств (`buildPropertyListRows`),
 * а блокировка подключённых имён — `rowBlockReason` (правила 0.8.2 сохранены).
 *
 * Pure logic — no DOM (client tests run without jsdom, per the existing
 * convention):
 *  - {@link buildPropertyListRows} — пара имён одной связи и одна строка скаляра;
 *  - {@link rowBlockReason} — уже подключённое имя не предлагается повторно,
 *    второе имя той же связи остаётся доступным;
 *  - {@link attachDraftFromExisting} — выбранное имя определяет `side`;
 *  - сторож исходника: диалога «Сторона привязки» и параллельного построителя
 *    строк в type-manager нет.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { attachDraftFromExisting, sideLabel } from '../src/renderer/screens/type-manager.js';
import type { RegistryRow } from '../src/renderer/screens/property-manager.js';
import {
  buildPropertyListRows,
  rowBlockReason,
  type PropertyListRow,
} from '../src/renderer/lib/property-list.js';
import {
  nextDraftPropertyId,
  opToAttachInput,
  planPropertyDiff,
} from '../src/renderer/lib/type-property-draft.js';
import type { LinkPropertySide, LinkType } from '@etn/shared';

const TYPE_MANAGER_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
  'screens',
  'type-manager.ts',
);

/** Минимальная строка реестра свойств. */
function makeRegistryRow(overrides: Partial<RegistryRow> = {}): RegistryRow {
  return {
    id: 'prop-1',
    name: 'дата создания',
    value_type: 'date',
    config: null,
    description: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    types_count: 2,
    values_count: 5,
    ...overrides,
  };
}

/** Минимальный каталог типа связи для разрешения имён сторон. */
function makeLinkType(overrides: Partial<LinkType> = {}): LinkType {
  return {
    id: 'lt-1',
    name_forward: 'место жительства',
    name_reverse: 'жители',
    parent_id: null,
    is_root: false,
    color: null,
    style: null,
    width: null,
    description: null,
    version: 1,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    created_by: 'user-1',
    ...overrides,
  };
}

/** Строка реестра свойства-связи «место жительства» / «жители». */
function makeLinkRow(overrides: Partial<RegistryRow> = {}): RegistryRow {
  return makeRegistryRow({
    id: 'prop-link',
    name: 'место жительства',
    value_type: 'link',
    config: { link_type_id: 'lt-1' },
    ...overrides,
  });
}

describe('buildPropertyListRows — список показывает конкретные имена (298fe6f3)', () => {
  it('свойство-связь даёт пару строк: прямое имя «источник», обратное «назначение»', () => {
    const rows = buildPropertyListRows([makeLinkRow()], [makeLinkType()]);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((e) => ({ name: e.name, side: e.side, id: e.id })),
      [
        { name: 'место жительства', side: 'source', id: 'prop-link:source' },
        { name: 'жители', side: 'target', id: 'prop-link:target' },
      ],
    );
    // Имена обеих сторон лежат в строке — поиск по любому из них её находит.
    assert.deepEqual(rows[0]!.linkNames, { forward: 'место жительства', reverse: 'жители' });
    assert.deepEqual(rows[1]!.linkNames, { forward: 'место жительства', reverse: 'жители' });
    // Строка остаётся ссылкой на одну запись реестра — одна привязка на имя.
    assert.equal(rows[0]!.propertyId, 'prop-link');
    assert.equal(rows[1]!.propertyId, 'prop-link');
  });

  it('скалярное свойство — одна строка со стороной null', () => {
    const rows = buildPropertyListRows([makeRegistryRow()], []);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.name, 'дата создания');
    assert.equal(rows[0]!.side, null);
    assert.equal(rows[0]!.linkNames, null);
    assert.equal(rows[0]!.id, 'prop-1');
  });

  it('совпадающие имена сторон — две строки, различаемые стороной', () => {
    const rows = buildPropertyListRows(
      [makeLinkRow()],
      [makeLinkType({ name_forward: 'см. также', name_reverse: 'см. также' })],
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((e) => e.side),
      ['source', 'target'],
    );
    // Имена одинаковы — различить строки можно только подписью стороны.
    assert.equal(sideLabel(rows[0]!.side), 'источник');
    assert.equal(sideLabel(rows[1]!.side), 'назначение');
  });

  it('тип связи ещё не в каталоге — одна строка с реестровым именем и стороной source', () => {
    const rows = buildPropertyListRows([makeLinkRow()], []);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.name, 'место жительства');
    assert.equal(rows[0]!.side, 'source');
    assert.equal(rows[0]!.linkNames, null);
  });
});

describe('rowBlockReason — уже привязанные имена не предлагаются (298fe6f3)', () => {
  const source = buildPropertyListRows([makeLinkRow()], [makeLinkType()])[0]!;
  const target = buildPropertyListRows([makeLinkRow()], [makeLinkType()])[1]!;
  const scalar = buildPropertyListRows([makeRegistryRow()], [])[0]!;
  const none = new Map<string, ReadonlySet<LinkPropertySide>>();
  const noInherited = new Set<string>();

  it('нет привязок — обе строки выбираемы', () => {
    assert.equal(rowBlockReason(source, none, noInherited), null);
    assert.equal(rowBlockReason(target, none, noInherited), null);
  });

  it('подключено прямое имя — обратное остаётся выбираемым (4251fbe5 сохранён)', () => {
    const bound = new Map<string, ReadonlySet<LinkPropertySide>>([
      ['prop-link', new Set(['source'])],
    ]);
    assert.equal(rowBlockReason(source, bound, noInherited), 'подключено');
    assert.equal(rowBlockReason(target, bound, noInherited), null);
  });

  it('подключены оба имени — обе строки недоступны', () => {
    const bound = new Map<string, ReadonlySet<LinkPropertySide>>([
      ['prop-link', new Set<LinkPropertySide>(['source', 'target'])],
    ]);
    assert.equal(rowBlockReason(source, bound, noInherited), 'подключено');
    assert.equal(rowBlockReason(target, bound, noInherited), 'подключено');
  });

  it('унаследованное свойство — «унаследовано» у обеих строк', () => {
    const inherited = new Set(['prop-link']);
    assert.equal(rowBlockReason(source, none, inherited), 'унаследовано');
    assert.equal(rowBlockReason(target, none, inherited), 'унаследовано');
  });

  it('скалярное свойство блокируется целиком', () => {
    const bound = new Map<string, ReadonlySet<LinkPropertySide>>([['prop-1', new Set()]]);
    assert.equal(rowBlockReason(scalar, bound, noInherited), 'подключено');
  });
});

describe('attachDraftFromExisting — выбранное имя задаёт сторону (298fe6f3)', () => {
  it('прямое имя → привязка source', () => {
    const row = makeLinkRow();
    const draft = attachDraftFromExisting(row, 'source', 'место жительства');
    assert.equal(draft.side, 'source');
    assert.equal(draft.property_id, 'prop-link');
    assert.equal(draft.key, 'место жительства');
    assert.equal(draft.value_type, 'link');
    assert.equal(draft.isNew, true);
  });

  it('обратное имя → привязка target, снимок имени — обратное', () => {
    const draft = attachDraftFromExisting(makeLinkRow(), 'target', 'жители');
    assert.equal(draft.side, 'target');
    assert.equal(draft.key, 'жители');
  });

  it('скалярное свойство — side null, имя реестровое', () => {
    const draft = attachDraftFromExisting(makeRegistryRow(), null);
    assert.equal(draft.side, null);
    assert.equal(draft.key, 'дата создания');
  });
});

describe('сквозной путь: имя строки → тело POST привязки (298fe6f3)', () => {
  function attachBodyFor(entry: PropertyListRow): unknown {
    const original: readonly import('@etn/shared').PropertyDefinition[] = [];
    const draft = [
      {
        id: nextDraftPropertyId(),
        isNew: true,
        property_id: entry.propertyId,
        side: entry.side,
        required: false,
        key: entry.name,
        value_type: entry.valueType,
        config: entry.registry.config,
        description: entry.registry.description,
      },
    ];
    const plan = planPropertyDiff(original, draft, []);
    const attach = plan.ops.find((op) => op.kind === 'attach');
    assert.ok(attach !== undefined);
    return opToAttachInput(attach);
  }

  const rows = buildPropertyListRows([makeLinkRow()], [makeLinkType()]);

  it('прямое имя уходит на сервер со стороной source', () => {
    assert.deepEqual(attachBodyFor(rows[0]!), {
      mode: 'attach',
      property_id: 'prop-link',
      required: false,
      side: 'source',
    });
  });

  it('обратное имя уходит на сервер со стороной target', () => {
    assert.deepEqual(attachBodyFor(rows[1]!), {
      mode: 'attach',
      property_id: 'prop-link',
      required: false,
      side: 'target',
    });
  });
});

describe('сторож: диалога стороны привязки и параллельного построителя строк нет (298fe6f3)', () => {
  const source = fs.readFileSync(TYPE_MANAGER_SRC, 'utf8');

  it('диалог «Сторона привязки» и его хелперы удалены', () => {
    // Упоминание в пояснительном комментарии допустимо; запрещены сами
    // конструкции: заголовок диалога и его хелперы.
    for (const gone of [
      "title: 'Сторона привязки'",
      'pickBindingSide',
      'attachSideDecision',
      'isSideAlreadyBound',
    ]) {
      assert.equal(
        source.includes(gone),
        false,
        `в type-manager.ts не должно остаться «${gone}» — сторона задаётся выбранным именем`,
      );
    }
  });

  it('строки строит общий модуль, а не локальный построитель', () => {
    assert.ok(
      source.includes('buildPropertyListRows'),
      'список берёт строки из lib/property-list.ts',
    );
    for (const gone of ['buildAttachEntries', 'attachEntryBlockReason', 'AttachEntry']) {
      assert.equal(
        source.includes(gone),
        false,
        `в type-manager.ts не должно остаться «${gone}» — второй список свойств запрещён`,
      );
    }
  });
});
