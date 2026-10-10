/**
 * Слияние слоя и модель владельцев вложений `attachment_owners` (0.12.1, задача
 * ff69343a; тех.проект «Общие вложения» f9b8917c; ADR 9f90b010; спека слоёв
 * b80cba23; сущности `attachments` 19dd0b5d и `attachment_owners` 2868dac0).
 *
 * Пробы доменного ядра слияния на СЫРЫХ слоевых данных — владения вставляются
 * напрямую в таблицу (переходный период: владения пишет только миграция, задача
 * домена 7678876a ещё впереди). Проверяется:
 *
 *   * замыкание и посрочный реплей строк владений: владение слоя доезжает до
 *     основы, вложение/владелец разрешаются по цепочке, неразрешимое вложение —
 *     `missing_closure`;
 *   * исчезновение вложения: когда после слияния во ВСЕХ рабочих слоях не
 *     осталось живого владения, строка вложения убирается из цели, а висячий
 *     `icon_attachment_id` мысли обнуляется;
 *   * пока у вложения есть живого владельца (в т.ч. другого) — вложение и
 *     указатель не трогаются.
 *
 * Пропускается, когда нативная сборка `better-sqlite3` недоступна.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID, EtnError } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { materializeShadow, materializeTombstone } from '../src/db/layer-write.js';
import {
  discardLayerThought,
  mergeLayer,
  mergeLayerThought,
  type MergeSelection,
} from '../src/domain/merge-service.js';

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

/** Мысль в указанном слое (сырые данные). */
function seedThought(ndb: NetworkDb, id: string, title: string, layerId: string = BASE_LAYER_ID): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, active, is_protected, is_root,
         created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 1, 0, 0, ?, 'u', ?, 'u')`,
    )
    .run(id, layerId, title, title.toLowerCase(), now, now);
}

/** Строка вложения (owner-колонки — легаси-путь домена, переходный период). */
function seedAttachment(
  ndb: NetworkDb,
  id: string,
  layerId: string = BASE_LAYER_ID,
  ownerType = 'thought',
  ownerId = 'legacy-owner',
): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO attachments (id, layer_id, owner_type, owner_id, kind, url, position,
         created_at, created_by)
       VALUES (?, ?, ?, ?, 'url', 'http://example.test/a', 0, ?, 'u')`,
    )
    .run(id, layerId, ownerType, ownerId, now);
}

/** Публикация с обложкой-вложением (сырые данные). */
function seedPublication(ndb: NetworkDb, id: string, title: string, coverId: string): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO publications (id, layer_id, title, cover_attachment_id,
         created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, 'u', ?, 'u')`,
    )
    .run(id, BASE_LAYER_ID, title, coverId, now, now);
}

/** Одна строка владения (attachment_owners) напрямую. */
function seedOwnership(
  ndb: NetworkDb,
  args: {
    id: string;
    layerId?: string;
    attachmentId: string;
    ownerId: string;
    ownerType?: string;
    deleted?: number;
    position?: number;
  },
): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO attachment_owners (id, layer_id, deleted, base_version, attachment_id,
         owner_type, owner_id, position, created_at, created_by)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, 'u')`,
    )
    .run(
      args.id,
      args.layerId ?? BASE_LAYER_ID,
      args.deleted ?? 0,
      args.attachmentId,
      args.ownerType ?? 'thought',
      args.ownerId,
      args.position ?? 0,
      now,
    );
}

/** Строки вложения `id` в конкретном слое, включая надгробия. */
function attachmentRowsInLayer(ndb: NetworkDb, id: string, layerId: string): number {
  return (
    ndb
      .prepare('SELECT COUNT(*) AS c FROM attachments WHERE id = ? AND layer_id = ?')
      .get(id, layerId) as { c: number }
  ).c;
}

/** Живые строки вложения `id` в рабочих (не служебных) слоях. */
function liveAttachmentRows(ndb: NetworkDb, id: string): number {
  return (
    ndb
      .prepare(
        `SELECT COUNT(*) AS c FROM attachments a
         JOIN layers l ON l.id = a.layer_id AND l.is_service = 0
         WHERE a.id = ? AND a.deleted = 0`,
      )
      .get(id) as { c: number }
  ).c;
}

/** Физические строки владения `ownerId` во всех слоях. */
function ownershipRows(ndb: NetworkDb, ownerId: string): Array<{ layer_id: string; deleted: number }> {
  return ndb
    .prepare('SELECT layer_id, deleted FROM attachment_owners WHERE owner_id = ?')
    .all(ownerId) as Array<{ layer_id: string; deleted: number }>;
}

