/**
 * Повторная загрузка данных после восстановления связи (ошибка de34b35b,
 * замечания заказчика после проверки GUI).
 *
 * Контракт `editor/comments.ts` (и вкладок «Дневник»/«Вложения»/«Связи»/
 * «Свойства»): первая загрузка может упасть `connection-lost`; ошибка
 * остаётся на экране, а как только сеть снова сообщает `connected`, загрузка
 * повторяется с состояния `{kind:'loading'}` — без пересборки вкладки.
 * Здесь закреплён ровно этот сценарий и подписка `onReconnected`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { EtnError } from '@etn/shared';

import { isConnectionLostError } from '../src/renderer/lib/dom.js';
import { onReconnected, store } from '../src/renderer/state.js';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

/** Первая попытка падает connection-lost, вторая возвращает комментарий. */
function fakeCommentsList(): () => Promise<Array<{ kind: string; body_md: string }>> {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) {
      throw new EtnError('INTERNAL', 'Нет связи с сервером — запрос отменён', {
        kind: 'connection-lost',
        networkId: 'n1',
      });
    }
    return [{ kind: 'permanent', body_md: 'Текст комментария' }];
  };
}

describe('повторная загрузка после связи', () => {
  it('comments.list: ошибка → connected → повтор и рендер комментария', async () => {
    store.update({
      networkId: 'n1',
      rtStatusByNetwork: { n1: 'offline' },
    });
    const list = fakeCommentsList();

    let state: 'loading' | 'error' | 'ready' = 'loading';
    let rendered = '';
    let stop: () => void = () => undefined;

    async function loadPermanent(): Promise<void> {
      state = 'loading';
      try {
        const comments = await list();
        rendered = comments.find((c) => c.kind === 'permanent')?.body_md ?? '';
        state = 'ready';
      } catch (err) {
        state = 'error';
        if (isConnectionLostError(err)) {
          stop = onReconnected('n1', () => void loadPermanent());
        }
      }
    }

    // Панель отсоединена от DOM: активна другая вкладка. Это НЕ dispose —
    // повтор обязан сработать (verifier blocker de34b35b).
    const detachedPanel = { isConnected: false };
    assert.equal(detachedPanel.isConnected, false);

    await loadPermanent();
    assert.equal(state, 'error', 'первая попытка показывает ошибку');
    assert.equal(rendered, '');

    // Сеть восстановилась — загрузка обязана повториться сама.
    store.update({ rtStatusByNetwork: { n1: 'connected' } });
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));

    assert.equal(state, 'ready', 'после connected состояние стало ready');
    assert.equal(rendered, 'Текст комментария', 'комментарий отрисован в отсоединённой панели');
    stop();
  });

  it('dispose панели снимает подписку (вытесненная вкладка не перезагружается)', () => {
    store.update({ networkId: 'n1', rtStatusByNetwork: { n1: 'offline' } });
    let retried = 0;
    let retryStop: (() => void) | null = null;
    const disposeCallbacks: Array<() => void> = [];
    const lifecycle = {
      onDispose(callback: () => void): void {
        disposeCallbacks.push(callback);
      },
    };
    lifecycle.onDispose(() => {
      retryStop?.();
      retryStop = null;
    });
    retryStop = onReconnected('n1', () => {
      retried += 1;
    });

    // Редактор вытеснил панель: жизненный цикл освобождает подписку.
    for (const callback of disposeCallbacks) callback();
    store.update({ rtStatusByNetwork: { n1: 'connected' } });
    assert.equal(retried, 0);
  });

  it('смена сети снимает подписку (чужой connected не будит вкладку)', () => {
    store.update({ networkId: 'n1', rtStatusByNetwork: { n1: 'offline' } });
    let retried = 0;
    const stop = onReconnected('n1', () => {
      retried += 1;
    });
    store.update({ networkId: 'n2', rtStatusByNetwork: { n2: 'connected' } });
    assert.equal(retried, 0);
    stop();
  });

  it('исходник комментария заряжает повтор со состояния loading', () => {
    const src = readFileSync(resolve(RENDERER, 'editor', 'comments.ts'), 'utf8');
    assert.match(src, /async function loadPermanent\(\): Promise<void>/);
    assert.match(src, /shell\.setState\(\{ kind: 'loading' \}\)/);
    assert.match(src, /if \(isConnectionLostError\(err\)\) watchForReconnect\(\)/);
    // Никакой DOM-связности: панель может быть отсоединена (другая вкладка).
    assert.doesNotMatch(src, /onReconnected\([^)]*isConnected/);
    assert.match(src, /onReconnected\(networkId, \(\) => void loadPermanent\(\)\)/);
    assert.match(src, /lifecycle\.onDispose\(\(\) => \{/);
  });

  it('редактор освобождает подписки только при вытеснении панели', () => {
    const src = readFileSync(resolve(RENDERER, 'editor', 'editor.ts'), 'utf8');
    // Тип жизненного цикла доходит до строителей вкладок и секций.
    assert.match(src, /export interface TabPaneLifecycle/);
    assert.match(src, /export type TabContentBuilder = \(\s*ctx: EditorContext,\s*lifecycle: TabPaneLifecycle,?\s*\) => HTMLElement/);
    assert.match(src, /export type MainSectionBuilder = \(\s*ctx: EditorContext,\s*lifecycle: TabPaneLifecycle,?\s*\) => GroupSpec \| null/);
    // Вытеснение/пересборка: dispose перед удалением из кэша и при полном
    // сбросе кэша (`mountEditor` / `renderFull`).
    assert.match(src, /function disposePane\(/);
    assert.match(src, /function disposeAllPanes\(/);
    assert.match(src, /disposePane\(id\);\s*builtPanes\.delete\(id\)/);
    assert.match(src, /disposeAllPanes\(\);\s*builtPanes = new Map\(\)/);
    // Отсоединение панели само по себе подписку не снимает.
    assert.doesNotMatch(src, /isConnected[^\n]*onDispose/);
  });
});
