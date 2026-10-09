/**
 * Лента «Дневника»: порядок клиентской вставки — только по дате/времени
 * (задача 5a002590; требование c6ddc1ea после ревизии 2026-10-09).
 *
 * Прежняя модель («класс записи — всегда первым», итерация приёмки №9) отменена:
 * состав привязок на порядок не влияет. Полный регресс стабильности — в
 * `chronicle-feed-stable-order.test.ts`; здесь — вставка созданной записи.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChronicleRow, ChronicleTarget } from '@etn/shared';

/** Строка ленты с одной датой; `targets` — привязки вне HOME (пусто = без мыслей). */
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

/** Привязка к чужой мысли. */
function foreignTarget(id = 'thought-1'): ChronicleTarget {
  return { kind: 'thought', thought: { id } } as unknown as ChronicleTarget;
}

describe('лента «Дневника»: вставка созданной записи по дате/времени (5a002590)', () => {
  it('убывание: запись встаёт по времени, без приоритета «записи дня»', async () => {
    const { insertRowByDay } = await import('../src/renderer/screens/chronicle/diary.js');
    const list = [row('x', '2026-09-10', '12:00', [foreignTarget()]), row('h', '2026-09-10', '08:00')];
    const added = row('n', '2026-09-10', '20:00');
    assert.deepEqual(insertRowByDay(list, added, 'desc').map((r) => r.id), ['n', 'x', 'h']);
  });

  it('возрастание: порядок строго по valid_from вне зависимости от привязок', async () => {
    const { insertRowByDay } = await import('../src/renderer/screens/chronicle/diary.js');
    const list = [row('h', '2026-09-10', '08:00'), row('x', '2026-09-10', '12:00', [foreignTarget()])];
    const added = row('n', '2026-09-10', '09:00');
    assert.deepEqual(insertRowByDay(list, added, 'asc').map((r) => r.id), ['h', 'n', 'x']);
  });

  it('вставка по дню через границы уважает направление', async () => {
    const { insertRowByDay } = await import('../src/renderer/screens/chronicle/diary.js');
    const asc = [row('a', '2026-09-10'), row('c', '2026-09-20')];
    assert.deepEqual(insertRowByDay(asc, row('b', '2026-09-15'), 'asc').map((r) => r.id), ['a', 'b', 'c']);
    const desc = [row('c', '2026-09-20'), row('a', '2026-09-10')];
    assert.deepEqual(insertRowByDay(desc, row('b', '2026-09-15'), 'desc').map((r) => r.id), ['c', 'b', 'a']);
  });
});
