/**
 * Дефолты свойств-связей по сторонам привязки (0.8.2, задача eb24beed, ADR
 * «дефолт свойства живёт на привязке, общие значения — по сторонам связи»).
 *
 * Проверяет: приёмочный пример тех.проекта; дефолт на собственной привязке;
 * применение target-стороны каноническими рёбрами; пустой override → общее
 * значение стороны; отсутствие транзитивности; валидацию target-дефолта
 * (существование без отбора по типам) и запрет ключа у скаляра.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EtnError } from '@etn/shared';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import {
  createNetworkProperty,
  createTypeProperty,
  listEffectiveTypeProperties,
  setTypePropertyDefaultOverride,
  updateNetworkProperty,
} from '../src/domain/property-service.js';
import { createThought } from '../src/domain/thought-service.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';

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

const USER = 'user-1';

/** Живые рёбра типа `linkTypeId`, инцидентные мысли `thoughtId`. */
function incidentEdges(
  ndb: NetworkDb,
  linkTypeId: string,
  thoughtId: string,
): Array<{ source_id: string; target_id: string }> {
  return ndb
    .prepare(
      `SELECT source_id, target_id FROM links_v
        WHERE type_id = ? AND active = 1 AND marked_for_deletion = 0
          AND (source_id = ? OR target_id = ?)`,
    )
    .all(linkTypeId, thoughtId, thoughtId) as Array<{ source_id: string; target_id: string }>;
}

