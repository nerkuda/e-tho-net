/**
 * Откат создания свойства при отказе записи привязок (ошибка 0033ea14, DoD 2:
 * «создание свойства-связи либо сохраняется целиком, либо честно отклоняется —
 * частичных состояний быть не должно»).
 *
 * `rollbackCreatedProperty` вызывается из `apply` редактора свойства, когда
 * `applyTypeRows` упал после `POST /properties`: свойство уже создано, строки
 * типов записываются отдельными запросами. Откат обязан снять созданные
 * привязки (иначе `DELETE /properties/{id}` отказывает 409) и затем удалить
 * свойство. Здесь фиксируются порядок вызовов и устойчивость к отказам.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rollbackCreatedProperty } from '../src/renderer/screens/property-manager.js';

interface StubOptions {
  /** Id привязок, снятие которых падает (на живом сервере — уже снято/чужая привязка). */
  failingBindings?: ReadonlySet<string>;
  /** `DELETE /properties/{id}` падает (свойство осталось привязанным). */
  removeFails?: boolean;
}

/** Подделка моста `window.etn`: журнал вызовов в порядке выполнения. */
function stubBridge(options: StubOptions = {}): string[] {
  const calls: string[] = [];
  const api = {
    types: {
      removeTypeProperty: async (
        _networkId: string,
        _ownerType: string,
        thoughtTypeId: string,
        bindingId: string,
      ): Promise<void> => {
        calls.push(`unbind:${thoughtTypeId}:${bindingId}`);
        if (options.failingBindings?.has(bindingId) === true) throw new Error('binding is gone');
      },
    },
    propertyRegistry: {
      remove: async (_networkId: string, propertyId: string): Promise<void> => {
        calls.push(`remove:${propertyId}`);
        if (options.removeFails === true) throw new Error('property is bound to types');
      },
    },
  };
  const win = ((globalThis as any).window ??= {});
  win.etn = api;
  return calls;
}

describe('откат созданного свойства при отказе записи привязок (0033ea14)', () => {
  it('снимает привязки до удаления свойства и сообщает об успехе', async () => {
    const calls = stubBridge();
    const ok = await rollbackCreatedProperty('n1', 'prop-new', [
      { thoughtTypeId: 'type-a', id: 'bind-a' },
      { thoughtTypeId: 'type-b', id: 'bind-b' },
    ]);

    assert.equal(ok, true);
    assert.deepEqual(calls, ['unbind:type-a:bind-a', 'unbind:type-b:bind-b', 'remove:prop-new']);
  });

  it('отказ снятия одной привязки не мешает остальным и удалению свойства', async () => {
    const calls = stubBridge({ failingBindings: new Set(['bind-a']) });
    const ok = await rollbackCreatedProperty('n1', 'prop-new', [
      { thoughtTypeId: 'type-a', id: 'bind-a' },
      { thoughtTypeId: 'type-b', id: 'bind-b' },
    ]);

    assert.equal(ok, true);
    assert.deepEqual(calls, ['unbind:type-a:bind-a', 'unbind:type-b:bind-b', 'remove:prop-new']);
  });

  it('если свойство удалить не удалось — возвращает false (вызывающий покажет причину)', async () => {
    const calls = stubBridge({ removeFails: true });
    const ok = await rollbackCreatedProperty('n1', 'prop-new', [
      { thoughtTypeId: 'type-a', id: 'bind-a' },
    ]);

    assert.equal(ok, false);
    assert.deepEqual(calls, ['unbind:type-a:bind-a', 'remove:prop-new']);
  });
});
