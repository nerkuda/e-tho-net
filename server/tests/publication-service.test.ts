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
import { publicationExclusionId, publicationOrderId } from '../src/db/publication-id.js';
import { createAttachment } from '../src/domain/attachment-service.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
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
  restoreShelf,
  setPublicationOrder,
  trashPublication,
  trashShelf,
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

/** Seed a typed thought directly and return its id. */
function seedThought(ndb: NetworkDb, title: string, typeId: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, 1, 0, 0, 1, ?, 'u', ?, 'u')`,
    )
    .run(id, ndb.layerId, title, title.toLowerCase(), typeId, now, now);
  return id;
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

/** Рабочий слой-ребёнок основы. */
function seedLayer(ndb: NetworkDb): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
       VALUES (?, (SELECT id FROM layers WHERE is_base = 1), 'Слой', 0, 1, 'u', ?, ?)`,
    )
    .run(id, now, now);
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
        // Вложение-обложка, принадлежащее публикации (владение в
        // attachment_owners, 0.12.1).
        const attId = createAttachment(
          ndb,
          'publication',
          p.id,
          { kind: 'url', url: 'https://e/c.png' },
          'u',
        ).id;
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
        // Строки-детали пишутся напрямую: тест про каскад purge, а не про
        // валидацию принадлежности узлов/мыслей (ошибки 5f23f57d/3882bd46).
        const now = new Date().toISOString();
        ndb
          .prepare(
            `INSERT INTO publication_order (id, layer_id, publication_id, node_key, position,
                                            updated_at, updated_by)
             VALUES (?, ?, ?, 'n1', 1, ?, 'u')`,
          )
          .run(publicationOrderId(p.id, 'n1'), ndb.layerId, p.id, now);
        const thought = randomUUID();
        ndb
          .prepare(
            `INSERT INTO publication_exclusions (id, layer_id, publication_id, thought_id,
                                                 created_at, created_by)
             VALUES (?, ?, ?, ?, ?, 'u')`,
          )
          .run(publicationExclusionId(p.id, thought), ndb.layerId, p.id, thought, now);
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
        const layerId = seedLayer(ndb);
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
        const layerId = seedLayer(ndb);
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
    it('порядок принимает узлы отбора и отвергает произвольный узел', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const type = createThoughtType(ndb, { name: 'Doc' }, 'u');
        const a = seedThought(ndb, 'A', type.id);
        const b = seedThought(ndb, 'B', type.id);
        const p = createPublication(
          ndb,
          { title: 'X', title_recipe: { type_ids: [type.id], sort: 'alpha', order: 'asc' } },
          'u',
        );
        setPublicationOrder(
          ndb,
          p.id,
          [
            { node_key: a, position: 2 },
            { node_key: b, position: 1 },
          ],
          'u',
        );
        assert.deepEqual(
          listPublicationOrder(ndb, p.id).map((i) => i.node_key),
          [b, a],
        );
        // Произвольный ключ, никогда не существовавший у публикации, отвергается
        // (ошибка 5f23f57d), позиция не пишется.
        assert.throws(
          () => setPublicationOrder(ndb, p.id, [{ node_key: randomUUID(), position: 0 }], 'u'),
          (e) => codeOf(e) === 'VALIDATION_ERROR',
        );
        assert.deepEqual(
          listPublicationOrder(ndb, p.id).map((i) => i.node_key),
          [b, a],
        );
      } finally {
        ndb.close();
      }
    });

    it('исключения: член публикации принимается, посторонний отвергается', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const type = createThoughtType(ndb, { name: 'Doc' }, 'u');
        const other = createThoughtType(ndb, { name: 'Other' }, 'u');
        const a = seedThought(ndb, 'A', type.id);
        const p = createPublication(
          ndb,
          { title: 'X', title_recipe: { type_ids: [type.id], sort: 'alpha', order: 'asc' } },
          'u',
        );
        assert.equal(addPublicationExclusion(ndb, p.id, a, 'u').length, 1);
        // Повторное добавление идемпотентно.
        assert.equal(addPublicationExclusion(ndb, p.id, a, 'u').length, 1);
        assert.equal(removePublicationExclusion(ndb, p.id, a).length, 0);

        // Мысль сети, не входящая в публикацию → VALIDATION_ERROR.
        const outsider = seedThought(ndb, 'Z', other.id);
        assert.throws(
          () => addPublicationExclusion(ndb, p.id, outsider, 'u'),
          (e) => codeOf(e) === 'VALIDATION_ERROR',
        );
        assert.throws(
          () => removePublicationExclusion(ndb, p.id, outsider),
          (e) => codeOf(e) === 'VALIDATION_ERROR',
        );
        // Несуществующий id → NOT_FOUND.
        assert.throws(
          () => addPublicationExclusion(ndb, p.id, randomUUID(), 'u'),
          (e) => codeOf(e) === 'NOT_FOUND',
        );
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
        // Удалять полку можно и непустой (карточка c80951ea): состав уходит
        // каскадом, публикация остаётся.
        deleteShelf(ndb, shelf.id);
        assert.equal(listShelves(ndb).length, 0);
        assert.notEqual(getPublication(ndb, p.id), null);
        // Физическое удаление освобождает имя — повторное создание проходит.
        const again = createShelf(ndb, { title: 'Полка' }, 'u');
        assert.notEqual(again.id, shelf.id);
      } finally {
        ndb.close();
      }
    });

    it('полку в слое нельзя удалить физически: только корзина', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);

        const shelf = createShelf(ndb, { title: 'Полка' }, 'u');
        assert.throws(
          () => deleteShelf(ndb, shelf.id),
          (e) => codeOf(e) === 'VALIDATION_ERROR',
        );

        // Пометка убирает полку из списка слоя; имя занято до purge.
        assert.equal(trashShelf(ndb, shelf.id, 'u').marked_for_deletion, true);
        assert.equal(listShelves(ndb).length, 0);
        assert.throws(
          () => createShelf(ndb, { title: 'Полка' }, 'u'),
          (e) => codeOf(e) === 'VALIDATION_ERROR',
        );
        assert.equal(restoreShelf(ndb, shelf.id, 'u').marked_for_deletion, false);
        assert.equal(listShelves(ndb).length, 1);
      } finally {
        ndb.close();
      }
    });

    it('оживляет надгробия порядка, исключений и состава полки в слое', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const type = createThoughtType(ndb, { name: 'Doc' }, 'u');
        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);
        const thought = seedThought(ndb, 'T', type.id);
        const p = createPublication(
          ndb,
          { title: 'X', title_recipe: { type_ids: [type.id], sort: 'alpha', order: 'asc' } },
          'u',
        );

        // publication_order: принудительное надгробие → повторная перестановка
        // оживляет строку (детерминированный id), позиция применяется. Ключ —
        // мысль отбора: после оживления она остаётся узлом публикации.
        const orderId = publicationOrderId(p.id, thought);
        ndb
          .prepare(
            `INSERT INTO publication_order (id, layer_id, publication_id, node_key, position,
                                            deleted, updated_at, updated_by)
             VALUES (?, ?, ?, ?, 9, 1, '2024-01-01T00:00:00Z', 'u')`,
          )
          .run(orderId, layerId, p.id, thought);
        assert.equal(listPublicationOrder(ndb, p.id).length, 0);
        setPublicationOrder(ndb, p.id, [{ node_key: thought, position: 5 }], 'u');
        assert.deepEqual(listPublicationOrder(ndb, p.id), [{ node_key: thought, position: 5 }]);

        // publication_exclusions: add → remove (надгробие) → add оживляет.
        addPublicationExclusion(ndb, p.id, thought, 'u');
        removePublicationExclusion(ndb, p.id, thought);
        assert.equal(listPublicationExclusions(ndb, p.id).length, 0);
        addPublicationExclusion(ndb, p.id, thought, 'u');
        assert.equal(listPublicationExclusions(ndb, p.id).length, 1);

        // shelf_items: add → remove (надгробие) → add оживляет с новой позицией.
        const shelf = createShelf(ndb, { title: 'Полка' }, 'u');
        addShelfItem(ndb, shelf.id, p.id, 1, 'u');
        removeShelfItem(ndb, shelf.id, p.id);
        assert.equal(listShelves(ndb)[0]?.items.length, 0);
        addShelfItem(ndb, shelf.id, p.id, 7, 'u');
        const items = listShelves(ndb)[0]?.items ?? [];
        assert.equal(items.length, 1);
        assert.equal(items[0]?.position, 7);
      } finally {
        ndb.close();
      }
    });
  },
);
