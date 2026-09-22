/**
 * Настройка сети «Показывать содержимое корзины» — задача 77923b49 (0.8.2),
 * `preferences.show_trash`.
 *
 * Контракт по умолчанию: `true` — поведение после фикса 355319d4 не меняется,
 * помеченные на удаление мысли/связи видны с признаком корзины. `false` —
 * помеченное скрыто ровно там, где неактуальное прячет `show_inactive`:
 * фокус/соседи (карта и локальный граф редактора), рёбра, иерархия структур,
 * сгруппированный список связей мысли.
 *
 * Обе грани фильтрации проверяются вместе: и РЕБРО корзины
 * (`links.marked_for_deletion`), и ПОМЕЧЕННАЯ МЫСЛЬ
 * (`thoughts.marked_for_deletion`) — как `show_inactive` покрывает и
 * `l.active`, и `t.active`.
 *
 * Общая in-memory NetworkDb; скипается без нативного better-sqlite3.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import {
  createLink,
  getEdgesAmong,
  getLinkDirections,
  listLinksByThought,
  updateLink,
} from '../src/domain/link-service.js';
import { getHierarchy } from '../src/domain/structure-service.js';
import { createThought, focus, getNeighbors, updateThought } from '../src/domain/thought-service.js';

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

/** Create an a→b untyped link and return its id. */
function link(ndb: NetworkDb, sourceId: string, targetId: string): string {
  return createLink(ndb, { source_id: sourceId, target_id: targetId }, USER).id;
}

/** Mark an existing link for deletion (moves it to the trash). */
function trashLink(ndb: NetworkDb, linkId: string): void {
  updateLink(ndb, linkId, { marked_for_deletion: true }, undefined, USER);
}

/** Mark a thought for deletion (moves it to the trash). */
function trashThought(ndb: NetworkDb, thoughtId: string): void {
  updateThought(ndb, thoughtId, { marked_for_deletion: true }, undefined, USER);
}

