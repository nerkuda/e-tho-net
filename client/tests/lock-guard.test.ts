/**
 * Тесты контракта хелпера захватов `lib/lock-guard.ts` (ошибка `85edaad1`).
 *
 * Контракт {@link acquireOrShowBlocked}: «неудачный захват не блокирует работу»
 * — любая ошибка (включая бросок `requireNetworkId()` при закрытой сети)
 * оборачивается исходом `failed`, а не пробрасывается наружу. Вызывающие
 * (`trash.ts`, `comments.ts`, `editor.ts`, `property-manager.ts`,
 * `type-manager.ts`) навешивают `.then(...)` без `.catch`, поэтому исключение
 * из хелпера грозило unhandled rejection.
 *
 * Реальный `EditorView`/DOM не поднимается: нужен лишь минимальный шим для
 * `notice()` (тост в пустой ветке сбоя). Модуль `lock-guard.ts` тянет
 * `../app.js`, поэтому импорт — динамический, ПОСЛЕ установки шима.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/** Минимальный `document`/`window` под `notice()` и косвенные чтения модулей. */
function shimDom(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body: new ShimElement('body'),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

shimDom();

const { store } = await import('../src/renderer/state.js');
const { acquireOrShowBlocked } = await import('../src/renderer/lib/lock-guard.js');

/**
 * Кладёт дублёр моста `etn`. `lib/etn.ts` читает мост лениво: при
 * определённом `window` — из `window.etn`, иначе из `globalThis.etn`
 * (шим `notice()` определяет `window` ради `setTimeout`). Пишем в оба места.
 */
function installEtn(locks: { acquire: (...args: string[]) => Promise<unknown> }): void {
  (globalThis as any).etn = { locks };
  const win = (globalThis as any).window;
  if (win !== undefined) win.etn = { locks };
}

describe('lock-guard: неудачный захват не блокирует (85edaad1)', () => {
  it('закрытая сеть: requireNetworkId внутри try → исход failed, без броска', async () => {
    const prevNetworkId = store.state.networkId;
    let acquireCalls = 0;
    installEtn({
      acquire: async () => {
        acquireCalls += 1;
        return {};
      },
    });
    // Сеть закрыта — `requireNetworkId()` бросает «Сеть не открыта.».
    store.update({ networkId: null });

    try {
      const outcome = await acquireOrShowBlocked('thought', 'thought-x');
      assert.equal(outcome.kind, 'failed', 'исход — failed, а не выброшенное исключение');
      assert.ok(outcome.kind === 'failed' && outcome.error instanceof Error, 'ошибка сохранена');
      assert.equal(acquireCalls, 0, 'сетевой вызов не делается без открытой сети');
    } finally {
      store.update({ networkId: prevNetworkId });
    }
  });

  it('открытая сеть: захват уходит на сервер и даёт исход acquired', async () => {
    const prevNetworkId = store.state.networkId;
    let acquireCalls = 0;
    installEtn({
      acquire: async (_net: string, entityType: string, entityId: string) => {
        acquireCalls += 1;
        return {
          id: 'lock-1',
          entity_type: entityType,
          entity_id: entityId,
          user_id: 'me',
          client_id: null,
          acquired_at_ms: 0,
        };
      },
    });
    store.update({ networkId: 'net-open' });

    try {
      const outcome = await acquireOrShowBlocked('thought', 'thought-y');
      assert.equal(outcome.kind, 'acquired');
      assert.equal(acquireCalls, 1, 'захват ушёл на сервер при открытой сети');
    } finally {
      store.update({ networkId: prevNetworkId });
    }
  });
});
