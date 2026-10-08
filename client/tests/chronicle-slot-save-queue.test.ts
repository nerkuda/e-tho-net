/**
 * Регресс ошибки d60f61b5: «Дневник: запись дня без заголовка не создаётся —
 * коммит слота зависает, текст затем теряется».
 *
 * Корень (подтверждён рантайм-трейсом на стенде .tmp/ver-focus, сценарий d1):
 * Ctrl+Enter в теле слота запускал единую запись, но `editor.blur()` синхронно
 * порождал `focusout` слота → `ensureSlot({})` (план `none`) ЗАНИМАЛ страж
 * `slotBusy` первым. Настоящее сохранение тела `ensureSlot({ body })` видело
 * занятый страж и возвращало чужой промис — содержимое не долетало до сервера:
 * POST /comments не уходил, запись не создавалась, метка календаря не появлялась.
 * Слот при этом «успешно» выходил в просмотр сырым markdown (`onSave` возвращал
 * `md` вместо html).
 *
 * Фикс — очередь `enqueueSlotSave`: очередное сохранение выполняется строго
 * после предыдущего и НЕ подменяется его результатом. Защита от дубля сохранена:
 * второй вызов видит проставленный `state.commentId` и обновляет запись.
 *
 * Поведенческая часть: чистая очередь `enqueueSlotSave` (diary.ts) на
 * смоделированном сценарии гонки. Структурные инварианты экрана — в стороже
 * `guard-chronicle-slot-save-queue.test.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { enqueueSlotSave } from '../src/renderer/screens/chronicle/diary.js';

/** Разрешение промиса извне (ручное управление ходом очереди в тесте). */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('очередь сохранений псевдо-записи (ошибка d60f61b5)', () => {
  it('сохранение с содержимым не подменяется промисом раннего пустого сохранения', async () => {
    // Сценарий гонки: «пустое» сохранение ухода фокуса (`ensureSlot({})`, план
    // `none`) уже в полёте и держит очередь. Раньше настоящее сохранение тела
    // возвращало его промис и терялось; теперь тело сохраняется после него.
    const calls: string[] = [];
    const empty = deferred<null>();
    const bodySave = enqueueSlotSave(empty.promise, async () => {
      calls.push('POST /comments');
      return 'rec';
    });
    // Пока пустое не разрешилось, тело ещё не сохранено — но и не потеряно.
    assert.deepEqual(calls, [], 'тело ждёт завершения раннего сохранения');
    empty.resolve(null);
    assert.equal(await bodySave, 'rec', 'тело сохранено, id записи получен');
    assert.deepEqual(calls, ['POST /comments'], 'запрос создания ушёл на сервер');
  });

  it('сохранения выполняются строго в порядке поступления', async () => {
    const order: string[] = [];
    const first = deferred<void>();
    let busy: Promise<unknown> | null = null;
    const run1 = enqueueSlotSave(busy, async () => {
      await first.promise;
      order.push('first');
      return 1;
    });
    busy = run1;
    const run2 = enqueueSlotSave(busy, async () => {
      order.push('second');
      return 2;
    });
    assert.deepEqual(order, [], 'ни одно не стартовало, пока очередь занята');
    first.resolve();
    assert.deepEqual(await Promise.all([run1, run2]), [1, 2]);
    assert.deepEqual(order, ['first', 'second'], 'порядок сохранён');
  });

  it('сбой предыдущего сохранения не блокирует следующее', async () => {
    const failed: Promise<unknown> = Promise.reject(new Error('boom'));
    const next = enqueueSlotSave(failed, async () => 'ok');
    assert.equal(await next, 'ok', 'очередь продолжается после сбоя');
  });

  it('без занятой очереди сохранение стартует сразу', async () => {
    assert.equal(await enqueueSlotSave(null, async () => 'rec'), 'rec');
  });
});