describe(
  'link-property defaults by binding side (0.8.2)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    /**
     * Каркас примера тех.проекта: свойство-связь «версия → работы версии»,
     * привязанное источником к задаче/ошибке/техпроекту и назначением к версии.
     * Возвращает типы, id свойства и link-типа.
     */
    function seedVersionLink(ndb: NetworkDb) {
      const task = createThoughtType(ndb, { name: 'Задача-тип' }, USER);
      const err = createThoughtType(ndb, { name: 'Ошибка-тип' }, USER);
      const project = createThoughtType(ndb, { name: 'Техпроект-тип' }, USER);
      const version = createThoughtType(ndb, { name: 'Версия-тип' }, USER);

      const prop = createNetworkProperty(
        ndb,
        {
          name: 'запланировано в версию',
          value_type: 'link',
          name_forward: 'запланировано в версию',
          name_reverse: 'включает работы',
        },
        USER,
      );
      const linkTypeId = (prop.config?.link_type_id ?? '') as string;
      assert.ok(linkTypeId !== '', 'свойство-связь получило тип связи');

      // Источники: задача, ошибка, техпроект — собственные привязки стороны source.
      for (const typeId of [task.id, err.id, project.id]) {
        createTypeProperty(ndb, 'thought_type', typeId, {
          key: 'запланировано в версию',
          value_type: 'link',
          side: 'source',
        }, USER);
      }
      // Назначение: версия — привязка стороны target.
      createTypeProperty(ndb, 'thought_type', version.id, {
        key: 'запланировано в версию',
        value_type: 'link',
        side: 'target',
      }, USER);

      return { task, err, project, version, prop, linkTypeId };
    }

    it('воспроизводит приёмочный пример тех.проекта (задача → версия, ошибка → пусто, версия → три задачи)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { task, err, version, prop, linkTypeId } = seedVersionLink(ndb);

        const version99 = createThought(ndb, { title: 'Версия 99.99.99', type_id: version.id }, USER);
        const t1 = createThought(ndb, { title: 'Подготовить репозиторий', type_id: task.id }, USER);
        const t2 = createThought(ndb, { title: 'Подготовить данные для тестирования', type_id: task.id }, USER);
        const t3 = createThought(ndb, { title: 'Проверить запланированные работы', type_id: task.id }, USER);

        // Источники: задача — 99.99.99, техпроект — 99.99.99, ошибка — пусто;
        // общее источников — пусто.
        setTypePropertyDefaultOverride(ndb, 'thought_type', task.id, prop.id, [version99.id], USER);
        setTypePropertyDefaultOverride(ndb, 'thought_type', version.id, prop.id, [t1.id, t2.id, t3.id], USER);

        // Эффективный список источника отдаёт override, назначения — набор источников.
        const taskEff = listEffectiveTypeProperties(ndb, 'thought_type', task.id).find(
          (d) => d.property_id === prop.id,
        )!;
        assert.deepEqual(taskEff.default_value, [version99.id]);
        assert.equal(taskEff.overridden_here, true);
        const versionEff = listEffectiveTypeProperties(ndb, 'thought_type', version.id).find(
          (d) => d.property_id === prop.id,
        )!;
        assert.deepEqual(versionEff.default_value, [t1.id, t2.id, t3.id]);
        assert.equal(versionEff.side, 'target');

        // Новая задача → ребро задача → версия 99.99.99.
        const newTask = createThought(ndb, { title: 'Новая задача', type_id: task.id }, USER);
        assert.deepEqual(incidentEdges(ndb, linkTypeId, newTask.id), [
          { source_id: newTask.id, target_id: version99.id },
        ]);

        // Новая ошибка → рёбер нет (пустой дефолт, общее источников пусто).
        const newErr = createThought(ndb, { title: 'Новая ошибка', type_id: err.id }, USER);
        assert.deepEqual(incidentEdges(ndb, linkTypeId, newErr.id), []);

        // Новая версия → три канонических ребра источник → новая мысль.
        const newVersion = createThought(ndb, { title: 'Новая версия', type_id: version.id }, USER);
        const versionEdgeKeys = incidentEdges(ndb, linkTypeId, newVersion.id)
          .map((e) => `${e.source_id}->${e.target_id}`)
          .sort();
        const expectedEdgeKeys = [t1.id, t2.id, t3.id]
          .map((src) => `${src}->${newVersion.id}`)
          .sort();
        assert.deepEqual(versionEdgeKeys, expectedEdgeKeys);
      } finally {
        ndb.close();
      }
    });

    it('пустой override берёт общее значение стороны, а не дефолт предка', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const parent = createThoughtType(ndb, { name: 'Родитель-тип' }, USER);
        const child = createThoughtType(ndb, { name: 'Потомок-тип', parent_id: parent.id }, USER);
        const target = createThoughtType(ndb, { name: 'Цель-тип' }, USER);

        const prop = createNetworkProperty(
          ndb,
          {
            name: 'ссылается на',
            value_type: 'link',
            name_forward: 'ссылается на',
            name_reverse: 'упоминается в',
            config: { default_value: [] },
          },
          USER,
        );
        const linkTypeId = (prop.config?.link_type_id ?? '') as string;
        createTypeProperty(ndb, 'thought_type', parent.id, {
          key: 'ссылается на',
          value_type: 'link',
          side: 'source',
        }, USER);
        void target;

        const commonTarget = createThought(ndb, { title: 'Общая цель' }, USER);
        // Общее значение стороны источников (пустое → зададим явно).
        updateNetworkProperty(ndb, prop.id, { config: { ...(prop.config ?? {}), default_value: [commonTarget.id] } }, USER);
        // У родителя — свой override, у потомка своей строки нет.
        const parentTarget = createThought(ndb, { title: 'Цель родителя' }, USER);
        setTypePropertyDefaultOverride(ndb, 'thought_type', parent.id, prop.id, [parentTarget.id], USER);

        const childEff = listEffectiveTypeProperties(ndb, 'thought_type', child.id).find(
          (d) => d.property_id === prop.id,
        )!;
        assert.deepEqual(childEff.default_value, [commonTarget.id], 'потомок видит общее, а не дефолт предка');
        assert.equal(childEff.overridden_here, false);

        // Применение на потомке — ребро к общей цели, не к цели родителя.
        const newChild = createThought(ndb, { title: 'Новый потомок', type_id: child.id }, USER);
        assert.deepEqual(incidentEdges(ndb, linkTypeId, newChild.id), [
          { source_id: newChild.id, target_id: commonTarget.id },
        ]);
      } finally {
        ndb.close();
      }
    });

    it('target-дефолт валидируется по существованию без отбора allowed_target_type_ids', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const source = createThoughtType(ndb, { name: 'Источник-тип' }, USER);
        const target = createThoughtType(ndb, { name: 'Назначение-тип' }, USER);

        const prop = createNetworkProperty(
          ndb,
          {
            name: 'связано с',
            value_type: 'link',
            name_forward: 'связано с',
            name_reverse: 'связано с (обратно)',
          },
          USER,
        );
        const linkTypeId = (prop.config?.link_type_id ?? '') as string;
        createTypeProperty(ndb, 'thought_type', source.id, {
          key: 'связано с',
          value_type: 'link',
          side: 'source',
        }, USER);
        createTypeProperty(ndb, 'thought_type', target.id, {
          key: 'связано с',
          value_type: 'link',
          side: 'target',
        }, USER);
        // Ограничение цели: только тип назначения.
        updateNetworkProperty(ndb, prop.id, {
          config: { ...(prop.config ?? {}), allowed_target_type_ids: [target.id] },
        }, USER);

        // Источник — мысль типа source, он НЕ проходит allowed_target_type_ids как
        // цель, но для target-дефолта это допустимо (значения — сторона источников).
        const srcThought = createThought(ndb, { title: 'Мысль-источник', type_id: source.id }, USER);
        setTypePropertyDefaultOverride(ndb, 'thought_type', target.id, prop.id, [srcThought.id], USER);

        const newTarget = createThought(ndb, { title: 'Новая цель', type_id: target.id }, USER);
        assert.deepEqual(incidentEdges(ndb, linkTypeId, newTarget.id), [
          { source_id: srcThought.id, target_id: newTarget.id },
        ]);

        // Несуществующий id в target-дефолте отвергается.
        assert.throws(
          () =>
            setTypePropertyDefaultOverride(
              ndb,
              'thought_type',
              target.id,
              prop.id,
              ['00000000-0000-4000-8000-0000000000ff'],
              USER,
            ),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('config.default_value_target: валиден для связи, отвергается у скаляра, проверяет существование', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const target = createThoughtType(ndb, { name: 'Тип-цель' }, USER);
        const someThought = createThought(ndb, { title: 'Мысль', type_id: target.id }, USER);

        const prop = createNetworkProperty(
          ndb,
          { name: 'связь-дефолт', value_type: 'link', name_forward: 'связь-дефолт', name_reverse: 'обратно-связь-дефолт' },
          USER,
        );
        const updated = updateNetworkProperty(ndb, prop.id, {
          config: { ...(prop.config ?? {}), default_value_target: [someThought.id] },
        }, USER);
        assert.deepEqual(updated.config?.default_value_target, [someThought.id]);

        // Несуществующий id — 422.
        assert.throws(
          () =>
            updateNetworkProperty(ndb, prop.id, {
              config: { ...(prop.config ?? {}), default_value_target: ['nope'] },
            }, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );

        // У скалярного свойства ключ недопустим.
        const scalar = createNetworkProperty(ndb, { name: 'скаляр-без-target', value_type: 'text' }, USER);
        assert.throws(
          () =>
            updateNetworkProperty(ndb, scalar.id, {
              config: { default_value_target: [someThought.id] },
            }, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
        assert.throws(
          () =>
            createNetworkProperty(ndb, {
              name: 'скаляр-с-target',
              value_type: 'text',
              config: { default_value_target: [someThought.id] },
            }, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });
  },
);
