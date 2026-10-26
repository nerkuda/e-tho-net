/**
 * Renderer-side realtime status behaviour (ошибка de34b35b):
 *  - эффективный статус активной сети — через `getRtStatus` (переключение
 *    вкладки показывает статус своей сети, а не последнего события);
 *  - `canSave()` запрещает сохранение в `suspect`/`reconnecting`/`offline`;
 *  - первое подключение не рапортует ложное «Соединение восстановлено», а
 *    переход connected→потеря даёт ровно одно уведомление без спама.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';
import { getRtStatus, getRtStatusDetail, store } from '../src/renderer/state.js';
import { canSave, initDrafts } from '../src/renderer/drafts.js';

const NET1 = '11111111-2222-3333-4444-555555555555';
const NET2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** Минимальный `document`/`window` для тостов. */
function installDom(): void {
  const body = new ShimElement('body');
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new ShimElement(tag),
    body,
  };
  (globalThis as unknown as { window: unknown }).window = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown,
    clearTimeout: (id: unknown) => clearTimeout(id as NodeJS.Timeout),
    addEventListener: () => undefined,
  };
}

/** Тексты тостов в стеке (0.14.1: контейнер `.notice-stack`). */
function noticeTexts(): string[] {
  const body = (globalThis as unknown as { document: { body: ShimElement } }).document.body;
  const stack = body.children.find((el) => el.classList.contains('notice-stack'));
  if (stack === undefined) return [];
  return stack.children.map((box) => box.children.map((child) => child.textContent).join(' '));
}

describe('renderer realtime status (de34b35b)', () => {
  beforeEach(() => {
    store.update({
      networkId: NET1,
      rtStatus: 'idle',
      rtStatusByNetwork: {},
      rtStatusDetailByNetwork: {},
    });
  });

  it('getRtStatus follows the active network and never borrows another network status', () => {
    store.update({
      rtStatusByNetwork: { [NET1]: 'connected', [NET2]: 'offline' },
      rtStatus: 'offline',
    });
    assert.equal(getRtStatus(store.state), 'connected');
    store.update({ networkId: NET2 });
    assert.equal(getRtStatus(store.state), 'offline');
    // No entry for the active network yet (tab just opened): neutral
    // `connecting`, never the flat status of another network (verify remark 3).
    store.update({ networkId: '33333333-4444-5555-6666-777777777777' });
    assert.equal(getRtStatus(store.state), 'connecting');
    store.update({ networkId: null, rtStatus: 'idle' });
    assert.equal(getRtStatus(store.state), 'idle');
  });

  it('getRtStatusDetail is per network', () => {
    store.update({
      rtStatusByNetwork: { [NET1]: 'reconnecting', [NET2]: 'reconnecting' },
      rtStatusDetailByNetwork: { [NET1]: 'server-restart' },
    });
    assert.equal(getRtStatusDetail(store.state), 'server-restart');
    store.update({ networkId: NET2 });
    assert.equal(getRtStatusDetail(store.state), null);
  });

  it('canSave is false for suspect/reconnecting/offline, true only for connected', () => {
    for (const status of ['suspect', 'reconnecting', 'offline'] as const) {
      store.update({ rtStatusByNetwork: { [NET1]: status } });
      assert.equal(canSave(), false, status);
    }
    store.update({ rtStatusByNetwork: { [NET1]: 'connected' } });
    assert.equal(canSave(), true);
  });

  it('первое подключение не показывает «Соединение восстановлено», потеря — одно уведомление', () => {
    installDom();
    initDrafts();

    // Первое подключение: сообщения о восстановлении быть не должно.
    store.update({ rtStatusByNetwork: { [NET1]: 'connected' }, rtStatus: 'connected' });
    assert.deepEqual(noticeTexts(), []);

    // Потеря: ровно одно жёлтое уведомление, дальше suspect→reconnecting→offline
    // не спамит.
    store.update({ rtStatusByNetwork: { [NET1]: 'suspect' }, rtStatus: 'suspect' });
    store.update({ rtStatusByNetwork: { [NET1]: 'reconnecting' }, rtStatus: 'reconnecting' });
    store.update({ rtStatusByNetwork: { [NET1]: 'offline' }, rtStatus: 'offline' });
    const lost = noticeTexts();
    assert.equal(lost.length, 1, lost.join(' | '));

    // Реальное восстановление — одно сообщение.
    store.update({ rtStatusByNetwork: { [NET1]: 'connected' }, rtStatus: 'connected' });
    const restored = noticeTexts();
    assert.equal(restored.length, 2, restored.join(' | '));
    assert.ok(restored.some((t) => t.includes('Соединение восстановлено')));
  });
});
