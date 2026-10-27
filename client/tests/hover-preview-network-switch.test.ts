/**
 * Unit tests for the open guard of the Ctrl-hover preview engine (ошибка
 * a3151e33: «Попап предпросмотра показывает комментарий чужой сети после
 * переключения»).
 *
 * Сетевые резолверы движка (`comment`, `chrono`, `attachments`, wiki-ссылки,
 * `thought-cross-network`) читают данные ТЕКУЩЕЙ сети и снимают её вместе с
 * триггером до первого await. Если пользователь переключил сеть/вкладку, пока
 * ответ в полёте, содержимое прежней пары показывать нельзя: DOM рабочего
 * пространства уже пересоздан (`teardownWorkspace` + `clear(root)`), а попап
 * открылся бы якорем к откреплённому узлу поверх чужого экрана.
 *
 * {@link isOpenGuardValid} — единственный страж на ВСЕ kind: поколение
 * открытий не перекрыто, пара «сеть + вкладка» та же, триггер ещё в документе.
 * Проверяется как чистая функция — без DOM и store, как и остальные
 * поведенческие пробы движка (`hover-preview-close.test.ts`).
 */

import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { hoverPreviewInternals } from '../src/renderer/lib/hover-preview.js';
import { store } from '../src/renderer/state.js';

const { isOpenGuardValid, screenPairKey, watchScreenPairChange } = hoverPreviewInternals;

const NET = '00000000-0000-4000-8000-000000000001';
const OTHER_NET = '00000000-0000-4000-8000-000000000002';

const PAIR = { networkId: '00000000-0000-4000-8000-000000000001', tabId: 'tab-a' };
const GUARD = { generation: 7, pair: PAIR };
/** Актуальное состояние в момент ответа резолвера. */
const CURRENT = { generation: 7, pairIsCurrent: true, attached: true };

test('isOpenGuardValid: актуальная пара и живой триггер — попап открывается', () => {
  assert.equal(isOpenGuardValid(GUARD, CURRENT), true);
});

test('isOpenGuardValid: сеть/вкладка сменились, пока шёл резолвер — содержимое не показывается', () => {
  assert.equal(isOpenGuardValid(GUARD, { ...CURRENT, pairIsCurrent: false }), false);
});

test('isOpenGuardValid: более новое открытие/отмена перекрыло поколение — поздний ответ отбрасывается', () => {
  assert.equal(isOpenGuardValid(GUARD, { ...CURRENT, generation: 8 }), false);
});

test('isOpenGuardValid: триггер откреплён (workspace пересоздан) — попап не открывается', () => {
  assert.equal(isOpenGuardValid(GUARD, { ...CURRENT, attached: false }), false);
});

test('isOpenGuardValid: пара не снята (нет открытой сети) — попап не открывается', () => {
  assert.equal(isOpenGuardValid({ generation: 7, pair: null }, CURRENT), false);
});

// ---------------------------------------------------------------------------
// Круг 3: уже ОТКРЫТАЯ цепочка закрывается при смене пары «сеть + вкладка»
// (ошибка a3151e33). Панель монтируется в `document.body` и переживает
// `teardownWorkspace` + `clear(root)`, поэтому закрытие живёт в подписке движка.
// ---------------------------------------------------------------------------

describe('watchScreenPairChange: смена пары закрывает открытую цепочку (a3151e33)', () => {
  beforeEach(() => {
    store.update({ networkId: null, activeTabId: null });
  });

  test('смена сети — по одному вызову на переход', () => {
    let calls = 0;
    const stop = watchScreenPairChange(() => {
      calls += 1;
    });
    store.update({ networkId: NET });
    assert.equal(calls, 1);
    store.update({ networkId: OTHER_NET });
    assert.equal(calls, 2);
    stop();
  });

  test('смена вкладки в той же сети — тоже смена пары', () => {
    store.update({ networkId: NET, activeTabId: 'tab-a' });
    let calls = 0;
    const stop = watchScreenPairChange(() => {
      calls += 1;
    });
    store.update({ activeTabId: 'tab-b' });
    assert.equal(calls, 1);
    stop();
  });

  test('обновление состояния без смены пары цепочку не закрывает', () => {
    store.update({ networkId: NET, activeTabId: 'tab-a' });
    let calls = 0;
    const stop = watchScreenPairChange(() => {
      calls += 1;
    });
    store.update({ showInactive: true });
    store.update({ focus: null });
    store.update({ networkId: NET, activeTabId: 'tab-a' });
    assert.equal(calls, 0);
    stop();
  });

  test('после отписки смена пары закрытие не вызывает', () => {
    store.update({ networkId: NET, activeTabId: 'tab-a' });
    let calls = 0;
    const stop = watchScreenPairChange(() => {
      calls += 1;
    });
    stop();
    store.update({ networkId: OTHER_NET });
    assert.equal(calls, 0);
  });

  test('screenPairKey различает сеть и вкладку, null — пустой ключ', () => {
    assert.equal(screenPairKey(null), '');
    assert.notEqual(screenPairKey(PAIR), screenPairKey({ ...PAIR, tabId: 'tab-b' }));
    assert.notEqual(screenPairKey(PAIR), screenPairKey({ ...PAIR, networkId: OTHER_NET }));
  });
});
