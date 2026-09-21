/**
 * Юнит-тесты общего пикера сущностей (client/src/renderer/lib/entity-picker.ts,
 * ADR «выбор сущности — один пикер на типы мыслей, типы связей и мысли»;
 * задача ae0d4ffb вехи 3 версии 0.8.2).
 *
 * Два слоя:
 *  1. Чистая логика списка — `visibleEntityIds` (правило «пустой поиск
 *     показывает ВЕСЬ каталог», включая типы верхнего уровня, у которых
 *     родитель — исключённый из `options` корень иерархии), отступ строк,
 *     каталоги типов. Гоняется без DOM.
 *  2. Встроенное комбо (`buildEntityCombo`) — под минимальным DOM-шимом (тот
 *     же подход, что у suggest-dropdown.test.ts). Проверяется, что фокус на
 *     пустом поле и каретка ▾ показывают полный каталог ОДИН раз (регрессия
 *     двойного списка), что строки — облачка с иерархическим отступом и
 *     тогглом, что у типа связи есть свотч и подпись «прямое / обратное», и
 *     что строка «Создать новый» вызывает `onCreateNew`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LinkType, ThoughtType } from '@etn/shared';

import {
  buildEntityCombo,
  linkTypeEntityOptions,
  normalizeParentTypeId,
  pickEntitiesModal,
  thoughtTypeEntityOptions,
  typeRowIndentSteps,
  visibleEntityIds,
  type EntityOption,
} from '../src/renderer/lib/entity-picker.js';
import { store } from '../src/renderer/state.js';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Каталоги типов
// ---------------------------------------------------------------------------

function tt(
  id: string,
  name: string,
  parentId: string | null,
  extra: Partial<ThoughtType> = {},
): ThoughtType {
  return {
    id,
    name,
    parent_id: parentId,
    is_root: false,
    icon: null,
    icon_kind: 'emoji',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    description: null,
    comment_template_md: null,
    version: 1,
    created_at: '',
    updated_at: '',
    created_by: '',
    ...extra,
  };
}

function lt(id: string, parentId: string | null, extra: Partial<LinkType> = {}): LinkType {
  return {
    id,
    name_forward: `f${id}`,
    name_reverse: `r${id}`,
    parent_id: parentId,
    is_root: false,
    color: null,
    style: null,
    width: null,
    description: null,
    version: 1,
    created_at: '',
    updated_at: '',
    created_by: '',
    ...extra,
  };
}

/** root → (a → b), c — плоское дерево из двух уровней. */
const ROOT = tt('root', 'основной тип', 'root', { is_root: true });
const A = tt('a', 'Проект', 'root');
const B = tt('b', 'Задача', 'a');
const C = tt('c', 'Архив', 'root');
const THOUGHT_TYPES = [ROOT, A, B, C];

const LINK_ROOT = lt('lroot', 'lroot', { is_root: true });
const LINK_A = lt('la', 'lroot');
const LINK_B = lt('lb', 'la', { color: '#123456', style: 'dashed', width: 3 });
const LINK_TYPES = [LINK_ROOT, LINK_A, LINK_B];

// ---------------------------------------------------------------------------
// Чистая логика
// ---------------------------------------------------------------------------

describe('entity-picker: каталоги типов без корня иерархии', () => {
  it('thoughtTypeEntityOptions убирает корень и сдвигает глубины', () => {
    const options = thoughtTypeEntityOptions(THOUGHT_TYPES);
    assert.deepEqual(
      options.map((o) => [o.id, o.depth, o.parentId]),
      [
        ['c', 1, 'root'],
        ['a', 1, 'root'],
        ['b', 2, 'a'],
      ],
    );
    assert.ok(options.every((o) => o.selectable === true));
    // Облачко резолвит значок/цвета/начертание по типу.
    assert.ok(options.every((o) => o.cloud.type_id === o.id));
  });

  it('linkTypeEntityOptions подписывает «прямое / обратное» и несёт свотч', () => {
    const options = linkTypeEntityOptions(LINK_TYPES);
    assert.deepEqual(options.map((o) => o.id), ['la', 'lb']);
    assert.deepEqual(options.map((o) => o.depth), [1, 2]);
    assert.equal(options[0]!.title, 'fla / rla');
    assert.deepEqual(options[1]!.line, { color: '#123456', style: 'dashed', width: 3 });
    // Обратное имя остаётся доступным для поиска.
    assert.equal(options[0]!.searchText, 'rla');
  });
});

