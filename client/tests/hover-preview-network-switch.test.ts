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

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hoverPreviewInternals } from '../src/renderer/lib/hover-preview.js';

const { isOpenGuardValid } = hoverPreviewInternals;

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
