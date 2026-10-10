/**
 * Слоевая видимость realtime-событий ВЛАДЕНИЙ вложения (0.12.1, задача
 * f77382ba, `server/src/realtime/layer-visibility.ts`).
 *
 * До этого теста ветка `extractRowRef` для `attachment.owner.added`/`removed`
 * была покрыта только чтением кода. Здесь — протокольные пробы через публичный
 * `isEventVisibleInLayer` на реальном слоевом контексте (`layer_chain`):
 *
 *  - владение, добавленное в СЛОЕ, видно подписчику слоя и невидимо основе;
 *  - удаление владельца в ОСНОВЕ с физическим удалением строки доставляется
 *    подписчику слоя (`visibleWhenMissing` у `attachment.owner.removed`) —
 *    подписчик должен узнать, что владение исчезло;
 *  - для `attachment.owner.added` отсутствие строки НЕ доставляется;
 *  - надгробие владения в слое перекрывает событие основы (не доставляется).
 *
 * Пропускается, когда нативная сборка `better-sqlite3` недоступна.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID, type AnyRealtimeEvent } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { isEventVisibleInLayer } from '../src/realtime/layer-visibility.js';

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

/** Слой-потомок указанного родителя. */
function seedLayer(ndb: NetworkDb, parentId: string, depth: number): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
       VALUES (?, ?, 'Слой', 0, ?, 'u', ?, ?)`,
    )
    .run(id, parentId, depth, now, now);
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

/** Одна строка владения (attachment_owners) напрямую. */
function seedOwnership(ndb: NetworkDb, args: {
  id: string;
  layerId: string;
  attachmentId: string;
  ownerId: string;
  position?: number;
}): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO attachment_owners (id, layer_id, deleted, base_version, attachment_id,
         owner_type, owner_id, position, created_at, created_by)
       VALUES (?, ?, 0, 0, ?, 'thought', ?, ?, ?, 'u')`,
    )
    .run(args.id, args.layerId, args.attachmentId, args.ownerId, args.position ?? 0, now);
}

/** Real-time-событие владения вложения. */
function ownerEvent(
  type: 'attachment.owner.added' | 'attachment.owner.removed',
  layerId: string,
  data: { attachment_id: string; owner_type: string; owner_id: string },
): AnyRealtimeEvent {
  return {
    type,
    seq: 1,
    ts: '2026-01-01T00:00:00.000Z',
    actor: { user_id: 'u2', client_id: 'c2' },
    network_id: 'n1',
    audience: 'network',
    layer_id: layerId,
    data,
  } as unknown as AnyRealtimeEvent;
}

describe(
  'слоевая видимость событий владений вложения (f77382ba)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('владение, добавленное в слое, видно слою и не видно основе', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const att = randomUUID();
        seedAttachment(ndb, BASE_LAYER_ID, att);
        const child = seedLayer(ndb, BASE_LAYER_ID, 1);
        ndb.useLayer(child);
        seedOwnership(ndb, { id: 'own-layer', layerId: child, attachmentId: att, ownerId: 'owner-c' });
        const evt = ownerEvent('attachment.owner.added', child, {
          attachment_id: att,
          owner_type: 'thought',
          owner_id: 'owner-c',
        });

        // Свой слой — fast path (layer_id события = слой подписчика).
        assert.equal(isEventVisibleInLayer(ndb, evt, child), true, 'слой видит своё владение');

        // Основа: строки слоя нет в её цепочке — не доставляем.
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(
          isEventVisibleInLayer(ndb, evt, BASE_LAYER_ID),
          false,
          'основа не видит владение слоя',
        );
      } finally {
        ndb.close();
      }
    });

    it('removed в основе с физическим удалением строки доставляется слою (visibleWhenMissing)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const att = randomUUID();
        seedAttachment(ndb, BASE_LAYER_ID, att);
        seedOwnership(ndb, { id: 'own-1', layerId: BASE_LAYER_ID, attachmentId: att, ownerId: 'owner-1' });
        const child = seedLayer(ndb, BASE_LAYER_ID, 1);

        // Снятие владения в ОСНОВЕ физически удаляет строку.
        ndb.useLayer(BASE_LAYER_ID);
        ndb.prepare('DELETE FROM attachment_owners WHERE id = ?').run('own-1');

        ndb.useLayer(child);
        const removed = ownerEvent('attachment.owner.removed', BASE_LAYER_ID, {
          attachment_id: att,
          owner_type: 'thought',
          owner_id: 'owner-1',
        });
        assert.equal(
          isEventVisibleInLayer(ndb, removed, child),
          true,
          'removed без строки в цепочке — доставляется (visibleWhenMissing)',
        );

        // Контроль: тот же отсутствующий id, но событие ДОБАВЛЕНИЯ — не доставляется.
        const added = ownerEvent('attachment.owner.added', BASE_LAYER_ID, {
          attachment_id: att,
          owner_type: 'thought',
          owner_id: 'owner-1',
        });
        assert.equal(
          isEventVisibleInLayer(ndb, added, child),
          false,
          'added без строки в цепочке — не доставляется',
        );
      } finally {
        ndb.close();
      }
    });

    it('надгробие владения в слое перекрывает событие основы', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const att = randomUUID();
        seedAttachment(ndb, BASE_LAYER_ID, att);
        seedOwnership(ndb, { id: 'own-1', layerId: BASE_LAYER_ID, attachmentId: att, ownerId: 'owner-1' });
        const evt = ownerEvent('attachment.owner.added', BASE_LAYER_ID, {
          attachment_id: att,
          owner_type: 'thought',
          owner_id: 'owner-1',
        });

        // Без перекрытия событие основы видно потомку.
        const clean = seedLayer(ndb, BASE_LAYER_ID, 1);
        ndb.useLayer(clean);
        assert.equal(isEventVisibleInLayer(ndb, evt, clean), true, 'чистый потомок видит событие основы');

        // Потомок «удалил» это владение (надгробие) — событие основы не течёт.
        const overriding = seedLayer(ndb, BASE_LAYER_ID, 1);
        ndb.useLayer(overriding);
        ndb
          .prepare(
            `INSERT INTO attachment_owners (id, layer_id, deleted, base_version, attachment_id,
               owner_type, owner_id, position, created_at, created_by)
             VALUES ('own-1', ?, 1, 0, ?, 'thought', 'owner-1', 0, ?, 'u')`,
          )
          .run(overriding, att, new Date().toISOString());
        assert.equal(
          isEventVisibleInLayer(ndb, evt, overriding),
          false,
          'надгробие слоя перекрывает событие основы',
        );
      } finally {
        ndb.close();
      }
    });
  },
);