describe(
  'merge + attachment_owners: замыкание, реплей и исчезновение вложения',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('владение слоя реплеится в основу; вложение разрешается по цепочке', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = randomUUID();
        const t2 = randomUUID();
        const att = randomUUID();
        seedThought(ndb, t, 'T');
        seedThought(ndb, t2, 'T2');
        seedAttachment(ndb, att);
        seedOwnership(ndb, { id: 'own-1', attachmentId: att, ownerId: t });

        const layer = seedLayer(ndb);
        // Новое владение второго объекта, созданное В СЛОЕ.
        seedOwnership(ndb, { id: 'own-2', layerId: layer, attachmentId: att, ownerId: t2 });

        const report = mergeLayer(ndb, layer, undefined, 'u');

        assert.equal(report.applied.attachment_owners, 1);
        assert.deepEqual(report.skipped, []);
        // Владение доехало до основы; вложение живо (есть живые владельцы).
        assert.equal(ownershipRows(ndb, t2).filter((r) => r.layer_id === BASE_LAYER_ID && r.deleted === 0).length, 1);
        assert.equal(liveAttachmentRows(ndb, att), 1);
        // Строка слоя убрана (§8.4).
        assert.equal(
          (ndb.prepare('SELECT COUNT(*) AS c FROM attachment_owners WHERE layer_id = ?').get(layer) as { c: number }).c,
          0,
        );
      } finally {
        ndb.close();
      }
    });

    it('владение с неразрешимым вложением — набор не замкнут (missing_closure)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = randomUUID();
        seedThought(ndb, t, 'T');
        const layer = seedLayer(ndb);
        seedOwnership(ndb, { id: 'own-bad', layerId: layer, attachmentId: 'no-such-att', ownerId: t });

        const selection: MergeSelection = { attachment_owners: ['own-bad'] };
        let error: EtnError | undefined;
        try {
          mergeLayer(ndb, layer, selection, 'u');
        } catch (err) {
          error = err as EtnError;
        }
        assert.ok(error instanceof EtnError, 'ожидалась EtnError');
        assert.equal(error!.code, 'VALIDATION_ERROR');
        const missing = (error!.details as { missing_closure: Array<{ table: string; id: string }> })
          .missing_closure;
        assert.deepEqual(missing, [
          { table: 'attachments', id: 'no-such-att', referenced_by: { table: 'attachment_owners', id: 'own-bad' } },
        ]);
        // Слой не тронут: реплей не состоялся.
        assert.equal(
          (ndb.prepare('SELECT COUNT(*) AS c FROM attachment_owners WHERE layer_id = ?').get(layer) as { c: number }).c,
          1,
        );
      } finally {
        ndb.close();
      }
    });

    it('исчезновение вложения: нет живых владений — строка убрана, icon_attachment_id обнулён', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = randomUUID();
        const att = randomUUID();
        seedThought(ndb, t, 'T');
        seedAttachment(ndb, att);
        seedOwnership(ndb, { id: 'own-1', attachmentId: att, ownerId: t });
        ndb
          .prepare('UPDATE thoughts SET icon_attachment_id = ? WHERE id = ? AND layer_id = ?')
          .run(att, t, BASE_LAYER_ID);

        const layer = seedLayer(ndb);
        ndb.useLayer(layer);
        // Снятие последнего владения в слое — надгробие строки владельца.
        assert.equal(materializeTombstone(ndb, 'attachment_owners', 'own-1'), true);
        ndb.useLayer(BASE_LAYER_ID);

        const report = mergeLayer(ndb, layer, undefined, 'u');

        assert.equal(report.applied.attachment_owners, 1);
        // Вложение исчезло: живых владений не осталось ни в одном рабочем слое.
        assert.equal(liveAttachmentRows(ndb, att), 0);
        // Висячий указатель иконки обнулён.
        const icon = (
          ndb
            .prepare('SELECT icon_attachment_id FROM thoughts WHERE id = ? AND layer_id = ?')
            .get(t, BASE_LAYER_ID) as { icon_attachment_id: string | null }
        ).icon_attachment_id;
        assert.equal(icon, null);
      } finally {
        ndb.close();
      }
    });

    it('вложение с другим живым владельцем не исчезает и указатель не обнуляется', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = randomUUID();
        const t2 = randomUUID();
        const att = randomUUID();
        seedThought(ndb, t, 'T');
        seedThought(ndb, t2, 'T2');
        seedAttachment(ndb, att);
        seedOwnership(ndb, { id: 'own-1', attachmentId: att, ownerId: t });
        seedOwnership(ndb, { id: 'own-2', attachmentId: att, ownerId: t2 });
        ndb
          .prepare('UPDATE thoughts SET icon_attachment_id = ? WHERE id = ? AND layer_id = ?')
          .run(att, t, BASE_LAYER_ID);

        const layer = seedLayer(ndb);
        ndb.useLayer(layer);
        assert.equal(materializeTombstone(ndb, 'attachment_owners', 'own-1'), true);
        ndb.useLayer(BASE_LAYER_ID);

        mergeLayer(ndb, layer, undefined, 'u');

        // Живое владение own-2 удерживает вложение и указатель.
        assert.equal(liveAttachmentRows(ndb, att), 1);
        const icon = (
          ndb
            .prepare('SELECT icon_attachment_id FROM thoughts WHERE id = ? AND layer_id = ?')
            .get(t, BASE_LAYER_ID) as { icon_attachment_id: string | null }
        ).icon_attachment_id;
        assert.equal(icon, att);
      } finally {
        ndb.close();
      }
    });

    it('переходный период: вложение слоя по owner-колонкам едет с мыслью (mergeLayerThought), без висячего icon', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = randomUUID();
        const att = randomUUID();
        seedThought(ndb, t, 'T');

        const layer = seedLayer(ndb);
        ndb.useLayer(layer);
        // Доменный путь 0.12.1: вложение создано в слое с owner-колонками,
        // строк владений attachment_owners не появилось (их пишет только
        // миграция 050). Мысль ссылается на вложение как на иконку.
        seedAttachment(ndb, att, layer, 'thought', t);
        assert.equal(materializeShadow(ndb, 'thoughts', t), true);
        ndb
          .prepare('UPDATE thoughts SET icon_attachment_id = ? WHERE id = ? AND layer_id = ?')
          .run(att, t, layer);
        ndb.useLayer(BASE_LAYER_ID);

        mergeLayerThought(ndb, layer, t, 'overwrite', 'u');

        // Вложение доехало ДО ОСНОВЫ (а не осталось в слое)…
        assert.equal(attachmentRowsInLayer(ndb, att, BASE_LAYER_ID), 1);
        assert.equal(attachmentRowsInLayer(ndb, att, layer), 0);
        // …и потому указатель иконки мысли в основе разрешим (не висячий).
        const icon = (
          ndb
            .prepare('SELECT icon_attachment_id FROM thoughts WHERE id = ? AND layer_id = ?')
            .get(t, BASE_LAYER_ID) as { icon_attachment_id: string | null }
        ).icon_attachment_id;
        assert.equal(icon, att);
        assert.equal(attachmentRowsInLayer(ndb, att, BASE_LAYER_ID), 1);
      } finally {
        ndb.close();
      }
    });

    it('переходный период: отбрасывание мысли убирает вложение слоя по owner-колонкам, основу не трогает', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = randomUUID();
        const att = randomUUID();
        seedThought(ndb, t, 'T');

        const layer = seedLayer(ndb);
        ndb.useLayer(layer);
        seedAttachment(ndb, att, layer, 'thought', t);
        assert.equal(materializeShadow(ndb, 'thoughts', t), true);
        ndb
          .prepare('UPDATE thoughts SET icon_attachment_id = ? WHERE id = ? AND layer_id = ?')
          .run(att, t, layer);
        ndb.useLayer(BASE_LAYER_ID);

        const discarded = discardLayerThought(ndb, layer, t);

        assert.equal(discarded.discarded.attachments, 1);
        assert.equal(discarded.discarded.thoughts, 1);
        // В основе вложения нет и не было — отбрасывание его не создаёт.
        assert.equal(liveAttachmentRows(ndb, att), 0);
      } finally {
        ndb.close();
      }
    });

    it('исчезновение вложения обнуляет cover_attachment_id публикации', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const pub = randomUUID();
        const att = randomUUID();
        seedPublication(ndb, pub, 'Публикация', att);
        seedAttachment(ndb, att);
        seedOwnership(ndb, {
          id: 'own-pub',
          attachmentId: att,
          ownerId: pub,
          ownerType: 'publication',
        });

        const layer = seedLayer(ndb);
        ndb.useLayer(layer);
        assert.equal(materializeTombstone(ndb, 'attachment_owners', 'own-pub'), true);
        ndb.useLayer(BASE_LAYER_ID);

        mergeLayer(ndb, layer, undefined, 'u');

        assert.equal(liveAttachmentRows(ndb, att), 0);
        const cover = (
          ndb
            .prepare('SELECT cover_attachment_id FROM publications WHERE id = ? AND layer_id = ?')
            .get(pub, BASE_LAYER_ID) as { cover_attachment_id: string | null }
        ).cover_attachment_id;
        assert.equal(cover, null);
      } finally {
        ndb.close();
      }
    });

    it('исчезновение вложения с владением owner_type=link', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const att = randomUUID();
        seedAttachment(ndb, att);
        seedOwnership(ndb, {
          id: 'own-link',
          attachmentId: att,
          ownerId: randomUUID(),
          ownerType: 'link',
        });

        const layer = seedLayer(ndb);
        ndb.useLayer(layer);
        assert.equal(materializeTombstone(ndb, 'attachment_owners', 'own-link'), true);
        ndb.useLayer(BASE_LAYER_ID);

        mergeLayer(ndb, layer, undefined, 'u');

        assert.equal(liveAttachmentRows(ndb, att), 0);
      } finally {
        ndb.close();
      }
    });
  },
);