describe('entity-picker: пустой поиск показывает весь каталог', () => {
  const options = thoughtTypeEntityOptions(THOUGHT_TYPES);
  const noneExpanded = new Set<string>();

  it('иерархический каталог: верхний уровень виден, хотя корня нет в options', () => {
    // Регрессия: `parentId` верхнеуровневых типов ссылается на корень
    // иерархии, исключённый из options (`thoughtTypeEntityOptions`), поэтому
    // без правила «отсутствующий родитель раскрыт» верхний уровень пропадал
    // и по пустому запросу оставался только потомок a → b.
    const visible = visibleEntityIds(options, '', noneExpanded);
    assert.deepEqual([...visible].sort(), ['a', 'c']);
  });

  it('плоский каталог: все варианты без родителя видны', () => {
    const flat: EntityOption[] = [
      { id: 'x', title: 'X', parentId: null, selectable: true, cloud: { id: 'x', title: 'X' } },
      { id: 'y', title: 'Y', selectable: true, cloud: { id: 'y', title: 'Y' } },
    ];
    assert.deepEqual([...visibleEntityIds(flat, '', noneExpanded)], ['x', 'y']);
  });

  it('раскрытый родитель открывает потомков, свёрнутый — нет', () => {
    assert.deepEqual([...visibleEntityIds(options, '', new Set(['a']))].sort(), ['a', 'b', 'c']);
    assert.deepEqual([...visibleEntityIds(options, '', noneExpanded)].sort(), ['a', 'c']);
  });

  it('непустой поиск оставляет совпадения с цепочкой предков', () => {
    const visible = visibleEntityIds(options, 'зада', noneExpanded);
    assert.deepEqual([...visible].sort(), ['a', 'b']);
  });

  it('отступ строки: верхний уровень — 0 шагов, потомок — 1', () => {
    assert.equal(typeRowIndentSteps(1), 0);
    assert.equal(typeRowIndentSteps(2), 1);
    assert.equal(typeRowIndentSteps(undefined), 0);
  });
});

// ---------------------------------------------------------------------------
// DOM-шим
// ---------------------------------------------------------------------------

interface ShimWindow {
  innerWidth: number;
  innerHeight: number;
  addEventListener(type: string, listener: (event: any) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (event: any) => void, capture?: boolean): void;
}

function installShim(): { body: ShimElement; pressEscape: () => void } {
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body,
  };
  /** Слушатели `window` — каркас диалога вешает сюда Esc и Ctrl+Enter. */
  const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];
  const win: ShimWindow = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type, listener) => {
      windowListeners.push({ type, listener });
    },
    removeEventListener: (type, listener) => {
      const index = windowListeners.findIndex((l) => l.type === type && l.listener === listener);
      if (index >= 0) windowListeners.splice(index, 1);
    },
  };
  (globalThis as any).window = win;
  /** Нажатие Esc — реальный путь каркаса: его `keydown`-слушатель закрывает диалог. */
  const pressEscape = (): void => {
    const event = {
      key: 'Escape',
      repeat: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false,
      preventDefault: () => {
        event.defaultPrevented = true;
      },
    };
    for (const { type, listener } of [...windowListeners]) {
      if (type === 'keydown') listener(event);
    }
  };
  return { body, pressEscape };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function mousedownEvent(target: unknown): any {
  return { target, preventDefault: () => undefined, stopPropagation: () => undefined };
}

/** Строки открытого списка (класс `type-combo-item`). */
function itemRows(body: ShimElement): ShimElement[] {
  const list = body.children.find((c) => c.classList.contains('type-combo-list'));
  if (list === undefined) return [];
  return list.children.filter((c) => c.classList.contains('type-combo-item'));
}

/** Id-облачка строки (для проверки отсутствия дублей). */
function cloudIds(body: ShimElement): string[] {
  return itemRows(body)
    .map((row) => row.children.find((c) => c.classList.contains('prop-ref-cloud'))?.dataset['id'])
    .filter((id): id is string => id !== undefined);
}

/** Рекурсивный поиск первого элемента по классу (поле выбора вложено в рамку
 *  `.entity-combo-field`, поэтому прямой перебор детей корня не годится). */
