/**
 * Регресс стабильности порядка ленты «Дневника» (задача 5a002590, требование
 * c6ddc1ea после ревизии 2026-10-09).
 *
 * Обратная связь пользователя: запись «прыгала» при добавлении к ней мысли или
 * при удалении всех мыслей. Причина — первичный ключ сортировки «класс записи»
 * (0 — привязка только к HOME, 1 — прочие). Теперь порядок — ТОЛЬКО по
 * дате/времени записи (`valid_from` → `valid_to` → `created_at` → `id`), состав
 * привязок на позицию не влияет.
 *
 * Тест мутационно-проверяемый: стоит вернуть класс в `compareRecords` (или в
 * `ORDER BY` домена) — краснеет соответствующий набор.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { ChronicleRow, ChronicleTarget } from '@etn/shared';
import { compareRecords, insertRowByDay } from '../src/renderer/screens/chronicle/diary.js';

function row(
  id: string,
  day: string,
  hour = '10:00',
  targets: ChronicleTarget[] = [],
): ChronicleRow {
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

function foreignTarget(id = 'thought-1'): ChronicleTarget {
  return { kind: 'thought', thought: { id } } as unknown as ChronicleTarget;
}

function ids(list: readonly ChronicleRow[]): string[] {
  return list.map((r) => r.id);
}

describe('лента «Дневника»: стабильный порядок только по дате/времени (5a002590)', () => {
  it('состав привязок НЕ влияет на сравнение: при равных датах решает id, а не класс', () => {
    // «a» — с чужой привязкой (прежний класс 1), «b» — без привязок (класс 0).
    // Классовая сортировка подняла бы «b» первым; дата/время (и id) дают [a, b].
    const a = row('a', '2026-09-10', '10:00', [foreignTarget()]);
    const b = row('b', '2026-09-10', '10:00');
    assert.deepEqual(ids([a, b].sort(compareRecords)), ['a', 'b']);
    // Порядок не зависит от того, какая из строк несёт привязки.
    assert.deepEqual(ids([b, a].sort(compareRecords)), ['a', 'b']);
    assert.equal(compareRecords(a, b), -compareRecords(b, a), 'сравнение антисимметрично');
  });

  it('добавление мысли к записи не меняет её позицию в ленте', () => {
    const list = [row('a', '2026-09-10', '12:00'), row('b', '2026-09-10', '10:00'), row('c', '2026-09-10', '14:00')];
    const before = [...list].sort(compareRecords);
    // «b» получила мысль — прежний класс 0 → 1, но время то же.
    const after = before
      .map((r) => (r.id === 'b' ? { ...r, targets: [foreignTarget()] } : r))
      .sort(compareRecords);
    assert.deepEqual(ids(before), ['b', 'a', 'c']);
    assert.deepEqual(ids(after), ['b', 'a', 'c'], 'добавление мысли не двигает запись');
  });

  it('удаление всех мыслей не меняет её позицию в ленте', () => {
    const list = [
      row('a', '2026-09-10', '12:00', [foreignTarget('t1')]),
      row('b', '2026-09-10', '10:00', [foreignTarget('t2')]),
      row('c', '2026-09-10', '14:00', [foreignTarget('t3')]),
    ];
    const before = [...list].sort(compareRecords);
    const after = before
      .map((r) => (r.id === 'a' ? { ...r, targets: [] } : r))
      .sort(compareRecords);
    assert.deepEqual(ids(before), ['b', 'a', 'c']);
    assert.deepEqual(ids(after), ['b', 'a', 'c'], 'снятие всех мыслей не двигает запись');
  });

  it('insertRowByDay вставляет локальную строку строго по дате/времени', () => {
    const list = [row('a', '2026-09-10', '10:00'), row('c', '2026-09-10', '14:00')];
    const inserted = insertRowByDay(list, row('b', '2026-09-10', '12:00'), 'asc');
    assert.deepEqual(ids(inserted), ['a', 'b', 'c']);
    // Новая запись с привязкой не «переезжает» через датам.
    const withTarget = insertRowByDay(list, row('b', '2026-09-10', '12:00', [foreignTarget()]), 'asc');
    assert.deepEqual(ids(withTarget), ['a', 'b', 'c']);
  });

  it('серверный ORDER BY не содержит класса записи', () => {
    const domain = fs.readFileSync(
      path.resolve(import.meta.dirname, '..', '..', 'server', 'src', 'domain', 'chronicle-service.ts'),
      'utf8',
    );
    const orderBy = domain.match(/ORDER BY[\s\S]*?LIMIT/);
    assert.ok(orderBy, 'в домене найден ORDER BY');
    assert.ok(!/RECORD_CLASS_SQL/.test(domain), 'выражение класса записи удалено');
    assert.ok(!/CASE WHEN EXISTS/.test(orderBy![0]), 'ORDER BY не считает класс записи');
    assert.match(orderBy![0], /c\.valid_from/, 'ORDER BY начинается с valid_from');
  });
});
