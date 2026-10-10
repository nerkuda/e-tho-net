/**
 * Интеграционный тест РЕАЛЬНОГО пути `paintView` → разметка «замочков» чужих
 * захватов трансклюзий в просмотре (ошибка f60f99e0, замечание тестировщика).
 *
 * Чистый хелпер `decorateViewTransclusionLocks` покрыт отдельно
 * (`transclusion-view-lock.test.ts`); здесь проверяется, что `createMarkdownField`
 * (его `paintView`, `editor/markdown-field.ts`) РЕАЛЬНО вызывает разметку на
 * рендере и включает подписку на кэш захватов. Мутация «убрать эти два вызова
 * из `paintView`» обязана красить тест: без них ни вызов разметки, ни подписка
 * не наблюдаются.
 *
 * Headless: DOM-шим проекта (`tests/dom-shim.ts`) — HTML просмотра кладётся в
 * `innerHTML` (шим его не разбирает на узлы), поэтому вызов разметки
 * наблюдается на уровне `querySelectorAll` самого элемента просмотра, а
 * подписка — на уровне запроса живых полей из глобального `document`.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';
import { __resetForTests, __setForTests } from '../src/renderer/lib/lock-cache.js';
import type { LockRow } from '@etn/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NET = 'c4f9a3b2-1111-2222-3333-444455556666';
const ID_SRC = '11111111-1111-4111-8111-111111111111';

/** Счётчики наблюдаемых вызовов реального пути. */
interface Calls {
  /** Вызовы селектора `.md-transclusion[…]` — разметка «замочков» в просмотре. */
  decorate: number;
  /** Обход живых полей `.md-field-view` из подписки на lock-cache. */
  wireQuery: number;
}

/** Сборка headless-окружения, достаточного для `createMarkdownField`. */
function installShim(): Calls {
  const calls: Calls = { decorate: 0, wireQuery: 0 };
  const styleStub = {
    setProperty: () => undefined,
    removeProperty: () => undefined,
    getPropertyValue: () => '',
  };
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: styleStub },
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    activeElement: null,
    querySelectorAll: (selector: string) => {
      if (selector === '.md-field-view') calls.wireQuery += 1;
      return [];
    },
    querySelector: () => null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  win.cancelAnimationFrame = (id: number) => clearTimeout(id);
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.getComputedStyle = () => ({ getPropertyValue: () => '' });
  win.matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  const ls = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => ls.get(k) ?? null,
    setItem: (k: string, v: string) => void ls.set(k, v),
    removeItem: (k: string) => void ls.delete(k),
    clear: () => ls.clear(),
    key: (i: number) => [...ls.keys()][i] ?? null,
    get length() {
      return ls.size;
    },
  };
  // Наблюдение за вызовом разметки на элементе просмотра (шим не разбирает
  // `innerHTML`, поэтому о вызове судим по селектору разметки блоков).
  const proto = ShimElement.prototype as any;
  if (proto.__viewLockOrig === undefined) {
    proto.__viewLockOrig = proto.querySelectorAll;
    proto.querySelectorAll = function (this: ShimElement, selector: string) {
      if (selector.startsWith('.md-transclusion[')) calls.decorate += 1;
      return proto.__viewLockOrig.call(this, selector);
    };
  }
  return calls;
}

function restoreShimQsa(): void {
  const proto = ShimElement.prototype as any;
  if (proto.__viewLockOrig !== undefined) {
    proto.querySelectorAll = proto.__viewLockOrig;
    proto.__viewLockOrig = undefined;
  }
}

/** Строка кэша захватов: источник держит другой участник. */
function foreignLock(entityId: string): LockRow {
  return {
    id: `lock-${entityId}`,
    entity_type: 'thought',
    entity_id: entityId,
    user_id: 'Алиса',
    client_id: 'client-1',
    acquired_at_ms: 1,
  };
}

describe('реальный путь paintView: разметка замочков и подписка (f60f99e0)', () => {
  beforeEach(() => {
    __resetForTests();
  });

  afterEach(() => {
    restoreShimQsa();
  });

  it('createMarkdownField на рендере размечает замочки и подписывается на lock-cache', async () => {
    const calls = installShim();
    const { store } = (await import('../src/renderer/state.js')) as typeof import('../src/renderer/state.js');
    store.update({ networkId: NET });
    const md = (await import('../src/renderer/editor/markdown-field.js')) as typeof import('../src/renderer/editor/markdown-field.js');

    md.createMarkdownField({
      md: '',
      html:
        `<div class="md-transclusion" data-transclusion-source="${ID_SRC}">текст</div>`,
      sourceMapView: false,
    });

    // paintView вызвал разметку «замочков» (мутация: убрать вызов — счётчик 0).
    assert.ok(calls.decorate >= 1, 'paintView обязан размечать «замочки» в просмотре');

    // Подписка на lock-cache активна: переход кэша обходит живые поля просмотра
    // (мутация: убрать wireViewTransclusionLocks — обхода не будет).
    const before = calls.wireQuery;
    __setForTests([foreignLock(ID_SRC)]);
    assert.ok(calls.wireQuery > before, 'подписка на lock-cache обязана быть активна');

    // Даём осесть асинхронным работам поля (загрузка зума и т.п.).
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
