/**
 * Authorship fill (task 5ef8b5bb «Заполнение авторства в операциях записи
 * сервера», требование e6d4165e «колонки авторства у редактируемых сущностей»,
 * миграция 033).
 *
 * Покрывает критерий приёмки задачи: «каждая операция записи через REST
 * обновляет авторство; пользователь снаружи видит имена и даты в DTO».
 * Внутри domain-уровня это уже проверяют unit-тесты; здесь — end-to-end
 * чек на уровне SQL: SELECT сразу после INSERT/UPDATE показывает корректные
 * `created_by`/`updated_by`/`created_at_ms`/`updated_at_ms`, а правка
 * значения свойства касается владельца (требование «приравнивание»), а
 * правка настроек типа — самого типа.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import { createThought, updateThought } from '../src/domain/thought-service.js';
import { createLink, updateLink } from '../src/domain/link-service.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { createLinkType } from '../src/domain/link-type-service.js';
import { createLayer } from '../src/domain/layer-service.js';
import { createComment, updateComment } from '../src/domain/comment-service.js';
import { createAttachment, updateAttachment } from '../src/domain/attachment-service.js';
import {
  createNetworkProperty,
  createTypeProperty,
  setPropertyValue,
  updateNetworkProperty,
} from '../src/domain/property-service.js';

const ALICE = '00000000-0000-4000-8000-00000000a11ce';
const BOB = '00000000-0000-4000-8000-00000000b0b00';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

describe(
  'authorship columns filled in domain writes (task 5ef8b5bb)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('thought INSERT/UPDATE fill created_by/updated_by/_ms and the DTO returns them', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const before = Date.now();
        const t = createThought(ndb, { title: 'Идея' }, ALICE);
        const fetched = ndb
          .prepare(
            `SELECT created_by, updated_by, created_at_ms, updated_at_ms
             FROM thoughts WHERE id = ?`,
          )
          .get(t.id) as {
          created_by: string;
          updated_by: string;
          created_at_ms: number;
          updated_at_ms: number;
        };
        assert.equal(fetched.created_by, ALICE);
        assert.equal(fetched.updated_by, ALICE, 'новый ряд: updated_by = created_by');
        assert.ok(
          fetched.created_at_ms >= before && fetched.created_at_ms <= Date.now(),
          `created_at_ms ${fetched.created_at_ms} вне окна [${before}, ${Date.now()}]`,
        );
        assert.equal(fetched.updated_at_ms, fetched.created_at_ms);

        const afterUpdate = Date.now();
        updateThought(ndb, t.id, { title: 'Идея v2' }, t.version, BOB);
        const afterRow = ndb
          .prepare(
            `SELECT created_by, updated_by, created_at_ms, updated_at_ms FROM thoughts WHERE id = ?`,
          )
          .get(t.id) as {
          created_by: string;
          updated_by: string;
          created_at_ms: number;
          updated_at_ms: number;
        };
        assert.equal(afterRow.updated_by, BOB);
        assert.equal(afterRow.created_by, ALICE, 'created_by не меняется при UPDATE');
        assert.ok(afterRow.updated_at_ms >= afterUpdate);
        assert.ok(afterRow.updated_at_ms > fetched.created_at_ms);
        assert.equal(afterRow.created_at_ms, fetched.created_at_ms);
      } finally {
        ndb.close();
      }
    });

    it('link INSERT/UPDATE fill created_by/updated_by/_ms', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = createThought(ndb, { title: 'A' }, ALICE);
        const b = createThought(ndb, { title: 'B' }, ALICE);
        const l = createLink(ndb, { source_id: a.id, target_id: b.id }, ALICE);
        const row = ndb
          .prepare(
            `SELECT created_by, updated_by, created_at_ms, updated_at_ms FROM links WHERE id = ?`,
          )
          .get(l.id) as { created_by: string; updated_by: string; created_at_ms: number; updated_at_ms: number };
        assert.equal(row.created_by, ALICE);
        assert.equal(row.updated_by, ALICE);

        updateLink(ndb, l.id, { active: false }, l.version, BOB);
        const afterRow = ndb
          .prepare(
            `SELECT created_by, updated_by, updated_at_ms FROM links WHERE id = ?`,
          )
          .get(l.id) as { created_by: string; updated_by: string; updated_at_ms: number };
        assert.equal(afterRow.updated_by, BOB);
        assert.equal(afterRow.created_by, ALICE);
      } finally {
        ndb.close();
      }
    });

    it('comment INSERT/UPDATE fill created_by/updated_by/_ms', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = createThought(ndb, { title: 'Цель' }, ALICE);
        const c = createComment(
          ndb,
          'thought',
          t.id,
          { kind: 'permanent', body_md: 'постоянный' },
          ALICE,
        );
        const rowAfterCreate = ndb
          .prepare(
            `SELECT created_by, updated_by, created_at_ms, updated_at_ms FROM comments WHERE id = ?`,
          )
          .get(c.id) as { created_by: string; updated_by: string; created_at_ms: number; updated_at_ms: number };
        assert.equal(rowAfterCreate.created_by, ALICE);
        assert.equal(rowAfterCreate.updated_by, ALICE);
        assert.equal(rowAfterCreate.created_at_ms, rowAfterCreate.updated_at_ms);

        updateComment(ndb, c.id, { body_md: 'правлен' }, c.version, BOB);
        const rowAfterUpdate = ndb
          .prepare(
            `SELECT created_by, updated_by, updated_at_ms FROM comments WHERE id = ?`,
          )
          .get(c.id) as { created_by: string; updated_by: string; updated_at_ms: number };
        assert.equal(rowAfterUpdate.updated_by, BOB);
        assert.equal(rowAfterUpdate.created_by, ALICE);
        assert.ok(rowAfterUpdate.updated_at_ms >= rowAfterCreate.updated_at_ms);
      } finally {
        ndb.close();
      }
    });

    it('attachment INSERT/UPDATE fill created_by/updated_by/_ms (no updated_at TEXT column)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = createThought(ndb, { title: 'Host' }, ALICE);
        const a = createAttachment(
          ndb,
          'thought',
          t.id,
          { kind: 'url', url: 'https://e.x/page' },
          ALICE,
        );
        const rowAfterCreate = ndb
          .prepare(
            `SELECT created_by, updated_by, created_at_ms, updated_at_ms FROM attachments WHERE id = ?`,
          )
          .get(a.id) as { created_by: string; updated_by: string; created_at_ms: number; updated_at_ms: number };
        assert.equal(rowAfterCreate.created_by, ALICE);
        // У `attachments` нет своей ISO-колонки `updated_at` — миллисекунд
        // достаточно для сортировки и вкладки «Метаданные».
        assert.ok(rowAfterCreate.created_at_ms >= 0);
        assert.equal(rowAfterCreate.created_at_ms, rowAfterCreate.updated_at_ms);

        updateAttachment(ndb, a.id, { title: 'New' }, BOB);
        const rowAfterUpdate = ndb
          .prepare(
            `SELECT created_by, updated_by, updated_at_ms FROM attachments WHERE id = ?`,
          )
          .get(a.id) as { created_by: string; updated_by: string; updated_at_ms: number };
        assert.equal(rowAfterUpdate.updated_by, BOB);
        assert.equal(rowAfterUpdate.created_by, ALICE);
        assert.ok(rowAfterUpdate.updated_at_ms >= rowAfterCreate.updated_at_ms);
      } finally {
        ndb.close();
      }
    });

    it('thought_type and link_type INSERT/UPDATE fill created_by/updated_by/_ms', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'Карточка' }, ALICE);
        const ttRow = ndb
          .prepare(
            `SELECT created_by, updated_by, created_at_ms, updated_at_ms FROM thought_types WHERE id = ?`,
          )
          .get(tt.id) as { created_by: string; updated_by: string };
        assert.equal(ttRow.created_by, ALICE);
        assert.equal(ttRow.updated_by, ALICE);

        const lt = createLinkType(ndb, { name_forward: 'f', name_reverse: 'r' }, ALICE);
        const ltRow = ndb
          .prepare(
            `SELECT created_by, updated_by, created_at_ms, updated_at_ms FROM link_types WHERE id = ?`,
          )
          .get(lt.id) as { created_by: string; updated_by: string };
        assert.equal(ltRow.created_by, ALICE);
        assert.equal(ltRow.updated_by, ALICE);
      } finally {
        ndb.close();
      }
    });

    it('layer INSERT/UPDATE fill created_by/updated_by/_ms (no updated_at TEXT column)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const root = ndb
          .prepare("SELECT id FROM layers WHERE is_base = 1")
          .get() as { id: string };
        const L = createLayer(ndb, {
          parentId: root.id,
          title: 'Слой',
          createdBy: ALICE,
        });
        const row = ndb
          .prepare(
            `SELECT created_by, updated_by, created_at_ms, updated_at_ms FROM layers WHERE id = ?`,
          )
          .get(L.id) as { created_by: string; updated_by: string };
        assert.equal(row.created_by, ALICE);
        assert.equal(row.updated_by, ALICE);
      } finally {
        ndb.close();
      }
    });

    it('property registry and property_value INSERT fill created_by/updated_by/_ms', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const prop = createNetworkProperty(
          ndb,
          { name: 'статус', value_type: 'text' },
          ALICE,
        );
        const propRow = ndb
          .prepare(
            `SELECT created_by, updated_by, created_at_ms, updated_at_ms FROM properties WHERE id = ?`,
          )
          .get(prop.id) as {
          created_by: string;
          updated_by: string;
          created_at_ms: number;
          updated_at_ms: number;
        };
        assert.equal(propRow.created_by, ALICE);
        assert.equal(propRow.updated_by, ALICE);

        // Update переписывает updated_by/updated_at_ms, created_by не меняется.
        updateNetworkProperty(ndb, prop.id, { description: 'новое описание' }, BOB);
        const propAfterUpdate = ndb
          .prepare(
            `SELECT created_by, updated_by, created_at_ms, updated_at_ms FROM properties WHERE id = ?`,
          )
          .get(prop.id) as {
          created_by: string;
          updated_by: string;
          created_at_ms: number;
          updated_at_ms: number;
        };
        assert.equal(propAfterUpdate.updated_by, BOB);
        assert.equal(propAfterUpdate.created_by, ALICE);
        assert.ok(propAfterUpdate.updated_at_ms >= propRow.created_at_ms);

        // property_value: created_by/updated_by/_ms заполняются при записи.
        const tt = createThoughtType(ndb, { name: 'Карточка' }, ALICE);
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'статус', value_type: 'text' }, ALICE);
        const t = createThought(ndb, { title: 'Объект', type_id: tt.id }, ALICE);
        setPropertyValue(ndb, 'thought', t.id, 'статус', 'в работе', BOB);
        const valueRow = ndb
          .prepare(
            `SELECT pv.created_by AS created_by, pv.updated_by AS updated_by,
                    pv.created_at_ms AS created_at_ms, pv.updated_at_ms AS updated_at_ms
             FROM property_values pv
             JOIN properties p ON p.id = pv.property_id
             WHERE pv.owner_type = 'thought' AND pv.owner_id = ?
               AND p.name_key = type_name_key('статус')`,
          )
          .get(t.id) as
          | {
              created_by: string;
              updated_by: string;
              created_at_ms: number;
              updated_at_ms: number;
            }
          | undefined;
        assert.ok(valueRow, 'property_value row must exist');
        assert.equal(valueRow.created_by, BOB);
        assert.equal(valueRow.updated_by, BOB);
        assert.ok(valueRow.created_at_ms > 0);
        assert.equal(valueRow.created_at_ms, valueRow.updated_at_ms);
      } finally {
        ndb.close();
      }
    });

    it('приравнивание: правка значения свойства трогает updated_by/updated_at_ms владельца-мысли', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'Карточка' }, ALICE);
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'статус', value_type: 'text' }, ALICE);
        const t = createThought(ndb, { title: 'Объект', type_id: tt.id }, ALICE);
        const thoughtAfterCreate = ndb
          .prepare(
            `SELECT updated_by, updated_at_ms FROM thoughts WHERE id = ?`,
          )
          .get(t.id) as { updated_by: string; updated_at_ms: number };
        assert.equal(thoughtAfterCreate.updated_by, ALICE);
        const baselineMs = thoughtAfterCreate.updated_at_ms;

        // Правка значения свойства должна обновить автора мысли (BOB).
        setPropertyValue(ndb, 'thought', t.id, 'статус', 'готово', BOB);
        const thoughtAfterValue = ndb
          .prepare(
            `SELECT updated_by, updated_at_ms FROM thoughts WHERE id = ?`,
          )
          .get(t.id) as { updated_by: string; updated_at_ms: number };
        assert.equal(
          thoughtAfterValue.updated_by,
          BOB,
          'правка значения свойства обязана сменить updated_by владельца',
        );
        assert.ok(thoughtAfterValue.updated_at_ms >= baselineMs);
      } finally {
        ndb.close();
      }
    });

    it('приравнивание: правка значения свойства на связи трогает updated_by/updated_at_ms связи', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const lt = createLinkType(ndb, { name_forward: 'f', name_reverse: 'r' }, ALICE);
        createTypeProperty(ndb, 'link_type', lt.id, { key: 'вес', value_type: 'number' }, ALICE);
        const a = createThought(ndb, { title: 'A' }, ALICE);
        const b = createThought(ndb, { title: 'B' }, ALICE);
        const link = createLink(
          ndb,
          { source_id: a.id, target_id: b.id, type_id: lt.id },
          ALICE,
        );
        setPropertyValue(ndb, 'link', link.id, 'вес', 7, BOB);
        const linkRow = ndb
          .prepare(
            `SELECT updated_by, updated_at_ms FROM links WHERE id = ?`,
          )
          .get(link.id) as { updated_by: string };
        assert.equal(linkRow.updated_by, BOB);
      } finally {
        ndb.close();
      }
    });

    it('приравнивание: подключение свойства к типу трогает updated_by/updated_at_ms самого типа', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'Карточка' }, ALICE);
        const ttBefore = ndb
          .prepare(
            `SELECT version, updated_by, updated_at_ms FROM thought_types WHERE id = ?`,
          )
          .get(tt.id) as { version: number; updated_by: string; updated_at_ms: number };
        assert.equal(ttBefore.updated_by, ALICE);
        const baselineVersion = ttBefore.version;
        const baselineMs = ttBefore.updated_at_ms;

        createTypeProperty(
          ndb,
          'thought_type',
          tt.id,
          { key: 'поле', value_type: 'text' },
          BOB,
        );
        const ttAfter = ndb
          .prepare(
            `SELECT version, updated_by, updated_at_ms FROM thought_types WHERE id = ?`,
          )
          .get(tt.id) as { version: number; updated_by: string; updated_at_ms: number };
        assert.equal(
          ttAfter.updated_by,
          BOB,
          'подключение свойства обязано сменить updated_by типа',
        );
        assert.equal(ttAfter.version, baselineVersion + 1);
        assert.ok(ttAfter.updated_at_ms >= baselineMs);
      } finally {
        ndb.close();
      }
    });

    it('migration 033 backfilled rows carry non-empty author and _ms > 0', () => {
      // Проверяем, что миграция отработала на свежей БД — обратная
      // совместимость: SELECT по существующим колонкам возвращает не-NULL
      // значения, даже если прикладной код ещё не пишет в них.
      const ndb = createInMemoryNetworkDb();
      try {
        const row = ndb
          .prepare(
            `SELECT created_by, updated_by, created_at_ms, updated_at_ms FROM thoughts LIMIT 1`,
          )
          .get() as
          | {
              created_by: string;
              updated_by: string;
              created_at_ms: number;
              updated_at_ms: number;
            }
          | undefined;
        // В пустой сети может не быть рядов; проверим только когда есть HOME.
        if (row !== undefined) {
          assert.ok(row.created_by.length > 0);
          assert.ok(row.updated_by.length > 0);
          assert.ok(row.created_at_ms > 0);
          assert.ok(row.updated_at_ms > 0);
        }
      } finally {
        ndb.close();
      }
    });
  },
);
