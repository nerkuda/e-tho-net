/**
 * Regression tests for the «Добавить свойство» flow of the type editor
 * (карточка ошибки 4251fbe5 — «Невозможно задать скалярное свойство в
 * редакторе типа мысли»).
 *
 * До фикса кнопка «Добавить свойство…» сначала спрашивала сторону привязки
 * (источник/назначение) и подставляла её ВСЕМ свойствам — скалярное свойство
 * уходило на сервер с `side: 'source'`, сервер отвечал 422 «сторона привязки
 * задаётся только для свойств-связей», и «Применить и закрыть» не сохранял
 * ничего. Теперь сторона спрашивается ПОСЛЕ выбора свойства-связи, а для
 * скаляра не спрашивается и не отправляется вовсе.
 *
 * Pure logic — no DOM (client tests run without jsdom, per the existing
 * convention):
 *  - {@link attachSideDecision} — нужен ли вопрос стороны для вида значения;
 *  - {@link isSideAlreadyBound} — занята ли выбранная сторона свойства-связи;
 *  - {@link attachDraftFromExisting} — draft-строка со стороной только у
 *    свойств-связей (скаляр — `side: null`);
 *  - сквозной случай `planPropertyDiff` → `opToAttachInput`: тело POST
 *    скалярной привязки несёт `side: null` — сервер её принимает.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  attachDraftFromExisting,
  attachSideDecision,
  isSideAlreadyBound,
} from '../src/renderer/screens/type-manager.js';
import type { RegistryRow } from '../src/renderer/screens/property-manager.js';
import {
  nextDraftPropertyId,
  opToAttachInput,
  planPropertyDiff,
} from '../src/renderer/lib/type-property-draft.js';

/** Минимальная строка реестра свойств для {@link attachDraftFromExisting}. */
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

describe('attachSideDecision — сторона нужна только свойству-связи (4251fbe5)', () => {
  it('скалярные виды не спрашивают сторону', () => {
    for (const vt of ['text', 'number', 'date', 'bool', 'url'] as const) {
      assert.equal(attachSideDecision(vt), 'none', `вид ${vt}`);
    }
  });

  it('вид «связь» спрашивает сторону', () => {
    assert.equal(attachSideDecision('link'), 'ask');
  });
});

describe('isSideAlreadyBound — дубль стороны свойства-связи (4251fbe5)', () => {
  it('нет записи о сторонах — сторона свободна', () => {
    assert.equal(isSideAlreadyBound(undefined, 'source'), false);
  });

  it('пустой набор (скаляр) — сторона свободна', () => {
    assert.equal(isSideAlreadyBound(new Set(), 'source'), false);
  });

  it('занятая сторона определяется', () => {
    assert.equal(isSideAlreadyBound(new Set(['source']), 'source'), true);
    assert.equal(isSideAlreadyBound(new Set(['source']), 'target'), false);
    assert.equal(isSideAlreadyBound(new Set(['source', 'target']), 'target'), true);
  });
});

describe('attachDraftFromExisting — сторона только у свойства-связи (4251fbe5)', () => {
  it('скалярное свойство подключается с side: null', () => {
    const draft = attachDraftFromExisting(makeRegistryRow(), null);
    assert.equal(draft.side, null);
    assert.equal(draft.property_id, 'prop-1');
    assert.equal(draft.key, 'дата создания');
    assert.equal(draft.value_type, 'date');
    assert.equal(draft.required, false);
    assert.equal(draft.isNew, true);
  });

  it('свойство-связь подключается с выбранной стороной', () => {
    const linkRow = makeRegistryRow({
      name: 'версия',
      value_type: 'link',
      config: { link_type_id: 'lt-1', direction: 'out' },
    });
    assert.equal(attachDraftFromExisting(linkRow, 'source').side, 'source');
    assert.equal(attachDraftFromExisting(linkRow, 'target').side, 'target');
  });
});

describe('сквозной путь: тело POST скалярной привязки без стороны (4251fbe5)', () => {
  it('attach скаляра несёт side: null — сервер принимает', () => {
    const original: readonly import('@etn/shared').PropertyDefinition[] = [];
    type LinkPropertySide = import('@etn/shared').LinkPropertySide;
    const draft = [
      {
        id: nextDraftPropertyId(),
        isNew: true,
        property_id: 'prop-1',
        side: null as LinkPropertySide | null,
        required: false,
        key: 'дата создания',
        value_type: 'date' as const,
        config: null,
        description: null,
      },
    ];
    const plan = planPropertyDiff(original, draft, []);
    const attach = plan.ops.find((op) => op.kind === 'attach');
    assert.ok(attach !== undefined);
    assert.equal(opToAttachInput(attach).side, null);
    assert.deepEqual(opToAttachInput(attach), {
      mode: 'attach',
      property_id: 'prop-1',
      required: false,
      side: null,
    });
  });
});
