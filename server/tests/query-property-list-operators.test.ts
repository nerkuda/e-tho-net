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

/**
 * Регресс ошибки 7489e4d9-4024-4d37-a4f3-c8094265514c: наборные операторы и
 * `in`/`not_in` по МНОЖЕСТВЕННОМУ `text`-свойству (`config.multiple`) должны
 * матчить ПОЭЛЕМЕНТНО. Значение такого свойства хранится одной comma-joined
 * строкой (`"Москва, Питер"`, 02-data-model §3.4–3.5), а движок сравнивал её
 * целиком — мысль со значением `"a, b"` не находилась условием `in ["a"]`.
 *
 * Пути исполнения покрыты оба: REST (`op`, через `parseStructureFilter` →
 * `structureRequestToQuery` → `queryThoughts`) и канонический (MCP
 * `etn.thoughts.query`, поле `operator` — прямой вызов `queryThoughts`;
 * `parseStructureFilter` лишь транслирует `op` → `operator`, движок один).
 */
describe('наборные операторы по множественному text: поэлементно (ошибка 7489e4d9)', {
  skip: !nativeAvailable(),
}, () => {
  /** Канонический запрос (как его строит MCP-фасад) — `operator`, не `op`. */
  function canonical(properties: Array<Record<string, unknown>>) {
    return {
      sort: 'alpha' as const,
      order: 'asc' as const,
      limit: 100,
      offset: 0,
      properties: properties as never,
    };
  }

  /**
   * Множественное text-свойство: A = "Москва, Питер", B = "Питер",
   * C = "Тверь", D = "Москва-река" (граничный случай — не элемент "Москва").
   */
  function setup() {
    const ndb = createInMemoryNetworkDb();
    const propId = seedTextProperty(ndb, 'города', { multiple: true, options: ['Москва', 'Питер', 'Тверь'] });
    const a = seedThought(ndb, 'A');
    const b = seedThought(ndb, 'B');
    const c = seedThought(ndb, 'C');
    const d = seedThought(ndb, 'D');
    seedTextValue(ndb, a, propId, 'Москва, Питер');
    seedTextValue(ndb, b, propId, 'Питер');
    seedTextValue(ndb, c, propId, 'Тверь');
    seedTextValue(ndb, d, propId, 'Москва-река');
    return { ndb, propId, a, b, c, d };
  }

  it('in ["Москва"] матчит мысль со значением "Москва, Питер" (MCP-путь)', () => {
    const { ndb, propId, a, d } = setup();
    const res = queryThoughts(
      ndb,
      'u',
      canonical([{ property_id: propId, operator: 'in', value: ['Москва'] }]),
      { emptyFilterMode: 'all' },
    );
    assert.deepEqual(res.items.map((i) => i.id), [a]);
    assert.ok(!res.items.some((i) => i.id === d), 'элемент матчится по границе разделителя');
  });

  it('in ["Питер"] матчит обе мысли с этим элементом (REST-путь)', () => {
    const { ndb, propId, a, b } = setup();
    const res = runRestBody(ndb, {
      properties: [{ property_id: propId, op: 'in', value: ['Питер'] }],
    });
    assert.deepEqual(res.items.map((i) => i.id).sort(), [a, b].sort());
  });

  it('any_of ["Москва"] матчит мысль со значением "Москва, Питер"', () => {
    const { ndb, propId, a } = setup();
    const res = queryThoughts(
      ndb,
      'u',
      canonical([{ property_id: propId, operator: 'any_of', value: ['Москва'] }]),
      { emptyFilterMode: 'all' },
    );
    assert.deepEqual(res.items.map((i) => i.id), [a]);
  });

  it('all_of ["Москва","Питер"] матчит; all_of ["Москва","Тверь"] — нет', () => {
    const { ndb, propId, a } = setup();
    const hit = queryThoughts(
      ndb,
      'u',
      canonical([{ property_id: propId, operator: 'all_of', value: ['Москва', 'Питер'] }]),
      { emptyFilterMode: 'all' },
    );
    assert.deepEqual(hit.items.map((i) => i.id), [a]);
    const miss = queryThoughts(
      ndb,
      'u',
      canonical([{ property_id: propId, operator: 'all_of', value: ['Москва', 'Тверь'] }]),
      { emptyFilterMode: 'all' },
    );
    assert.deepEqual(miss.items, []);
  });

  it('none_of ["Питер"] исключает мысли с элементом "Питер"', () => {
    const { ndb, propId, c, d } = setup();
    const res = queryThoughts(
      ndb,
      'u',
      canonical([{ property_id: propId, operator: 'none_of', value: ['Питер'] }]),
      { emptyFilterMode: 'all' },
    );
    assert.deepEqual(res.items.map((i) => i.id).sort(), [c, d].sort());
  });

  it('not_in ["Питер"] исключает мысли с элементом "Питер" (REST-путь)', () => {
    const { ndb, propId, c, d } = setup();
    const res = runRestBody(ndb, {
      properties: [{ property_id: propId, op: 'not_in', value: ['Питер'] }],
    });
    assert.deepEqual(res.items.map((i) => i.id).sort(), [c, d].sort());
  });

  it('одиночное text-свойство сохраняет точное сравнение', () => {
    const ndb = createInMemoryNetworkDb();
    const propId = seedTextProperty(ndb, 'страна', null);
    const msk = seedThought(ndb, 'msk');
    seedTextValue(ndb, msk, propId, 'Москва, Питер');
    // Одиночное свойство — значение целиком; "Москва" не совпадает.
    const no = queryThoughts(
      ndb,
      'u',
      canonical([{ property_id: propId, operator: 'in', value: ['Москва'] }]),
      { emptyFilterMode: 'all' },
    );
    assert.deepEqual(no.items, []);
    const yes = queryThoughts(
      ndb,
      'u',
      canonical([{ property_id: propId, operator: 'in', value: ['Москва, Питер'] }]),
      { emptyFilterMode: 'all' },
    );
    assert.deepEqual(yes.items.map((i) => i.id), [msk]);
  });

  /**
   * Регресс дефекта, найденного верификатором: OR-цепочка `in`/`any_of` с 2+
   * значениями не была обёрнута во внешние скобки, а клаузы условий
   * объединяются через AND — приоритет AND над OR разрывал WHERE и в
   * комбинации с любым другим условием пропускал лишние мысли. Проверяем на
   * комбинации «списковый оператор + has_comment» обоими фасадами.
   */
  it('in с 2 значениями + has_comment: лишние мысли не просачиваются (MCP-путь)', () => {
    const { ndb, propId, a } = setupForCombination();
    const res = queryThoughts(
      ndb,
      'u',
      { ...canonical([{ property_id: propId, operator: 'in', value: ['Москва', 'Питер'] }]), has_comment: true },
      { emptyFilterMode: 'all' },
    );
    assert.deepEqual(res.items.map((i) => i.id), [a], 'только мысль с комментарием и совпавшим элементом');
  });

  it('in с 2 значениями + has_comment: лишние мысли не просачиваются (REST-путь)', () => {
    const { ndb, propId, a } = setupForCombination();
    const res = runRestBody(ndb, {
      properties: [{ property_id: propId, op: 'in', value: ['Москва', 'Питер'] }],
      has_comment: true,
    });
    assert.deepEqual(res.items.map((i) => i.id), [a]);
  });

  it('одиночное text: in с 2 значениями + has_comment не течёт (регресс generic-пути)', () => {
    const ndb = createInMemoryNetworkDb();
    const propId = seedTextProperty(ndb, 'город-single', null);
    const a = seedThought(ndb, 'A');
    seedThought(ndb, 'B');
    seedTextValue(ndb, a, propId, 'Москва');
    seedPermanentComment(ndb, a);
    const res = queryThoughts(
      ndb,
      'u',
      { ...canonical([{ property_id: propId, operator: 'in', value: ['Москва', 'Питер'] }]), has_comment: true },
      { emptyFilterMode: 'all' },
    );
    assert.deepEqual(res.items.map((i) => i.id), [a]);
  });
});

