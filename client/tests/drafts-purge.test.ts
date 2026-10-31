/**
 * Юнит-тест политики чистки черновиков при старте (ошибка fb9d6058, п.5
 * решений; ошибка 351068ed пп.3, 5, 6; стратегия «тестируемый шов» —
 * клиентские тесты не поднимают настоящий better-sqlite3 под Electron ABI).
 *
 * Проверяется то, что решает пурж, а не SQL:
 * - незавершённые статусы (`pending`/`conflict`/`failed`) удаляются по всем
 *   профилям и сетям, `sent` не трогается;
 * - стартовый счётчик считает только `pending` с непустым текстом: о
 *   `conflict`/`failed` пользователь уже получил сообщение в прошлой сессии
 *   (351068ed п.3), поэтому второй отчёт о них не показывается;
 * - пустой `comment-new` (JSON-конверт с `bodyMd: ""`) текстом не считается
 *   (351068ed п.6);
 * - сбой удаления одной строки не отменяет остальные, сбой чтения не валит
 *   старт клиента (351068ed п.5).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  purgeStaleDrafts,
  UNFINISHED_DRAFT_STATUSES,
  type DraftPurgeRow,
} from '../src/main/db/drafts-purge.js';

/** Фейк-хранилище: строки в памяти (без SQLite/Electron). */
function makeStore(
  rows: DraftPurgeRow[],
  opts: { failDeleteIds?: string[]; failList?: boolean } = {},
): {
  store: { listAllDrafts(): DraftPurgeRow[]; deleteDraft(id: string): void };
  deletedIds: string[];
  remaining(): DraftPurgeRow[];
} {
  const live = [...rows];
  const deletedIds: string[] = [];
  const failing = new Set(opts.failDeleteIds ?? []);
  return {
    store: {
      listAllDrafts: () => {
        if (opts.failList === true) throw new Error('database is locked');
        return [...live];
      },
      deleteDraft: (id: string) => {
        if (failing.has(id)) throw new Error(`cannot delete ${id}`);
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

test('удаляет все незавершённые статусы всех профилей и сетей, sent не трогается', () => {
  const { store, deletedIds, remaining } = makeStore([
    { id: 'a', entity_type: 'comment', value: 'ТЕКСТ', status: 'pending' },
    { id: 'b', entity_type: 'comment', value: 'ТЕКСТ', status: 'conflict' },
    { id: 'c', entity_type: 'comment', value: 'ТЕКСТ', status: 'failed' },
    { id: 'd', entity_type: 'comment', value: null, status: 'pending' },
    { id: 'e', entity_type: 'comment', value: '   ', status: 'conflict' },
    { id: 'f', entity_type: 'comment', value: 'ОТПРАВЛЕН', status: 'sent' },
  ]);

  const result = purgeStaleDrafts(store);

  assert.deepEqual(deletedIds, ['a', 'b', 'c', 'd', 'e'], 'удалены все незавершённые');
  assert.deepEqual(remaining().map((r) => r.id), ['f'], 'sent остался');
  // О `conflict`/`failed` пользователь уведомлён в прошлой сессии — второй
  // отчёт при старте был бы дублем (351068ed п.3). Счётчик — только `pending`.
  assert.deepEqual(result, { deleted: 5, deletedWithText: 1, failed: 0 }, 'счётчик «с текстом»');
});

test('пустой comment-new (JSON-конверт без текста) «с текстом» не считается', () => {
  const empty = JSON.stringify({ ownerType: 'thought', ownerId: 't-1', bodyMd: '' });
  const blank = JSON.stringify({ ownerType: 'thought', ownerId: 't-2', bodyMd: '   ' });
  const filled = JSON.stringify({ ownerType: 'thought', ownerId: 't-3', bodyMd: 'ТЕКСТ' });
  const { store } = makeStore([
    { id: 'a', entity_type: 'comment-new', value: empty, status: 'pending' },
    { id: 'b', entity_type: 'comment-new', value: blank, status: 'pending' },
    { id: 'c', entity_type: 'comment-new', value: filled, status: 'pending' },
    { id: 'd', entity_type: 'comment', value: 'ОБЫЧНЫЙ ТЕКСТ', status: 'pending' },
    // Битый конверт: содержимое неизвестно — считаем, что текст мог быть.
    { id: 'e', entity_type: 'comment-new', value: '{"bodyMd":', status: 'pending' },
  ]);

  const result = purgeStaleDrafts(store);

  assert.deepEqual(result, { deleted: 5, deletedWithText: 3, failed: 0 });
});

test('сбой удаления одной строки не отменяет остальные', () => {
  const { store, deletedIds, remaining } = makeStore(
    [
      { id: 'a', entity_type: 'comment', value: 'ПЕРВЫЙ', status: 'pending' },
      { id: 'b', entity_type: 'comment', value: 'ВТОРОЙ', status: 'pending' },
      { id: 'c', entity_type: 'comment', value: 'ТРЕТИЙ', status: 'pending' },
    ],
    { failDeleteIds: ['b'] },
  );

  const result = purgeStaleDrafts(store);

  assert.deepEqual(deletedIds, ['a', 'c'], 'остальные строки удалены');
  assert.deepEqual(remaining().map((r) => r.id), ['b'], 'сбойная строка осталась');
  assert.deepEqual(result, { deleted: 2, deletedWithText: 2, failed: 1 }, 'сбой посчитан');
});

test('сбой чтения списка не валит старт клиента', () => {
  const { store } = makeStore([], { failList: true });
  assert.deepEqual(purgeStaleDrafts(store), { deleted: 0, deletedWithText: 0, failed: 1 });
});

test('пустая база и только отправленные строки — нули и молчание', () => {
  const empty = makeStore([]);
  assert.deepEqual(purgeStaleDrafts(empty.store), { deleted: 0, deletedWithText: 0, failed: 0 });

  const sentOnly = makeStore([
    { id: 'f', entity_type: 'comment', value: 'ОТПРАВЛЕН', status: 'sent' },
  ]);
  assert.deepEqual(purgeStaleDrafts(sentOnly.store), { deleted: 0, deletedWithText: 0, failed: 0 });
  assert.deepEqual(sentOnly.remaining().map((r) => r.id), ['f']);
});
