/**
 * Домен подсистемы «Публикации» (0.11.1, задача 8178e007): CRUD с валидацией,
 * корзина и блокировки удаления, локальный порядок, исключения, полки,
 * владелец-вложение обложки.
 *
 * Пропускается, когда нативная сборка `better-sqlite3` недоступна.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { EtnError } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import {
  addPublicationExclusion,
  addShelfItem,
  checkPublicationDeletion,
  createPublication,
  createShelf,
  deleteShelf,
  getPublication,
  listPublicationExclusions,
  listPublicationOrder,
  listPublications,
  listShelves,
  purgePublication,
  removePublicationExclusion,
  removeShelfItem,
  restorePublication,
  setPublicationOrder,
  trashPublication,
  updatePublication,
} from '../src/domain/publication-service.js';

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

/** Code of a thrown EtnError (или `undefined`). */
function codeOf(err: unknown): string | undefined {
  return err instanceof EtnError ? err.code : undefined;
}

/** Id существующего свойства-связи для рецепта (создаётся прямым SQL). */
function seedProperty(ndb: NetworkDb, valueType = 'link'): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description,
                               created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .run(id, ndb.layerId, `p-${id.slice(0, 8)}`, `p-${id.slice(0, 8)}`, valueType, now, now);
  return id;
}

