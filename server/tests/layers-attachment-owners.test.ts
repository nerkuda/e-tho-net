/**
 * Ветвимость таблицы владений вложений `attachment_owners` (0.12.1, задача
 * fbc276df; тех.проект «Общие вложения» f9b8917c; спека слоёв 13-layers.md §3,
 * требование b80cba23). Таблица уже зарегистрирована в `BRANCHABLE_TABLES`
 * задачей миграции 369241e4 (коммит db2368b5); здесь — протокольные пробы
 * слоевых механизмов НА ДОМЕННЫХ ЗАПИСЯХ ВЛАДЕНИЙ (не перечитывая код):
 *
 * - чтения идут через представление `attachment_owners_v`: надгробие одной
 *   строки владения прячет её из слоя, вторая строка владения остаётся
 *   видимой, а физическая строка основы не тронута;
 * - снятие владения в слое (`deleteRowLayered` → `materializeTombstone`) ставит
 *   надгробие ТОЛЬКО в строке слоя — в основе владение живо;
 * - владение, созданное в слое, видно только в слое (основа его не видит) —
 *   паритет с публикациями;
 * - первая правка (`materializeShadow`) копирует строку-победителя предка в
 *   слой; правка слоя видна через представление и не трогает основу;
 * - представление и temp-снапшот видимости `attachment_owners_snap` реально
 *   создаются/наполняются для новой таблицы — механизмы итерируют
 *   `BRANCHABLE_TABLES`, а не прошиты по именам таблиц.
 *
 * Пропускается, когда нативная сборка `better-sqlite3` недоступна.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { deleteRowLayered, materializeShadow, materializeTombstone } from '../src/db/layer-write.js';

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

/** Слой работы — прямой ребёнок основы. */
function seedLayer(ndb: NetworkDb): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
       VALUES (?, ?, 'Слой', 0, 1, 'u', ?, ?)`,
    )
    .run(id, BASE_LAYER_ID, now, now);
  return id;
}

/** Строка вложения-хоста (владельцы живут в `attachment_owners`). */
function seedAttachment(ndb: NetworkDb, layerId: string, id: string): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO attachments (id, layer_id, owner_type, owner_id, kind, url, position,
         created_at, created_by)
       VALUES (?, ?, 'thought', 'legacy-owner', 'url', 'http://example.test/a', 0, ?, 'u')`,
    )
    .run(id, layerId, now);
}

