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
import { refreshRealtimeStatuses, toRtStatusDetail } from '../src/renderer/realtime.js';

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

/** Даёт отработать async-цепочкам досылки черновиков. */
async function settleAsync(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
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

  it('проба живости: suspect→connected без тостов и досыла; потеря и восстановление — по одному сообщению', async () => {
    installDom();
    // Мост черновиков: волна досылки видна по вызову `draftList`. Стартовое
    // сообщение о чистке (client_meta) здесь пустое.
    const draftListCalls: string[] = [];
    (globalThis as unknown as { window: { etn: unknown } }).window.etn = {
      ui: {
        draftList: async (networkId: string) => {
          draftListCalls.push(networkId);
          return [];
        },
      },
      meta: { get: async () => null, set: async () => undefined },
    };
    initDrafts();

    // Первое подключение: сообщения о восстановлении быть не должно. Первый
    // connect сессии — досыл черновиков ТЕКУЩЕЙ сессии (H19), поэтому ровно
    // одна волна.
    store.update({ rtStatusByNetwork: { [NET1]: 'connected' }, rtStatus: 'connected' });
    await settleAsync();
    assert.deepEqual(noticeTexts(), []);
    assert.equal(draftListCalls.length, 1, 'первый connect — досыл черновиков сессии');

    // Проба живости (действие зависло > 3 с): на входе в suspect сообщения НЕТ
    // (fb9d6058 п.4), а pong до дедлайна возвращает connected без ложного
    // «Соединение восстановлено» и БЕЗ повторного досыла черновиков.
    store.update({ rtStatusByNetwork: { [NET1]: 'suspect' }, rtStatus: 'suspect' });
    assert.deepEqual(noticeTexts(), [], 'вход в suspect молчит');
    store.update({ rtStatusByNetwork: { [NET1]: 'connected' }, rtStatus: 'connected' });
    await settleAsync();
    assert.deepEqual(noticeTexts(), [], 'проба подтвердила живость — тишина');
    assert.equal(draftListCalls.length, 1, 'проба — не восстановление: досыла нет');

    // Реальная потеря: проба НЕ подтвердилась за дедлайн (suspect →
    // reconnecting) — ровно одно «Проверяем связь», дальше до offline молчание.
    store.update({ rtStatusByNetwork: { [NET1]: 'suspect' }, rtStatus: 'suspect' });
    store.update({ rtStatusByNetwork: { [NET1]: 'reconnecting' }, rtStatus: 'reconnecting' });
    store.update({ rtStatusByNetwork: { [NET1]: 'offline' }, rtStatus: 'offline' });
    await settleAsync();
    const lost = noticeTexts();
    assert.equal(lost.length, 1, lost.join(' | '));
    assert.ok(lost[0]!.includes('Проверяем связь'), lost.join(' | '));

    // Реальное восстановление — одно сообщение и одна волна досыла.
    store.update({ rtStatusByNetwork: { [NET1]: 'connected' }, rtStatus: 'connected' });
    await settleAsync();
    const restored = noticeTexts();
    assert.equal(restored.length, 2, restored.join(' | '));
    assert.ok(restored.some((t) => t.includes('Соединение восстановлено')));
    assert.equal(draftListCalls.length, 2, 'реальное восстановление — досыл');
  });

  it('detail server-maintenance из main доходит до store, неизвестный — отбрасывается (12fd5b0e)', async () => {
    assert.equal(toRtStatusDetail('server-restart'), 'server-restart');
    assert.equal(toRtStatusDetail('server-maintenance'), 'server-maintenance');
    assert.equal(toRtStatusDetail('bogus'), null);
    assert.equal(toRtStatusDetail(undefined), null);

    installDom();
    (globalThis as unknown as { window: { etn: unknown } }).window.etn = {
      realtime: {
        getStatuses: async () => [
          { networkId: NET1, status: 'offline', detail: 'server-maintenance' },
          { networkId: NET2, status: 'reconnecting', detail: 'bogus' },
        ],
      },
    };
    store.update({ networkId: NET1, rtStatusDetailByNetwork: {} });
    await refreshRealtimeStatuses();
    assert.equal(getRtStatusDetail(store.state), 'server-maintenance');
    store.update({ networkId: NET2 });
    assert.equal(getRtStatusDetail(store.state), null, 'неизвестное уточнение отброшено');
    store.update({ networkId: NET1 });
  });
});
