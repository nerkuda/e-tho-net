/**
 * Паритет единого набора сортировок отбора с сервером (ошибки 33a3e285 и
 * 4dd14aa3, веха 5 версии 0.8.2).
 *
 * `FILTER_SORTS` (`renderer/lib/filter-builder.ts`) — единственный набор
 * сортировок клиента: конструктор сохраняет только перечисленное, а
 * исполнитель отбора принимает всё, что конструктор позволил сохранить.
 * Набор обязан совпадать с серверным `STRUCTURE_SORTS`: расхождение
 * порождало молчаливую потерю сортировки (33a3e285) и сортировку, которую
 * сервер не исполняет (4dd14aa3).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STRUCTURE_SORTS } from '@etn/shared';

import { FILTER_SORTS, filterSortLabel, isFilterSort } from '../src/renderer/lib/filter-builder.js';

describe('FILTER_SORTS (единый набор сортировок отбора)', () => {
  it('совпадает с серверным STRUCTURE_SORTS — паритет набора', () => {
    assert.deepEqual(
      FILTER_SORTS.map((o) => o.v),
      [...STRUCTURE_SORTS],
      'набор сортировок клиента обязан совпадать с серверным STRUCTURE_SORTS',
    );
  });

  it('updated («по дате изменения») входит в набор и исполним', () => {
    const entry = FILTER_SORTS.find((o) => o.v === 'updated');
    assert.ok(entry, 'updated должно быть в едином наборе');
    assert.equal(entry!.label, 'по дате изменения');
    assert.ok(isFilterSort('updated'), 'исполнитель признаёт updated валидным');
    assert.equal(filterSortLabel('updated'), 'по дате изменения');
  });
});
