/**
 * Юнит-тест политики чистки черновиков при старте (ошибка fb9d6058, п.5
 * решений; стратегия «тестируемый шов» — клиентские тесты не поднимают
 * настоящий better-sqlite3 под Electron ABI).
 *
 * Проверяется то, что решает пурж, а не SQL: незавершённые статусы
 * (`pending`/`conflict`/`failed`) удаляются по всем профилям и сетям, `sent`
 * не трогается, счётчик «с текстом» считает только непустые значения (по нему
 * показывается стартовое сообщение).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  purgeStaleDrafts,
  UNFINISHED_DRAFT_STATUSES,
  type DraftPurgeRow,
} from '../src/main/db/drafts-purge.js';

/** Фейк-хранилище: строки в памяти (без SQLite/Electron). */
function makeStore(rows: DraftPurgeRow[]): {
  store: { listAllDrafts(): DraftPurgeRow[]; deleteDraft(id: string): void };
  deletedIds: string[];
  remaining(): DraftPurgeRow[];
} {
  const live = [...rows];
  const deletedIds: string[] = [];
  return {
    store: {
      listAllDrafts: () => [...live],
      deleteDraft: (id: string) => {
        deletedIds.push(id);
        const at = live.findIndex((r) => r.id === id);
        if (at >= 0) live.splice(at, 1);
      },
    },
    deletedIds,
    remaining: () => [...live],
  };
}

test('политика: незавершённые статусы — pending/conflict/failed, sent не трогается', () => {
  assert.deepEqual([...UNFINISHED_DRAFT_STATUSES], ['pending', 'conflict', 'failed']);
});

test('удаляет все незавершённые статусы всех профилей и сетей, считает строки с текстом', () => {
  const { store, deletedIds, remaining } = makeStore([
    { id: 'a', value: 'ТЕКСТ', status: 'pending' },
    { id: 'b', value: 'ТЕКСТ', status: 'conflict' },
    { id: 'c', value: 'ТЕКСТ', status: 'failed' },
    { id: 'd', value: null, status: 'pending' },
    { id: 'e', value: '   ', status: 'conflict' },
    { id: 'f', value: 'ОТПРАВЛЕН', status: 'sent' },
  ]);

  const result = purgeStaleDrafts(store);

  assert.deepEqual(deletedIds, ['a', 'b', 'c', 'd', 'e'], 'удалены все незавершённые');
  assert.deepEqual(remaining().map((r) => r.id), ['f'], 'sent остался');
  assert.deepEqual(result, { deleted: 5, deletedWithText: 3 }, 'счётчики раздельные');
});

test('пустая база и только отправленные строки — нули и молчание', () => {
  const empty = makeStore([]);
  assert.deepEqual(purgeStaleDrafts(empty.store), { deleted: 0, deletedWithText: 0 });

  const sentOnly = makeStore([{ id: 'f', value: 'ОТПРАВЛЕН', status: 'sent' }]);
  assert.deepEqual(purgeStaleDrafts(sentOnly.store), { deleted: 0, deletedWithText: 0 });
  assert.deepEqual(sentOnly.remaining().map((r) => r.id), ['f']);
});
