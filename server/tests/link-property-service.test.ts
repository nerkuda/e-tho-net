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
  setPropertyValue,
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
        // 0.8.1: зеркало материализуется в type_properties при создании source-привязки
        // (задача e1fbf304; требование 115e44fa), поэтому в карточке — одна запись
        // (материализованная привязка target), без внетипового дубликата.
        const cLinks = getPropertyValuesResolved(ndb, 'thought', c.id).filter(
          (v): v is ResolvedLinkProperty => v.value_type === 'link' && !(v as ResolvedLinkProperty).structural,
        );
        // Возвращается 1 запись (материализованная target-привязка); legacy-зеркала
        // из appendMirroredLinkProperties больше не добавляются — пара уже покрыта.
        assert.equal(cLinks.length, 1);
        const linkProp = cLinks[0]!;
        assert.equal(linkProp.property_name, 'регулируется из');
        assert.equal(linkProp.direction, 'in');
        assert.equal(linkProp.outside_type, false);
      } finally {
        ndb.close();
      }
    });

    it('an edge whose link type has no registry property still projects as outside-type (e5cfacb9)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        // Легаси-ребро: тип связи есть, свойства-связи в реестре нет —
        // проекция «ребро → свойство» полная, связь обязана быть видна
        // внетиповым свойством-связью (имя — из типа связи).
        const lt = createLinkType(
          ndb,
          { name_forward: 'Сотрудники', name_reverse: 'Место работы' },
          USER,
        );
        const org = createThoughtType(ndb, { name: 'Организация' }, USER);
        const person = createThoughtType(ndb, { name: 'Персона' }, USER);
        const firm = createThought(ndb, { title: 'Фирма 1С', type_id: org.id }, USER);
        const p1 = createThought(ndb, { title: 'Иванов', type_id: person.id }, USER);
        createLink(ndb, { source_id: firm.id, target_id: p1.id, type_id: lt.id }, USER);

        // У источника: внетиповое свойство-связь с прямым именем типа связи.
        const firmLinks = getPropertyValuesResolved(ndb, 'thought', firm.id).filter(
          (v): v is ResolvedLinkProperty =>
            v.value_type === 'link' && !(v as ResolvedLinkProperty).structural,
        );
        const firmOut = firmLinks.find((l) => l.outside_type === true && l.link_type_id === lt.id);
        assert.ok(firmOut !== undefined, 'edge without a registry property is visible');
        assert.equal(firmOut.direction, 'out');
        assert.equal(firmOut.property_name, 'Сотрудники');
        assert.equal(firmOut.property_id, '');
        assert.equal(firmOut.count, 1);

        // У цели: то же ребро — обратным именем и направлением.
        const p1Links = getPropertyValuesResolved(ndb, 'thought', p1.id).filter(
          (v): v is ResolvedLinkProperty =>
            v.value_type === 'link' && !(v as ResolvedLinkProperty).structural,
        );
        const p1Out = p1Links.find((l) => l.outside_type === true && l.link_type_id === lt.id);
        assert.ok(p1Out !== undefined);
        assert.equal(p1Out.direction, 'in');
        assert.equal(p1Out.property_name, 'Место работы');

        // Запрос значений отдаёт рёбра и у внетипового свойства.
        const values = getPropertyValuesWithLinks(ndb, 'thought', firm.id).find(
          (v) => v.value_type === 'link' && 'values' in v && v.property_name === 'Сотрудники',
        );
        assert.ok(values !== undefined && 'values' in values);
        assert.equal((values as { values: unknown[] }).values.length, 1);
      } finally {
        ndb.close();
      }
    });

    it('a link property with display ≠ registry name is writable under both keys (migration 040 legacy)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        // Пост-миграционное состояние 040: свойство-связь сохранило прежнее
        // имя реестра («место работы»), а его тип связи называется
        // «upd: место работы» — чтение отдаёт ключ- display, и запись из
        // редактора по нему падала NOT_FOUND.
        const lt = createLinkType(
          ndb,
          { name_forward: 'upd: место работы', name_reverse: 'upd: место работы' },
          USER,
        );
        const person = createThoughtType(ndb, { name: 'Персона' }, USER);
        const def = createTypeProperty(
          ndb,
          'thought_type',
          person.id,
          {
            key: 'upd: место работы',
            value_type: 'link',
            config: { link_type_id: lt.id, direction: 'out' },
          },
          USER,
        );
        // Имитация миграции 040: реестровое имя осталось прежним, display
        // (имя прямое типа связи) расходится с ним.
        ndb
          .prepare(
            `UPDATE properties SET name = ?, name_key = type_name_key(?) WHERE id = ? AND layer_id = ?`,
          )
          .run('место работы', 'место работы', def.property_id, ndb.layerId);

        const a = createThought(ndb, { title: 'Иванов', type_id: person.id }, USER);
        const org = createThoughtType(ndb, { name: 'Организация' }, USER);
        const firm = createThought(ndb, { title: 'Фирма', type_id: org.id }, USER);

        // Чтение отдаёт ключ-display.
        const eff = listEffectiveTypeProperties(ndb, 'thought_type', person.id);
        assert.ok(eff.some((d) => d.key === 'upd: место работы' && d.value_type === 'link'));

        // Запись по display-ключу (путь редактора мысли) создаёт ребро.
        setPropertyValue(ndb, 'thought', a.id, 'upd: место работы', [firm.id], USER);
        let values = getPropertyValuesWithLinks(ndb, 'thought', a.id).find(
          (v) => v.value_type === 'link' && 'values' in v && v.property_name === 'upd: место работы',
        );
        assert.ok(values !== undefined && 'values' in values);
        assert.equal((values as { values: unknown[] }).values.length, 1);

        // Запись по прежнему имени реестра (канонический путь) работает тоже.
        setPropertyValue(ndb, 'thought', a.id, 'место работы', [firm.id], USER);
        values = getPropertyValuesWithLinks(ndb, 'thought', a.id).find(
          (v) => v.value_type === 'link' && 'values' in v && v.property_name === 'upd: место работы',
        );
        assert.ok(values !== undefined && 'values' in values);
        assert.equal((values as { values: unknown[] }).values.length, 1, 'no duplicate edge');
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

    it('mirror in type catalogue: allowed type gets the reverse property (materialized as own)', () => {
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

        // У исходного типа — прямое свойство (side=source).
        const taskEffective = listEffectiveTypeProperties(ndb, 'thought_type', task.id);
        const taskLink = taskEffective.find(
          (p) => p.value_type === 'link' && p.config?.link_type_id === lt.id,
        );
        assert.ok(taskLink !== undefined);
        assert.equal(taskLink!.key, 'версия -> работы');
        assert.equal(taskLink!.side, 'source');

        // У накрываемого типа — материализованная зеркальная привязка
        // (0.8.1, задача e1fbf304; требование 115e44fa). Свойство стало own,
        // не синтетическое зеркало — пара (link_type, side) адресует ровно одно
        // свойство (требование b9562306).
        const verEffective = listEffectiveTypeProperties(ndb, 'thought_type', ver.id);
        const verLink = verEffective.find(
          (p) => p.value_type === 'link' && p.config?.link_type_id === lt.id,
        );
        assert.ok(verLink !== undefined);
        assert.equal(verLink!.key, 'работы версии');
        assert.equal(verLink!.value_type, 'link');
        assert.equal(verLink!.config?.link_type_id, lt.id);
        // Направление задаётся привязкой (side='target' → direction='in');
        // config.direction остаётся исходным значением свойства-реестра.
        assert.equal(verLink!.side, 'target');
        assert.equal(verLink!.inherited, false);
        assert.equal(verLink!.defined_on, ver.id);
        assert.equal(verLink!.required, false);
        // Только эта типизированная link-привязка у ver (структурные
        // «Родители»/«Потомки» наследуются от корневого типа и здесь
        // не учитываются — у них `link_type_id` пустой).
        assert.equal(
          verEffective.filter(
            (p) => p.value_type === 'link' && p.config?.link_type_id !== undefined,
          ).length,
          1,
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

        // 0.8.1: зеркальная привязка материализуется на comp (target, side='target')
        // при создании source-привязки на req. Подтип subComp наследует её по цепочке
        // типов (требование 115e44fa: «привязки назначения наследуются наравне
        // с привязками источника»), а не через динамически вычисляемое зеркало.
        const subEffective = listEffectiveTypeProperties(ndb, 'thought_type', subComp.id);
        const inherited = subEffective.filter(
          (p) =>
            p.value_type === 'link' &&
            p.config?.link_type_id === lt.id &&
            p.inherited === true,
        );
        assert.equal(inherited.length, 1);
        assert.equal(inherited[0]!.key, 'регулируется из');
        assert.equal(inherited[0]!.side, 'target');
        assert.equal(inherited[0]!.defined_on, comp.id);
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
        // Сначала явная target-привязка на comp.id: в 0.8.1 на одну сторону —
        // ровно одна привязка пары (link_type, side).
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
        // Source-привязка с allowed_target_type_ids=[comp.id] — зеркало
        // уже материализовано, повторного создания не происходит (0.8.1,
        // задача e1fbf304; требование 115e44fa).
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

        const compEffective = listEffectiveTypeProperties(ndb, 'thought_type', comp.id);
        const samePair = compEffective.filter(
          (p) =>
            p.value_type === 'link' &&
            p.config?.link_type_id === lt.id &&
            p.config?.direction === 'in',
        );
        // Пара адресует ровно одно свойство: ни дубликата, ни синтетического зеркала.
        assert.equal(samePair.length, 1);
        assert.equal(samePair[0]!.side, 'target');
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
