/**
 * Тосты перехода связи (ошибка 98f94df6). Класс «ложное «Соединение
 * восстановлено»»: глобальные `lastConnected`/`hadConnection` не различали
 * сети, поэтому переключение на ЗДОРОВУЮ сеть во время пробы живости старой
 * давало тост восстановления, хотя связи не теряли.
 *
 * Отдельный файл — `initDrafts` инициализируется один раз на процесс: в
 * общем файле статусов подписка и глобальные переменные переживают тесты.
 *
 * Таблица класса (она же в постоянном комментарии ошибки 98f94df6):
 *
 *   тост «Соединение восстановлено» — ЕСТЬ:
 *   - `reconnecting → connected` активной сети;
 *   - `offline → connected` активной сети;
 *   - то же для сети, на которую переключились (её собственный переход).
 *
 *   тост — НЕТ:
 *   - первый `connected` сессии (у сети нет предыдущего статуса);
 *   - `suspect → connected` (проба подтвердила живость);
 *   - `connected → connected` (повторный снапшот);
 *   - переключение на сеть, чей предыдущий статус `connected`, даже если
 *     старая активная сеть в `suspect` (сама ошибка 98f94df6);
 *   - переключение на сеть без записи в карте статусов;
 *   - обслуживание сервера активно (`serverMaintenance.active`).
 *
 *   «Проверяем связь» (notice, не тост) — при `connected → reconnecting/
 *   offline` и при неподтверждённой пробе `suspect → reconnecting/offline`;
 *   вход в `suspect` молчит.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';
import { store } from '../src/renderer/state.js';
import { initDrafts } from '../src/renderer/drafts.js';

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

/** Есть ли среди сообщений тост восстановления связи. */
function hasRecoveredToast(): boolean {
  return noticeTexts().some((text) => text.includes('Соединение восстановлено'));
}

/** Даёт отработать async-цепочкам досылки черновиков. */
async function settleAsync(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('тост «Соединение восстановлено» — только настоящий обрыв (98f94df6)', () => {
  it('переключение на здоровую сеть во время пробы старой не даёт ложного тоста', async () => {
    installDom();
    (globalThis as unknown as { window: { etn: unknown } }).window.etn = {
      ui: { draftList: async () => [] },
      meta: { get: async () => null, set: async () => undefined },
    };
    store.update({
      networkId: NET1,
      rtStatus: 'idle',
      rtStatusByNetwork: {},
      rtStatusDetailByNetwork: {},
      serverMaintenance: null,
    });
    initDrafts();

    // Обе сети подключены; активна NET1. Первый connect сессии — без тоста.
    store.update({
      networkId: NET1,
      rtStatusByNetwork: { [NET1]: 'connected', [NET2]: 'connected' },
      rtStatus: 'connected',
    });
    await settleAsync();
    assert.equal(hasRecoveredToast(), false, 'первый connect молчит');

    // NET1 ушёл в пробу живости (действие зависло) — тишина.
    store.update({ rtStatusByNetwork: { [NET1]: 'suspect', [NET2]: 'connected' } });
    await settleAsync();
    assert.equal(hasRecoveredToast(), false, 'вход в suspect молчит');

    // Пользователь переключился на здоровую NET2, пока проба NET1 летит.
    // Глобальный `lastConnected` отрицателен из-за `suspect` NET1 — раньше
    // этого хватало для ложного «Соединение восстановлено».
    store.update({ networkId: NET2 });
    await settleAsync();
    assert.equal(hasRecoveredToast(), false, 'переключение на здоровую сеть — не восстановление');

    // Возврат на NET1, проба подтвердила живость: тоже тишина.
    store.update({ networkId: NET1 });
    store.update({ rtStatusByNetwork: { [NET1]: 'connected', [NET2]: 'connected' } });
    await settleAsync();
    assert.equal(hasRecoveredToast(), false, 'подтверждённая проба — не восстановление');
  });

  it('настоящий обрыв и восстановление активной сети дают ровно один тост', async () => {
    installDom();
    (globalThis as unknown as { window: { etn: unknown } }).window.etn = {
      ui: { draftList: async () => [] },
      meta: { get: async () => null, set: async () => undefined },
    };
    store.update({
      networkId: NET1,
      rtStatus: 'idle',
      rtStatusByNetwork: {},
      rtStatusDetailByNetwork: {},
      serverMaintenance: null,
    });
    initDrafts();

    store.update({
      networkId: NET1,
      rtStatusByNetwork: { [NET1]: 'connected', [NET2]: 'connected' },
      rtStatus: 'connected',
    });
    await settleAsync();
    assert.equal(hasRecoveredToast(), false, 'первый connect молчит');

    // Реальный обрыв: connected → reconnecting → offline (одно «Проверяем связь»).
    store.update({ rtStatusByNetwork: { [NET1]: 'reconnecting', [NET2]: 'connected' } });
    store.update({ rtStatusByNetwork: { [NET1]: 'offline', [NET2]: 'connected' } });
    await settleAsync();
    assert.equal(hasRecoveredToast(), false, 'обрыв — не восстановление');

    // Восстановление: offline → connected — один тост.
    store.update({ rtStatusByNetwork: { [NET1]: 'connected', [NET2]: 'connected' } });
    await settleAsync();
    assert.equal(hasRecoveredToast(), true, 'настоящее восстановление сообщается');
    const recoveredCount = noticeTexts().filter((text) =>
      text.includes('Соединение восстановлено'),
    ).length;
    assert.equal(recoveredCount, 1, 'тост ровно один');

    // Повторный снапшот connected ничего не добавляет.
    store.update({ rtStatusByNetwork: { [NET1]: 'connected', [NET2]: 'connected' } });
    await settleAsync();
    const repeated = noticeTexts().filter((text) =>
      text.includes('Соединение восстановлено'),
    ).length;
    assert.equal(repeated, 1, 'повторный connected не тостит');
  });
});
