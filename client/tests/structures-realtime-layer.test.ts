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

import {
  invalidateQueries,
  onQueryInvalidated,
  registerQuery,
  resetQueryRegistry,
} from '../src/renderer/lib/live/query-registry.js';
import { queryKeys } from '../src/renderer/lib/live/query-keys.js';

const RENDERER_ROOT = path.resolve(import.meta.dirname, '..', 'src', 'renderer');
const read = (rel: string): string => fs.readFileSync(path.join(RENDERER_ROOT, rel), 'utf8');

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

  it('шина больше не дёргает «Структуры» вручную', () => {
    const realtimeUi = read('realtime-ui.ts');
    assert.ok(!realtimeUi.includes('applyStructuresRealtime'), 'нет applyStructuresRealtime');
    assert.ok(!realtimeUi.includes('scheduleStructuresRefresh'), 'нет scheduleStructuresRefresh');
    assert.ok(!realtimeUi.includes('structures/structures.js'), 'нет импорта структур в шину');
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
    unsub();
    resetQueryRegistry();
  });
});
