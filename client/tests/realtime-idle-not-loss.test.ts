/**
 * Закрытие вкладки мыслесети — не потеря связи (ошибка 3fa5f9ba).
 *
 * Симптом заказчика: при закрытии верхней вкладки сети появляется тост «Нет
 * соединения — правка сохранена как черновик и отправится после восстановления
 * связи», хотя сервер и связь живы.
 *
 * Корень (подтверждён GUI-стендом и этим регрессом): закрытие ПОСЛЕДНЕЙ вкладки
 * сети освобождает её realtime-сокет в main (`TabRealtimePool.release` →
 * `disconnect()`), и в renderer приходит статус этой сети `idle`. Подписчик
 * черновиков считал любую не-`connected` смену статуса после `connected`
 * реальным обрывом, а `linkLossMessage` для `idle` отдавала текст по умолчанию
 * — тот самый «Нет соединения…».
 *
 * Класс, а не случай: `idle` (сеть не открыта ни в одной вкладке) и
 * `connecting` (сокет ещё открывается) — отсутствие сессии, а не обрыв;
 * сообщение о потере связи остаётся только у `reconnecting`/`offline` (и
 * неподтверждённой пробы `suspect → reconnecting/offline`).
 *
 * Отдельный файл: `initDrafts` инициализируется один раз на процесс, и его
 * глобальные `lastConnected`/`prevByNetwork` не должны протекать между
 * тестами (грабля a4f561fc — упавший до teardown тест красит соседний).
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

/** Тексты сообщений в стеке тостов (0.14.1: контейнер `.notice-stack`). */
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

describe('закрытие вкладки сети — не потеря связи (3fa5f9ba)', () => {
  it('connected → idle → connecting → connected без сообщений, реальный обрыв — одно', async () => {
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

    // Открытая сеть: сокет поднялся, первое подключение сессии — тишина.
    store.update({
      rtStatusByNetwork: { [NET1]: 'connected', [NET2]: 'connected' },
      rtStatus: 'connected',
    });
    await settleAsync();
    assert.deepEqual(noticeTexts(), [], 'первое подключение молчит');

    // Закрытие последней вкладки сети: main освободил сокет → `idle`.
    // Это не потеря связи: пользователь сам закрыл вкладку при живом сервере.
    store.update({ rtStatusByNetwork: { [NET1]: 'idle', [NET2]: 'connected' } });
    await settleAsync();
    assert.deepEqual(noticeTexts(), [], 'idle после закрытия вкладки — не потеря связи');

    // Повторное открытие сети: сокет открывается (`connecting`) и поднимается
    // (`connected`). Ни «Нет соединения…», ни ложного «Соединение восстановлено».
    store.update({ rtStatusByNetwork: { [NET1]: 'connecting', [NET2]: 'connected' } });
    await settleAsync();
    assert.deepEqual(noticeTexts(), [], 'connecting — открытие сессии, не потеря связи');
    store.update({ rtStatusByNetwork: { [NET1]: 'connected', [NET2]: 'connected' } });
    await settleAsync();
    assert.deepEqual(noticeTexts(), [], 'подключение той же сети — не восстановление после обрыва');

    // Класс закрыт, а не заглушен: настоящий обрыв по-прежнему сообщается.
    store.update({ rtStatusByNetwork: { [NET1]: 'reconnecting', [NET2]: 'connected' } });
    await settleAsync();
    const lost = noticeTexts();
    assert.equal(lost.length, 1, lost.join(' | '));
    assert.ok(lost[0]!.includes('Переподключение к серверу'), lost.join(' | '));
  });
});
