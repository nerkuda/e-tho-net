/**
 * Unit tests for writing links through link-property values (0.8.1, задача
 * 2fe173c5): заполнение свойства-связи создаёт ребро без указания направления,
 * симметрия (прямое/обратное), инварианты рёбер, операции add/remove/set,
 * структурные «Родители»/«Потомки», удаление в корзину с сохранением
 * комментария.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EtnError } from '@etn/shared';
import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import {
  addLinkPropertyValue,
  computeThoughtCardWarnings,
  createNetworkProperty,
  createTypeProperty,
  getLinkPropertyValues,
  getPropertyValuesWithLinks,
  removeLinkPropertyValue,
  setPropertyValue,
} from '../src/domain/property-service.js';
import { createLinkType } from '../src/domain/link-type-service.js';
import { getLink } from '../src/domain/link-service.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { createThought } from '../src/domain/thought-service.js';

const USER = 'user-1';

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
  'link-property write (0.8.1)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('заполнение свойства-связи (set) создаёт ребро, направление из определения', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const lt = createLinkType(ndb, { name_forward: 'применяется к', name_reverse: 'регулируется из' }, USER);
        const req = createThoughtType(ndb, { name: 'Требование' }, USER);
        const comp = createThoughtType(ndb, { name: 'Компонент' }, USER);
        createTypeProperty(
          ndb, 'thought_type', req.id,
          { key: 'применяется к', value_type: 'link', config: { link_type_id: lt.id, direction: 'out' } },
          USER,
        );
        const r = createThought(ndb, { title: 'Требование 1', type_id: req.id }, USER);
        const c = createThought(ndb, { title: 'Компонент 1', type_id: comp.id }, USER);

        setPropertyValue(ndb, 'thought', r.id, 'применяется к', c.id, USER);
        const values = getLinkPropertyValues(ndb, 'thought', r.id, lt.id, 'out');
        assert.equal(values.length, 1);
        assert.equal(values[0]!.target_id, c.id);
      } finally {
        ndb.close();
      }
    });

    it('симметрия: заполнение обратного свойства создаёт то же ребро', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const lt = createLinkType(ndb, { name_forward: 'применяется к', name_reverse: 'регулируется из' }, USER);
        const req = createThoughtType(ndb, { name: 'ТребованиеS' }, USER);
        const comp = createThoughtType(ndb, { name: 'КомпонентS' }, USER);
        createTypeProperty(
          ndb, 'thought_type', req.id,
          { key: 'применяется к', value_type: 'link', config: { link_type_id: lt.id, direction: 'out' } },
          USER,
        );
        createTypeProperty(
          ndb, 'thought_type', comp.id,
          { key: 'регулируется из', value_type: 'link', config: { link_type_id: lt.id, direction: 'in' } },
          USER,
        );
        const r = createThought(ndb, { title: 'Требование S1', type_id: req.id }, USER);
        const c = createThought(ndb, { title: 'Компонент S1', type_id: comp.id }, USER);

        // Обратное свойство: компонент заполняет «регулируется из» требованием.
        setPropertyValue(ndb, 'thought', c.id, 'регулируется из', r.id, USER);
        const values = getLinkPropertyValues(ndb, 'thought', r.id, lt.id, 'out');
        assert.equal(values.length, 1);
        assert.equal(values[0]!.target_id, c.id);
        // То же ребро видно и с обратной стороны.
        const inValues = getLinkPropertyValues(ndb, 'thought', c.id, lt.id, 'in');
        assert.equal(inValues.length, 1);
        assert.equal(inValues[0]!.target_id, r.id);
      } finally {
        ndb.close();
      }
    });

    it('запрещает петлю', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const lt = createLinkType(ndb, { name_forward: 'см. также', name_reverse: 'см. также' }, USER);
        const tt = createThoughtType(ndb, { name: 'ПроектLoop' }, USER);
        createTypeProperty(
          ndb, 'thought_type', tt.id,
          { key: 'см. также', value_type: 'link', config: { link_type_id: lt.id, direction: 'out' } },
          USER,
        );
        const a = createThought(ndb, { title: 'A', type_id: tt.id }, USER);
        assert.throws(
          () => setPropertyValue(ndb, 'thought', a.id, 'см. также', a.id, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('проверяет allowed_target_type_ids при записи', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const lt = createLinkType(ndb, { name_forward: 'применяется к', name_reverse: 'регулируется из' }, USER);
        const req = createThoughtType(ndb, { name: 'ТребованиеT' }, USER);
        const comp = createThoughtType(ndb, { name: 'КомпонентT' }, USER);
        const other = createThoughtType(ndb, { name: 'ЗадачаT' }, USER);
        createTypeProperty(
          ndb, 'thought_type', req.id,
          { key: 'применяется к', value_type: 'link', config: { link_type_id: lt.id, direction: 'out', allowed_target_type_ids: [comp.id] } },
          USER,
        );
        const r = createThought(ndb, { title: 'Требование T1', type_id: req.id }, USER);
        const o = createThought(ndb, { title: 'Задача T1', type_id: other.id }, USER);
        assert.throws(
          () => setPropertyValue(ndb, 'thought', r.id, 'применяется к', o.id, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('add идемпотентен и пишет комментарий', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const lt = createLinkType(ndb, { name_forward: 'зависит от', name_reverse: 'используется в' }, USER);
        const task = createThoughtType(ndb, { name: 'ЗадачаA' }, USER);
        const comp = createThoughtType(ndb, { name: 'КомпонентA' }, USER);
        createTypeProperty(
          ndb, 'thought_type', task.id,
          { key: 'зависит от', value_type: 'link', config: { link_type_id: lt.id, direction: 'out' } },
          USER,
        );
        const a = createThought(ndb, { title: 'Задача A1', type_id: task.id }, USER);
        const b = createThought(ndb, { title: 'Компонент A1', type_id: comp.id }, USER);

        const first = addLinkPropertyValue(ndb, 'thought', a.id, 'зависит от', b.id, 'нужен для сборки', USER);
        assert.equal(first.created, true);
        const second = addLinkPropertyValue(ndb, 'thought', a.id, 'зависит от', b.id, null, USER);
        assert.equal(second.created, false);
        assert.equal(second.link_id, first.link_id);

        const values = getLinkPropertyValues(ndb, 'thought', a.id, lt.id, 'out');
        assert.equal(values.length, 1);
        assert.equal(values[0]!.comment, 'нужен для сборки');
      } finally {
        ndb.close();
      }
    });

    it('remove помечает ребро в корзину и не теряет комментарий', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const lt = createLinkType(ndb, { name_forward: 'зависит от', name_reverse: 'используется в' }, USER);
        const task = createThoughtType(ndb, { name: 'ЗадачаR' }, USER);
        const comp = createThoughtType(ndb, { name: 'КомпонентR' }, USER);
        createTypeProperty(
          ndb, 'thought_type', task.id,
          { key: 'зависит от', value_type: 'link', config: { link_type_id: lt.id, direction: 'out' } },
          USER,
        );
        const a = createThought(ndb, { title: 'Задача R1', type_id: task.id }, USER);
        const b = createThought(ndb, { title: 'Компонент R1', type_id: comp.id }, USER);

        const { link_id } = addLinkPropertyValue(ndb, 'thought', a.id, 'зависит от', b.id, 'важно', USER);
        removeLinkPropertyValue(ndb, 'thought', a.id, 'зависит от', b.id, USER);

        // Ребро не видно в значениях, но физически в корзине с сохранённым комментарием.
        assert.equal(getLinkPropertyValues(ndb, 'thought', a.id, lt.id, 'out').length, 0);
        const link = getLink(ndb, link_id);
        assert.ok(link !== null && link.marked_for_deletion === true);
      } finally {
        ndb.close();
      }
    });

    it('set — полная замена набора, лишние рёбра в корзину', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const lt = createLinkType(ndb, { name_forward: 'зависит от', name_reverse: 'используется в' }, USER);
        const task = createThoughtType(ndb, { name: 'ЗадачаSet' }, USER);
        const comp = createThoughtType(ndb, { name: 'КомпонентSet' }, USER);
        createTypeProperty(
          ndb, 'thought_type', task.id,
          { key: 'зависит от', value_type: 'link', config: { link_type_id: lt.id, direction: 'out' } },
          USER,
        );
        const a = createThought(ndb, { title: 'Задача Set1', type_id: task.id }, USER);
        const b = createThought(ndb, { title: 'Компонент Set1', type_id: comp.id }, USER);
        const c = createThought(ndb, { title: 'Компонент Set2', type_id: comp.id }, USER);

        setPropertyValue(ndb, 'thought', a.id, 'зависит от', [b.id, c.id], USER);
        assert.equal(getLinkPropertyValues(ndb, 'thought', a.id, lt.id, 'out').length, 2);

        setPropertyValue(ndb, 'thought', a.id, 'зависит от', [b.id], USER);
        const values = getLinkPropertyValues(ndb, 'thought', a.id, lt.id, 'out');
        assert.equal(values.length, 1);
        assert.equal(values[0]!.target_id, b.id);
      } finally {
        ndb.close();
      }
    });

    it('структурные «Родители»/«Потомки» есть у каждой мысли и не обязательны', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'Раздел' }, USER);
        const parent = createThought(ndb, { title: 'Родитель', type_id: tt.id }, USER);
        const child = createThought(ndb, { title: 'Ребёнок', type_id: tt.id }, USER);

        // Не обязательны: у корневой мысли родителей нет — предупреждений нет.
        assert.deepEqual(computeThoughtCardWarnings(ndb, parent.id), []);

        // Запись через «Потомки» создаёт структурное ребро.
        setPropertyValue(ndb, 'thought', parent.id, 'Потомки', [child.id], USER);
        const values = getPropertyValuesWithLinks(ndb, 'thought', parent.id);
        const potomki = values.find(
          (v) => v.value_type === 'link' && 'values' in v && v.property_name === 'Потомки',
        ) as { values: Array<{ target_id: string }> } | undefined;
        assert.ok(potomki !== undefined);
        assert.deepEqual(potomki.values.map((v) => v.target_id), [child.id]);
      } finally {
        ndb.close();
      }
    });
  },
);

/**
 * Направление ЗАПИСИ свойства-связи по стороне привязки владельца (0.8.2, ошибка
 * c67676f3): свойство привязано источником к одному типу и назначением к
 * другому; заполнение у цели обязано создать ребро значение → владелец, чтобы
 * прочитаться тем же свойством (а не лечь в обратную сторону).
 */