/**
 * Множественное text-свойство `города`: A = "Москва, Питер" с постоянным
 * комментарием, B = "Питер" без комментария, C = "Тверь"; для комбинации
 * спискового оператора с другим условием (`has_comment`).
 */
function setupForCombination(): { ndb: NetworkDb; propId: string; a: string; b: string; c: string } {
  const ndb = createInMemoryNetworkDb();
  const propId = seedTextProperty(ndb, 'города-combo', { multiple: true, options: ['Москва', 'Питер'] });
  const a = seedThought(ndb, 'A');
  const b = seedThought(ndb, 'B');
  const c = seedThought(ndb, 'C');
  seedTextValue(ndb, a, propId, 'Москва, Питер');
  seedTextValue(ndb, b, propId, 'Питер');
  seedTextValue(ndb, c, propId, 'Тверь');
  seedPermanentComment(ndb, a);
  return { ndb, propId, a, b, c };
}

/** Постоянный комментарий мысли — для условия `has_comment`. */
function seedPermanentComment(ndb: NetworkDb, thoughtId: string): void {
  ndb
    .prepare(
      `INSERT INTO comments (id, owner_type, owner_id, kind, body_md, body_html, valid_from,
                             version, created_at, updated_at, created_by, updated_by)
       VALUES (?, 'thought', ?, 'permanent', 'x', 'x', '2024-01-01', 1, '2024', '2024', 'u', 'u')`,
    )
    .run(randomUUID(), thoughtId);
}

