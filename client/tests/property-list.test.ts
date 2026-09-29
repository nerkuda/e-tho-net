/**
 * Контракт общего списка свойств (задача 6ebde54e, 0.8.2).
 *
 * Список — один компонент в двух режимах: «менеджер» (диалог «Свойства») и
 * «пикер» («Добавить свойство…» редактора типа). Здесь закреплены:
 *  - форматирование (чистые функции): колонки, единый значок концов связи
 *    (вертикальное направление вниз/вверх и эффективное оформление линии),
 *    обрезка имён по 30-й символ, подпись «связь (имя - имя)», иконки видов
 *    значения, ⓘ-подсказка, эффективное оформление линии;
 *  - привязка слоёв по якорям исходника (клиентские тесты идут без DOM):
 *    одна функция активации на Enter/двойной клик, клавиатура и текущая строка
 *    от фасада `lib/ui/table`, контекстное меню из словаря пунктов (удаление —
 *    только в менеджере), отсутствие крестика удаления, использование обоими
 *    потребителями.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  LINK_NAME_LIMIT,
  buildPropertyListRows,
  linkEndDashArray,
  linkEndDirection,
  linkEndIconSpec,
  linkEndLineStyle,
  linkEndLineWidth,
  propertyDescriptionHint,
  propertyListColumns,
  truncateLinkName,
  valueTypeCellLabel,
  valueTypeIconName,
  type PropertyListRow,
  type PropertyRegistryRow,
} from '../src/renderer/lib/property-list.js';
import type { LinkType, PropertyValueType } from '@etn/shared';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');
const COMPONENT_TS = resolve(RENDERER, 'lib', 'property-list.ts');
const MANAGER_TS = resolve(RENDERER, 'screens', 'property-manager.ts');
const PICKER_TS = resolve(RENDERER, 'screens', 'type-manager.ts');
const CATALOGUE_TS = resolve(RENDERER, 'screens', 'type-catalogue.ts');
const ICONS_TS = resolve(RENDERER, 'lib', 'icons.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function registryRow(overrides: Partial<PropertyRegistryRow> = {}): PropertyRegistryRow {
  return {
    id: 'p1',
    name: 'свойство',
    value_type: 'text',
    config: null,
    description: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    types_count: 1,
    values_count: 0,
    ...overrides,
  };
}

function linkType(overrides: Partial<LinkType> = {}): LinkType {
  return {
    id: 'lt-1',
    name_forward: 'вперёд',
    name_reverse: 'назад',
    parent_id: null,
    is_root: true,
    color: null,
    style: null,
    width: null,
    description: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    version: 1,
    created_by: 'u',
    ...overrides,
  };
}

function linkRow(): PropertyListRow {
  const rows = buildPropertyListRows(
    [registryRow({ id: 'p-link', name: 'вперёд', value_type: 'link', config: { link_type_id: 'lt-1' }, types_source_count: 2, types_target_count: 4 })],
    [linkType()],
  );
  return rows[0]!;
}

describe('колонки списка свойств (требование 5)', () => {
  it('три колонки: Имя, Тип значения, Кол-во типов', () => {
    assert.deepEqual(propertyListColumns(), ['Имя', 'Тип значения', 'Кол-во типов']);
  });
});

describe('обрезка имён и подпись типа значения конца связи (требование 5)', () => {
  it('обрезает по 30-й символ включительно', () => {
    assert.equal(LINK_NAME_LIMIT, 30);
    assert.equal(truncateLinkName('a'.repeat(30)), 'a'.repeat(30));
    assert.equal(truncateLinkName('a'.repeat(31)), 'a'.repeat(30));
    assert.equal(truncateLinkName('коротко'), 'коротко');
  });

  it('конец связи — «связь (имя - имя)» с обрезкой обоих имён', () => {
    const row = linkRow();
    assert.equal(valueTypeCellLabel(row), 'связь (вперёд - назад)');
    const long = buildPropertyListRows(
      [registryRow({ id: 'p2', value_type: 'link', config: { link_type_id: 'lt-2' } })],
      [linkType({ id: 'lt-2', name_forward: 'Ф'.repeat(40), name_reverse: 'Р'.repeat(40) })],
    )[0]!;
    assert.equal(valueTypeCellLabel(long), `связь (${'Ф'.repeat(30)} - ${'Р'.repeat(30)})`);
    // Полный вариант — для тултипа.
    assert.equal(valueTypeCellLabel(long, true), `связь (${'Ф'.repeat(40)} - ${'Р'.repeat(40)})`);
  });

  it('скаляр — подпись вида значения (как было)', () => {
    const scalar = buildPropertyListRows([registryRow({ value_type: 'date' })], [])[0]!;
    assert.equal(valueTypeCellLabel(scalar), 'дата');
  });

  it('вырожденный конец связи без имён даёт «связь»', () => {
    const degraded = buildPropertyListRows(
      [registryRow({ id: 'p3', name: 'связь', value_type: 'link', config: { link_type_id: 'lt-x' } })],
      [],
    )[0]!;
    assert.equal(valueTypeCellLabel(degraded), 'связь');
  });
});

describe('единый значок конца связи (требование 4, задача 88def930)', () => {
  it('направление: вниз у источника (исходящая), вверх у назначения (входящая)', () => {
    assert.equal(linkEndDirection('source'), 'down');
    assert.equal(linkEndDirection('target'), 'up');
    assert.equal(linkEndDirection(null), 'down', 'бестиповый конец ведёт себя как исходящий');
    assert.equal(linkEndIconSpec('source', null).direction, 'down');
    assert.equal(linkEndIconSpec('target', null).direction, 'up');
  });

  it('значок один: у концов одной связи совпадает всё, кроме направления', () => {
    const row = linkRow();
    const source = linkEndIconSpec('source', row.visual);
    const target = linkEndIconSpec('target', row.visual);
    // Всё, кроме направления, у концов одной связи совпадает — значок общий.
    assert.deepEqual({ ...source, direction: null }, { ...target, direction: null });
  });

  it('оформление линии — эффективные настройки связи с клампом толщины', () => {
    const row = linkRow();
    // Тип связи без собственного оформления наследует дефолт (width 1).
    assert.equal(linkEndLineWidth(row.visual), 1);
    assert.equal(linkEndLineStyle(row.visual), 'solid');
    assert.equal(linkEndLineWidth({ color: null, style: 'dashed', width: 99 }), 6);
    assert.equal(linkEndLineWidth({ color: null, style: 'dotted', width: 0 }), 1);
    assert.equal(linkEndLineStyle({ color: null, style: 'dotted', width: 0 }), 'dotted');
  });

  it('цвет/стиль/толщина переносятся в спецификацию значка', () => {
    const spec = linkEndIconSpec('source', { color: '#e08a3c', style: 'dashed', width: 4 });
    assert.deepEqual(spec, { direction: 'down', width: 4, style: 'dashed', color: '#e08a3c' });
    // Без оформления — цвет по умолчанию из CSS.
    assert.equal(linkEndIconSpec('source', null).color, null);
  });

  it('прерывистость линии: dashed — штрихи, dotted — точки, solid — сплошная', () => {
    assert.equal(linkEndDashArray('solid'), null);
    assert.equal(linkEndDashArray('dashed'), '5 3');
    assert.equal(linkEndDashArray('dotted'), '1 3');
  });
});

describe('иконки видов значения (требование 4)', () => {
  it('каждому скалярному виду — своя иконка, link — без иконки', () => {
    const expected: Record<PropertyValueType, string | null> = {
      text: 'value-text',
      number: 'value-number',
      date: 'value-date',
      bool: 'value-bool',
      url: 'value-url',
      thought_ref: 'value-ref',
      link: null,
      // Кросс-сетевая ссылка (задача 7849008a): своя иконка для UX.
      cross_network_ref: 'value-cross-network-ref',
    };
    for (const [vt, icon] of Object.entries(expected)) {
      assert.equal(valueTypeIconName(vt as PropertyValueType), icon, `иконка вида ${vt}`);
    }
  });

  it('иконки объявлены в общем наборе (lib/icons.ts)', () => {
    const src = read(ICONS_TS);
    for (const icon of ['value-text', 'value-number', 'value-date', 'value-bool', 'value-url', 'value-ref']) {
      assert.ok(src.includes(`'${icon}'`), `иконка «${icon}» объявлена в IconName`);
    }
  });
});

describe('ⓘ-подсказка описания (требование 5)', () => {
  it('непустое описание даёт текст, пустое/отсутствующее — нет', () => {
    const withDesc = buildPropertyListRows([registryRow({ description: '  подробности  ' })], [])[0]!;
    assert.equal(propertyDescriptionHint(withDesc), 'подробности');
    const empty = buildPropertyListRows([registryRow({ description: '   ' })], [])[0]!;
    assert.equal(propertyDescriptionHint(empty), null);
    const none = buildPropertyListRows([registryRow({ description: null })], [])[0]!;
    assert.equal(propertyDescriptionHint(none), null);
  });
});

describe('счётчики «Кол-во типов» (требование 6)', () => {
  it('у двух концов одной связи — свои числа по своим привязкам', () => {
    const rows = buildPropertyListRows(
      [registryRow({ id: 'pl', value_type: 'link', config: { link_type_id: 'lt-1' }, types_source_count: 3, types_target_count: 7 })],
      [linkType()],
    );
    assert.equal(rows.find((r) => r.side === 'source')!.typesCount, 3);
    assert.equal(rows.find((r) => r.side === 'target')!.typesCount, 7);
  });
});

describe('якоря рендера и режимов (требования 3–9)', () => {
  const src = read(COMPONENT_TS);

  it('одна функция активации обслуживает клавиатуру и двойной клик', () => {
    assert.match(src, /function activate\(row: PropertyListRow\): void/, 'единая функция активации');
    // Активация — событие фасада (Enter/двойной клик), а не самодельный keydown.
    assert.ok(src.includes('onActivate: (row) => activate(row)'), 'фасад зовёт activate');
    assert.ok(!src.includes("addEventListener('keydown'"), 'своих обработчиков клавиш в модуле нет');
  });

  it('вся клавиатура и текущая строка — от фасада lib/ui/table', () => {
    assert.ok(src.includes('createTable<PropertyListRow>'), 'список собран фасадом таблицы');
    assert.ok(!src.includes("'ArrowDown'"), 'самодельной навигации стрелками нет');
    assert.ok(!src.includes('scrollIntoView'), 'прокрутку к текущей строке ведёт фасад');
  });

  it('крестика удаления в строках нет, удаление — в контекстном меню менеджера', () => {
    assert.ok(!src.includes("button('✕'"), 'в списке нет кнопки-крестика');
    // Пункты меню — из общего словаря (menuAction), не самодельные объекты.
    assert.ok(src.includes("menuAction(t('propertyList.menu.edit')"), 'меню содержит «Изменить»');
    assert.ok(src.includes("menuAction(t('actions.delete')"), 'меню содержит «Удалить» (из словаря)');
    assert.match(src, /mode === 'manager' && callbacks\.onDelete !== undefined/, '«Удалить» только в менеджере');
    assert.ok(src.includes('rowMenu: (row) => rowMenu(row)'), 'меню отдаётся фасаду');
  });

  it('значок конца связи — единый вертикальный SVG в эффективном оформлении связи', () => {
    assert.match(src, /buildLinkEndIcon\(linkEndIconSpec\(row\.side, row\.visual\)\)/, 'один значок из спецификации');
    assert.match(src, /side === 'target' \? 'up' : 'down'/, 'направление: вниз — источник, вверх — цель');
    // Направление — координатами вертикальной линии и шеврона, без зеркалирования.
    assert.match(src, /'data-direction': spec\.direction/, 'направление видно в разметке значка');
    assert.ok(!src.includes("svg.style.transform = 'scaleX(-1)'"), 'зеркалирования значка больше нет');
    assert.match(src, /const y2 = down \? end : start;/, 'линия рисуется сверху вниз у источника и снизу вверх у цели');
    assert.match(src, /'stroke-width': spec\.width/, 'толщина из эффективного оформления');
    assert.match(src, /linkEndDashArray\(spec\.style\)/, 'штрих из эффективного оформления');
    assert.match(src, /svg\.style\.color = spec\.color/, 'цвет из эффективного оформления');
    // Старой пары «линия + глиф стрелки» больше нет.
    assert.ok(!src.includes('property-list-arrow-line'), 'нет отдельного элемента линии');
    assert.ok(!src.includes('property-list-arrow-head'), 'нет отдельного глифа стрелки');
  });

  it('ⓘ несёт описание свойства, полное имя пары — в тултипе', () => {
    assert.match(src, /span\('ⓘ', 'muted prop-hint'\)/, 'символ ⓘ');
    assert.match(src, /valueTypeCellLabel\(row, true\)/, 'тултип с полным именем');
  });
});

describe('якоря потребителей (требование 1, 10)', () => {
  it('менеджер свойств — режим manager, кнопка «Добавить», объединённый диалог шире', () => {
    const src = read(MANAGER_TS);
    assert.ok(src.includes('buildPropertyList({'), 'менеджер использует общий список');
    assert.match(src, /mode: 'manager'/);
    assert.match(
      src,
      /onAdd:\s*\(\) =>\s*openPropertyManagerEditor\(null,\s*onChanged,\s*\(created\) =>\s*\{\s*pendingSelectId = created\.id;/,
      '«Добавить» открывает редактор на создании; созданное свойство становится текущей строкой (правило 7, 11ddd910)',
    );
    assert.match(src, /onDelete: \(row\) => void removeRow\(row\.registry\)/, 'удаление — подтверждение менеджера');
    // С 0.10.2 (задача 979761cd) список свойств — вкладка объединённого
    // диалога каталога: заголовок и роль l задаёт его оболочка.
    const catalogue = read(CATALOGUE_TS);
    assert.match(catalogue, /id: 'properties'/, 'вкладка «Свойства мыслей» объединённого диалога');
    assert.match(
      catalogue,
      /title:\s*t\('catalogue\.title'\)[\s\S]{0,400}?size:\s*'l'/,
      'объединённый диалог — роль l (900px, шире прежних 720px)',
    );
  });

  it('пикер типа — режим picker с блокировкой подключённых имён', () => {
    const src = read(PICKER_TS);
    assert.ok(src.includes('buildPropertyList({'), 'пикер использует общий список');
    assert.match(src, /mode: 'picker'/);
    assert.match(src, /rowBlocked: \(row\) => rowBlockReason\(row, existingSides, inheritedPropertyIds\)/);
    assert.ok(!src.includes('buildAttachEntries'), 'параллельного списка нет');
  });

  it('список не дублирует логику строк в потребителях', () => {
    const manager = read(MANAGER_TS);
    for (const gone of ['sortRegistryRows', 'annotateRows', 'filterRegistryRows']) {
      assert.ok(!manager.includes(`function ${gone}`), `в property-manager.ts нет своей «${gone}»`);
    }
  });
});
