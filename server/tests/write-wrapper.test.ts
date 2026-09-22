/**
 * Обёртка записи домена `runWrite` (ADR 162d8e7a, задача 8b2efe2d,
 * веха 9 версии 0.8.2; требование 3269a025 «Очистка корзины атомарна»,
 * ошибка ac8a684b).
 *
 * Два свойства обёртки, которые раньше зависели от дисциплины вызывающего:
 *   1. атомарность: сбой посреди изменения откатывает его целиком —
 *      сбой посреди очистки корзины не оставляет частичного удаления;
 *   2. порядок «сначала коммит, потом эффекты»: событие/журнал/аудит
 *      о невыполненной записи уйти не могут, а данные эффектов берутся
 *      из результата записи.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EtnError } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { createThought, getThought, updateThought } from '../src/domain/thought-service.js';
import { listTrash, purgeTrash } from '../src/domain/trash-service.js';
import { runWrite, type WriteFx } from '../src/domain/write-wrapper.js';
import { listActivity } from '../src/domain/activity-service.js';

/** Фейковый транспорт фасада: собирает события и аудит в списки. */
function spyFx(): WriteFx & {
  emitted: Array<{ type: string; data: unknown }>;
  audited: unknown[];
} {
  const emitted: Array<{ type: string; data: unknown }> = [];
  const audited: unknown[] = [];
  return {
    networkId: 'test-net',
    userId: 'u1',
    layerId: null,
    emit: (type, data) => {
      emitted.push({ type, data });
    },
    audit: (entry) => {
      audited.push(entry);
    },
    emitted,
    audited,
  };
}

describe('runWrite: обёртка записи домена (транзакция → событие → журнал → аудит)', () => {
  it('успешная запись: события, журнал и аудит исполняются после коммита, из результата', () => {
    const ndb: NetworkDb = createInMemoryNetworkDb();
    try {
      const fx = spyFx();
      const thought = runWrite(ndb, fx, () => {
        const created = createThought(ndb, { title: 'Обёрнутая мысль' }, 'u1');
        return {
          result: created,
          events: [{ type: 'thought.created', data: { thought: created } }],
          activity: [{ kind: 'thought', action: 'created', thought: created }],
          audit: {
            action: 'etn.test.write',
            targetType: 'thought',
            targetId: created.id,
            details: { title: created.title },
          },
        };
      });
      assert.equal(thought.title, 'Обёрнутая мысль');
      assert.equal(fx.emitted.length, 1);
      assert.equal(fx.emitted[0]!.type, 'thought.created');
      assert.equal(fx.audited.length, 1);

      const activity = listActivity(ndb, { networkId: 'test-net' });
      assert.equal(activity.total, 1);
      assert.equal(activity.data[0]!.entity_id, thought.id);
      assert.equal(activity.data[0]!.action, 'created');
    } finally {
      ndb.close();
    }
  });

  it('сбой внутри записи откатывает её целиком: событие, журнал и аудит о невыполненной записи уйти не могут', () => {
    const ndb: NetworkDb = createInMemoryNetworkDb();
    try {
      const fx = spyFx();
      assert.throws(
        () =>
          runWrite(ndb, fx, () => {
            // Мутация уже случилась внутри транзакции…
            const created = createThought(ndb, { title: 'Откаченная мысль' }, 'u1');
            // …но проход обрывается до возврата исхода.
            throw new EtnError('INTERNAL', 'сбой посреди записи', { id: created.id });
          }),
        /сбой посреди записи/,
      );
      // Мысль не создана — транзакция откатилась.
      const leftovers = ndb
        .prepare("SELECT COUNT(*) AS c FROM thoughts_v WHERE title = 'Откаченная мысль'")
        .get() as { c: number };
      assert.equal(leftovers.c, 0);
      // Ни одного эффекта: событие/журнал/аудит исполняются только после коммита.
      assert.equal(fx.emitted.length, 0);
      assert.equal(fx.audited.length, 0);
      assert.equal(listActivity(ndb, { networkId: 'test-net' }).total, 0);
    } finally {
      ndb.close();
    }
  });

  it('purgeTrash: сбой посреди очистки корзины не оставляет частичного удаления (ac8a684b)', () => {
    const ndb: NetworkDb = createInMemoryNetworkDb();
    try {
      // Две помеченные мысли; вторая — защищённая строка, удаление которой
      // обрывает проход (PROTECTED_ENTITY) ПОСЛЕ успешного удаления первой.
      const a = createThought(ndb, { title: 'A: удаляется первой' }, 'u1');
      const b = createThought(ndb, { title: 'B: обрывает проход' }, 'u1');
      updateThought(ndb, a.id, { marked_for_deletion: true }, undefined, 'u1');
      updateThought(ndb, b.id, { marked_for_deletion: true }, undefined, 'u1');
      // Инъекция сбоя: пометка строки защищённой мимо доменного API —
      // проверка `is_protected` в deleteThought бросит посреди прохода.
      ndb.prepare('UPDATE thoughts SET is_protected = 1 WHERE id = ?').run(b.id);

      const fx = spyFx();
      assert.throws(
        () => runWrite(ndb, fx, () => purgeTrash(ndb)),
        /protected thoughts cannot be deleted/,
      );

      // Частичного удаления нет: обе строки на месте и всё ещё в корзине.
      assert.notEqual(getThought(ndb, a.id), null);
      assert.notEqual(getThought(ndb, b.id), null);
      const trash = listTrash(ndb);
      assert.equal(trash.thoughts.length, 2);

      // События и журнал о невыполненной очистке не публиковались.
      assert.equal(fx.emitted.length, 0);
      assert.equal(fx.audited.length, 0);
      assert.equal(listActivity(ndb, { networkId: 'test-net' }).total, 0);

      // Контроль: после снятия инъекции та же корзина очищается целиком.
      ndb.prepare('UPDATE thoughts SET is_protected = 0 WHERE id = ?').run(b.id);
      const swept = runWrite(ndb, fx, () => purgeTrash(ndb));
      assert.deepEqual({ purged: swept.purged, skipped: swept.skipped }, { purged: 2, skipped: 0 });
      assert.equal(fx.emitted.length, 2); // два thought.deleted
    } finally {
      ndb.close();
    }
  });
});