function findByClass(root: ShimElement, cls: string): ShimElement | undefined {
  if (root.classList.contains(cls)) return root;
  for (const child of root.children) {
    const found = findByClass(child, cls);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Все элементы с классом (для проверки отсутствия/наличия частей). */
function findAllByClass(root: ShimElement, cls: string): ShimElement[] {
  const out: ShimElement[] = [];
  if (root.classList.contains(cls)) out.push(root);
  for (const child of root.children) out.push(...findAllByClass(child, cls));
  return out;
}

/** Части поля одиночного выбора. */
function parts(combo: { root: HTMLElement }): {
  input: ShimElement;
  caret: ShimElement;
  pick: ShimElement;
  field: ShimElement;
  valueHost: ShimElement;
} {
  const root = combo.root as unknown as ShimElement;
  const input = findByClass(root, 'entity-combo-input');
  const caret = findByClass(root, 'entity-combo-caret');
  const pick = findByClass(root, 'entity-combo-pick');
  const field = findByClass(root, 'entity-combo-field');
  const valueHost = findByClass(root, 'entity-combo-value');
  assert.ok(input !== undefined, 'в комбо есть строка ввода');
  assert.ok(caret !== undefined, 'в комбо есть каретка');
  assert.ok(pick !== undefined, 'в комбо есть кнопка «…»');
  assert.ok(field !== undefined, 'в комбо есть рамка поля');
  assert.ok(valueHost !== undefined, 'в комбо есть хост значения');
  return { input, caret, pick, field, valueHost };
}

/** Облачко значения в поле (класс `.prop-ref-cloud`), или `undefined`. */
function valueCloud(combo: { root: HTMLElement }): ShimElement | undefined {
  const root = combo.root as unknown as ShimElement;
  return findByClass(root, 'prop-ref-cloud');
}

// ---------------------------------------------------------------------------
// Встроенное комбо: каталог, каретка, иерархия, создание
// ---------------------------------------------------------------------------

describe('entity-picker: встроенное комбо', () => {
  it('фокус на пустом поле показывает весь каталог, включая верхний уровень', async () => {
    const { body } = installShim();
    store.update({ thoughtTypes: THOUGHT_TYPES });
    const combo = buildEntityCombo({ networkId: 'n', kind: 'thought-types', value: null, emptyLabel: 'без типа', onChange: () => undefined });
    const { input } = parts(combo);
    input.emit('focus');
    await flush();
    assert.deepEqual(cloudIds(body), ['c', 'a'], 'верхний уровень виден; потомок свёрнутого a скрыт');
  });

  it('каретка ▾ не дублирует каталог (единственный источник, регрессия двойного списка)', async () => {
    const { body } = installShim();
    store.update({ thoughtTypes: THOUGHT_TYPES });
    const combo = buildEntityCombo({ networkId: 'n', kind: 'thought-types', value: null, emptyLabel: 'без типа', onChange: () => undefined });
    const { input, caret } = parts(combo);
    // Поле пустое: ручное открытие раньше будило и «empty»-, и «typed»-источник,
    // и каталог рисовался дважды.
    caret.emit('mousedown', mousedownEvent(caret));
    caret.emit('click');
    await flush();
    const ids = cloudIds(body);
    assert.deepEqual(ids, ['c', 'a'], 'каталог показан один раз, без повторов');
    assert.equal(new Set(ids).size, ids.length, 'дублей нет');
    assert.equal(input.value, '', 'каретка не подставляет текст');
  });

  it('строка типа — облачко с иерархическим отступом; тоггл раскрывает потомков', async () => {
    const { body } = installShim();
    store.update({ thoughtTypes: THOUGHT_TYPES });
    const combo = buildEntityCombo({ networkId: 'n', kind: 'thought-types', value: null, onChange: () => undefined });
    const { input } = parts(combo);
    input.emit('focus');
    await flush();
    const rows = itemRows(body);
    // c, a — строки первого уровня; у каждой есть колонка тоггла/листа.
    const rowA = rows.find((r) => r.children.some((c) => c.dataset['id'] === 'a'));
    assert.ok(rowA !== undefined, 'строка типа a есть');
    assert.equal(rowA!.style.paddingLeft, '8px', 'верхний уровень — без отступа');
    const cloud = rowA!.children.find((c) => c.classList.contains('prop-ref-cloud'));
    assert.ok(cloud !== undefined, 'строка типа — облачко (значок/цвета/начертание)');
    assert.ok(cloud!.classList.contains('cloud-width-container'));

    // Клик по тогглу a раскрывает b.
    const toggle = rowA!.children.find((c) => c.classList.contains('type-combo-toggle'));
    assert.ok(toggle !== undefined, 'у узла с потомками есть тоггл');
    toggle!.emit('click', { preventDefault: () => undefined, stopPropagation: () => undefined });
    await flush();
    assert.deepEqual(cloudIds(body), ['c', 'a', 'b'], 'тоггл раскрыл потомков');
    const rowB = itemRows(body).find((r) => r.children.some((c) => c.dataset['id'] === 'b'));
    assert.equal(rowB!.style.paddingLeft, '24px', 'потомок сдвинут на шаг');
  });

  it('expandAll раскрывает дерево целиком', async () => {
    const { body } = installShim();
    store.update({ thoughtTypes: THOUGHT_TYPES });
    const combo = buildEntityCombo({ networkId: 'n', kind: 'thought-types', value: null, expandAll: true, onChange: () => undefined });
    const { input } = parts(combo);
    input.emit('focus');
    await flush();
    assert.deepEqual(cloudIds(body), ['c', 'a', 'b']);
  });

  it('тип связи: свотч линии и подпись «прямое / обратное»', async () => {
    const { body } = installShim();
    store.update({ linkTypes: LINK_TYPES });
    const combo = buildEntityCombo({ networkId: 'n', kind: 'link-types', value: null, expandAll: true, onChange: () => undefined });
    const { input } = parts(combo);
    input.emit('focus');
    await flush();
    const rowB = itemRows(body).find((r) => r.children.some((c) => c.dataset['id'] === 'lb'));
    assert.ok(rowB !== undefined, 'строка типа связи lb есть');
    const swatch = rowB!.children.find((c) => c.classList.contains('type-combo-swatch'));
    assert.ok(swatch !== undefined, 'у типа связи есть свотч линии');
    assert.equal(swatch!.style.borderTop, '3px dashed #123456');
    const cloud = rowB!.children.find((c) => c.classList.contains('prop-ref-cloud'));
    assert.equal(cloud!.children.find((c) => c.tagName === 'span')?.textContent, 'flb / rlb');
  });

  it('«Создать новый» появляется на запрос без совпадений и вызывает onCreateNew', async () => {
    const { body } = installShim();
    store.update({ thoughtTypes: THOUGHT_TYPES });
    const queries: string[] = [];
    const combo = buildEntityCombo({
      networkId: 'n',
      kind: 'thought-types',
      value: null,
      onChange: () => undefined,
      onCreateNew: async (query) => {
        queries.push(query);
        return null;
      },
    });
    const { input } = parts(combo);
    input.emit('focus');
    await flush();
    input.value = 'новая сущность';
    input.emit('input');
    await flush();
    const createRow = itemRows(body).find((r) => r.classList.contains('type-combo-create'));
    assert.ok(createRow !== undefined, 'строка создания показана');
    createRow!.click();
    await flush();
    assert.deepEqual(queries, ['новая сущность'], 'onCreateNew получил запрос');
  });

  it('есть совпадения — строки создания нет', async () => {
    const { body } = installShim();
    store.update({ thoughtTypes: THOUGHT_TYPES });
    const combo = buildEntityCombo({
      networkId: 'n',
      kind: 'thought-types',
      value: null,
      onChange: () => undefined,
      onCreateNew: async () => null,
    });
    const { input } = parts(combo);
    input.emit('focus');
    await flush();
    input.value = 'зада';
    input.emit('input');
    await flush();
    assert.ok(
      !itemRows(body).some((r) => r.classList.contains('type-combo-create')),
      'при совпадениях создание не предлагается',
    );
  });
});

describe('entity-picker: поле одиночного выбора — заполнено = только просмотр (ba2f57d3)', () => {
  it('пустое значение: строка живого поиска и каретка видны, облачка нет', () => {
    installShim();
    store.update({ thoughtTypes: THOUGHT_TYPES });
    const combo = buildEntityCombo({
      networkId: 'n',
      kind: 'thought-types',
      value: null,
      emptyLabel: 'без типа',
      placeholder: 'без типа',
      onChange: () => undefined,
    });
    const { input, caret } = parts(combo);
    assert.equal(input.classList.contains('hidden'), false, 'пусто — строка ввода доступна');
    assert.equal(caret.classList.contains('hidden'), false, 'пусто — каретка доступна');
    assert.equal(valueCloud(combo), undefined, 'пусто — облачка значения нет');
  });

  it('заполненное значение: облачко прямо в поле, ввод и каретка недоступны', () => {
    installShim();
    store.update({ thoughtTypes: THOUGHT_TYPES });
    const combo = buildEntityCombo({
      networkId: 'n',
      kind: 'thought-types',
      value: 'a',
      onChange: () => undefined,
    });
    const { input, caret, field } = parts(combo);
    const cloud = valueCloud(combo);
    assert.ok(cloud !== undefined, 'значение показано облачком в поле');
    assert.equal(cloud!.dataset['id'], 'a');
    assert.ok(field.contains(cloud!), 'облачко лежит ВНУТРИ рамки поля');
    assert.equal(
      input.classList.contains('hidden'),
      true,
      'заполнено — строка ввода недоступна (нет второго поля рядом с облачком)',
    );
    assert.equal(caret.classList.contains('hidden'), true, 'заполнено — каретка скрыта');
  });

  it('крестик на облачке очищает значение и возвращает ввод', () => {
    installShim();
    store.update({ thoughtTypes: THOUGHT_TYPES });
    const changes: Array<string | null> = [];
    const combo = buildEntityCombo({
      networkId: 'n',
      kind: 'thought-types',
      value: 'a',
      onChange: (id) => changes.push(id),
    });
    const { input, caret } = parts(combo);
    const remove = findByClass(combo.root as unknown as ShimElement, 'st-f-clear-inline');
    assert.ok(remove !== undefined, 'у облачка значения есть крестик очистки');
    remove!.emit('click', { stopPropagation: () => undefined });
    assert.deepEqual(changes, [null], 'крестик очистил значение');
    assert.equal(valueCloud(combo), undefined, 'облачко убрано');
    assert.equal(input.classList.contains('hidden'), false, 'поле снова принимает ввод');
    assert.equal(caret.classList.contains('hidden'), false, 'каретка вернулась');
    assert.equal(combo.value(), null);
  });

  it('кнопка «…» открывает диалог одиночного выбора и применяет выбранное', async () => {
    const { body } = installShim();
    store.update({ thoughtTypes: THOUGHT_TYPES });
    const changes: Array<string | null> = [];
    const combo = buildEntityCombo({
      networkId: 'n',
      kind: 'thought-types',
      value: 'a',
      onChange: (id) => changes.push(id),
    });
    const { pick } = parts(combo);
    pick.click();
    await flush();
    await flush();
    const rows = findAllByClass(body, 'entity-pick-row');
    assert.ok(rows.length > 0, 'диалог «…» показал каталог типов');
    const target = rows.find((r) => findByClass(r, 'prop-ref-cloud')?.dataset['id'] === 'c');
    assert.ok(target !== undefined, 'в диалоге есть строка типа c');
    target!.click();
    await flush();
    assert.deepEqual(changes, ['c'], 'диалог применил выбранный единственный тип');
    assert.equal(combo.value(), 'c');
    assert.equal(valueCloud(combo)?.dataset['id'], 'c', 'новое значение показано в поле');
  });

  it('disabled: «…» не открывает диалог и крестика очистки нет', () => {
    installShim();
    store.update({ thoughtTypes: THOUGHT_TYPES });
    const changes: Array<string | null> = [];
    const combo = buildEntityCombo({
      networkId: 'n',
      kind: 'thought-types',
      value: 'a',
      disabled: true,
      onChange: (id) => changes.push(id),
    });
    const { pick, input } = parts(combo);
    assert.equal(pick.disabled, true, 'кнопка «…» выключена');
    assert.equal(input.disabled, true, 'строка ввода выключена');
    assert.equal(
      findByClass(combo.root as unknown as ShimElement, 'st-f-clear-inline'),
      undefined,
      'у выключенного поля крестика очистки нет',
    );
  });
});

describe('normalizeParentTypeId — служебный корень это «без родителя»', () => {
  // Регрессия e0a4345 (0.8.2): у типов верхнего уровня parent_id указывает на
  // служебный корень иерархии (миграция 021), корень в каталог вариантов не
  // попадает — без нормализации комбо рисовал его сырой id чипом.
  it('id корня нормализуется в null, чужой id и null проходят как есть', () => {
    const ROOT = '00000000-0000-4000-8000-000000000002';
    assert.equal(normalizeParentTypeId(ROOT, ROOT), null);
    assert.equal(normalizeParentTypeId('11111111-1111-4111-8111-111111111111', ROOT), '11111111-1111-4111-8111-111111111111');
    assert.equal(normalizeParentTypeId(null, ROOT), null);
    // корня нет в каталоге (пустой store) — значение не трогаем
    assert.equal(normalizeParentTypeId(ROOT, undefined), ROOT);
    assert.equal(normalizeParentTypeId(ROOT, null), ROOT);
  });
});

// ---------------------------------------------------------------------------
// Команды-иконки верхней строки чек-листа (ошибка bd8b78a0)
// ---------------------------------------------------------------------------

describe('entity-picker: команды-иконки верхней строки чек-листа (bd8b78a0)', () => {
  /** Варианты каталога для диалога без обращения к store. */
  const CATALOGUE: EntityOption[] = [
    { id: 'la', title: 'f / r', selectable: true, cloud: { id: 'la', title: 'f / r' } },
    { id: 'lb', title: 'g / s', selectable: true, cloud: { id: 'lb', title: 'g / s' } },
  ];

  it('верхняя строка = поиск + команды-иконки, футер = «Отмена»/применение', () => {
    const { body } = installShim();
    void pickEntitiesModal({
      networkId: 'n',
      kind: 'link-types',
      title: 'Фильтр типов связей на карте',
      catalogue: CATALOGUE,
      currentIds: ['la'],
      allowEmpty: false,
      applyLabel: 'Применить и закрыть',
      commands: () => [
        { icon: 'check-check', title: 'Пометить все', onClick: () => undefined },
        { icon: 'rotate-ccw', title: 'Вернуть умолчания', onClick: () => undefined },
      ],
    });

    const backdrop = body.children[0];
    assert.ok(backdrop, 'диалог смонтирован');

    // Верхняя строка: строка поиска и три команды-иконки (общая «Очистить» +
    // две команды вызывающего) — справа от поиска, текстовых надписей нет.
    const searchbar = findByClass(backdrop, 'st-f-searchbar');
    assert.ok(searchbar, 'есть верхняя строка');
    assert.ok(findByClass(searchbar, 'st-f-search'), 'в верхней строке есть поиск');
    const commands = findAllByClass(searchbar, 'icon-btn');
    assert.equal(commands.length, 3, 'три команды-иконки в верхней строке');
    assert.deepEqual(
      commands.map((b) => b.title),
      ['Очистить', 'Пометить все', 'Вернуть умолчания'],
      'тултипы несут полные названия команд',
    );
    for (const btn of commands) {
      assert.equal(btn.getAttribute('aria-label'), btn.title, 'кнопка доступна по aria-label');
    }

    // Футер: ровно «Отмена» и «Применить и закрыть», без команд.
    const footerButtons = findAllByClass(backdrop, 'dialog-btn');
    assert.deepEqual(
      footerButtons.map((b) => b.textContent),
      ['Отмена', 'Применить и закрыть'],
      'в футере только отмена и применение',
    );
    assert.equal(
      findAllByClass(backdrop, 'st-f-searchbar').length,
      1,
      'команды не продублированы в футере',
    );
  });

  it('«Очистить» в верхней строке снимает отметки', () => {
    const { body } = installShim();
    void pickEntitiesModal({
      networkId: 'n',
      kind: 'link-types',
      title: 'Фильтр',
      catalogue: CATALOGUE,
      currentIds: ['la', 'lb'],
      allowEmpty: true,
    });
    const backdrop = body.children[0];
    assert.ok(backdrop, 'диалог смонтирован');
    const clear = findAllByClass(backdrop, 'icon-btn')[0];
    assert.ok(clear, 'есть кнопка «Очистить»');
    assert.equal(clear.disabled, false, 'при непустом наборе активна');
    clear.click();
    // После очистки кнопка выключается (updateButtons).
    assert.equal(clear.disabled, true, 'пустой набор выключает «Очистить»');
  });
});

// ---------------------------------------------------------------------------
// Завершение модального чек-листа (ошибка c9bd04ed)
// ---------------------------------------------------------------------------

describe('entity-picker: завершение модального чек-листа (c9bd04ed)', () => {
  /** Плоский каталог типов мыслей для диалога без обращения к store. */
  const CATALOGUE: EntityOption[] = [
    { id: 'ta', title: 'Проект', selectable: true, cloud: { id: 'ta', title: 'Проект' } },
    { id: 'tb', title: 'Задача', selectable: true, cloud: { id: 'tb', title: 'Задача' } },
  ];

  it('одиночный выбор: клик по строке возвращает выбор И закрывает диалог', async () => {
    // Регрессия c9bd04ed: клик по строке резолвил промис, но диалог оставался
    // поверх всего — закрывали его только кнопки футера.
    const { body } = installShim();
    let result: string[] | null | undefined;
    const done = pickEntitiesModal({
      networkId: 'n',
      kind: 'thought-types',
      title: 'Выбрать тип мысли',
      catalogue: CATALOGUE,
      single: true,
    }).then((ids) => {
      result = ids;
    });
    assert.equal(body.children.length, 1, 'диалог открыт');
    const rows = findAllByClass(body.children[0]!, 'entity-pick-row');
    assert.equal(rows.length, 2, 'каталог показан целиком');
    rows[0]!.click();
    await done;
    assert.deepEqual(result, ['ta'], 'одиночный выбор вернул выбранный id');
    assert.equal(body.children.length, 0, 'диалог закрыт сразу после выбора');
  });

  it('одиночный выбор: в футере только «Отмена» (применения нет)', () => {
    const { body } = installShim();
    void pickEntitiesModal({
      networkId: 'n',
      kind: 'thought-types',
      title: 'Выбрать тип мысли',
      catalogue: CATALOGUE,
      single: true,
    });
    const backdrop = body.children[0];
    assert.ok(backdrop, 'диалог смонтирован');
    assert.deepEqual(
      findAllByClass(backdrop, 'dialog-btn').map((b) => b.textContent),
      ['Отмена'],
      'одиночный режим завершается выбором строки, а не кнопкой применения',
    );
  });

  it('множественный выбор: клик по строке не закрывает, закрывает применение', async () => {
    const { body } = installShim();
    let result: string[] | null | undefined;
    const done = pickEntitiesModal({
      networkId: 'n',
      kind: 'thought-types',
      title: 'Типы мыслей',
      catalogue: CATALOGUE,
      currentIds: ['tb'],
    }).then((ids) => {
      result = ids;
    });
    const backdrop = body.children[0];
    assert.ok(backdrop, 'диалог смонтирован');
    // Клик по строке в множественном режиме отмечает вариант, но диалог не
    // закрывает и ничего не возвращает (в отличие от одиночного).
    findAllByClass(backdrop, 'entity-pick-row')[0]!.click();
    assert.equal(body.children.length, 1, 'клик по строке не закрыл диалог');
    assert.equal(result, undefined, 'до применения результат не отдан');
    const apply = findAllByClass(backdrop, 'dialog-btn').find((b) => b.textContent === 'Применить');
    assert.ok(apply, 'в футере есть кнопка применения');
    apply!.click();
    await done;
    assert.deepEqual(result, ['tb'], 'применение отдало текущий набор');
    assert.equal(body.children.length, 0, 'применение закрыло диалог');
  });
});

// ---------------------------------------------------------------------------
// Отмена модального чек-листа резолвит промис (ошибка 12dfb87e)
// ---------------------------------------------------------------------------

describe('entity-picker: отмена модального чек-листа (12dfb87e)', () => {
  /** Плоский каталог типов мыслей для диалога без обращения к store. */
  const CATALOGUE: EntityOption[] = [
    { id: 'ta', title: 'Проект', selectable: true, cloud: { id: 'ta', title: 'Проект' } },
    { id: 'tb', title: 'Задача', selectable: true, cloud: { id: 'tb', title: 'Задача' } },
  ];

  /** Кнопка «Отмена» футера открытого диалога. */
  function cancelButton(backdrop: ShimElement): ShimElement {
    const btn = findAllByClass(backdrop, 'dialog-btn').find((b) => b.textContent === 'Отмена');
    assert.ok(btn !== undefined, 'в футере есть «Отмена»');
    return btn!;
  }

  it('кнопка «Отмена» (одиночный режим) резолвит промис в null и закрывает диалог', async () => {
    // Регрессия 12dfb87e: у «Отмены» не было onClick, а `closeSelf` из правки
    // c9bd04ed только снимал диалог — промис висел вечно.
    const { body } = installShim();
    let result: string[] | null | undefined;
    const done = pickEntitiesModal({
      networkId: 'n',
      kind: 'thought-types',
      title: 'Выбрать тип мысли',
      catalogue: CATALOGUE,
      single: true,
    }).then((ids) => {
      result = ids;
    });
    const backdrop = body.children[0];
    assert.ok(backdrop !== undefined, 'диалог смонтирован');
    cancelButton(backdrop).click();
    await done;
    assert.equal(result, null, 'отмена отдана как null, а не зависшим промисом');
    assert.equal(body.children.length, 0, 'диалог закрыт');
  });

  it('Esc резолвит промис в null (путь закрытия каркаса)', async () => {
    const { body, pressEscape } = installShim();
    let result: string[] | null | undefined;
    const done = pickEntitiesModal({
      networkId: 'n',
      kind: 'thought-types',
      title: 'Типы мыслей',
      catalogue: CATALOGUE,
      currentIds: ['ta'],
    }).then((ids) => {
      result = ids;
    });
    assert.equal(body.children.length, 1, 'диалог открыт');
    pressEscape();
    await done;
    assert.equal(result, null, 'Esc — отмена, промис резолвлен');
    assert.equal(body.children.length, 0, 'Esc снял диалог');
  });

  it('× в заголовке резолвит промис в null', async () => {
    const { body } = installShim();
    let result: string[] | null | undefined;
    const done = pickEntitiesModal({
      networkId: 'n',
      kind: 'thought-types',
      title: 'Выбрать тип мысли',
      catalogue: CATALOGUE,
      single: true,
    }).then((ids) => {
      result = ids;
    });
    const backdrop = body.children[0];
    assert.ok(backdrop !== undefined, 'диалог смонтирован');
    const closeBtn = findAllByClass(backdrop, 'dialog-close')[0];
    assert.ok(closeBtn !== undefined, 'в заголовке есть ×');
    closeBtn!.click();
    await done;
    assert.equal(result, null, '× — отмена');
    assert.equal(body.children.length, 0, 'диалог закрыт');
  });

  it('множественный чек-лист: «Отмена» отдаёт null, а не текущий набор', async () => {
    const { body } = installShim();
    let result: string[] | null | undefined;
    const done = pickEntitiesModal({
      networkId: 'n',
      kind: 'thought-types',
      title: 'Типы мыслей',
      catalogue: CATALOGUE,
      currentIds: ['ta'],
    }).then((ids) => {
      result = ids;
    });
    const backdrop = body.children[0];
    assert.ok(backdrop !== undefined, 'диалог смонтирован');
    // «Очистить» меняет набор, но промис до завершения молчит.
    findAllByClass(backdrop, 'icon-btn')[0]!.click();
    assert.equal(result, undefined, 'до завершения результат не отдан');
    cancelButton(backdrop).click();
    await done;
    assert.equal(result, null, 'отмена отдана как null даже при пустом наборе');
  });

  it('применение пустого набора отдаёт [], а не null (отмена отличима)', async () => {
    const { body } = installShim();
    let result: string[] | null | undefined;
    const done = pickEntitiesModal({
      networkId: 'n',
      kind: 'thought-types',
      title: 'Типы мыслей',
      catalogue: CATALOGUE,
    }).then((ids) => {
      result = ids;
    });
    const backdrop = body.children[0];
    assert.ok(backdrop !== undefined, 'диалог смонтирован');
    const apply = findAllByClass(backdrop, 'dialog-btn').find((b) => b.textContent === 'Применить');
    assert.ok(apply !== undefined, 'в футере есть «Применить»');
    apply!.click();
    await done;
    assert.deepEqual(result, [], 'осознанное применение пустого набора — []');
  });

  it('встроенное комбо: отмена в диалоге «…» не меняет значение', async () => {
    // Ветка `if (ids === null) return;` в `openPicker` была недостижима
    // (ошибка 12dfb87e) — теперь отмена доходит до вызывающего.
    const { body } = installShim();
    store.update({ thoughtTypes: THOUGHT_TYPES });
    const calls: Array<string | null> = [];
    const combo = buildEntityCombo({
      networkId: 'n',
      kind: 'thought-types',
      value: null,
      onChange: (id) => calls.push(id),
    });
    parts(combo).pick.click();
    await flush();
    const backdrop = body.children[0];
    assert.ok(backdrop !== undefined, 'диалог «…» открыт');
    cancelButton(backdrop).click();
    await flush();
    assert.deepEqual(calls, [], 'отмена не позвала onChange');
    assert.equal(combo.value(), null, 'значение осталось пустым');
  });

  it('встроенное комбо: выбор в диалоге «…» по-прежнему задаёт значение', async () => {
    const { body } = installShim();
    store.update({ thoughtTypes: THOUGHT_TYPES });
    const calls: Array<string | null> = [];
    const combo = buildEntityCombo({
      networkId: 'n',
      kind: 'thought-types',
      value: null,
      onChange: (id) => calls.push(id),
    });
    parts(combo).pick.click();
    await flush();
    const backdrop = body.children[0];
    assert.ok(backdrop !== undefined, 'диалог «…» открыт');
    const row = findAllByClass(backdrop, 'entity-pick-row')[0];
    assert.ok(row !== undefined, 'каталог показан');
    row!.click();
    await flush();
    assert.deepEqual(calls, ['c'], 'выбор строки задал значение');
    assert.equal(combo.value(), 'c', 'значение в поле обновилось');
    assert.equal(body.children.length, 0, 'диалог закрыт выбором');
  });
});
