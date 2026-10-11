/**
 * Регресс-защита исполнения условий-списков по свойству (операторы
 * «в списке»/«не в списке», REST-контракт §6.10 — `in`/`not_in`; тем же путём
 * идёт исполнение отборов типа `etn.views.run` через `parseStructureFilter`
 * → `structureRequestToQuery` → `queryThoughts`).
 *
 * Карточка b610729c-2fdf-4f18-b526-7e7aeddb860f: конструктор отборов склеивал
 * несколько значений в одну строку, и отбор пустел. Корень — клиентская
 * генерация `definition`; серверный движок массив значений обрабатывает верно.
 * Этот тест фиксирует контракт исполнения (правильный уровень — парсер +
 * движок): ДВА значения дают объединение совпадений, а не пусто.
 *
 * Skip на отсутствии нативной сборки `better-sqlite3` — как у соседних тестов.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { parseStructureFilter } from '../src/domain/structure-service.js';
import {
  structureRequestToQuery,
  queryThoughts,
  type ThoughtQueryResult,
} from '../src/domain/query-service.js';

/** True when the `better-sqlite3` native binding loads. */
function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

function seedThought(ndb: NetworkDb, title: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, NULL, 1, 0, 0, 1,
               '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.toLowerCase());
  return id;
}

function seedTextProperty(ndb: NetworkDb, key: string, config: Record<string, unknown> | null = null): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description, created_at, updated_at)
       VALUES (?, '00000000-0000-4000-8000-0000000000ba5e', ?, lower(?), 'text', ?, NULL, '2024', '2024')`,
    )
    .run(id, key, key, config === null ? null : JSON.stringify(config));
  return id;
}

/** Хранимая форма множественного text — comma-joined строка (§3.4–3.5). */
function seedTextValue(ndb: NetworkDb, thoughtId: string, propertyId: string, value: string): void {
  ndb
    .prepare(
      `INSERT INTO property_values (id, owner_type, owner_id, property_id, value_text, updated_at)
       VALUES (?, 'thought', ?, ?, ?, '2024')`,
    )
    .run(randomUUID(), thoughtId, propertyId, value);
}

/** Прогон REST-тела отбора через парсер и движок — как это делает роут §6.10. */
function runRestBody(ndb: NetworkDb, body: Record<string, unknown>): ThoughtQueryResult {
  const filter = parseStructureFilter(body);
  const req = structureRequestToQuery({ ...filter, sort: 'alpha', order: 'asc', limit: 100, offset: 0 });
  return queryThoughts(ndb, 'u', req, { emptyFilterMode: 'all' });
}

describe('условия-списки по свойству: in/not_in (ошибка b610729c)', { skip: !nativeAvailable() }, () => {
  /** Свойство со списком вариантов, как в карточке; значения — по одному на мысль. */
  function setup(): { ndb: NetworkDb; propId: string; moscow: string; piter: string; tver: string } {
    const ndb = createInMemoryNetworkDb();
    const propId = seedTextProperty(ndb, 'город', { multiple: true, options: ['Москва', 'Питер', 'Тверь'] });
    const moscow = seedThought(ndb, 'Мысль Москва');
    const piter = seedThought(ndb, 'Мысль Питер');
    const tver = seedThought(ndb, 'Мысль Тверь');
    seedTextValue(ndb, moscow, propId, 'Москва');
    seedTextValue(ndb, piter, propId, 'Питер');
    seedTextValue(ndb, tver, propId, 'Тверь');
    return { ndb, propId, moscow, piter, tver };
  }

  it('«в списке» из ДВУХ значений возвращает объединение, а не пусто', () => {
    const { ndb, propId, moscow, piter, tver } = setup();
    const res = runRestBody(ndb, {
      properties: [{ property_id: propId, op: 'in', value: ['Москва', 'Питер'] }],
    });
    const ids = res.items.map((i) => i.id).sort();
    assert.deepEqual(ids, [moscow, piter].sort(), 'оба значения из списка матчатся');
    assert.ok(!ids.includes(tver), 'значение вне списка не матчится');
  });

  it('«в списке» из ОДНОГО значения работает так же (контроль)', () => {
    const { ndb, propId, piter } = setup();
    const res = runRestBody(ndb, {
      properties: [{ property_id: propId, op: 'in', value: ['Питер'] }],
    });
    assert.deepEqual(res.items.map((i) => i.id), [piter]);
  });

  it('«не в списке» из двух значений исключает оба', () => {
    const { ndb, propId, moscow, piter, tver } = setup();
    const res = runRestBody(ndb, {
      properties: [{ property_id: propId, op: 'not_in', value: ['Москва', 'Питер'] }],
    });
    assert.deepEqual(res.items.map((i) => i.id), [tver]);
    assert.ok(!res.items.some((i) => i.id === moscow || i.id === piter));
  });
});
