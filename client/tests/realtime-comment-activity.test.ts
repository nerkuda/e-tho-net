/**
 * Активность комментария = изменение ВЛАДЕЛЬЦА (ETN ошибка 04344707, «Замечания
 * визуальной проверки часть 8»).
 *
 * Домен двигает `updated_at` владельца-МЫСЛИ при создании/правке/удалении
 * комментария и хроно-записи (ошибка 228df7a4; приравнивание — требование
 * e6d4165e «правка содержимого владельца = правка владельца»), поэтому отбор по
 * «Дате изменений» и условие «Есть комментарий» меняют состав результатов.
 * Клиент обязан перечитать страницу отбора «Структур» — иначе правка
 * комментария «не считается изменением мысли»: список остаётся прежним, пока
 * пользователь не нажмёт «Применить» вручную.
 *
 * Здесь закрепляются оба пути инвалидации одного набора ключей:
 *   • роутер реального времени (`comment.created`/`updated`/`deleted`) — по
 *     `RouteResult.invalidated` (табличный путь маршрута);
 *   • локальный сигнал mutator-слоя (`signalOwnerActivity`) — своя правка
 *     обязана гасить ТЕ ЖЕ ключи, что сетевое событие (урок ошибки 4b3d1940).
 *
 * Окрестность фокуса (`focus:<id>`) в набор НЕ входит сознательно: отклик фокуса
 * комментариев не несёт, а его перечитывание трясло редактор (ошибка 206e33a1) —
 * тест фиксирует это, чтобы фикс 04344707 не вернул 206e33a1.
 *
 * Замечание приёмки круга 1 ошибки 91b8afbb: проверка «фокуса нет в
 * `RouteResult.invalidated`» была ВАКУУМНОЙ — `routeRealtimeEvent` возвращает
 * только ЗАРЕГИСТРИРОВАННЫЕ ключи, а тест регистрировал одну страницу отбора,
 * поэтому возврат `queryKeys.focus(<владелец>)` в маршруты `comment.*` сторож не
 * ловил (краснел только `data-layer.test.ts`). Теперь кейсы `comment.*`
 * регистрируют ещё и окрестность владельца из фикстуры (`focus:@t1`) — лишнее
 * гашение фокуса попадает в `invalidated` и валит проверку.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AnyRealtimeEvent } from '@etn/shared';

import {
  commentActivityKeys,
  getQueryState,
  onQueryInvalidated,
  queryKeys,
  registerQuery,
  resetEventRouter,
  resetQueryRegistry,
  routeRealtimeEvent,
  signalOwnerActivity,
} from '../src/renderer/lib/live/index.js';

let seq = 0;

function event(type: string, data: Record<string, unknown>): AnyRealtimeEvent {
  seq += 1;
  return {
    type,
    seq,
    ts: '2024-01-01T00:00:00.000Z',
    actor: { user_id: 'u2', client_id: 'c2' },
    audience: 'network',
    network_id: 'n1',
    layer_id: 'base',
    data,
    meta: { version: 1 },
  } as unknown as AnyRealtimeEvent;
}

/** Ключи, погашенные за время вызова (локальный путь — через наблюдателя слоя). */
function invalidatedKeys(run: () => void): string[] {
  const keys: string[] = [];
  const off = onQueryInvalidated((_prefix, keys0) => {
    keys.push(...keys0);
  });
  try {
    run();
  } finally {
    off();
  }
  return keys;
}

describe('активность комментария: страница отбора «Структур» гасится (04344707)', () => {
  it('набор ключей — страница «Структур», и НЕ окрестность фокуса (память 206e33a1)', () => {
    assert.deepEqual(commentActivityKeys(), [queryKeys.structuresPageAll()]);
    for (const key of commentActivityKeys()) {
      assert.ok(!key.startsWith('focus'), `focus не гасим: ${key}`);
    }
  });

  it('comment.created/updated/deleted гасят страницу отбора', () => {
    const cases: AnyRealtimeEvent[] = [
      event('comment.created', { comment: { id: 'c1', owner_type: 'thought', owner_id: 't1' } }),
      event('comment.updated', {
        id: 'c1',
        owner_id: 't1',
        owner_type: 'thought',
        kind: 'chronological',
        changes: { body_md: 'x' },
        version: 2,
      }),
      event('comment.deleted', { owner_type: 'thought', owner_id: 't1', id: 'c1' }),
    ];
    // Окрестность владельца из фикстуры регистрируется НАМЕРЕННО: реестр
    // возвращает только зарегистрированные ключи, и без этой регистрации
    // `invalidated` не может содержать `focus` — проверка запрета 206e33a1
    // была вакуумной (замечание приёмки круга 1 ошибки 91b8afbb): возврат
    // `focus(owner_id)` в маршруты `comment.*` сторож не ловил.
    const ownerFocusKey = queryKeys.focus('t1');
    for (const evt of cases) {
      resetQueryRegistry();
      resetEventRouter();
      const pageKey = queryKeys.structuresPage('all');
      registerQuery(pageKey, null);
      registerQuery(ownerFocusKey, null);
      const res = routeRealtimeEvent(evt);
      assert.ok(res.routed, `${evt.type}: событие обязано быть маршрутизировано`);
      assert.deepEqual(
        res.invalidated,
        [pageKey],
        `${evt.type}: маршрут обязан погасить ровно страницу отбора (окрестность фокуса запрещена, 206e33a1)`,
      );
      assert.equal(getQueryState(pageKey).status, 'stale', `${evt.type}: страница помечена stale`);
      assert.ok(
        !res.invalidated.some((k) => k.startsWith('focus')),
        `${evt.type}: окрестность фокуса гасить нельзя (206e33a1)`,
      );
    }
  });

  it('своя правка (signalOwnerActivity) гасит тот же ключ, что сетевое событие', () => {
    resetQueryRegistry();
    registerQuery(queryKeys.structuresPage('all'), null);
    const viaSignal = invalidatedKeys(() => {
      signalOwnerActivity('t1');
    });
    resetQueryRegistry();
    registerQuery(queryKeys.structuresPage('all'), null);
    const viaEvent = invalidatedKeys(() => {
      routeRealtimeEvent(
        event('comment.deleted', { owner_type: 'thought', owner_id: 't1', id: 'c1' }),
      );
    });
    assert.deepEqual(
      viaSignal,
      [queryKeys.structuresPage('all')],
      `свой путь: ${viaSignal.join(', ') || '—'}`,
    );
    assert.deepEqual(
      viaSignal.filter((k) => k.startsWith('structures-page')),
      viaEvent.filter((k) => k.startsWith('structures-page')),
      'локальный путь обязан совпасть с сетевым',
    );
  });
});