describe(
  'publication-service: CRUD и валидация',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('создаёт публикацию с разумными значениями по умолчанию', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const p = createPublication(ndb, { title: '  Документ  ', subtitle: 'подзаг' }, 'u1');
        assert.equal(p.title, 'Документ');
        assert.equal(p.subtitle, 'подзаг');
        assert.equal(p.cover_kind, 'none');
        assert.equal(p.assembly_date, null);
        assert.deepEqual(p.text_sources, []);
        assert.deepEqual(p.extra_properties, []);
        assert.equal(p.active, true);
        assert.equal(p.marked_for_deletion, false);
        assert.equal(p.version, 1);
        assert.equal(getPublication(ndb, p.id)?.id, p.id);
      } finally {
        ndb.close();
      }
    });

    it('резюме с заголовком отвергается', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        assert.throws(
          () => createPublication(ndb, { title: 'X', summary_md: '# Заголовок' }, 'u'),
          (e) => codeOf(e) === 'VALIDATION_ERROR',
        );
        assert.throws(
          () => createPublication(ndb, { title: 'X', summary_md: 'Текст\n===' }, 'u'),
          (e) => codeOf(e) === 'VALIDATION_ERROR',
        );
        // Обычный текст без заголовков проходит.
        const ok = createPublication(ndb, { title: 'X', summary_md: 'просто текст' }, 'u');
        assert.equal(ok.summary_md, 'просто текст');
      } finally {
        ndb.close();
      }
    });

    it('ровно один источник обложки', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const p = createPublication(ndb, { title: 'X' }, 'u');
        assert.throws(
          () =>
            updatePublication(
              ndb,
              p.id,
              { cover_url: 'https://e/x.png', cover_attachment_id: randomUUID() },
              'u',
            ),
          (e) => codeOf(e) === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('обложка-вложение обязана принадлежать публикации', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const p = createPublication(ndb, { title: 'X' }, 'u');
        const now = new Date().toISOString();
        // Строка-вложение с owner_type='publication' этой публикации.
        const attId = randomUUID();
        ndb
          .prepare(
            `INSERT INTO attachments (id, layer_id, owner_type, owner_id, kind, url, position,
                                      created_at, created_by, updated_by, created_at_ms, updated_at_ms)
             VALUES (?, ?, 'publication', ?, 'url', 'https://e/c.png', 0, ?, 'u', 'u', ?, ?)`,
          )
          .run(attId, ndb.layerId, p.id, now, Date.now(), Date.now());
        const updated = updatePublication(ndb, p.id, { cover_attachment_id: attId }, 'u');
        assert.equal(updated.cover_attachment_id, attId);
        assert.equal(updated.cover_kind, 'attachment');

        // Вложение другой публикации не годится.
        const other = createPublication(ndb, { title: 'Y' }, 'u');
        assert.throws(
          () => updatePublication(ndb, other.id, { cover_attachment_id: attId }, 'u'),
          (e) => codeOf(e) === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('рецепты не пересекаются и ссылаются на существующие свойства', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const prop = seedProperty(ndb);
        assert.throws(
          () =>
            createPublication(
              ndb,
              { title: 'X', text_sources: [prop], extra_properties: [prop] },
              'u',
            ),
          (e) => codeOf(e) === 'VALIDATION_ERROR',
        );
        assert.throws(
          () => createPublication(ndb, { title: 'X', text_sources: [randomUUID()] }, 'u'),
          (e) => codeOf(e) === 'VALIDATION_ERROR',
        );
        const ok = createPublication(
          ndb,
          { title: 'X', text_sources: [prop], extra_properties: [] },
          'u',
        );
        assert.deepEqual(ok.text_sources, [prop]);
      } finally {
        ndb.close();
      }
    });

    it('диапазон нумерации проверяется, assembly_date патчем не меняется', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        assert.throws(
          () => createPublication(ndb, { title: 'X', numbering_from: 5, numbering_to: 2 }, 'u'),
          (e) => codeOf(e) === 'VALIDATION_ERROR',
        );
        const p = createPublication(ndb, { title: 'X', numbering_from: 2, numbering_to: 4 }, 'u');
        assert.equal(p.numbering_from, 2);
        const updated = updatePublication(ndb, p.id, { title: 'Y' }, 'u');
        assert.equal(updated.title, 'Y');
        assert.equal(updated.assembly_date, null);
        assert.equal(updated.version, 2);
      } finally {
        ndb.close();
      }
    });

    it('список: поиск, фильтр актуальности, полки', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = createPublication(ndb, { title: 'Альфа', authorship: 'Иван' }, 'u');
        createPublication(ndb, { title: 'Бета' }, 'u');
        const shelf = createShelf(ndb, { title: 'Избранное' }, 'u');
        addShelfItem(ndb, shelf.id, a.id, 1, 'u');

        assert.equal(listPublications(ndb, {}).total, 2);
        assert.equal(listPublications(ndb, { q: 'альф' }).items[0]?.id, a.id);
        assert.equal(listPublications(ndb, { q: 'иван' }).items[0]?.id, a.id);
        assert.equal(listPublications(ndb, { shelf: shelf.id }).total, 1);

        trashPublication(ndb, a.id, 'u');
        assert.equal(listPublications(ndb, {}).total, 1);
        assert.equal(listPublications(ndb, { active: 'any', include_trashed: true }).total, 2);
      } finally {
        ndb.close();
      }
    });
  },
);

