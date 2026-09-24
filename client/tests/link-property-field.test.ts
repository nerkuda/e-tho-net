/**
 * Юнит-тесты переиспользуемого поля выбора свойства-связи с живым поиском
 * (`client/src/renderer/lib/link-property-field.ts`, ошибка dc175a5b).
 *
 * Проверяются:
 *  1. чистая модель вариантов — по одному пункту на имя стороны свойства-связи,
 *     единый алфавитный порядок, подпись стороны, имена пары типа связи и
 *     спецификация значка конца связи (направление — зеркалирование);
 *  2. живой поиск — тот же фильтр, что у общего списка свойств (по имени
 *     стороны, по обратному имени пары, по описанию); скаляры и структурные
 *     «Родители»/«Потомки» в поле не предлагаются;
 *  3. само поле — обычный ввод (не `select`), список открывается по фокусу,
 *     выбор даёт `LinkPropertyPick` с именем стороны-ключом, «без свойства»
 *     снимает выбор, замена строк (`setRows`) обновляет подпись.
 *
 * Модуль гоняется под Node с общим DOM-шимом (`dom-shim.ts`), как соседние
 * тесты списка свойств и выпадашки подсказок.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LinkType } from '@etn/shared';

import {
  LINK_PROPERTY_NONE_LABEL,
  buildLinkPropertyField,
  filterLinkPropertyOptions,
  linkPropertyOptions,
  type LinkPropertyPick,
} from '../src/renderer/lib/link-property-field.js';
import { buildPropertyListRows, type PropertyRegistryRow } from '../src/renderer/lib/property-list.js';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// DOM-шим (тот же подход, что у suggest-dropdown.test.ts)
// ---------------------------------------------------------------------------

function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  };
}
installShim();

/** Тик микрозадач: асинхронная загрузка вариантов выпадашки. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Открытый список поля (слой выпадашки живёт в `document.body`). */
function openList(): ShimElement | null {
  const body = (globalThis as any).document.body as ShimElement;
  return body.children.find((c) => c.className.split(/\s+/).includes('type-combo-list')) ?? null;
}

/** Подписи пунктов открытого списка. */
function listNames(): string[] {
  return (openList() ?? new ShimElement('div'))
    .querySelectorAll('.type-combo-item')
    .map((row) => row.querySelectorAll('.type-combo-label')[0]?.textContent ?? '');
}

// ---------------------------------------------------------------------------
// Данные: реестр свойств + каталог типов связей
// ---------------------------------------------------------------------------

const FORWARD = 'запланировано в версию';
const REVERSE = 'включает работы';

function linkType(): LinkType {
  return {
    id: 'lt1',
    name_forward: FORWARD,
    name_reverse: REVERSE,
    parent_id: null,
    is_root: false,
    color: '#e08a3c',
    style: 'dashed',
    width: 3,
    description: null,
  } as LinkType;
}

function registryRow(extra: Partial<PropertyRegistryRow>): PropertyRegistryRow {
  return {
    id: 'p1',
    name: FORWARD,
    value_type: 'link',
    config: { link_type_id: 'lt1' },
    description: null,
    created_at: '',
    updated_at: '',
    types_count: 2,
    values_count: 0,
    types_source_count: 1,
    types_target_count: 1,
    ...extra,
  } as PropertyRegistryRow;
}

const SIDES = buildPropertyListRows(
  [
    registryRow({}),
    registryRow({ id: 'p2', name: 'Скаляр', value_type: 'text', config: null }),
    registryRow({ id: 'p3', name: 'Родители', config: { structural: true } }),
  ],
  [linkType()],
);

