/**
 * Unit tests for the link-property value type (0.8.1, задача c0b729cb):
 * определение свойства-связи в реестре, уникальность пары (тип связи +
 * направление), имя из типа связи по направлению, проекция рёбер в свойства
 * при чтении (счётчики в карточке, рёбра в запросе значений), зеркало по
 * `allowed_target_type_ids`, обязательность в warnings, и исключение
 * `thought_ref` из допустимых видов значения.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EtnError, type ResolvedLinkProperty, type ResolvedPropertyValue } from '@etn/shared';
import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import {
  computeThoughtCardWarnings,
  createTypeProperty,
  getPropertyValuesResolved,
  getPropertyValuesWithLinks,
  listEffectiveTypeProperties,
} from '../src/domain/property-service.js';
import { createLinkType } from '../src/domain/link-type-service.js';
import { createLink } from '../src/domain/link-service.js';
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
  'link-property (0.8.1)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('declares a link property and derives its name from the link type (direction out)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const lt = createLinkType(
          ndb,
          { name_forward: 'применяется к', name_reverse: 'регулируется из' },
          USER,
        );
        const tt = createThoughtType(ndb, { name: 'Требование' }, USER);
        createTypeProperty(
          ndb,
          'thought_type',
          tt.id,
          { key: 'применяется к', value_type: 'link', config: { link_type_id: lt.id, direction: 'out' } },
          USER,
        );
        const effective = listEffectiveTypeProperties(ndb, 'thought_type', tt.id);
        const linkProp = effective.find((p) => p.value_type === 'link' && p.key === 'применяется к');
        assert.ok(linkProp !== undefined);
        // Имя берётся из типа связи (name_forward), а не из переданного key.
        assert.equal(linkProp!.key, 'применяется к');
        assert.equal(linkProp!.config?.link_type_id, lt.id);
      } finally {
        ndb.close();
      }
    });

    it('derives the reverse name for direction in', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const lt = createLinkType(
          ndb,
          { name_forward: 'применяется к', name_reverse: 'регулируется из' },
          USER,
        );
        const tt = createThoughtType(ndb, { name: 'Сущность' }, USER);
        createTypeProperty(
          ndb,
          'thought_type',
          tt.id,
          { key: 'x', value_type: 'link', config: { link_type_id: lt.id, direction: 'in' } },
          USER,
        );
        const effective = listEffectiveTypeProperties(ndb, 'thought_type', tt.id);
        const linkProp = effective.find((p) => p.value_type === 'link' && p.key === 'регулируется из');
        assert.ok(linkProp !== undefined);
        assert.equal(linkProp!.key, 'регулируется из');
      } finally {
        ndb.close();
      }
    });

    it('rejects a second link property with the same (link_type, direction) on one type', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const lt = createLinkType(ndb, { name_forward: 'см. также', name_reverse: 'см. также' }, USER);
        const tt = createThoughtType(ndb, { name: 'Проект' }, USER);
        createTypeProperty(
          ndb,
          'thought_type',
          tt.id,
          { key: 'см. также', value_type: 'link', config: { link_type_id: lt.id, direction: 'out' } },
          USER,
        );
        assert.throws(
          () =>
            createTypeProperty(
              ndb,
              'thought_type',
              tt.id,
              { key: 'см. также 2', value_type: 'link', config: { link_type_id: lt.id, direction: 'out' } },
              USER,
            ),
          (e: unknown) => e instanceof EtnError && e.code === 'DUPLICATE',
        );
      } finally {
        ndb.close();
      }
    });

    it('rejects creating a new thought_ref property (ADR thought_ref упраздняется)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'Книга' }, USER);
        assert.throws(
          () => createTypeProperty(ndb, 'thought_type', tt.id, { key: 'автор', value_type: 'thought_ref' }, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('projects typed edges into the card as counters and returns edges via the values query', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const lt = createLinkType(
          ndb,
          { name_forward: 'зависит от', name_reverse: 'используется в' },
          USER,
        );
        const task = createThoughtType(ndb, { name: 'Задача' }, USER);
        const comp = createThoughtType(ndb, { name: 'Компонент' }, USER);
        createTypeProperty(
          ndb,
          'thought_type',
          task.id,
          { key: 'зависит от', value_type: 'link', config: { link_type_id: lt.id, direction: 'out' } },
          USER,
        );
        const a = createThought(ndb, { title: 'Задача A', type_id: task.id }, USER);
        const b = createThought(ndb, { title: 'Компонент B', type_id: comp.id }, USER);
        const c = createThought(ndb, { title: 'Компонент C', type_id: comp.id }, USER);
        createLink(ndb, { source_id: a.id, target_id: b.id, type_id: lt.id }, USER);
        createLink(ndb, { source_id: a.id, target_id: c.id, type_id: lt.id }, USER);

        // Карточка: счётчик, а не список целей.
        const card = getPropertyValuesResolved(ndb, 'thought', a.id).filter(
          (v): v is ResolvedPropertyValue => v.value_type !== 'link',
        );
        assert.equal(card.length, 0, 'no scalar values on the task');
        const links = getPropertyValuesResolved(ndb, 'thought', a.id).filter(
          (v) => v.value_type === 'link' && !(v as ResolvedLinkProperty).structural,
        );
        assert.equal(links.length, 1);
        const linkProp = links[0] as Extract<(typeof links)[number], { value_type: 'link' }>;
        assert.equal(linkProp.count, 2);
        assert.equal(linkProp.property_name, 'зависит от');
        assert.equal(linkProp.direction, 'out');
        assert.equal(linkProp.outside_type, false);

        // Запрос значений: id ребра + цель.
        const values = getPropertyValuesWithLinks(ndb, 'thought', a.id);
        const linkValues = values.find((v) => v.value_type === 'link' && 'values' in v && v.property_name === 'зависит от');
        assert.ok(linkValues !== undefined && 'values' in linkValues);
        const items = (linkValues as { values: Array<{ link_id: string; target_id: string; target_title: string | null }> }).values;
        assert.equal(items.length, 2);
        const targets = items.map((i) => i.target_title).sort();
        assert.deepEqual(targets, ['Компонент B', 'Компонент C']);
        assert.ok(items.every((i) => typeof i.link_id === 'string' && i.link_id.length > 0));

        // Обратная сторона: компонент видит «используется в» внетиповым.
        const bLinks = getPropertyValuesResolved(ndb, 'thought', b.id).filter(
          (v): v is ResolvedLinkProperty => v.value_type === 'link' && !(v as ResolvedLinkProperty).structural,
        );
        assert.equal(bLinks.length, 1);
        assert.equal(bLinks[0]!.property_name, 'используется в');
        assert.equal(bLinks[0]!.direction, 'in');
        assert.equal(bLinks[0]!.outside_type, true);
      } finally {
        ndb.close();
      }
    });

    it('mirror: allowed_target_type_ids spawns the reverse property on allowed target types', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const lt = createLinkType(
          ndb,
          { name_forward: 'применяется к', name_reverse: 'регулируется из' },
          USER,
        );
        const req = createThoughtType(ndb, { name: 'Требование' }, USER);
        const comp = createThoughtType(ndb, { name: 'Компонент' }, USER);
        createTypeProperty(
          ndb,
          'thought_type',
          req.id,
          {
            key: 'применяется к',
            value_type: 'link',
            config: { link_type_id: lt.id, direction: 'out', allowed_target_type_ids: [comp.id] },
          },
          USER,
        );
        const r = createThought(ndb, { title: 'Требование 1', type_id: req.id }, USER);
        const c = createThought(ndb, { title: 'Компонент 1', type_id: comp.id }, USER);
        createLink(ndb, { source_id: r.id, target_id: c.id, type_id: lt.id }, USER);

        // Цель (компонент) получает зеркальное обратное свойство, не внетиповое.
        const cLinks = getPropertyValuesResolved(ndb, 'thought', c.id).filter(
          (v): v is ResolvedLinkProperty => v.value_type === 'link' && !(v as ResolvedLinkProperty).structural,
        );
        assert.equal(cLinks.length, 1);
        assert.equal(cLinks[0]!.property_name, 'регулируется из');
        assert.equal(cLinks[0]!.direction, 'in');
        assert.equal(cLinks[0]!.outside_type, false);
      } finally {
        ndb.close();
      }
    });

    it('a required link property is checked in card warnings (empty → warning, filled → none)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const lt = createLinkType(
          ndb,
          { name_forward: 'применяется к', name_reverse: 'регулируется из' },
          USER,
        );
        const req = createThoughtType(ndb, { name: 'ТребованиеR' }, USER);
        createTypeProperty(
          ndb,
          'thought_type',
          req.id,
          {
            key: 'применяется к',
            value_type: 'link',
            required: true,
            config: { link_type_id: lt.id, direction: 'out' },
          },
          USER,
        );
        const r = createThought(ndb, { title: 'Без связей', type_id: req.id }, USER);
        const warnings = computeThoughtCardWarnings(ndb, r.id);
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0]!.code, 'REQUIRED_PROPERTY_MISSING');

        // Живое ребро снимает предупреждение.
        const target = createThought(ndb, { title: 'Цель', type_id: req.id }, USER);
        createLink(ndb, { source_id: r.id, target_id: target.id, type_id: lt.id }, USER);
        assert.deepEqual(computeThoughtCardWarnings(ndb, r.id), []);
      } finally {
        ndb.close();
      }
    });

    // -------------------------------------------------------------------------
    // Зеркала в каталоге типа (требование dde92461): listEffectiveTypeProperties
    // синтезирует обратное свойство у накрываемых типов, а не только при чтении
    // карточки мысли. Без этого редактор типа, etn.types.list и конструктор
    // отборов зеркало не видели вовсе.
    // -------------------------------------------------------------------------

    it('mirror in type catalogue: allowed type gets the reverse property (mirrored, not own)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const lt = createLinkType(
          ndb,
          { name_forward: 'версия -> работы', name_reverse: 'работы версии' },
          USER,
        );
        const ver = createThoughtType(ndb, { name: 'Версия' }, USER);
        const task = createThoughtType(ndb, { name: 'ЗадачаM' }, USER);
        createTypeProperty(
          ndb,
          'thought_type',
          task.id,
          {
            key: 'версия',
            value_type: 'link',
            config: { link_type_id: lt.id, direction: 'out', allowed_target_type_ids: [ver.id] },
          },
          USER,
        );

        // У исходного типа — прямое свойство, без флага mirrored.
        const taskEffective = listEffectiveTypeProperties(ndb, 'thought_type', task.id);
        const taskLink = taskEffective.find(
          (p) => p.value_type === 'link' && p.config?.link_type_id === lt.id && !p.mirrored,
        );
        assert.ok(taskLink !== undefined);
        assert.equal(taskLink!.key, 'версия -> работы');

        // У накрываемого типа — зеркальное обратное, синтетическое (не own).
        const verEffective = listEffectiveTypeProperties(ndb, 'thought_type', ver.id);
        const mirrors = verEffective.filter((p) => p.mirrored === true);
        assert.equal(mirrors.length, 1);
        const mirror = mirrors[0]!;
        assert.equal(mirror.key, 'работы версии');
        assert.equal(mirror.value_type, 'link');
        assert.equal(mirror.config?.link_type_id, lt.id);
        assert.equal(mirror.config?.direction, 'in');
        assert.equal(mirror.inherited, false);
        assert.equal(mirror.defined_on, ver.id);
        assert.equal(mirror.required, false);
        // Кроме зеркала собственных link-привязок у накрываемого типа нет.
        assert.equal(
          verEffective.filter(
            (p) => p.value_type === 'link' && p.mirrored !== true && !p.inherited,
          ).length,
          0,
        );
      } finally {
        ndb.close();
      }
    });

    it('mirror in type catalogue: inherited by descendants of an allowed type', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const lt = createLinkType(
          ndb,
          { name_forward: 'применяется к', name_reverse: 'регулируется из' },
          USER,
        );
        const req = createThoughtType(ndb, { name: 'ТребованиеD' }, USER);
        const comp = createThoughtType(ndb, { name: 'КомпонентD' }, USER);
        const subComp = createThoughtType(
          ndb,
          { name: 'ПодкомпонентD', parent_id: comp.id },
          USER,
        );
        createTypeProperty(
          ndb,
          'thought_type',
          req.id,
          {
            key: 'применяется к',
            value_type: 'link',
            config: { link_type_id: lt.id, direction: 'out', allowed_target_type_ids: [comp.id] },
          },
          USER,
        );

        // Потомок накрываемого типа наследует зеркало; определяющий тип —
        // сам «КомпонентD» из allowed-списка.
        const subEffective = listEffectiveTypeProperties(ndb, 'thought_type', subComp.id);
        const mirrors = subEffective.filter((p) => p.mirrored === true);
        assert.equal(mirrors.length, 1);
        assert.equal(mirrors[0]!.key, 'регулируется из');
        assert.equal(mirrors[0]!.inherited, true);
        assert.equal(mirrors[0]!.defined_on, comp.id);
      } finally {
        ndb.close();
      }
    });

    it('mirror in type catalogue: no duplicate when the pair is already explicit', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const lt = createLinkType(
          ndb,
          { name_forward: 'применяется к', name_reverse: 'регулируется из' },
          USER,
        );
        const req = createThoughtType(ndb, { name: 'ТребованиеU' }, USER);
        const comp = createThoughtType(ndb, { name: 'КомпонентU' }, USER);
        createTypeProperty(
          ndb,
          'thought_type',
          req.id,
          {
            key: 'применяется к',
            value_type: 'link',
            config: { link_type_id: lt.id, direction: 'out', allowed_target_type_ids: [comp.id] },
          },
          USER,
        );
        // Явная привязка той же пары (тип связи, направление in) на целевом типе.
        createTypeProperty(
          ndb,
          'thought_type',
          comp.id,
          {
            key: 'регулируется из',
            value_type: 'link',
            config: { link_type_id: lt.id, direction: 'in' },
          },
          USER,
        );

        const compEffective = listEffectiveTypeProperties(ndb, 'thought_type', comp.id);
        const samePair = compEffective.filter(
          (p) =>
            p.value_type === 'link' &&
            p.config?.link_type_id === lt.id &&
            p.config?.direction === 'in',
        );
        // Пара адресует ровно одно свойство: явное, зеркала не добавлено.
        assert.equal(samePair.length, 1);
        assert.equal(samePair[0]!.mirrored ?? false, false);
      } finally {
        ndb.close();
      }
    });

    it('mirror in type catalogue: absent without allowed_target_type_ids and for link types', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const lt = createLinkType(
          ndb,
          { name_forward: 'см. также', name_reverse: 'см. также' },
          USER,
        );
        const a = createThoughtType(ndb, { name: 'ТипA' }, USER);
        const b = createThoughtType(ndb, { name: 'ТипB' }, USER);
        createTypeProperty(
          ndb,
          'thought_type',
          a.id,
          { key: 'см. также', value_type: 'link', config: { link_type_id: lt.id, direction: 'out' } },
          USER,
        );

        // Без ограничения — в каталоге типа B зеркала нет (обратная сторона
        // остаётся внетиповой при чтении мысли, требование dde92461).
        const bEffective = listEffectiveTypeProperties(ndb, 'thought_type', b.id);
        assert.equal(bEffective.filter((p) => p.mirrored === true).length, 0);

        // У типов связей зеркал тоже не появляется (владелец не thought_type).
        const ltEffective = listEffectiveTypeProperties(ndb, 'link_type', lt.id);
        assert.equal(ltEffective.filter((p) => p.mirrored === true).length, 0);
      } finally {
        ndb.close();
      }
    });
  },
);
