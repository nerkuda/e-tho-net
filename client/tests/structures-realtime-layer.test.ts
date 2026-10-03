/**
 * G2 (65286909): «Структуры» на реактивном слое данных.
 *
 * Прежний bespoke-инкремент (`screens/structures/realtime-apply.ts`) снесён:
 * решение «когда обновлять» принимает слой (`structures-page:@<filter>` +
 * инвалидация роутером), экран применяет ОДИН путь — отложенный полный
 * перезапрос активной страницы (окно дебаунса 400 мс). Скрытый вид помечает
 * снимок «грязным» и перезагружается при показе (ошибка 8e702d8c).
 *
 * Экран в node-тесте не поднимается (тянет `app.js`/холст/редактор) — проводка
 * проверяется структурно по исходнику; контракт слоя — функционально через
 * реестр запросов.
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
  resetQueryRegistry,
  subscribeQuery,
} from '../src/renderer/lib/live/query-registry.js';
import { resetEventRouter, routeRealtimeEvent } from '../src/renderer/lib/live/event-router.js';
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

describe('structures G2: слой определяет обновление снимка', () => {
  const structures = read('screens/structures/structures.ts');

  it('снимок подписан на ключ structures-page через onQueryInvalidated', () => {
    assert.match(structures, /function bindStructuresQuery\(\): void \{/);
    assert.match(structures, /onQueryInvalidated\(\(prefix\) => \{/);
    assert.match(structures, /matchesKeyPrefix\(prefix, 'structures-page'\)/);
    assert.match(structures, /registerQuery\(key, null\)/);
  });

  it('scheduleStructuresRefresh гасит ключ слоя, а не дёргает снимок напрямую', () => {
    const body = structures.slice(
      structures.indexOf('export function scheduleStructuresRefresh('),
    );
    assert.match(body.slice(0, 200), /invalidateQueries\(queryKeys\.structuresPageAll\(\)\)/);
  });

  it('экран применяет один путь — reloadAll с окном дебаунса 400 мс', () => {
    assert.match(structures, /createRealtimeBatch<never>\(\{[\s\S]{0,200}?windowMs: 400/);
    assert.match(
      structures,
      /applyFull: \(\) => \{[\s\S]*?if \(store\.state\.activeView !== 'structures'\) \{[\s\S]*?fullRefreshPending = true;[\s\S]*?return;[\s\S]*?void reloadAll\(\);/,
      'скрытый вид откладывает полный путь (ошибка 8e702d8c)',
    );
    // Показ вида снимает отложенную пометку перезагрузкой (существующий store-подписчик).
    assert.match(
      structures,
      /store\.subscribe\(\(\) => \{[\s\S]*?fullRefreshPending[\s\S]*?void reloadAll\(\);/,
    );
  });

  it('снимок публикуется в кэш слоя, bespoke-инкремент снесён', () => {
    assert.match(structures, /function publishStructuresSnapshot\(\): void \{/);
    assert.match(structures, /setQueryData\(structuresQueryKey, \{/);
    assert.ok(!structures.includes('applyStructuresRealtime'), 'нет applyStructuresRealtime');
    assert.ok(!structures.includes('realtime-apply.js'), 'нет импорта realtime-apply');
    assert.ok(!structures.includes('applyStructuresOps'), 'нет applyStructuresOps');
    assert.ok(!structures.includes('refreshDirections'), 'нет точечного додара directions');
  });

  it('мост производных эффектов больше не дёргает «Структуры» вручную', () => {
    const effects = read('realtime-effects.ts');
    assert.ok(!effects.includes('applyStructuresRealtime'), 'нет applyStructuresRealtime');
    assert.ok(!effects.includes('scheduleStructuresRefresh'), 'нет scheduleStructuresRefresh');
    assert.ok(!effects.includes('structures/structures.js'), 'нет импорта структур в мост');
  });

  it('модуль realtime-apply.ts снесён', () => {
    assert.equal(
      fs.existsSync(path.join(RENDERER_ROOT, 'screens', 'structures', 'realtime-apply.ts')),
      false,
    );
  });
});

describe('structures G2: контракт слоя (реестр + инвалидации)', () => {
  it('инвалидация structures-page уведомляет наблюдателя и метит запись stale', () => {
    resetQueryRegistry();
    const seen: string[] = [];
    const unsub = onQueryInvalidated((prefix, keys) => {
      if (prefix.startsWith('structures-page')) seen.push(...keys);
    });
    const key = queryKeys.structuresPage('active');
    registerQuery(key, null);
    const touched = invalidateQueries(queryKeys.structuresPageAll());
    assert.deepEqual(touched, [key]);
    assert.deepEqual(seen, [key], 'наблюдатель слоя получил ключ снимка');
    assert.equal(getQueryState(key).status, 'stale');
    unsub();
    resetQueryRegistry();
  });

  it('роутер гасит ключ structures-page на событие о мыслях и уведомляет экран', () => {
    resetQueryRegistry();
    resetEventRouter();
    const key = queryKeys.structuresPage('applied');
    registerQuery(key, null);
    const seen: string[] = [];
    const unsub = onQueryInvalidated((prefix, keys) => {
      if (prefix.startsWith('structures-page')) seen.push(...keys);
    });
    const res = routeRealtimeEvent(mkEvent('thought.deleted', { id: 't9' }, 1));
    assert.equal(res.routed, true);
    assert.ok(res.invalidated.includes(key), 'роутер погасил снимок «Структур»');
    assert.deepEqual(seen, [key]);
    unsub();
    resetQueryRegistry();
    resetEventRouter();
  });

  it('префиксная изоляция: focus-инвалидация и сосед по строке снимок не трогают', () => {
    resetQueryRegistry();
    const key = queryKeys.structuresPage('active');
    const focus = queryKeys.focus('t1');
    registerQuery(key, null);
    registerQuery(focus, null);
    registerQuery('structures-page-x:y', null);
    const touched = invalidateQueries(queryKeys.focusAll());
    assert.deepEqual(touched, [focus]);
    const touched2 = invalidateQueries(queryKeys.structuresPageAll());
    assert.deepEqual(touched2, [key], 'ложного матча по подстроке нет');
    resetQueryRegistry();
  });

  it('коалессия: повторные инвалидации снимка в одной пачке дают ОДИН перезапрос', async () => {
    resetQueryRegistry();
    const key = queryKeys.structuresPage('coalesce');
    let calls = 0;
    const fetcher = async (): Promise<number> => {
      calls += 1;
      return calls;
    };
    const unsub = subscribeQuery(key, fetcher, () => undefined);
    await settle();
    assert.equal(calls, 1, 'подписка запустила первый запрос');
    invalidateQueries(queryKeys.structuresPageAll());
    invalidateQueries(queryKeys.structuresPageAll());
    await settle();
    assert.equal(calls, 2, 'повторные инвалидации схлопнуты');
    unsub();
    resetQueryRegistry();
  });
});
