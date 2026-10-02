/**
 * Регресс-тест ошибки 31ed1d43 «Не обновляется карта мыслей, когда я меняю связь».
 *
 * Симптом: у мысли в фокусе удаляют связь (или меняют «Родителей») — мысль
 * перестаёт быть соседом, но остаётся «висеть» на карте.
 *
 * Причина: свежий ответ фокуса на ТОМ ЖЕ фокусе приносит первую порцию каждого
 * сектора; счётчик `loaded` при этом не учитывал её длину. Увидев рост
 * количества, пересчёт звал догрузку с `offset = 0` — та повторно запрашивала
 * первую же страницу и складывала её строки в `zoneAppended`. Эта копия уже не
 * сверяется с ответом фокуса: когда связь удаляют и мысль уходит из
 * `focus.children`, её задвоенная строка в `zoneAppended` продолжает рисоваться.
 *
 * Проверяется:
 *  1) чистое правило `planZoneReconcile` с длиной показанной первой порции —
 *     префикс «израсходованного» не меньше неё (юнит, см. zone-paging.test.ts);
 *  2) проводка в `canvas.ts`: пересчёт того же фокуса передаёт длину свежей
 *     порции и пересеивает `zoneVisibleIds`, чтобы догрузка не приняла мысль,
 *     уже показанную ответом фокуса.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const read = (rel: string): string =>
  readFileSync(resolve(import.meta.dirname, '..', 'src', 'renderer', rel), 'utf8');

describe('пересчёт того же фокуса не задваивает первую порцию сектора (31ed1d43)', () => {
  it('reconcileZoneTotals передаёт длину свежей первой порции в planZoneReconcile', () => {
    const canvas = read('canvas/canvas.ts');
    assert.ok(
      /planZoneReconcile\(counters \?\? createZonePaging\(\), total, undefined, focus\[dir\]\.length\)/.test(
        canvas,
      ),
      'пересчёт зовёт planZoneReconcile с длиной свежей первой порции сектора',
    );
  });

  it('reconcileZoneTotals пересеивает zoneVisibleIds из свежего ответа фокуса', () => {
    const canvas = read('canvas/canvas.ts');
    assert.ok(
      /zoneVisibleIds = new Set<string>\(\[[\s\S]{0,400}?focus\.parents\.map\(\(n\) => n\.id\),[\s\S]{0,200}?focus\.children\.map\(\(n\) => n\.id\),[\s\S]{0,200}?focus\.siblings\.map\(\(n\) => n\.id\),[\s\S]{0,300}?zoneAppended\.values\(\)/.test(
        canvas,
      ),
      'набор видимых id синхронизируется со свежим фокусом и уже подгруженными порциями',
    );
  });
});
