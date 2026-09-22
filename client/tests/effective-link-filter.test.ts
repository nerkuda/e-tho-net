/**
 * Поведенческие тесты резолва эффективного фильтра типов связей холста
 * (задача 7e9ec8bf): при незаданном явном предпочтении превью Ctrl-наведения
 * обязано нести тот же фильтр, которым сервер рисует саму карту — живой дефолт
 * из `show_on_map` реестра свойств.
 *
 * Проверяется цепочка (`lib/effective-link-filter.ts`): явное предпочтение
 * побеждает и не ходит в реестр; иначе дефолт считается по `show_on_map`;
 * кэш живёт ровно столько, сколько снимок окрестности фокуса (перерисовка
 * окрестности перечитывает реестр, серия наведений — нет).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { FocusResponse, NetworkProperty } from '@etn/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Реестр свойств с одним свойством-связью, помеченным на карту. */
function mappedProperty(linkTypeId: string, showOnMap: boolean): NetworkProperty {
  return {
    id: `prop-${linkTypeId}`,
    layer_id: 'base',
    name: `связь-${linkTypeId}`,
    name_key: `связь-${linkTypeId}`,
    value_type: 'link',
    config: { link_type_id: linkTypeId, show_on_map: showOnMap },
    description: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
  } as unknown as NetworkProperty;
}

/** Минимальный снимок окрестности — важна только его идентичность. */
function focusSnapshot(id: string): FocusResponse {
  return { focused: { id } } as unknown as FocusResponse;
}

/** Счётчик обращений к реестру + управляемый ответ. */
function installEtn(properties: NetworkProperty[]): { calls: () => number } {
  let calls = 0;
  (globalThis as any).window = {
    etn: {
      propertyRegistry: {
        list: async () => {
          calls += 1;
          return properties;
        },
      },
    },
  };
  return { calls: () => calls };
}

const modulePromise = import('../src/renderer/lib/effective-link-filter.js');

async function resolver() {
  const [mod, state] = await Promise.all([
    modulePromise,
    import('../src/renderer/state.js'),
  ]);
  return { mod, store: state.store };
}

beforeEach(async () => {
  // Снимок окрестности сбрасывается — кэш живого дефолта привязан к нему и
  // потому не переживает тест (отдельного сброса у модуля нет намеренно).
  const { store } = await resolver();
  store.update({ canvasLinkFilter: null, focus: null });
});

describe('эффективный фильтр связей холста (задача 7e9ec8bf)', () => {
  it('без явного предпочтения резолвит живой дефолт из show_on_map', async () => {
    const etnStub = installEtn([
      mappedProperty('lt-on', true),
      mappedProperty('lt-off', false),
    ]);
    const { mod } = await resolver();
    const filter = await mod.resolveEffectiveCanvasLinkFilter('net-1');
    assert.deepEqual(filter, { include_structural: true, type_ids: ['lt-on'] });
    assert.equal(etnStub.calls(), 1);
  });

  it('явное предпочтение побеждает и не читает реестр свойств', async () => {
    const etnStub = installEtn([mappedProperty('lt-on', true)]);
    const { mod, store } = await resolver();
    const explicit = { include_structural: false, type_ids: ['lt-other'] };
    store.update({ canvasLinkFilter: explicit });
    assert.deepEqual(await mod.resolveEffectiveCanvasLinkFilter('net-1'), explicit);
    assert.equal(etnStub.calls(), 0, 'при явном фильтре реестр не нужен');
  });

  it('серия наведений в одном снимке окрестности делит один запрос', async () => {
    const etnStub = installEtn([mappedProperty('lt-on', true)]);
    const { mod, store } = await resolver();
    store.update({ focus: focusSnapshot('t1') });
    await mod.resolveEffectiveCanvasLinkFilter('net-1');
    await mod.resolveEffectiveCanvasLinkFilter('net-1');
    assert.equal(etnStub.calls(), 1);
  });

  it('свежая окрестность фокуса перечитывает реестр (карта только что резолвила)', async () => {
    const etnStub = installEtn([mappedProperty('lt-on', true)]);
    const { mod, store } = await resolver();
    store.update({ focus: focusSnapshot('t1') });
    await mod.resolveEffectiveCanvasLinkFilter('net-1');
    // Карта перерисована (новая окрестность) — дефолт считается заново.
    store.update({ focus: focusSnapshot('t2') });
    await mod.resolveEffectiveCanvasLinkFilter('net-1');
    assert.equal(etnStub.calls(), 2);
  });

  it('сбой чтения реестра не залипает в кэше: следующий резолв повторяет запрос', async () => {
    let calls = 0;
    (globalThis as any).window = {
      etn: {
        propertyRegistry: {
          list: async () => {
            calls += 1;
            if (calls === 1) throw new Error('сеть недоступна');
            return [mappedProperty('lt-on', true)];
          },
        },
      },
    };
    const { mod, store } = await resolver();
    store.update({ focus: focusSnapshot('t1') });
    await assert.rejects(() => mod.resolveEffectiveCanvasLinkFilter('net-1'));
    assert.deepEqual(await mod.resolveEffectiveCanvasLinkFilter('net-1'), {
      include_structural: true,
      type_ids: ['lt-on'],
    });
    assert.equal(calls, 2);
  });
});
