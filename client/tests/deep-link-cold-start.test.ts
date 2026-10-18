/**
 * Интеграционный регресс холодного старта deep-link (ошибка d8b81425).
 *
 * Прежний фикс буферизовал URL в главном процессе, но renderer слал ack сразу
 * при подписке — до `await boot()`. `boot → restoreSession → openNetwork`
 * восстанавливал сохранённый фокус HOME и перекрывал `setFocus` цели. Тест
 * гоняет РЕАЛЬНЫЙ порядок запуска (`startDeepLinks` + production
 * `initDeepLinkHandler`/`signalDeepLinkReady`) на подставном мосте
 * `window.etn`, а применение цели проверяет с целью, ОТЛИЧНОЙ от HOME, и все
 * ветвления сценария.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DeepLinkPayload } from '../src/main/ipc/deep-link.js';
import { DeepLinkBuffer } from '../src/main/ipc/deep-link.js';
import type { DeepLinkDeps } from '../src/renderer/editor/deep-link-handler.js';
import { ShimElement } from './dom-shim.js';

const NET = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
const HOME = '00000000-0000-4000-8000-0000000000ba5e';
const TARGET = 'b8602f5b-1111-4222-8333-944455556666';

interface EtnStub {
  onLink: ((link: DeepLinkPayload) => void) | null;
  readyCount: number;
  order: string[];
  onSignalReady: (() => void) | null;
}

function shimDom(): EtnStub {
  (globalThis as { HTMLElement?: unknown }).HTMLElement = ShimElement;
  const doc: Record<string, unknown> = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body: new ShimElement('body'),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
    getSelection: () => null,
  };
  (globalThis as { document?: unknown }).document = doc;

  const g = globalThis as unknown as { window?: Record<string, unknown> };
  const win = (g.window ??= {});
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.dispatchEvent = () => undefined;

  const stub: EtnStub = { onLink: null, readyCount: 0, order: [], onSignalReady: null };
  win.etn = {
    deepLink: {
      onDeepLink: (cb: (link: DeepLinkPayload) => void) => {
        stub.onLink = cb;
        stub.order.push('subscribe');
      },
      signalReady: () => {
        stub.readyCount += 1;
        stub.order.push('signal');
        stub.onSignalReady?.();
      },
    },
  };
  return stub;
}

function deps(overrides: Partial<DeepLinkDeps> = {}) {
  const focused: string[] = [];
  const notices: string[] = [];
  const base: DeepLinkDeps = {
    currentNetworkId: () => NET,
    openNetwork: async () => undefined,
    getThought: async () => ({ id: TARGET, active: true }),
    setFocus: async (id: string) => {
      focused.push(id);
    },
    showInactive: () => false,
    notice: (text: string) => notices.push(text),
    getPublication: async () => ({}),
    openPublicationInWorkspace: async () => undefined,
    ...overrides,
  };
  return { base, focused, notices };
}

test('холодный старт: ack уходит после boot, цель ≠ HOME становится фокусом', async () => {
  const stub = shimDom();
  const { applyDeepLink, startDeepLinks } = await import(
    '../src/renderer/editor/deep-link-handler.js'
  );
  const { base, focused, notices } = deps();

  // Холодная цель лежит в буфере главного процесса до ack.
  const buffer = new DeepLinkBuffer();
  const link: DeepLinkPayload = { networkId: NET, thoughtId: TARGET };
  assert.equal(buffer.offer(link), false, 'до ack цель не доставляется');

  // Главный процесс по ack сливает буфер и шлёт событие renderer'у.
  const applied: Promise<void>[] = [];
  stub.onSignalReady = () => {
    for (const pending of buffer.setReady(true)) {
      applied.push(applyDeepLink(pending, base));
    }
  };

  await startDeepLinks(async () => {
    stub.order.push('boot');
    // restoreSession/openNetwork восстанавливает сохранённый фокус HOME.
    focused.push(HOME);
  });
  await Promise.all(applied);

  // Подписка (production initDeepLinkHandler) → boot → ack; сигнал ровно один.
  assert.deepEqual(stub.order, ['subscribe', 'boot', 'signal'], 'ack — только после boot');
  assert.equal(stub.readyCount, 1, 'повторного/раннего ack нет');
  assert.deepEqual(focused, [HOME, TARGET], 'цель перекрывает восстановленный HOME');
  assert.equal(focused.at(-1), TARGET);
  assert.notEqual(TARGET, HOME);
  assert.deepEqual(notices, []);
});

test('холодный старт: неактуальная мысль даёт notice и не меняет фокус', async () => {
  shimDom();
  const { applyDeepLink } = await import('../src/renderer/editor/deep-link-handler.js');
  const { base, focused, notices } = deps({
    getThought: async () => ({ id: TARGET, active: false }),
  });
  await applyDeepLink({ networkId: NET, thoughtId: TARGET }, base);
  assert.equal(notices.length, 1);
  assert.match(notices[0] ?? '', /неактуальную/u);
  assert.deepEqual(focused, []);
});

test('холодный старт: отсутствующая мысль даёт notice', async () => {
  shimDom();
  const { applyDeepLink } = await import('../src/renderer/editor/deep-link-handler.js');
  const { base, focused, notices } = deps({
    getThought: async () => {
      throw new Error('NOT_FOUND');
    },
  });
  await applyDeepLink({ networkId: NET, thoughtId: TARGET }, base);
  assert.equal(notices.length, 1);
  assert.match(notices[0] ?? '', /Мысль удалена или недоступна/u);
  assert.deepEqual(focused, []);
});

test('холодный старт: недоступная сеть даёт notice и не трогает мысль', async () => {
  shimDom();
  const { applyDeepLink } = await import('../src/renderer/editor/deep-link-handler.js');
  let readThought = false;
  const { base, focused, notices } = deps({
    currentNetworkId: () => null,
    openNetwork: async () => {
      throw new Error('ECONNREFUSED');
    },
    getThought: async () => {
      readThought = true;
      return { id: TARGET, active: true };
    },
  });
  await applyDeepLink({ networkId: NET, thoughtId: TARGET }, base);
  assert.equal(notices.length, 1);
  assert.match(notices[0] ?? '', /Сеть недоступна/u);
  assert.equal(readThought, false);
  assert.deepEqual(focused, []);
});