describe(
  'link-property write direction by owner binding side (0.8.2, c67676f3)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    /** Живые типизированные рёбра сети — для проверки направления. */
    function liveTypedEdges(
      ndb: NetworkDb,
      linkTypeId: string,
    ): Array<{ source_id: string; target_id: string }> {
      return ndb
        .prepare(
          `SELECT source_id, target_id FROM links_v
            WHERE type_id = ? AND active = 1 AND marked_for_deletion = 0
            ORDER BY source_id, target_id`,
        )
        .all(linkTypeId) as Array<{ source_id: string; target_id: string }>;
    }

    /** Карточка: свойство-связь по имени с его значениями. */
    function findLinkValues(
      ndb: NetworkDb,
      thoughtId: string,
      propertyName: string,
    ): Array<{ target_id: string }> | undefined {
      const found = getPropertyValuesWithLinks(ndb, 'thought', thoughtId).find(
        (v) => v.value_type === 'link' && 'values' in v && v.property_name === propertyName,
      );
      return found !== undefined && 'values' in found
        ? (found.values as Array<{ target_id: string }>).map((v) => ({ target_id: v.target_id }))
        : undefined;
    }

    /**
     * Свойство «организации категории / категория организации»: тип источника
     * «Категория» привязан стороной source, тип назначения «Организация» —
     * стороной target. Третий тип к свойству не привязан.
     */
    function seedCategoryOrg(ndb: NetworkDb) {
      const category = createThoughtType(ndb, { name: 'Категория-тип' }, USER);
      const org = createThoughtType(ndb, { name: 'Организация-тип' }, USER);
      const other = createThoughtType(ndb, { name: 'Прочее-тип' }, USER);
      const prop = createNetworkProperty(
        ndb,
        {
          name: 'организации категории',
          value_type: 'link',
          name_forward: 'организации категории',
          name_reverse: 'категория организации',
        },
        USER,
      );
      const linkTypeId = (prop.config?.link_type_id ?? '') as string;
      createTypeProperty(
        ndb,
        'thought_type',
        category.id,
        { key: 'организации категории', value_type: 'link', side: 'source' },
        USER,
      );
      createTypeProperty(
        ndb,
        'thought_type',
        org.id,
        { key: 'организации категории', value_type: 'link', side: 'target' },
        USER,
      );
      return { category, org, other, linkTypeId };
    }

    it('со стороны source: ребро владелец → значение, видно с обеих сторон', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { category, org, linkTypeId } = seedCategoryOrg(ndb);
        const c = createThought(ndb, { title: 'Медицина', type_id: category.id }, USER);
        const o = createThought(ndb, { title: 'Поликлиника', type_id: org.id }, USER);

        setPropertyValue(ndb, 'thought', c.id, 'организации категории', o.id, USER);

        assert.deepEqual(liveTypedEdges(ndb, linkTypeId), [{ source_id: c.id, target_id: o.id }]);
        const catVals = getLinkPropertyValues(ndb, 'thought', c.id, linkTypeId, 'out');
        assert.equal(catVals.length, 1);
        assert.equal(catVals[0]!.target_id, o.id);
        // Обратная сторона тоже прочитывает то же ребро.
        assert.deepEqual(findLinkValues(ndb, o.id, 'категория организации'), [{ target_id: c.id }]);
      } finally {
        ndb.close();
      }
    });

    it('со стороны target: ребро значение → владелец, значение читается этим же свойством', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { category, org, linkTypeId } = seedCategoryOrg(ndb);
        const c = createThought(ndb, { title: 'Медицина 2', type_id: category.id }, USER);
        const o = createThought(ndb, { title: 'Поликлиника 2', type_id: org.id }, USER);

        // Заполняем свойство У ОРГАНИЗАЦИИ (владелец — цель привязки).
        setPropertyValue(ndb, 'thought', o.id, 'категория организации', c.id, USER);

        // Ребро обязано лечь категория → организация (значение → владелец).
        assert.deepEqual(liveTypedEdges(ndb, linkTypeId), [{ source_id: c.id, target_id: o.id }]);
        // И прочитаться этим же свойством у организации.
        assert.deepEqual(findLinkValues(ndb, o.id, 'категория организации'), [{ target_id: c.id }]);
        const inVals = getLinkPropertyValues(ndb, 'thought', o.id, linkTypeId, 'in');
        assert.equal(inVals.length, 1);
        assert.equal(inVals[0]!.target_id, c.id);
      } finally {
        ndb.close();
      }
    });

    it('повторное заполнение target-стороны идемпотентно (значение не теряется)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { category, org, linkTypeId } = seedCategoryOrg(ndb);
        const c = createThought(ndb, { title: 'Медицина 3', type_id: category.id }, USER);
        const o = createThought(ndb, { title: 'Поликлиника 3', type_id: org.id }, USER);

        setPropertyValue(ndb, 'thought', o.id, 'категория организации', c.id, USER);
        setPropertyValue(ndb, 'thought', o.id, 'категория организации', c.id, USER);
        assert.deepEqual(liveTypedEdges(ndb, linkTypeId), [{ source_id: c.id, target_id: o.id }]);
        assert.deepEqual(findLinkValues(ndb, o.id, 'категория организации'), [{ target_id: c.id }]);
      } finally {
        ndb.close();
      }
    });

    it('валидация значений — по противоположной стороне привязки', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { category, org, other } = seedCategoryOrg(ndb);
        const c = createThought(ndb, { title: 'Медицина 4', type_id: category.id }, USER);
        const o = createThought(ndb, { title: 'Поликлиника 4', type_id: org.id }, USER);
        const x = createThought(ndb, { title: 'Прочее 4', type_id: other.id }, USER);

        // Владелец target принимает только источники (Категория) — «Прочее» отвергается.
        assert.throws(
          () => setPropertyValue(ndb, 'thought', o.id, 'категория организации', x.id, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
        // Владелец source принимает только цели (Организация) — «Прочее» отвергается.
        assert.throws(
          () => setPropertyValue(ndb, 'thought', c.id, 'организации категории', x.id, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
        // Правильная сторона проходит.
        setPropertyValue(ndb, 'thought', o.id, 'категория организации', c.id, USER);
      } finally {
        ndb.close();
      }
    });

    it('remove находит ребро с обеих сторон', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { category, org, linkTypeId } = seedCategoryOrg(ndb);
        const c1 = createThought(ndb, { title: 'Медицина 5', type_id: category.id }, USER);
        const o1 = createThought(ndb, { title: 'Поликлиника 5', type_id: org.id }, USER);
        const c2 = createThought(ndb, { title: 'Медицина 6', type_id: category.id }, USER);
        const o2 = createThought(ndb, { title: 'Поликлиника 6', type_id: org.id }, USER);

        // Ребро создано со стороны source; удаляем со стороны target.
        const first = addLinkPropertyValue(
          ndb, 'thought', c1.id, 'организации категории', o1.id, null, USER,
        );
        const removed = removeLinkPropertyValue(
          ndb, 'thought', o1.id, 'категория организации', c1.id, USER,
        );
        assert.equal(removed.link_id, first.link_id);

        // Ребро создано со стороны target; удаляем со стороны source.
        const second = addLinkPropertyValue(
          ndb, 'thought', o2.id, 'категория организации', c2.id, null, USER,
        );
        const removed2 = removeLinkPropertyValue(
          ndb, 'thought', c2.id, 'организации категории', o2.id, USER,
        );
        assert.equal(removed2.link_id, second.link_id);

        assert.deepEqual(liveTypedEdges(ndb, linkTypeId), []);
        assert.equal(getLink(ndb, first.link_id)?.marked_for_deletion, true);
        assert.equal(getLink(ndb, second.link_id)?.marked_for_deletion, true);
      } finally {
        ndb.close();
      }
    });
  },
);