/** Одна строка владения (attachment_owners) напрямую — слоевые пробы на сырых данных. */
function seedOwnership(
  ndb: NetworkDb,
  args: { id: string; layerId: string; attachmentId: string; ownerId: string; position?: number; deleted?: number },
): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO attachment_owners (id, layer_id, deleted, base_version, attachment_id,
         owner_type, owner_id, position, created_at, created_by)
       VALUES (?, ?, ?, 0, ?, 'thought', ?, ?, ?, 'u')`,
    )
    .run(
      args.id,
      args.layerId,
      args.deleted ?? 0,
      args.attachmentId,
      args.ownerId,
      args.position ?? 0,
      now,
    );
}

/** Физическая строка владения (id, layer) — прямой доступ к таблице. */
function ownerRow(
  ndb: NetworkDb,
  id: string,
  layerId: string,
): { deleted: number; base_version: number; position: number } | undefined {
  return ndb
    .prepare('SELECT deleted, base_version, position FROM attachment_owners WHERE id = ? AND layer_id = ?')
    .get(id, layerId) as
    | { deleted: number; base_version: number; position: number }
    | undefined;
}

/** Логические id владений, видимых в текущем контексте слоя (через `*_v`). */
function visibleOwners(ndb: NetworkDb): string[] {
  return (ndb.prepare('SELECT id FROM attachment_owners_v ORDER BY id').all() as { id: string }[]).map(
    (r) => r.id,
  );
}

/** Позиция видимого владения в текущем контексте слоя (через `*_v`). */
function visiblePosition(ndb: NetworkDb, id: string): number | null {
  return (
    (ndb.prepare('SELECT position FROM attachment_owners_v WHERE id = ?').get(id) as
      | { position: number }
      | undefined)?.position ?? null
  );
}

describe(
  'attachment_owners: ветвимость владений — надгробие в слое, создание в слое, тень',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('снятие одного владения в слое прячет только его строку; вторая строка и основа не тронуты', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const att = randomUUID();
        seedAttachment(ndb, BASE_LAYER_ID, att);
        seedOwnership(ndb, { id: 'own-1', layerId: BASE_LAYER_ID, attachmentId: att, ownerId: 'owner-1' });
        seedOwnership(ndb, { id: 'own-2', layerId: BASE_LAYER_ID, attachmentId: att, ownerId: 'owner-2', position: 1 });

        // Основа: оба владения видны.
        assert.deepEqual(visibleOwners(ndb), ['own-1', 'own-2']);

        const layer = seedLayer(ndb);
        ndb.useLayer(layer);
        // Слой наследует оба владения основы.
        assert.deepEqual(visibleOwners(ndb), ['own-1', 'own-2']);

        // Снятие ОДНОГО владения в слое (прикладной путь удаления строки).
        assert.equal(deleteRowLayered(ndb, 'attachment_owners', 'own-1'), 1);
        // Из слоя владение-1 скрыто, владение-2 осталось видимым.
        assert.deepEqual(visibleOwners(ndb), ['own-2']);

        // Физика: надгробие — только в строке слоя, вторая строка в слой не материализована.
        const shadow = ownerRow(ndb, 'own-1', layer);
        assert.equal(shadow?.deleted, 1, 'в слое должна быть строка-надгробие');
        assert.equal(shadow?.base_version, 0, 'attachment_owners безверсионна — base_version = 0');
        assert.equal(ownerRow(ndb, 'own-2', layer), undefined, 'вторая строка владения не должна материализоваться');

        // Основа не тронута: обе физические строки живы.
        assert.equal(ownerRow(ndb, 'own-1', BASE_LAYER_ID)?.deleted, 0);
        assert.equal(ownerRow(ndb, 'own-2', BASE_LAYER_ID)?.deleted, 0);

        // Повторное снятие — no-op (надгробие уже стоит).
        assert.equal(deleteRowLayered(ndb, 'attachment_owners', 'own-1'), 1);
        assert.deepEqual(visibleOwners(ndb), ['own-2']);

        // И в контексте основы владение-1 снова видно — правка слоя не утекла.
        ndb.useLayer(BASE_LAYER_ID);
        assert.deepEqual(visibleOwners(ndb), ['own-1', 'own-2']);
      } finally {
        ndb.close();
      }
    });

    it('владение, созданное в слое, видно только в слое; основа его не видит', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const att = randomUUID();
        seedAttachment(ndb, BASE_LAYER_ID, att);
        seedOwnership(ndb, { id: 'own-base', layerId: BASE_LAYER_ID, attachmentId: att, ownerId: 'owner-1' });

        const layer = seedLayer(ndb);
        ndb.useLayer(layer);
        // Новое владение создано В СЛОЕ (копия идёт в текущий слой, S4).
        seedOwnership(ndb, { id: 'own-layer', layerId: layer, attachmentId: att, ownerId: 'owner-2', position: 1 });
        assert.deepEqual(visibleOwners(ndb), ['own-base', 'own-layer']);

        // Снятие владения основы — тоже только в слое.
        assert.equal(materializeTombstone(ndb, 'attachment_owners', 'own-base'), true);
        assert.deepEqual(visibleOwners(ndb), ['own-layer']);

        // Основа не видит владения слоя и не потеряла своё.
        ndb.useLayer(BASE_LAYER_ID);
        assert.deepEqual(visibleOwners(ndb), ['own-base']);
        assert.equal(ownerRow(ndb, 'own-layer', BASE_LAYER_ID), undefined);
        assert.equal(ownerRow(ndb, 'own-base', BASE_LAYER_ID)?.deleted, 0);
      } finally {
        ndb.close();
      }
    });

    it('materializeShadow копирует владение в слой; правка слоя видна через *_v и не трогает основу', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const att = randomUUID();
        seedAttachment(ndb, BASE_LAYER_ID, att);
        seedOwnership(ndb, { id: 'own-1', layerId: BASE_LAYER_ID, attachmentId: att, ownerId: 'owner-1', position: 3 });

        const layer = seedLayer(ndb);
        ndb.useLayer(layer);
        // Первая правка владения в слое копирует строку-победителя основы.
        assert.equal(materializeShadow(ndb, 'attachment_owners', 'own-1'), true);
        const shadow = ownerRow(ndb, 'own-1', layer);
        assert.equal(shadow?.deleted, 0);
        assert.equal(shadow?.base_version, 0);
        // Дубля нет: представление по-прежнему видит одну строку владения.
        assert.deepEqual(visibleOwners(ndb), ['own-1']);

        // Правка тени видна через представление в слое…
        ndb
          .prepare('UPDATE attachment_owners SET position = 7 WHERE id = ? AND layer_id = ?')
          .run('own-1', layer);
        assert.equal(visiblePosition(ndb, 'own-1'), 7);

        // …но основу не трогает: там своя позиция и ровно одна строка.
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(visiblePosition(ndb, 'own-1'), 3);
        assert.equal(ownerRow(ndb, 'own-1', BASE_LAYER_ID)?.position, 3);
      } finally {
        ndb.close();
      }
    });
  },
);

describe(
  'attachment_owners: представление и снапшот видимости создаются для новой таблицы',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('attachment_owners_v и attachment_owners_snap существуют и снапшот совпадает с видимыми строками', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const att = randomUUID();
        seedAttachment(ndb, BASE_LAYER_ID, att);
        seedOwnership(ndb, { id: 'own-b', layerId: BASE_LAYER_ID, attachmentId: att, ownerId: 'owner-b' });
        const layer = seedLayer(ndb);
        ndb.useLayer(layer);
        seedOwnership(ndb, { id: 'own-a', layerId: layer, attachmentId: att, ownerId: 'owner-a' });

        // Механизмы слоёв итерируют BRANCHABLE_TABLES — для новой таблицы
        // созданы и представление, и temp-снапшот видимости.
        const tempObjects = (
          ndb
            .prepare(
              `SELECT name FROM sqlite_temp_master
               WHERE name IN ('attachment_owners_v', 'attachment_owners_snap') ORDER BY name`,
            )
            .all() as { name: string }[]
        ).map((r) => r.name);
        assert.deepEqual(tempObjects, ['attachment_owners_snap', 'attachment_owners_v']);

        // Снапшот содержит ровно победителей представления.
        const snapIds = (
          ndb
            .prepare('SELECT id FROM attachment_owners_snap ORDER BY id')
            .all() as { id: string }[]
        ).map((r) => r.id);
        assert.deepEqual(snapIds, visibleOwners(ndb));
        assert.deepEqual(snapIds, ['own-a', 'own-b']);

        // После снятия владения основы снапшот пересобирается и исключает его.
        materializeTombstone(ndb, 'attachment_owners', 'own-b');
        const snapAfter = (
          ndb
            .prepare('SELECT id FROM attachment_owners_snap ORDER BY id')
            .all() as { id: string }[]
        ).map((r) => r.id);
        assert.deepEqual(snapAfter, ['own-a']);
      } finally {
        ndb.close();
      }
    });
  },
);
