/**
 * Запись значения-связи с учётом стороны (ошибка 45248206).
 *
 * После фикса внетиповой проекции обе стороны двухстороннего свойства несут
 * ОДИН `property_id`. Прежнее сопоставление «только id» брало первый набор —
 * обычно source — и при выборе target перезаписывало чужую сторону.
 *
 * `addLinkPropertyValue` обязан найти набор выбранной стороны (id + `side`),
 * а легаси-ребро без реестрового свойства — по display-имени стороны.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addLinkPropertyValue } from '../src/renderer/lib/link-property-write.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface FakeCall {
  ownerId: string;
  key: string;
  targets: string[];
}

function installBridge(values: unknown[]): FakeCall[] {
  const calls: FakeCall[] = [];
  (globalThis as any).window = {
    etn: {
      properties: {
        get: async () => values,
        set: async (
          _networkId: string,
          _ownerType: string,
          ownerId: string,
          key: string,
          targets: string[],
        ) => {
          calls.push({ ownerId, key, targets });
        },
      },
    },
  };
  return calls;
}

describe('addLinkPropertyValue: сторона значения-связи (45248206)', () => {
  it('выбор target дополняет набор target, а не source', async () => {
    const calls = installBridge([
      { property_id: 'p1', property_name: 'Содержит', side: 'source', values: [{ target_id: 't-src' }], count: 1 },
      {
        property_id: 'p1',
        property_name: 'Содержится в',
        side: 'target',
        values: [{ target_id: 't-tgt' }],
        count: 1,
      },
    ]);

    await addLinkPropertyValue(
      'net1',
      'owner1',
      { propertyId: 'p1', key: 'Содержится в', side: 'target' },
      't-anchor',
    );

    assert.deepEqual(calls, [
      { ownerId: 'owner1', key: 'Содержится в', targets: ['t-tgt', 't-anchor'] },
    ]);
  });

  it('легаси-ребро без реестрового id находится по имени стороны', async () => {
    const calls = installBridge([
      { property_id: '', property_name: 'Читал в', values: [{ target_id: 't-old' }], count: 1 },
    ]);

    await addLinkPropertyValue(
      'net1',
      'owner1',
      { propertyId: '', key: 'Читал в', side: null },
      't-anchor',
    );

    assert.deepEqual(calls, [
      { ownerId: 'owner1', key: 'Читал в', targets: ['t-old', 't-anchor'] },
    ]);
  });
});
