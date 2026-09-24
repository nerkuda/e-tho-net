/**
 * Юнит-тесты переиспользуемого поля выбора свойства-связи с живым поиском
 * (`client/src/renderer/lib/link-property-field.ts`, ошибки dc175a5b / 5817b009).
 *
 * Проверяются:
 *  1. чистая модель вариантов — по одному пункту на имя стороны свойства-связи,
 *     единый алфавитный порядок, пара имён типа связи в скобках «(прямое -> обратное)»
 *     и спецификация значка конца связи (направление — вниз/вверх,
 *     задача 88def930);
 *  2. живой поиск — тот же фильтр, что у общего списка свойств (по имени
 *     стороны, по обратному имени пары, по описанию); скаляры и структурные
 *     «Родители»/«Потомки» в поле не предлагаются;
 *  3. само поле — обычный ввод (не `select`) с живым поиском, список открывается
 *     по фокусу, выбор даёт `LinkPropertyPick` с именем стороны-ключом, «без
 *     свойства» снимает выбор, замена строк (`setRows`) обновляет подпись;
 *  4. паттерн как у поля типа мысли (ошибка 5817b009): кнопка «…» открывает
 *     диалог выбора с полным списком, поиском внутри и теми же подписями;
 *     выпадашка живого поиска имеет свою минимальную ширину (имена не помещались).
 *
 * Модуль гоняется под Node с общим DOM-шимом (`dom-shim.ts`), как соседние
 * тесты списка свойств и выпадашки подсказок.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LinkType } from '@etn/shared';

import {
  LINK_PROPERTY_DROPDOWN_MIN_WIDTH,
  LINK_PROPERTY_NONE_LABEL,
  LINK_PROPERTY_PICKER_WIDTH,
  buildLinkPropertyField,
  filterLinkPropertyOptions,
  linkPropertyOptions,
  type LinkPropertyPick,
} from '../src/renderer/lib/link-property-field.js';
import { buildPropertyListRows, type PropertyRegistryRow } from '../src/renderer/lib/property-list.js';
import { closeDialog } from '../src/renderer/lib/dialog.js';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// DOM-шим (тот же подход, что у suggest-dropdown.test.ts)
// ---------------------------------------------------------------------------

const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];

function installShim(): void {
  windowListeners.length = 0;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type: string, listener: (event: any) => void) => {
      windowListeners.push({ type, listener });
    },
    removeEventListener: (type: string, listener: (event: any) => void) => {
      const index = windowListeners.findIndex((l) => l.type === type && l.listener === listener);
      if (index >= 0) windowListeners.splice(index, 1);
    },
  };
}
installShim();

/** Тик микрозадач: асинхронная загрузка вариантов выпадашки. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Тело документа (шим). */
function docBody(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

/** Открытый список поля (слой выпадашки живёт в `document.body`). */
function openList(): ShimElement | null {
  return docBody().children.find((c) => c.className.split(/\s+/).includes('type-combo-list')) ?? null;
}

/** Подписи пунктов открытого списка. */
function listNames(): string[] {
  return (openList() ?? new ShimElement('div'))
    .querySelectorAll('.type-combo-item')
    .map((row) => row.querySelectorAll('.type-combo-label')[0]?.textContent ?? '');
}

/** Строки открытого диалога выбора свойства-связи. */
function modalRows(): ShimElement[] {
  return docBody().querySelectorAll('.link-property-option');
}

/** Подписи строк открытого диалога выбора. */
function modalLabels(): string[] {
  return modalRows().map((row) => row.querySelectorAll('.link-property-option-label')[0]?.textContent ?? '');
}

/** Строка диалога с нужной подписью. */
function modalRow(label: string): ShimElement | undefined {
  return modalRows().find(
    (row) => row.querySelectorAll('.link-property-option-label')[0]?.textContent === label,
  );
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
    assert.equal(
      reverse!.pairLabel,
      `(${FORWARD} -> ${REVERSE})`,
      'пара имён типа связи в скобках через « -> » (ошибка 5817b009)',
    );
    assert.equal(forward!.pairLabel, `(${FORWARD} -> ${REVERSE})`, 'пара одна на обе стороны свойства');
    assert.ok(
      options.every((o) => !('sideLabel' in o)),
      'подписей «источник/назначение» у пунктов больше нет (ошибка 5817b009)',
    );
  });

  it('без известного типа связи обратное имя назвать нечем — пары нет', () => {
    const rows = buildPropertyListRows([registryRow({ config: null })], [linkType()]);
    const options = linkPropertyOptions(rows);
    assert.equal(options.length, 1, 'сторона одна — каталог типов связей не разрешил пару');
    assert.equal(options[0]!.pairLabel, null);
  });

  it('значок конца связи: направление вниз/вверх, оформление — эффективное', () => {
    const [reverse, forward] = linkPropertyOptions(SIDES);
    assert.equal(forward!.linkEnd.direction, 'down', 'источник — исходящая, стрелка вниз');
    assert.equal(reverse!.linkEnd.direction, 'up', 'назначение — входящая, стрелка вверх');
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
    // Слой выпадашки и диалог живут в `document.body` и остаются от прошлого
    // случая — начинаем каждый с чистого документа.
    while (docBody().children.some((c) => c.classList.contains('dialog-backdrop'))) closeDialog();
    docBody().replaceChildren();
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
    const list = openList();
    assert.ok(list !== null, 'список открыт');
    assert.equal(
      list!.style.minWidth,
      `${LINK_PROPERTY_DROPDOWN_MIN_WIDTH}px`,
      'у выпадашки своя минимальная ширина — имена помещаются (ошибка 5817b009)',
    );
  });

  it('в поле есть кнопка «…», как у поля типа мысли (ошибка 5817b009)', () => {
    const field = build();
    const pickBtn = field.root.querySelector('.link-property-pick') as unknown as ShimElement | null;
    assert.ok(pickBtn !== null, 'кнопка выбора есть в поле');
    assert.equal(pickBtn!.tagName ?? 'button', 'button');
  });

  it('кнопка «…» открывает диалог с полным списком и поиском внутри', () => {
    const field = build();
    const pickBtn = field.root.querySelector('.link-property-pick') as unknown as ShimElement;
    pickBtn.click();
    assert.deepEqual(
      modalLabels(),
      [LINK_PROPERTY_NONE_LABEL, REVERSE, FORWARD],
      'диалог показывает полный список с пунктом «без свойства»',
    );
    const dialogBox = docBody()
      .querySelectorAll('.dialog-box')
      .find((box) => box.querySelectorAll('.link-property-picker').length > 0);
    assert.equal(
      dialogBox?.style.width,
      `${LINK_PROPERTY_PICKER_WIDTH}px`,
      'диалог выбора свойства-связи — 560px, как и выпадашки (ошибка 5c7f8376)',
    );
    const search = docBody().querySelectorAll('.link-property-search')[0]!;
    search.value = 'включ';
    search.emit('input');
    assert.deepEqual(modalLabels(), [REVERSE, FORWARD], 'поиск внутри диалога сужает список');

    modalRow(FORWARD)!.click();
    assert.deepEqual(field.value(), { propertyId: 'p1', side: 'source', key: FORWARD });
    assert.equal(inputOf(field).value, FORWARD, 'выбор из диалога обновил подпись поля');
    assert.deepEqual(changes, [{ propertyId: 'p1', side: 'source', key: FORWARD }]);
    assert.deepEqual(modalLabels(), [], 'выбор закрыл диалог');
  });

  it('пункт «без свойства» в диалоге снимает выбор', () => {
    const field = build();
    const pickBtn = field.root.querySelector('.link-property-pick') as unknown as ShimElement;
    pickBtn.click();
    modalRow(REVERSE)!.click();
    assert.deepEqual(field.value(), { propertyId: 'p1', side: 'target', key: REVERSE });

    pickBtn.click();
    modalRow(LINK_PROPERTY_NONE_LABEL)!.click();
    assert.equal(field.value(), null);
    assert.equal(inputOf(field).value, '');
    assert.equal(changes.at(-1), null);
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
