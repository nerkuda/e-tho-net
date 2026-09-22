/**
 * Рёбра, помеченные на удаление (корзина, S13), в графовых выборках —
 * ошибка 355319d4 (0.8.2).
 *
 * Помеченное ребро физически живо и остаётся видимым: выборки соседей,
 * фокус-ответ и подграф ОБЯЗАНЫ отдавать признак корзины
 * (`link_marked_for_deletion`) — прятать помеченную сущность нельзя
 * (симметрия с помеченной мыслью), но выдавать её за живую тоже.
 * `meta.link_stats` — счётчики ЖИВЫХ связей: рёбра корзины в них не попадают.
 *
 * Общая in-memory NetworkDb; скипается без нативного better-sqlite3.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { getThoughtMeta } from '../src/domain/thought-meta.js';
import { subgraph } from '../src/domain/graph-traversal.js';
import { createLink, getEdgesAmong, toFocusEdge, updateLink } from '../src/domain/link-service.js';
import { createLinkType } from '../src/domain/link-type-service.js';
import { createThought, focus, getNeighbors } from '../src/domain/thought-service.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

const USER = 'user-1';

/** Create a thought and return its id. */
function thought(ndb: NetworkDb, title: string): string {
  return createThought(ndb, { title }, USER).id;
}

/** Create an a→b link and return its id. */
function link(ndb: NetworkDb, sourceId: string, targetId: string, typeId?: string): string {
  return createLink(
    ndb,
    { source_id: sourceId, target_id: targetId, ...(typeId !== undefined ? { type_id: typeId } : {}) },
    USER,
  ).id;
}

/** Mark an existing link for deletion (moves it to the trash). */
function trash(ndb: NetworkDb, linkId: string): void {
  updateLink(ndb, linkId, { marked_for_deletion: true }, undefined, USER);
}

describe(
  'рёбра в корзине не выглядят живыми (355319d4)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('focus: помеченное ребро остаётся в parents/edges с флагом корзины', () => {
      const ndb = createInMemoryNetworkDb();
      const focused = thought(ndb, 'Фокус');
      const liveParent = thought(ndb, 'Живой родитель');
      const trashedParent = thought(ndb, 'Родитель в корзине');
      const liveLinkId = link(ndb, liveParent, focused);
      const trashedLinkId = link(ndb, trashedParent, focused);
      trash(ndb, trashedLinkId);

      const response = focus(ndb, USER, focused);

      // Помеченное ребро НЕ спрятано: сосед на месте.
      const parents = new Map(response.parents.map((n) => [n.link_id, n]));
      assert.equal(response.parents.length, 2);
      assert.equal(parents.get(liveLinkId)?.link_marked_for_deletion, false);
      assert.equal(parents.get(trashedLinkId)?.link_marked_for_deletion, true);

      const edges = new Map(response.edges.map((e) => [e.id, e]));
      assert.equal(edges.get(liveLinkId)?.link_marked_for_deletion, false);
      assert.equal(edges.get(trashedLinkId)?.link_marked_for_deletion, true);
      ndb.close();
    });

    it('getNeighbors: флаг корзины есть в каждом направлении', () => {
      const ndb = createInMemoryNetworkDb();
      const focused = thought(ndb, 'Фокус');
      const parent = thought(ndb, 'Родитель');
      const child = thought(ndb, 'Потомок');
      const parentLink = link(ndb, parent, focused);
      const childLink = link(ndb, focused, child);
      trash(ndb, childLink);

      const parents = getNeighbors(ndb, focused, 'parents');
      const children = getNeighbors(ndb, focused, 'children');
      assert.equal(parents[0]?.link_marked_for_deletion, false);
      assert.equal(children[0]?.link_marked_for_deletion, true);
      assert.equal(parents[0]?.link_id, parentLink);
      assert.equal(children[0]?.link_id, childLink);
      ndb.close();
    });

    it('siblings: строка помечена только когда помечены ВСЕ параллельные рёбра', () => {
      const ndb = createInMemoryNetworkDb();
      const parent = thought(ndb, 'Родитель');
      const focused = thought(ndb, 'Фокус');
      const sibling = thought(ndb, 'Родственник');
      link(ndb, parent, focused);
      // Два ПАРАЛЛЕЛЬНЫХ ребра родитель→родственник: нетипизированные дубли
      // запрещены, поэтому это два разных типа связи.
      const typeA = createLinkType(
        ndb,
        { name_forward: 'вид A', name_reverse: 'вид A' },
        USER,
      ).id;
      const typeB = createLinkType(
        ndb,
        { name_forward: 'вид B', name_reverse: 'вид B' },
        USER,
      ).id;
      const first = link(ndb, parent, sibling, typeA);
      const second = link(ndb, parent, sibling, typeB);

      // Одно из двух параллельных рёбер помечено — строка остаётся живой
      // (MIN по группе).
      trash(ndb, first);
      assert.equal(getNeighbors(ndb, focused, 'siblings')[0]?.link_marked_for_deletion, false);

      // Помечены все параллельные рёбра — строка помечена.
      trash(ndb, second);
      assert.equal(getNeighbors(ndb, focused, 'siblings')[0]?.link_marked_for_deletion, true);
      ndb.close();
    });

    it('subgraph: помеченное ребро остаётся в edges с признаком корзины', () => {
      const ndb = createInMemoryNetworkDb();
      const a = thought(ndb, 'A');
      const b = thought(ndb, 'B');
      const ab = link(ndb, a, b);
      trash(ndb, ab);

      const result = subgraph(ndb, [a], 1);
      assert.deepEqual(result.nodes.slice().sort(), [a, b].sort());
      assert.equal(result.edges.length, 1);
      assert.equal(result.edges[0]?.id, ab);
      assert.equal(result.edges[0]?.link_marked_for_deletion, true);
      ndb.close();
    });

    it('toFocusEdge: единая проекция несёт флаг корзины для focus и /thoughts/edges', () => {
      const ndb = createInMemoryNetworkDb();
      const a = thought(ndb, 'A');
      const b = thought(ndb, 'B');
      const ab = link(ndb, a, b);
      trash(ndb, ab);

      const [row] = getEdgesAmong(ndb, [a, b], false);
      assert.ok(row, 'ребро не найдено');
      const edge = toFocusEdge(row!);
      assert.equal(edge.link_marked_for_deletion, true);
      assert.equal(edge.id, ab);
      ndb.close();
    });

    it('meta.link_stats: рёбра корзины не считаются живыми связями', () => {
      const ndb = createInMemoryNetworkDb();
      const focused = thought(ndb, 'Фокус');
      const live = thought(ndb, 'Живой');
      const trashed = thought(ndb, 'В корзине');
      link(ndb, live, focused);
      const trashedLink = link(ndb, focused, trashed);
      trash(ndb, trashedLink);

      const meta = getThoughtMeta(ndb, focused);
      const total = meta.link_stats.stats.reduce((sum, entry) => sum + entry.count, 0);
      // Одно живое ребро (входящее) — помеченное исходящее не считается.
      assert.equal(total, 1);
      assert.deepEqual(meta.link_stats.stats, [
        { link_type_id: null, direction: 'in', count: 1 },
      ]);
      ndb.close();
    });
  },
);
