/**
 * G3 (40fa8118): лента «Дневника» на реактивном слое данных.
 *
 * Лента — производный запрос слоя под ключом `chronicle-feed:@<filter>`:
 * решение «когда обновлять» принимает слой (роутер гасит ключ на чужие события,
 * локальные мутации гасят его же), экран применяет ОДИН путь — отложенный
 * полный перезапрос до загруженной глубины. Прежний bespoke-инкремент
 * (`realtime-apply.ts`, `applyChronicleRealtime`, `invalidateChronicleThought`)
 * снесён.
 *
 * Экран в node-тесте не поднимается (тянет `app.js`/редактор) — проводка
 * проверяется структурно по исходнику; контракт слоя (инвалидации роутера,
 * коалессия) — поведенчески через реестр запросов и реальный роутер.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { AnyRealtimeEvent, RealtimeEventType } from '@etn/shared';

import {
  getQueryState,
  invalidateQueries,
  onQueryInvalidated,
  registerQuery,
  resetEventRouter,
  resetQueryRegistry,
  routeRealtimeEvent,
  setQueryData,
  subscribeQuery,
} from '../src/renderer/lib/live/index.js';
import { queryKeys } from '../src/renderer/lib/live/query-keys.js';

const RENDERER_ROOT = path.resolve(import.meta.dirname, '..', 'src', 'renderer');
const read = (rel: string): string => fs.readFileSync(path.join(RENDERER_ROOT, rel), 'utf8');

const NET = '00000000-0000-4000-8000-0000000000aa';

function mkEvent(type: RealtimeEventType, data: unknown, seq: number): AnyRealtimeEvent {
  return {
    type,
    seq,
    ts: '2026-10-03T00:00:00.000Z',
    actor: { user_id: 'u1', client_id: 'c1' },
    network_id: NET,
    audience: 'network',
    data,
    layer_id: '00000000-0000-0000-0000-000000000000',
  } as unknown as AnyRealtimeEvent;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('chronicle G3: контракт слоя (поведенчески)', () => {
  it('роутер гасит ключ chronicle-feed на чужое comment.created и уведомляет наблюдателя', () => {
    resetQueryRegistry();
    resetEventRouter();
    const key = queryKeys.chronicleFeed('all');
    registerQuery(key, null);
    const seen: string[] = [];
    const unsub = onQueryInvalidated((prefix, keys) => {
      if (prefix.startsWith('chronicle-feed')) seen.push(...keys);
    });

    const res = routeRealtimeEvent(
      mkEvent('comment.created', {
        comment: { id: 'c1', kind: 'chronological', owner_id: 't1', owner_type: 'thought' },
      }, 1),
    );
    assert.equal(res.routed, true);
    assert.ok(res.invalidated.includes(key), 'роутер погасил ключ ленты');
    assert.deepEqual(seen, [key], 'наблюдатель слоя получил ключ ленты');
    assert.equal(getQueryState(key).status, 'stale');
    unsub();
    resetQueryRegistry();
    resetEventRouter();
  });

  it('локальная мутация гасит тот же ключ (единый путь «своя = чужая»)', () => {
    resetQueryRegistry();
    const key = queryKeys.chronicleFeed('all');
    registerQuery(key, null);
    const touched = invalidateQueries(queryKeys.chronicleFeedAll());
    assert.deepEqual(touched, [key]);
    assert.equal(getQueryState(key).status, 'stale');
    resetQueryRegistry();
  });

  it('префиксная изоляция: focus-инвалидация не трогает ключ ленты', () => {
    resetQueryRegistry();
    const feed = queryKeys.chronicleFeed('all');
    const focus = queryKeys.focus('t1');
    registerQuery(feed, null);
    registerQuery(focus, null);
    const touched = invalidateQueries(queryKeys.focusAll());
    assert.deepEqual(touched, [focus], 'погашен только focus-ключ');
    assert.equal(getQueryState(feed).status, 'stale', 'лента не тронута (изначально stale без данных)');
    // Ключ-«сосед» по строке не должен матчиться префиксом (сегментная семантика).
    registerQuery('chronicle-feed-other:x', null);
    const touched2 = invalidateQueries(queryKeys.chronicleFeedAll());
    assert.ok(!touched2.includes('chronicle-feed-other:x'), 'нет ложного матча по подстроке');
    resetQueryRegistry();
  });

  it('коалессия: две инвалидации ключа в одной пачке дают ОДИН перезапрос', async () => {
    resetQueryRegistry();
    const key = queryKeys.chronicleFeed('coalesce');
    let calls = 0;
    const fetcher = async (): Promise<number> => {
      calls += 1;
      return calls;
    };
    const unsub = subscribeQuery(key, fetcher, () => undefined);
    await settle();
    assert.equal(calls, 1, 'подписка запустила первый запрос');

    // Пара событий одной пачки (например, thought.created + link.created).
    invalidateQueries(key);
    invalidateQueries(key);
    await settle();
    assert.equal(calls, 2, 'повторные инвалидации схлопнуты в один перезапрос');
    unsub();
    resetQueryRegistry();
  });

  it('снимок ленты публикуется в кэш как fresh', () => {
    resetQueryRegistry();
    const key = queryKeys.chronicleFeed('snap');
    setQueryData(key, { seq: 1, rows: [], total: 0 });
    assert.equal(getQueryState(key).status, 'fresh');
    resetQueryRegistry();
  });

  it('чужая правка записи (comment.updated) перезапрашивает ленту через слой', async () => {
    resetQueryRegistry();
    resetEventRouter();
    const key = queryKeys.chronicleFeed('remote-edit');
    let calls = 0;
    const unsub = subscribeQuery(
      key,
      async () => {
        calls += 1;
        return calls;
      },
      () => undefined,
    );
    await settle();
    assert.equal(calls, 1, 'подписка запустила первый запрос');

    // Замена снесённой инкрементальной ветки (додар вне страницы, 820608e4):
    // любая чужая правка записи ведёт к перечитыванию ленты слоем.
    const res = routeRealtimeEvent(
      mkEvent('comment.updated', {
        id: 'c1',
        kind: 'chronological',
        owner_id: 't1',
        changes: { body_md: 'new' },
        version: 2,
      }, 1),
    );
    assert.equal(res.routed, true);
    assert.ok(res.invalidated.includes(key));
    await settle();
    assert.equal(calls, 2, 'чужая правка перезапросила ленту');
    unsub();
    resetQueryRegistry();
    resetEventRouter();
  });

  it('правка/удаление мысли адресна: гасится ключ мысли, а не вся лента (замечание G3)', () => {
    resetQueryRegistry();
    resetEventRouter();
    const chipKey = queryKeys.chronicleThought('t1');
    const delKey = queryKeys.chronicleThought('t2');
    const feedKey = queryKeys.chronicleFeed('all');
    registerQuery(chipKey, null);
    registerQuery(delKey, null);
    registerQuery(feedKey, null);
    const upd = routeRealtimeEvent(
      mkEvent('thought.updated', { id: 't1', changes: { title: 'new' }, version: 2 }, 1),
    );
    assert.ok(upd.invalidated.includes(chipKey), 'правка мысли-чипса гасит адресный ключ');
    assert.ok(!upd.invalidated.includes(feedKey), 'невидимая правка НЕ гасит всю ленту');
    const del = routeRealtimeEvent(mkEvent('thought.deleted', { id: 't2' }, 2));
    assert.ok(del.invalidated.includes(delKey), 'удаление мысли гасит адресный ключ');
    assert.ok(!del.invalidated.includes(feedKey), 'удаление невидимой мысли НЕ гасит всю ленту');
    resetQueryRegistry();
    resetEventRouter();
  });
});

describe('chronicle G3: проводка экрана и шины', () => {
  const chronicle = read('screens/chronicle/chronicle.ts');
  const realtimeUi = read('realtime-ui.ts');

  it('лента зарегистрирована под ключом chronicle-feed и подписана на его инвалидации', () => {
    assert.match(chronicle, /function bindChronicleFeed\(\): void \{/);
    assert.match(chronicle, /onQueryInvalidated\(\(prefix\) => \{/);
    assert.match(chronicle, /matchesKeyPrefix\(prefix, 'chronicle-feed'\)/);
    assert.match(chronicle, /registerQuery\(key, null\)/);
    assert.match(chronicle, /function scheduleChronicleFeedRefresh\(\): void \{/);
    assert.match(chronicle, /function publishChronicleSnapshot\(\): void \{/);
  });

  it('старый путь снесён: нет applyChronicleRealtime/invalidateChronicleThought/scheduleChronicleRefresh', () => {
    assert.ok(!/function applyChronicleRealtime\s*\(/.test(chronicle));
    assert.ok(!/function applyChronicleOps\s*\(/.test(chronicle));
    assert.ok(!/function invalidateChronicleThought\s*\(/.test(chronicle));
    assert.ok(!/function scheduleChronicleRefresh\s*\(/.test(chronicle));
    assert.ok(!chronicle.includes('realtime-apply.js'));
    assert.equal(
      fs.existsSync(path.join(RENDERER_ROOT, 'screens', 'chronicle', 'realtime-apply.ts')),
      false,
    );
  });

  it('шина больше не дёргает ленту вручную', () => {
    assert.ok(!realtimeUi.includes('applyChronicleRealtime'));
    assert.ok(!realtimeUi.includes('invalidateChronicleThought'));
    assert.ok(!realtimeUi.includes('scheduleChronicleRefresh'));
    assert.ok(!realtimeUi.includes('screens/chronicle/chronicle.js'), 'нет импорта экрана в шину');
  });

  it('скрытый экран откладывает перезапрос до показа (8e702d8c)', () => {
    assert.match(
      chronicle,
      /if \(store\.state\.activeView !== 'chronicle'\) \{\s*fullRefreshPending = true;/,
      'скрытый вид только помечает снимок грязным',
    );
    assert.match(
      chronicle,
      /store\.state\.activeView === 'chronicle' && fullRefreshPending[\s\S]{0,160}?refreshFeedAndCalendar\(\)/,
      'показ вида снимает пометку одним перезапросом',
    );
  });
});
