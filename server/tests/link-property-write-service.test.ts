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
