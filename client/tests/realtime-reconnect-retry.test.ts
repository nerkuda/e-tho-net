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
          stop = onReconnected('n1', () => true, () => void loadPermanent());
        }
      }
    }

    await loadPermanent();
    assert.equal(state, 'error', 'первая попытка показывает ошибку');
    assert.equal(rendered, '');

    // Сеть восстановилась — загрузка обязана повториться сама.
    store.update({ rtStatusByNetwork: { n1: 'connected' } });
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));

    assert.equal(state, 'ready', 'после connected состояние стало ready');
    assert.equal(rendered, 'Текст комментария', 'комментарий отрисован');
    stop();
  });

  it('подписка снимается: размонтированная вкладка не перезагружается', async () => {
    store.update({ networkId: 'n1', rtStatusByNetwork: { n1: 'offline' } });
    let retried = 0;
    const stop = onReconnected('n1', () => false, () => {
      retried += 1;
    });
    store.update({ rtStatusByNetwork: { n1: 'connected' } });
    assert.equal(retried, 0);
    stop();
  });

  it('смена сети снимает подписку (чужой connected не будит вкладку)', () => {
    store.update({ networkId: 'n1', rtStatusByNetwork: { n1: 'offline' } });
    let retried = 0;
    const stop = onReconnected('n1', () => true, () => {
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
    assert.match(src, /onReconnected\(\s*networkId,\s*\(\) => box\.isConnected,/);
  });
});