describe(
  'show_trash: видимость помеченных на удаление (77923b49)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('getEdgesAmong / getLinkDirections: по умолчанию помеченное ребро видно, showTrash=false — скрыто', () => {
      const ndb = createInMemoryNetworkDb();
      const a = thought(ndb, 'A');
      const b = thought(ndb, 'B');
      const live = link(ndb, a, b);
      const trashed = link(ndb, b, a);
      trashLink(ndb, trashed);

      const ids = [a, b];
      // Дефолт (аргумент не передан) = true — пометка видна, как после 355319d4.
      const byDefault = getEdgesAmong(ndb, ids, false).map((l) => l.id).sort();
      assert.deepEqual(byDefault, [live, trashed].sort());
      // Явный true — то же самое.
      assert.deepEqual(
        getEdgesAmong(ndb, ids, false, undefined, true).map((l) => l.id).sort(),
        [live, trashed].sort(),
      );
      // Настройка выключена — остаётся только живое ребро.
      assert.deepEqual(
        getEdgesAmong(ndb, ids, false, undefined, false).map((l) => l.id),
        [live],
      );

      // Индикаторы направлений считают те же рёбра: помеченное ребро b→a не
      // заполняет эллипс «есть родители», когда корзину не показывают.
      const shown = getLinkDirections(ndb, ids, undefined, false);
      assert.deepEqual(
        [shown.get(a)?.has_in, shown.get(a)?.has_out],
        [false, true],
        'у A остаётся только живое ребро a→b — входящее помечено корзиной',
      );
      const hidden = getLinkDirections(ndb, ids, undefined, true);
      assert.deepEqual([hidden.get(a)?.has_in, hidden.get(a)?.has_out], [true, true]);
      ndb.close();
    });

    it('focus: showTrash=false прячет помеченное ребро, помеченную мысль-соседа и её ребро', () => {
      const ndb = createInMemoryNetworkDb();
      const focused = thought(ndb, 'Фокус');
      const liveParent = thought(ndb, 'Живой родитель');
      const trashedParent = thought(ndb, 'Родитель в корзине');
      const trashedThought = thought(ndb, 'Сосед в корзине');
      const liveChild = thought(ndb, 'Живой потомок');
      const liveLinkId = link(ndb, liveParent, focused);
      const trashedLinkId = link(ndb, trashedParent, focused);
      trashLink(ndb, trashedLinkId);
      const trashedThoughtLink = link(ndb, focused, trashedThought);
      trashThought(ndb, trashedThought);
      const childLinkId = link(ndb, focused, liveChild);

      // Дефолт: помеченное видно и несёт признак корзины (355319d4).
      const byDefault = focus(ndb, USER, focused);
      assert.deepEqual(byDefault.parents.map((n) => n.id).sort(), [liveParent, trashedParent].sort());
      assert.equal(
        byDefault.parents.find((n) => n.id === trashedParent)?.link_marked_for_deletion,
        true,
      );
      assert.deepEqual(byDefault.children.map((n) => n.id).sort(), [liveChild, trashedThought].sort());

      // showTrash=false — скрыты обе грани: ребро корзины и помеченная мысль.
      const hidden = focus(ndb, USER, focused, { showTrash: false });
      assert.deepEqual(hidden.parents.map((n) => n.id), [liveParent]);
      assert.deepEqual(hidden.children.map((n) => n.id), [liveChild]);
      const edgeIds = hidden.edges.map((e) => e.id).sort();
      assert.deepEqual(
        edgeIds,
        [liveLinkId, childLinkId].sort(),
        'рёбра скрытых соседей не должны оставаться линиями на карте',
      );
      const edgeOfTrashedThought = hidden.edges.map((e) => e.target_id);
      assert.ok(
        !edgeOfTrashedThought.includes(trashedThought),
        'ребро к мысли корзины скрыто вместе с мыслью',
      );
      // Живые соседи не задеты: по-прежнему в зонах и с рёбрами.
      assert.deepEqual(
        hidden.parents.map((n) => n.link_id),
        [liveLinkId],
      );
      assert.deepEqual(
        hidden.children.map((n) => n.link_id),
        [childLinkId],
      );
      ndb.close();
    });

    it('getNeighbors: фильтр работает в каждом направлении, включая siblings', () => {
      const ndb = createInMemoryNetworkDb();
      const parent = thought(ndb, 'Родитель');
      const focused = thought(ndb, 'Фокус');
      const liveChild = thought(ndb, 'Потомок');
      const trashedChild = thought(ndb, 'Потомок в корзине');
      const trashedSibling = thought(ndb, 'Родственник в корзине');
      link(ndb, parent, focused);
      link(ndb, focused, liveChild);
      link(ndb, focused, trashedChild);
      trashThought(ndb, trashedChild);
      link(ndb, parent, trashedSibling);
      const trashedSiblingLink = ndb
        .prepare('SELECT id FROM links_v WHERE source_id = ? AND target_id = ?')
        .get(parent, trashedSibling) as { id: string };
      trashLink(ndb, trashedSiblingLink.id);

      assert.deepEqual(
        getNeighbors(ndb, focused, 'children', { showTrash: false }).map((n) => n.id),
        [liveChild],
      );
      assert.deepEqual(
        getNeighbors(ndb, focused, 'children').map((n) => n.id).sort(),
        [liveChild, trashedChild].sort(),
        'дефолт — помеченные видны',
      );
      assert.deepEqual(getNeighbors(ndb, focused, 'siblings', { showTrash: false }), []);
      assert.deepEqual(
        getNeighbors(ndb, focused, 'siblings').map((n) => n.id),
        [trashedSibling],
      );
      assert.deepEqual(
        getNeighbors(ndb, focused, 'parents', { showTrash: false }).map((n) => n.id),
        [parent],
      );
      ndb.close();
    });

    it('getHierarchy: дерево «Структур» прячет помеченных и их рёбра', () => {
      const ndb = createInMemoryNetworkDb();
      const root = thought(ndb, 'Корень дерева');
      const liveChild = thought(ndb, 'Живой потомок');
      const trashedChild = thought(ndb, 'Потомок в корзине');
      const trashedLinkChild = thought(ndb, 'Потомок с ребром в корзине');
      link(ndb, root, liveChild);
      link(ndb, root, trashedChild);
      trashThought(ndb, trashedChild);
      const trashedEdge = link(ndb, root, trashedLinkChild);
      trashLink(ndb, trashedEdge);

      const byDefault = getHierarchy(ndb, root, 'children');
      assert.deepEqual(
        byDefault.neighbors.map((n) => n.id).sort(),
        [liveChild, trashedChild, trashedLinkChild].sort(),
      );
      // Флаг корзины едет вместе с соседом (ошибка 8bbc9542): иначе помеченная
      // мысль видна, но клиент не может отрисовать метку, как на карте.
      assert.equal(
        byDefault.neighbors.find((n) => n.id === trashedChild)?.marked_for_deletion,
        true,
        'помеченный сосед приезжает с marked_for_deletion',
      );
      assert.equal(
        byDefault.neighbors.find((n) => n.id === liveChild)?.marked_for_deletion,
        false,
        'живой сосед не помечен',
      );

      const hidden = getHierarchy(ndb, root, 'children', { showTrash: false });
      assert.deepEqual(hidden.neighbors.map((n) => n.id), [liveChild]);
      assert.equal(
        hidden.edges.some((e) => e.id === trashedEdge),
        false,
        'ребро скрытого потомка не рисуется в дереве',
      );
      assert.deepEqual(
        [hidden.directions[root]?.has_outgoing],
        [true],
        'живой потомок оставляет ветвь раскрываемой',
      );

      // Родительская сторона — тем же фильтром.
      const parentsHidden = getHierarchy(ndb, liveChild, 'parents', { showTrash: false });
      assert.deepEqual(parentsHidden.neighbors.map((n) => n.id), [root]);
      ndb.close();
    });

    it('listLinksByThought: сгруппированный список прячет помеченное ребро и помеченную мысль-соседа', () => {
      const ndb = createInMemoryNetworkDb();
      const thoughtId = thought(ndb, 'Мысль редактора');
      const liveParent = thought(ndb, 'Живой родитель');
      const trashedOpponent = thought(ndb, 'Родитель в корзине');
      const trashedLinkOpponent = thought(ndb, 'Родитель с ребром в корзине');
      link(ndb, liveParent, thoughtId);
      link(ndb, trashedOpponent, thoughtId);
      trashThought(ndb, trashedOpponent);
      const trashedEdge = link(ndb, trashedLinkOpponent, thoughtId);
      trashLink(ndb, trashedEdge);

      const byDefault = listLinksByThought(ndb, thoughtId);
      assert.equal(
        byDefault.untyped_parents.length,
        3,
        'дефолт — помеченные связи и мысли видны (355319d4)',
      );

      const hidden = listLinksByThought(ndb, thoughtId, { showTrash: false });
      assert.deepEqual(
        hidden.untyped_parents.map((i) => i.source_thought?.id),
        [liveParent],
      );
      ndb.close();
    });
  },
);
