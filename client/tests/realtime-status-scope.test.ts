/**
 * Статусная строка показывает события ТОЛЬКО активной мыслесети (ошибка
 * eb6f5794).
 *
 * Пул realtime держит сокет каждой открытой вкладки (`tab-rt-pool`), поэтому в
 * рендерер приходят события всех сетей соединения. Текст последнего события
 * (`store.lastEvent` → `.sb-event` в статусной строке) пользователь читает как
 * событие СВОЕЙ вкладки: событие чужой сети туда попадать не должно. Данные
 * при этом не теряются — маркер «*» на вкладке, декларативный роутер и мост
 * производных эффектов обрабатывают событие как раньше.
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import type { AnyRealtimeEvent } from '@etn/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NET_A = '00000000-0000-4000-8000-00000000000a';
const NET_B = '00000000-0000-4000-8000-00000000000b';

/** Полное realtime-событие нужной формы (`isRealtimeEvent` пропускает). */
function realtimeEvent(type: string, networkId: string, data: unknown, seq = 1): AnyRealtimeEvent {
  return {
    type,
    seq,
    ts: '2026-01-01T00:00:00.000Z',
    actor: { user_id: 'u1', client_id: 'c1' },
    network_id: networkId,
    audience: 'network',
    data,
  } as AnyRealtimeEvent;
}

/** Последний подписанный обработчик `realtime:event` моста. */
let handler: ((raw: unknown) => void) | null = null;
/** Счётчик применённых производных эффектов (мост обязан видеть ВСЕ события). */
let applied = 0;

let store: (typeof import('../src/renderer/state.js'))['store'];
let describeEvent: (typeof import('../src/renderer/lib/pure.js'))['describeEvent'];

before(async () => {
  (globalThis as any).window = {
    etn: {
      realtime: {
        onStatusChange: () => undefined,
        onMaintenance: () => undefined,
        onStale: () => undefined,
        onNetworkLost: () => undefined,
        onLayerControl: () => undefined,
        onLanguage: () => undefined,
        onEvent: (cb: (raw: unknown) => void) => {
          handler = cb;
        },
        notifyOnline: () => undefined,
      },
    },
    addEventListener: () => undefined,
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id),
  };

  const { resetEventRouter } = await import('../src/renderer/lib/live/index.js');
  resetEventRouter();
  ({ store } = await import('../src/renderer/state.js'));
  ({ describeEvent } = await import('../src/renderer/lib/pure.js'));
  const { initRealtime, setRealtimeEffects } = await import('../src/renderer/realtime.js');
  initRealtime();
  setRealtimeEffects({
    onEventApplied: () => {
      applied += 1;
    },
  });
  assert.notEqual(handler, null, 'realtime-мост подписан на события');
});

/** Тело `comment.created` в форме, которую ждёт декларативный роутер данных. */
function commentPayload(id: string): unknown {
  return {
    comment: {
      id,
      owner_type: 'thought',
      owner_id: '00000000-0000-4000-8000-000000000001',
      kind: 'permanent',
      body_md: 'текст',
      version: 1,
    },
  };
}

/** Доставляет событие в мост (как это делает main) и даёт обработчикам пройти. */
async function feed(type: string, networkId: string, data: unknown): Promise<void> {
  applied = 0;
  handler!(realtimeEvent(type, networkId, data));
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('статусная строка: события только активной сети (eb6f5794)', () => {
  it('событие чужой сети не попадает в текст статусной строки, но применяется к данным', async () => {
    store.update({ networkId: NET_A, lastEvent: null });

    await feed('comment.created', NET_B, commentPayload('c-b'));

    assert.equal(store.state.lastEvent, null, 'чужое событие текст не двигает');
    assert.equal(applied, 1, 'мост производных эффектов событие получил — данные не теряются');
  });

  it('событие активной сети показывается пользователю', async () => {
    store.update({ networkId: NET_A, lastEvent: null });

    const evt = realtimeEvent('comment.created', NET_A, commentPayload('c-a'));
    handler!(evt);
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(store.state.lastEvent, describeEvent(evt), 'текст события своей сети показан');
  });

  it('смена активной вкладки гасит текст прежней сети', async () => {
    store.update({ networkId: NET_A, lastEvent: null });
    await feed('comment.created', NET_A, commentPayload('c-a2'));
    assert.notEqual(store.state.lastEvent, null, 'перед сменой текст есть');

    store.update({ networkId: NET_B });

    assert.equal(store.state.lastEvent, null, 'текст прежней сети не висит на новой вкладке');
  });
});
