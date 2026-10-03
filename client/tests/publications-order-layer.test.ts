/**
 * Тесты слоя для ручного порядка публикации (задача d13fd645).
 *
 * Доказывают, что PUT order доходит до открытого документа ПАТЧЕМ, а не полным
 * перечитыванием сборки:
 *  - своя мутация эмитит локальный сигнал `publication-order` на адресный ключ
 *    публикации с сохранёнными позициями;
 *  - реальное событие `publication.order.reordered` маршрутизируется на тот же
 *    ключ (и список библиотеки), а его payload несёт `items` для точечного
 *    применения — рефетч не требуется.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { AnyRealtimeEvent, PublicationOrderItem } from '@etn/shared';

import {
  onQueryInvalidated,
  queryKeys,
  registerQuery,
  resetEventRouter,
  resetQueryRegistry,
  routeRealtimeEvent,
  signalPublicationOrderChanged,
} from '../src/renderer/lib/live/index.js';

const NET = '00000000-0000-4000-8000-0000000000aa';
const PUB = 'pub-1';

const ITEMS: PublicationOrderItem[] = [
  { node_key: 'e:C', position: 1 },
  { node_key: 'e:A', position: 2 },
  { node_key: 'e:B', position: 3 },
];

function orderEvent(): AnyRealtimeEvent {
  return {
    type: 'publication.order.reordered',
    seq: 7,
    ts: '2026-10-03T00:00:00.000Z',
    actor: { user_id: 'u1', client_id: 'c1' },
    network_id: NET,
    audience: 'network',
    data: { publication_id: PUB, items: ITEMS },
    layer_id: '00000000-0000-0000-0000-000000000000',
  } as unknown as AnyRealtimeEvent;
}

interface Seen {
  prefix: string;
  cause: unknown;
}

describe('слой: порядок публикации обновляется патчем, без рефетча (d13fd645)', () => {
  beforeEach(() => {
    resetQueryRegistry();
    resetEventRouter();
  });

  it('свой PUT order эмитит сигнал publication-order на адресный ключ публикации', () => {
    // Ключ публикации зарегистрирован без фетчера — как в рабочей области:
    // инвалидация лишь уведомляет наблюдателя (рефетча нет).
    registerQuery(queryKeys.publicationAssembly(PUB), null);
    registerQuery(queryKeys.publicationAssembly('pub-2'), null);
    const seen: Seen[] = [];
    const unsub = onQueryInvalidated((prefix, _keys, cause) => seen.push({ prefix, cause }));

    signalPublicationOrderChanged(PUB, ITEMS);

    unsub();
    assert.equal(seen.length, 1, 'затронут только ключ этой публикации');
    assert.equal(seen[0]!.prefix, queryKeys.publicationAssembly(PUB));
    const cause = seen[0]!.cause as { local?: string; id?: string; data?: { items?: unknown } };
    assert.equal(cause.local, 'publication-order');
    assert.equal(cause.id, PUB);
    assert.deepEqual(cause.data?.items, ITEMS);
  });

  it('реальное событие publication.order.reordered несёт items и не требует рефетча', () => {
    registerQuery(queryKeys.publicationAssembly(PUB), null);
    const seen: Seen[] = [];
    const unsub = onQueryInvalidated((prefix, _keys, cause) => seen.push({ prefix, cause }));

    const result = routeRealtimeEvent(orderEvent(), { networkId: NET });

    unsub();
    assert.equal(result.routed, true);
    assert.ok(
      result.invalidated.includes(queryKeys.publicationAssembly(PUB)),
      'событие гасит ключ сборки этой публикации',
    );
    // Наблюдатель получает само событие как причину — из него рабочая область
    // берёт `items` и применяет порядок точечно (полного reload нет).
    const orderCause = seen.find(
      (entry) =>
        (entry.cause as { type?: string } | undefined)?.type === 'publication.order.reordered',
    );
    assert.ok(orderCause !== undefined, 'наблюдатель увидел причину-событие');
    const data = (orderCause.cause as { data: { items: PublicationOrderItem[] } }).data;
    assert.deepEqual(data.items, ITEMS);
  });
});