describe('модель вариантов поля выбора свойства-связи (ошибка dc175a5b)', () => {
  it('по пункту на имя стороны, единый алфавит, скаляры и структурные не предлагаются', () => {
    const options = linkPropertyOptions(SIDES);
    assert.deepEqual(
      options.map((o) => o.label),
      [REVERSE, FORWARD],
      'обе стороны свойства-связи в едином алфавитном порядке имён; скаляр и структурное отсеяны',
    );
    const [reverse, forward] = options;
    assert.deepEqual(
      options.map((o) => o.side),
      ['target', 'source'],
      'порядок отвечает именам сторон',
    );
    assert.equal(reverse!.sideLabel, 'назначение');
    assert.equal(forward!.sideLabel, 'источник');
    assert.equal(reverse!.pairLabel, `связь (${FORWARD} - ${REVERSE})`, 'подпись пары типа связи');
  });

  it('значок конца связи: направление зеркалированием, оформление — эффективное', () => {
    const [reverse, forward] = linkPropertyOptions(SIDES);
    assert.equal(forward!.linkEnd.mirrored, false, 'источник — стрелка вправо');
    assert.equal(reverse!.linkEnd.mirrored, true, 'назначение — зеркалится');
    assert.equal(reverse!.linkEnd.color, '#e08a3c');
    assert.equal(reverse!.linkEnd.style, 'dashed');
    assert.equal(reverse!.linkEnd.width, 3);
  });

  it('живой поиск: по своему имени, по обратному имени пары и по описанию', () => {
    const options = linkPropertyOptions(SIDES);
    assert.equal(filterLinkPropertyOptions(options, '').length, 2, 'пустой запрос — весь список');
    assert.deepEqual(
      filterLinkPropertyOptions(options, 'включает').map((o) => o.label),
      [REVERSE, FORWARD],
      'обратное имя находит свойство целиком (обе стороны) — как поиск общего списка свойств',
    );
    assert.equal(filterLinkPropertyOptions(options, 'неттакого').length, 0);
    const withDesc = linkPropertyOptions(
      buildPropertyListRows([registryRow({ description: 'планирование версии' })], [linkType()]),
    );
    assert.equal(filterLinkPropertyOptions(withDesc, 'планирование').length, 2, 'поиск по описанию');
  });
});

describe('поле выбора свойства-связи (ошибка dc175a5b)', () => {
  const changes: Array<LinkPropertyPick | null> = [];

  function build(rows = SIDES): ReturnType<typeof buildLinkPropertyField> {
    changes.length = 0;
    // Слой выпадашки живёт в `document.body` и у прошлого поля остаётся —
    // начинаем каждый случай с чистого документа.
    ((globalThis as any).document.body as ShimElement).replaceChildren();
    return buildLinkPropertyField({ rows, onChange: (pick) => changes.push(pick) });
  }

  /** Поле ввода внутри корня поля (в шиме корень — `ShimElement`). */
  function inputOf(field: ReturnType<typeof buildLinkPropertyField>): ShimElement {
    return field.root.querySelector('.link-property-input') as unknown as ShimElement;
  }

  /** Открывает список по фокусу и кликает пункт с нужной подписью. */
  async function pick(field: ReturnType<typeof buildLinkPropertyField>, label: string): Promise<void> {
    const input = inputOf(field);
    input.focus();
    await settle();
    const row = (openList() ?? new ShimElement('div'))
      .querySelectorAll('.type-combo-item')
      .find((r) => r.querySelectorAll('.type-combo-label')[0]?.textContent === label);
    assert.ok(row !== undefined, `в списке есть пункт «${label}»`);
    row!.click();
  }

  it('это поле ввода, а список открывается по фокусу со всеми пунктами', async () => {
    const field = build();
    const input = inputOf(field);
    assert.equal(input.tagName, 'input', 'корень поля — обычное поле ввода, никакой «открывашки»-select');
    assert.equal(field.value(), null, 'по умолчанию свойство не выбрано');
    input.focus();
    await settle();
    assert.deepEqual(listNames(), [LINK_PROPERTY_NONE_LABEL, REVERSE, FORWARD]);
  });

  it('выбор стороны-источника отдаёт pick с именем стороны-ключом и подписью в поле', async () => {
    const field = build();
    await pick(field, FORWARD);
    assert.deepEqual(field.value(), { propertyId: 'p1', side: 'source', key: FORWARD });
    assert.deepEqual(changes, [{ propertyId: 'p1', side: 'source', key: FORWARD }]);
    assert.equal(inputOf(field).value, FORWARD, 'выбранное имя стороны показано в поле');
  });

  it('пункт «без свойства» снимает выбор', async () => {
    const field = build();
    await pick(field, REVERSE);
    assert.deepEqual(field.value(), { propertyId: 'p1', side: 'target', key: REVERSE });
    await pick(field, LINK_PROPERTY_NONE_LABEL);
    assert.equal(field.value(), null);
    assert.equal(inputOf(field).value, '');
    assert.equal(changes.at(-1), null);
  });

  it('живой поиск сужает список; замена строк обновляет подпись выбранного', async () => {
    const field = build();
    const input = inputOf(field);
    await pick(field, FORWARD);
    input.focus();
    await settle();
    input.value = 'включ';
    input.emit('input');
    await settle();
    assert.deepEqual(listNames(), [REVERSE, FORWARD], 'живой поиск оставил свойство с обеими сторонами');
    input.blur();
    assert.equal(input.value, FORWARD, 'потеря фокуса вернула подпись выбранного');
    field.setRows([]);
    assert.equal(input.value, FORWARD, 'строки ушли, но имя выбранной стороны сохранено');
    assert.deepEqual(field.value(), { propertyId: 'p1', side: 'source', key: FORWARD });
  });
});