describe(
  'publication-service: корзина, блокировки, каскад',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('пометка/снятие пометки корзины', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const p = createPublication(ndb, { title: 'X' }, 'u');
        const trashed = trashPublication(ndb, p.id, 'u2');
        assert.equal(trashed.marked_for_deletion, true);
        assert.equal(trashed.marked_for_deletion_by, 'u2');
        const restored = restorePublication(ndb, p.id, 'u2');
        assert.equal(restored.marked_for_deletion, false);
      } finally {
        ndb.close();
      }
    });

    it('purge удаляет публикацию и каскад (порядок, исключения, полки)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const p = createPublication(ndb, { title: 'X' }, 'u');
        const shelf = createShelf(ndb, { title: 'Полка' }, 'u');
        setPublicationOrder(ndb, p.id, [{ node_key: 'n1', position: 1 }], 'u');
        addPublicationExclusion(ndb, p.id, randomUUID(), 'u');
        addShelfItem(ndb, shelf.id, p.id, 1, 'u');

        purgePublication(ndb, p.id);
        assert.equal(getPublication(ndb, p.id), null);
        assert.equal(listPublicationOrder(ndb, p.id).length, 0);
        assert.equal(listPublicationExclusions(ndb, p.id).length, 0);
        // Полка осталась, состав подчищен.
        assert.equal(listShelves(ndb).length, 1);
        assert.equal(listShelves(ndb)[0]?.items.length, 0);
      } finally {
        ndb.close();
      }
    });

    it('purge запрещён в рабочем слое', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const p = createPublication(ndb, { title: 'X' }, 'u');
        const layerId = randomUUID();
        const now = new Date().toISOString();
        ndb
          .prepare(
            `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
             VALUES (?, (SELECT id FROM layers WHERE is_base = 1), 'L', 0, 1, 'u', ?, ?)`,
          )
          .run(layerId, now, now);
        ndb.useLayer(layerId);
        assert.throws(
          () => purgePublication(ndb, p.id),
          (e) => codeOf(e) === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('checkPublicationDeletion сообщает удержание слоем', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const p = createPublication(ndb, { title: 'X' }, 'u');
        assert.deepEqual(checkPublicationDeletion(ndb, p.id), {
          blocked: false,
          blocking: { properties: 0, layers: [] },
        });
        const layerId = randomUUID();
        const now = new Date().toISOString();
        ndb
          .prepare(
            `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
             VALUES (?, (SELECT id FROM layers WHERE is_base = 1), 'L', 0, 1, 'u', ?, ?)`,
          )
          .run(layerId, now, now);
        ndb.useLayer(layerId);
        updatePublication(ndb, p.id, { title: 'в слое' }, 'u');
        ndb.useLayer('00000000-0000-4000-8000-0000000000ba5e');
        const check = checkPublicationDeletion(ndb, p.id);
        assert.equal(check.blocked, true);
        assert.equal(check.blocking.layers.length, 1);
        assert.throws(
          () => purgePublication(ndb, p.id),
          (e) => codeOf(e) === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });
  },
);

describe(
  'publication-service: порядок, исключения, полки',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('порядок сохраняется и сортируется, неизвестные узлы допустимы', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const p = createPublication(ndb, { title: 'X' }, 'u');
        setPublicationOrder(
          ndb,
          p.id,
          [
            { node_key: 'b', position: 2 },
            { node_key: 'a', position: 1 },
          ],
          'u',
        );
        assert.deepEqual(
          listPublicationOrder(ndb, p.id).map((i) => i.node_key),
          ['a', 'b'],
        );
      } finally {
        ndb.close();
      }
    });

    it('исключения добавляются и снимаются', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const p = createPublication(ndb, { title: 'X' }, 'u');
        const t = randomUUID();
        assert.equal(addPublicationExclusion(ndb, p.id, t, 'u').length, 1);
        // Повторное добавление идемпотентно.
        assert.equal(addPublicationExclusion(ndb, p.id, t, 'u').length, 1);
        assert.equal(removePublicationExclusion(ndb, p.id, t).length, 0);
      } finally {
        ndb.close();
      }
    });

    it('полки: уникальность имени, состав и удаление', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const p = createPublication(ndb, { title: 'X' }, 'u');
        const shelf = createShelf(ndb, { title: 'Полка' }, 'u');
        assert.throws(
          () => createShelf(ndb, { title: 'полка' }, 'u'),
          (e) => codeOf(e) === 'VALIDATION_ERROR',
        );
        const withItem = addShelfItem(ndb, shelf.id, p.id, 1, 'u');
        assert.equal(withItem.items.length, 1);
        assert.equal(withItem.items[0]?.publication_id, p.id);
        assert.equal(removeShelfItem(ndb, shelf.id, p.id).items.length, 0);
        addShelfItem(ndb, shelf.id, p.id, 1, 'u');
        deleteShelf(ndb, shelf.id);
        assert.equal(listShelves(ndb).length, 0);
        // Публикация не тронута удалением полки.
        assert.notEqual(getPublication(ndb, p.id), null);
      } finally {
        ndb.close();
      }
    });
  },
);
