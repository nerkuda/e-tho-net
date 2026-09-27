/**
 * Итерация приёмки №9 (0.10.1), пункт 1 — класс записи в сортировке ВСЕГДА
 * первым; направление отбора применяется только к датам/тайбрейкерам.
 *
 * Серверная часть — `chronicle-service.test.ts` и сторож паритета
 * `guard-chronicle-parity.test.ts`. Здесь — КЛИЕНТСКАЯ локальная вставка
 * созданной записи (`insertRowByDay`): новая запись из слота (класс 0) обязана
 * встать в верхний блок своего дня при любом направлении (требование c6ddc1ea).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChronicleRow, ChronicleTarget } from '@etn/shared';

/** Строка ленты с одной датой; `targets` — привязки вне HOME (пусто = класс 0). */
function row(id: string, day: string, hour = '10:00', targets: ChronicleTarget[] = []): ChronicleRow {
  const from = `${day}T${hour}:00.000Z`;
  return {
    id,
    title: id,
    valid_from: from,
    valid_to: from,
    use_time: false,
    version: 1,
    created_at: from,
    updated_at: from,
    created_by: 'u',
    updated_by: 'u',
    snippet: '',
    body_html: '',
    targets,
  };
}

/** Привязка к чужой мысли (переводит запись в класс 1). */
function foreignTarget(id = 'thought-1'): ChronicleTarget {
  return { kind: 'thought', thought: { id } } as unknown as ChronicleTarget;
}

describe('приёмка №9, п.1: класс записи — всегда первым (клиентская вставка)', () => {
  it('убывание: запись дня (класс 0) встаёт в верхний блок своего дня', async () => {
    const { insertRowByDay } = await import('../src/renderer/screens/chronicle/diary.js');
    // День один: класс 0 (h) и класс 1 (x); серверный порядок desc — [h, x].
    const list = [row('h', '2026-09-10', '08:00'), row('x', '2026-09-10', '12:00', [foreignTarget()])];
    const added = row('n', '2026-09-10', '20:00'); // новая запись из слота — класс 0
    const out = insertRowByDay(list, added, 'desc').map((r) => r.id);
    assert.deepEqual(out, ['n', 'h', 'x'], 'класс 0 первым в своём дне при «убывании»');
  });

  it('возрастание: класс 0 тоже идёт перед классом 1 того же дня', async () => {
    const { insertRowByDay } = await import('../src/renderer/screens/chronicle/diary.js');
    const list = [row('h', '2026-09-10', '08:00'), row('x', '2026-09-10', '12:00', [foreignTarget()])];
    const added = row('n', '2026-09-10', '09:00');
    const out = insertRowByDay(list, added, 'asc').map((r) => r.id);
    assert.deepEqual(out, ['h', 'n', 'x'], 'внутри класса 0 — по valid_from, класс 1 позже');
  });

  it('убывание вставляет по дню через границы (прежнее поведение сохранено)', async () => {
    const { insertRowByDay } = await import('../src/renderer/screens/chronicle/diary.js');
    const asc = [row('a', '2026-09-10'), row('c', '2026-09-20')];
    assert.deepEqual(
      insertRowByDay(asc, row('b', '2026-09-15'), 'asc').map((r) => r.id),
      ['a', 'b', 'c'],
      'возрастание — новая запись по своему дню',
    );
    const desc = [row('c', '2026-09-20'), row('a', '2026-09-10')];
    assert.deepEqual(
      insertRowByDay(desc, row('b', '2026-09-15'), 'desc').map((r) => r.id),
      ['c', 'b', 'a'],
      'убывание — новая запись по своему дню',
    );
  });

  it('класс записи не разворачивается направлением (recordClass)', async () => {
    const { recordClass } = await import('../src/renderer/screens/chronicle/diary.js');
    assert.equal(recordClass(row('h', '2026-09-10')), 0, 'пустые привязки — класс 0');
    assert.equal(recordClass(row('x', '2026-09-10', '10:00', [foreignTarget()])), 1, 'чужая мысль — класс 1');
  });
});