/** Свойство типа `url` (одиночное или множественное) для регрессов 55cb51f8. */
function seedUrlProperty(ndb: NetworkDb, key: string, config: Record<string, unknown> | null = null): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description, created_at, updated_at)
       VALUES (?, '00000000-0000-4000-8000-0000000000ba5e', ?, lower(?), 'url', ?, NULL, '2024', '2024')`,
    )
    .run(id, key, key, config === null ? null : JSON.stringify(config));
  return id;
}

/** Хранимая форма url-значения: строка целиком либо JSON-массив строк. */
function seedUrlValue(ndb: NetworkDb, thoughtId: string, propertyId: string, value: string): void {
  ndb
    .prepare(
      `INSERT INTO property_values (id, owner_type, owner_id, property_id, value_text, updated_at)
       VALUES (?, 'thought', ?, ?, ?, '2024')`,
    )
    .run(randomUUID(), thoughtId, propertyId, value);
}

/**
 * Регресс ошибки 55cb51f8-2f9b-41dd-a484-1370398dd59a: `in`/`not_in` по
 * МНОЖЕСТВЕННОМУ `url`-свойству (`config.multiple`) должны матчить
 * ПОЭЛЕМЕНТНО. Значение такого свойства хранится JSON-массивом строк
 * (`value_text`, напр. `["https://a","https://b"]`, 02-data-model §3.4–3.5),
 * а движок сравнивал строку целиком — мысль со значением `["https://a",…]`
 * не находилась условием `in ["https://a"]`. Наборные операторы уже работали
 * (через `json_each`); расходились только `in`/`not_in`.
 *
 * Требование 00eb824b уже заявляет для `url` поэлементный матчинг; тест
 * фиксирует контракт. Пути покрыты оба: MCP (поле `operator`, прямой вызов
 * `queryThoughts`) и REST (`op` через `parseStructureFilter` →
 * `structureRequestToQuery` → `queryThoughts`).
 */
describe('in/not_in по множественному url: поэлементно (ошибка 55cb51f8)', {
  skip: !nativeAvailable(),
}, () => {
  /** Канонический запрос (как его строит MCP-фасад) — `operator`, не `op`. */
  function canonical(properties: Array<Record<string, unknown>>) {
    return {
      sort: 'alpha' as const,
      order: 'asc' as const,
      limit: 100,
      offset: 0,
      properties: properties as never,
    };
  }

  /**
   * Множественное url-свойство: A = [a, b], B = [b], C = [c], D = [a0]
   * (граничный случай — не элемент `a`).
   */
  function setup() {
    const ndb = createInMemoryNetworkDb();
    const propId = seedUrlProperty(ndb, 'ссылки', { multiple: true });
    const a = seedThought(ndb, 'A');
    const b = seedThought(ndb, 'B');
    const c = seedThought(ndb, 'C');
    const d = seedThought(ndb, 'D');
    seedUrlValue(ndb, a, propId, JSON.stringify(['https://a.example', 'https://b.example']));
    seedUrlValue(ndb, b, propId, JSON.stringify(['https://b.example']));
    seedUrlValue(ndb, c, propId, JSON.stringify(['https://c.example']));
    seedUrlValue(ndb, d, propId, JSON.stringify(['https://a0.example']));
    return { ndb, propId, a, b, c, d };
  }

  it('in ["https://a.example"] матчит мысль со значением [a, b] (MCP-путь)', () => {
    const { ndb, propId, a } = setup();
    const res = queryThoughts(
      ndb,
      'u',
      canonical([{ property_id: propId, operator: 'in', value: ['https://a.example'] }]),
      { emptyFilterMode: 'all' },
    );
    assert.deepEqual(res.items.map((i) => i.id), [a]);
  });

  it('in ["https://b.example"] матчит обе мысли с этим элементом (REST-путь)', () => {
    const { ndb, propId, a, b } = setup();
    const res = runRestBody(ndb, {
      properties: [{ property_id: propId, op: 'in', value: ['https://b.example'] }],
    });
    assert.deepEqual(res.items.map((i) => i.id).sort(), [a, b].sort());
  });

  it('элемент матчится целиком, а не по префиксу', () => {
    const { ndb, propId, d } = setup();
    const res = queryThoughts(
      ndb,
      'u',
      canonical([{ property_id: propId, operator: 'in', value: ['https://a.example'] }]),
      { emptyFilterMode: 'all' },
    );
    assert.ok(!res.items.some((i) => i.id === d), '[a0] не содержит элемент a');
  });

  it('any_of ["https://a.example"] матчит мысль со значением [a, b]', () => {
    const { ndb, propId, a } = setup();
    const res = queryThoughts(
      ndb,
      'u',
      canonical([{ property_id: propId, operator: 'any_of', value: ['https://a.example'] }]),
      { emptyFilterMode: 'all' },
    );
    assert.deepEqual(res.items.map((i) => i.id), [a]);
  });

  it('all_of [a, b] матчит; all_of [a, c] — нет', () => {
    const { ndb, propId, a } = setup();
    const hit = queryThoughts(
      ndb,
      'u',
      canonical([{ property_id: propId, operator: 'all_of', value: ['https://a.example', 'https://b.example'] }]),
      { emptyFilterMode: 'all' },
    );
    assert.deepEqual(hit.items.map((i) => i.id), [a]);
    const miss = queryThoughts(
      ndb,
      'u',
      canonical([{ property_id: propId, operator: 'all_of', value: ['https://a.example', 'https://c.example'] }]),
      { emptyFilterMode: 'all' },
    );
    assert.deepEqual(miss.items, []);
  });

  it('none_of ["https://b.example"] исключает мысли с этим элементом', () => {
    const { ndb, propId, c, d } = setup();
    const res = queryThoughts(
      ndb,
      'u',
      canonical([{ property_id: propId, operator: 'none_of', value: ['https://b.example'] }]),
      { emptyFilterMode: 'all' },
    );
    assert.deepEqual(res.items.map((i) => i.id).sort(), [c, d].sort());
  });

  it('not_in ["https://b.example"] исключает мысли с этим элементом (REST-путь)', () => {
    const { ndb, propId, c, d } = setup();
    const res = runRestBody(ndb, {
      properties: [{ property_id: propId, op: 'not_in', value: ['https://b.example'] }],
    });
    assert.deepEqual(res.items.map((i) => i.id).sort(), [c, d].sort());
  });

  it('in ["https://a.example","https://c.example"] + has_comment: лишние мысли не просачиваются', () => {
    const ndb = createInMemoryNetworkDb();
    const propId = seedUrlProperty(ndb, 'ссылки-combo', { multiple: true });
    const a = seedThought(ndb, 'A');
    const c = seedThought(ndb, 'C');
    seedUrlValue(ndb, a, propId, JSON.stringify(['https://a.example', 'https://b.example']));
    seedUrlValue(ndb, c, propId, JSON.stringify(['https://c.example']));
    seedPermanentComment(ndb, a);
    const res = queryThoughts(
      ndb,
      'u',
      {
        ...canonical([
          { property_id: propId, operator: 'in', value: ['https://a.example', 'https://c.example'] },
        ]),
        has_comment: true,
      },
      { emptyFilterMode: 'all' },
    );
    assert.deepEqual(res.items.map((i) => i.id), [a], 'только мысль с комментарием и совпавшим элементом');
  });

  it('одиночное url-свойство сохраняет точное сравнение', () => {
    const ndb = createInMemoryNetworkDb();
    const propId = seedUrlProperty(ndb, 'адрес', null);
    const msk = seedThought(ndb, 'msk');
    seedUrlValue(ndb, msk, propId, 'https://a.example,https://b.example');
    // Одиночное свойство — значение целиком; элемент a не совпадает.
    const no = queryThoughts(
      ndb,
      'u',
      canonical([{ property_id: propId, operator: 'in', value: ['https://a.example'] }]),
      { emptyFilterMode: 'all' },
    );
    assert.deepEqual(no.items, []);
    const yes = queryThoughts(
      ndb,
      'u',
      canonical([
        { property_id: propId, operator: 'in', value: ['https://a.example,https://b.example'] },
      ]),
      { emptyFilterMode: 'all' },
    );
    assert.deepEqual(yes.items.map((i) => i.id), [msk]);
  });
});
