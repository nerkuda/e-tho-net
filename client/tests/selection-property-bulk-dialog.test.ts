/**
 * Диалог «Изменить значение свойства…» панели выделения (0.14.1, задача
 * 6ebcd8d6; спека панели 2fc9d85c, сценарий a6b54f0f).
 *
 * Проверяется поведение формы: таблица без колонки «Тип», счётчик «есть у K
 * из N», «разные значения», приглушённое поле без галочки с подписями
 * «не будет применено»/«будет очищено у K», недоступная «Применить» без
 * отметок, подтверждение очистки, итог N/M с причинами, диалог НЕ закрывается
 * после применения, пикер (+) без «Создать новое…» с исключением показанных,
 * пустая таблица и усечение «первые 100 из N», сигналы публикации/refresh.
 *
 * Дом — общий DOM-шим (`dom-shim.ts`): `window.etn` подменён снимком,
 * серверные вызовы считаются. Чистая арифметика строк/плана — в
 * `selection-property-bulk.test.ts`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShimElement } from './dom-shim.js';
import type { LinkPropertyValues, PropertyValue } from '@etn/shared';

type Entry = PropertyValue | LinkPropertyValues;

/** Событие, отправленное в документ (notifyPropertyValuesRefreshed). */
interface RecordedEvent {
  type: string;
  detail?: unknown;
}

const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];
const dispatched: RecordedEvent[] = [];

/**
 * Элемент шима; у вендорской сетки есть методы, которые адаптер
 * `table-grid.ts` вызывает напрямую (в браузере их даёт Vaadin Grid).
 */
function gridFriendlyElement(tag: string): ShimElement {
  const element = new ShimElement(tag);
  if (tag === 'vaadin-grid') {
    const grid = element as unknown as Record<string, unknown>;
    grid['items'] = [];
    grid['columns'] = [];
    grid['clearCache'] = () => undefined;
    grid['generateCellPartNames'] = () => undefined;
    grid['scrollToIndex'] = () => undefined;
    grid['getEventContext'] = () => null;
  }
  return element;
}

class FakeCustomEvent {
  type: string;
  detail: unknown;
  constructor(type: string, init?: { detail?: unknown }) {
    this.type = type;
    this.detail = init?.detail;
  }
}

/** Устанавливает DOM-глобали до динамического импорта модулей под тестом. */
function installShim(): ShimElement {
  windowListeners.length = 0;
  dispatched.length = 0;
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => gridFriendlyElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body,
    documentElement: new ShimElement('html'),
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: (event: RecordedEvent) => {
      dispatched.push(event);
      return true;
    },
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    setTimeout,
    clearTimeout,
    addEventListener: (type: string, listener: (event: any) => void) => {
      windowListeners.push({ type, listener });
    },
    removeEventListener: (type: string, listener: (event: any) => void) => {
      const index = windowListeners.findIndex((l) => l.type === type && l.listener === listener);
      if (index >= 0) windowListeners.splice(index, 1);
    },
  };
  (globalThis as any).CustomEvent = FakeCustomEvent;
  return body;
}

const shimBody = installShim();

const { store } = await import('../src/renderer/state.js');
const { closeDialog } = await import('../src/renderer/lib/dialog.js');
const { showSelectionPropertiesDialog } = await import('../src/renderer/selection/dialogs.js');
const { onQueryInvalidated } = await import('../src/renderer/lib/live/query-registry.js');
const { PROPERTY_VALUES_REFRESHED_EVENT } = await import(
  '../src/renderer/lib/property-values-refresh.js'
);

// ---------------------------------------------------------------------------
// Снимок «сервера»
// ---------------------------------------------------------------------------

interface RegistryRow {
  id: string;
  name: string;
  value_type: 'text' | 'link' | 'bool' | 'url';
  config: Record<string, unknown> | null;
  description: string | null;
  created_at: string;
  updated_at: string;
  types_count: number;
  values_count: number;
}

function registryRow(overrides: Partial<RegistryRow> & Pick<RegistryRow, 'id' | 'name'>): RegistryRow {
  return {
    value_type: 'text',
    config: null,
    description: null,
    created_at: '2026-10-23T00:00:00.000Z',
    updated_at: '2026-10-23T00:00:00.000Z',
    types_count: 0,
    values_count: 0,
    ...overrides,
  };
}

const REGISTRY: RegistryRow[] = [
  registryRow({ id: 'p-status', name: 'Статус' }),
  registryRow({ id: 'p-owner', name: 'Ответственный' }),
  registryRow({ id: 'p-priority', name: 'Приоритет' }),
  registryRow({ id: 'p-flag', name: 'Флаг', value_type: 'bool' }),
  registryRow({
    id: 'p-attach',
    name: 'Прикреплено',
    value_type: 'link',
    config: { link_type_id: 'lt-attach' },
    types_count: 1,
  }),
];

interface ThoughtRow {
  id: string;
  title: string;
  type_id: string | null;
}

const THOUGHTS: ThoughtRow[] = [
  { id: 't-a', title: 'A', type_id: 'type-1' },
  { id: 't-b', title: 'B', type_id: 'type-2' },
  { id: 't-c', title: 'C', type_id: null },
];

/** Состояние «сервера» между вызовами. */
interface ServerState {
  registry: RegistryRow[];
  thoughts: ThoughtRow[];
  values: Map<string, Entry[]>;
  setCalls: Array<{ thoughtId: string; key: string; value: unknown; side: string | null }>;
  removeCalls: Array<{ thoughtId: string; key: string; side: string | null }>;
  /** Пары, которые сервер отвергает (частичная неудача). */
  failPairs: Set<string>;
}

let server: ServerState;

/** Скалярное значение свойства. */
function scalar(
  ownerId: string,
  propertyId: string,
  propertyName: string,
  value: PropertyValue['value'],
  valueType: PropertyValue['value_type'] = 'text',
): PropertyValue {
  return {
    id: `pv-${ownerId}-${propertyId}`,
    owner_type: 'thought',
    owner_id: ownerId,
    property_id: propertyId,
    outside_type: true,
    property_name: propertyName,
    value_type: valueType,
    value,
    updated_at: '2026-10-23T00:00:00.000Z',
  };
}

function propertyOf(key: string): RegistryRow {
  const row = server.registry.find((candidate) => candidate.name === key);
  assert.ok(row !== undefined, `свойство «${key}» есть в реестре`);
  return row!;
}

/** Ставит скалярное значение в снимок «сервера». */
function writeScalar(thoughtId: string, key: string, value: unknown): void {
  const property = propertyOf(key);
  const entries = server.values.get(thoughtId) ?? [];
  const next = entries.filter((entry) => entry.property_id !== property.id);
  next.push(
    scalar(
      thoughtId,
      property.id,
      property.name,
      value as PropertyValue['value'],
      property.value_type === 'bool' ? 'bool' : property.value_type === 'url' ? 'url' : 'text',
    ),
  );
  server.values.set(thoughtId, next);
}

/** Состояние из предусловий сценария a6b54f0f (шаг 2). */
function seedScenario(): void {
  server = {
    registry: REGISTRY,
    thoughts: THOUGHTS,
    values: new Map([
      ['t-a', [scalar('t-a', 'p-status', 'Статус', 'в работе')]],
      [
        't-b',
        [
          scalar('t-b', 'p-status', 'Статус', 'в работе'),
          scalar('t-b', 'p-owner', 'Ответственный', 'Иван'),
        ],
      ],
      // C без «Статуса»: отсутствие не делает значение «разным».
      ['t-c', [scalar('t-c', 'p-owner', 'Ответственный', 'Пётр')]],
    ]),
    setCalls: [],
    removeCalls: [],
    failPairs: new Set(),
  };
  installApi();
}

/** Подменяет `window.etn` снимком «сервера». */
function installApi(): void {
  (globalThis as any).window.etn = {
    thoughts: {
      resolve: async (_networkId: string, ids: string[]) =>
        server.thoughts.filter((thought) => ids.includes(thought.id)),
    },
    propertyRegistry: {
      list: async () => server.registry,
    },
    properties: {
      get: async (_networkId: string, _ownerType: string, ownerId: string) =>
        server.values.get(ownerId) ?? [],
      set: async (
        _networkId: string,
        _ownerType: string,
        ownerId: string,
        key: string,
        value: unknown,
        side: string | null,
      ) => {
        if (server.failPairs.has(`${ownerId}|${key}`)) {
          throw new Error('цель недопустимого типа');
        }
        server.setCalls.push({ thoughtId: ownerId, key, value, side });
        writeScalar(ownerId, key, value);
      },
      remove: async (
        _networkId: string,
        _ownerType: string,
        ownerId: string,
        key: string,
        side: string | null,
      ) => {
        server.removeCalls.push({ thoughtId: ownerId, key, side });
        const property = propertyOf(key);
        const entries = server.values.get(ownerId) ?? [];
        server.values.set(
          ownerId,
          entries.filter((entry) => entry.property_id !== property.id),
        );
      },
    },
    types: {
      getLinkType: async () => {
        throw new Error('нет каталога');
      },
    },
  };
}

/** Микрозадачная пауза: догрузка диалога и промисы применения. */
async function flush(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// Поиск элементов
// ---------------------------------------------------------------------------

function backdrops(): ShimElement[] {
  return shimBody.children.filter((child) => child.classList.contains('dialog-backdrop'));
}

function topBackdrop(): ShimElement {
  const list = backdrops();
  assert.ok(list.length > 0, 'диалог открыт');
  return list[list.length - 1]!;
}

function dialogBodies(): ShimElement[] {
  return backdrops().map((backdrop) => findByClass(backdrop, 'dialog-body')!);
}

function currentBody(): ShimElement {
  const bodies = dialogBodies();
  assert.ok(bodies.length > 0, 'тело диалога есть');
  return bodies[bodies.length - 1]!;
}

function findByClass(root: ShimElement, cls: string): ShimElement | null {
  if (root.classList.contains(cls)) return root;
  for (const child of root.children) {
    const found = findByClass(child, cls);
    if (found !== null) return found;
  }
  return null;
}

function findAllByClass(root: ShimElement, cls: string): ShimElement[] {
  const out: ShimElement[] = [];
  if (root.classList.contains(cls)) out.push(root);
  for (const child of root.children) out.push(...findAllByClass(child, cls));
  return out;
}

/** Элемент-потомок по тегу. */
function findTag(root: ShimElement, tag: string): ShimElement | null {
  if (root.tagName.toLowerCase() === tag) return root;
  for (const child of root.children) {
    const found = findTag(child, tag);
    if (found !== null) return found;
  }
  return null;
}

function tableOf(body: ShimElement): ShimElement {
  const table = findByClass(body, 'prop-bulk-table');
  assert.ok(table !== null, 'таблица свойств есть');
  return table!;
}

function rowsOf(body: ShimElement): ShimElement[] {
  return tableOf(body).children[1]!.children;
}

function rowByKey(body: ShimElement, key: string): ShimElement {
  const row = rowsOf(body).find((candidate) => candidate.dataset['rowKey'] === key);
  assert.ok(row !== undefined, `строка «${key}» есть в таблице`);
  return row!;
}

function checkboxOf(row: ShimElement): ShimElement {
  return row.children[0]!.children[0] as ShimElement;
}

function editorBoxOf(row: ShimElement): ShimElement {
  return row.children[2]!.children[0] as ShimElement;
}

function hintsOf(row: ShimElement): string {
  return row.children[2]!.children[1]?.flatText() ?? '';
}

function textInputOf(row: ShimElement): ShimElement {
  const input = findTag(editorBoxOf(row), 'input');
  assert.ok(input !== null, 'поле ввода значения есть');
  return input!;
}

function footerButton(label: string, backdrop = topBackdrop()): ShimElement {
  const buttons = findAllByClass(backdrop, 'ui-btn').filter(
    (button) => !button.classList.contains('ui-btn--icon'),
  );
  const found = buttons.find((button) => button.textContent === label);
  assert.ok(found !== undefined, `в футере есть кнопка «${label}»`);
  return found!;
}

function hasFooterButton(label: string, backdrop = topBackdrop()): boolean {
  return findAllByClass(backdrop, 'ui-btn').some((button) => button.textContent === label);
}

function check(row: ShimElement, checked: boolean): void {
  const checkbox = checkboxOf(row);
  checkbox.checked = checked;
  checkbox.emit('change', {});
}

function type(input: ShimElement, value: string): void {
  input.value = value;
  input.emit('input', {});
}

/** Открывает диалог и ждёт загрузку. */
async function open(ids: string[]): Promise<ShimElement> {
  showSelectionPropertiesDialog(ids);
  await flush();
  return currentBody();
}

function prepare(): void {
  store.update({ networkId: 'n1', linkTypes: [], selection: [] });
  for (let index = 0; index < 20; index += 1) closeDialog();
  seedScenario();
}

// ---------------------------------------------------------------------------
// Тесты
// ---------------------------------------------------------------------------

describe('диалог значений свойств выделения: таблица (спека 2fc9d85c)', () => {
  it('колонки «флажок | Свойство | Значение», без колонки «Тип»; счётчик K из N', async () => {
    prepare();
    const body = await open(['t-a', 't-b', 't-c']);
    const headRow = tableOf(body).children[0]!.children[0]!;
    assert.deepEqual(
      headRow.children.map((cell) => cell.flatText()),
      ['', 'Свойство', 'Значение'],
      'колонки «Тип» нет — только отметка, свойство, значение',
    );

    const status = rowByKey(body, 'p-status');
    assert.ok(status.children[1]!.flatText().includes('Статус'), 'имя свойства');
    assert.ok(
      status.children[1]!.flatText().includes('есть у 2 из 3'),
      'счётчик присутствия: отсутствие у C не делает значение «разным»',
    );
    assert.equal(textInputOf(status).value, 'в работе', 'наличные одинаковы — значение в поле');
  });

  it('разные значения — поле пустое с подписью; не-текстовое поле — подписью в ячейке', async () => {
    prepare();
    server.values.set('t-c', [scalar('t-c', 'p-owner', 'Ответственный', 'Сидор')]);
    server.values.set('t-a', [
      ...(server.values.get('t-a') ?? []),
      scalar('t-a', 'p-flag', 'Флаг', true, 'bool'),
    ]);
    server.values.set('t-b', [
      ...(server.values.get('t-b') ?? []),
      scalar('t-b', 'p-flag', 'Флаг', false, 'bool'),
    ]);
    const body = await open(['t-a', 't-b', 't-c']);

    const owner = rowByKey(body, 'p-owner');
    assert.equal(textInputOf(owner).value, '', 'разные значения — поле пустое');
    assert.equal(textInputOf(owner).placeholder, 'разные значения', 'у текстового поля — placeholder');

    // Не-текстовое поле (bool): подпись «разные значения» — внешняя, в ячейке;
    // общий редактор значения не расширяется (решение предполёта 2026-10-23).
    const flag = rowByKey(body, 'p-flag');
    assert.ok(hintsOf(flag).includes('разные значения'), 'bool: подпись «разные значения» в ячейке');
    const flagEditor = editorBoxOf(flag);
    assert.ok(findTag(flagEditor, 'select') !== null, 'bool — трёхзначный селект');
    assert.equal(findTag(flagEditor, 'input'), null, 'текстового поля с placeholder у bool нет');
  });

  it('без галочки поле приглушено и не редактируется, «Применить» недоступна', async () => {
    prepare();
    const body = await open(['t-a', 't-b', 't-c']);
    const status = rowByKey(body, 'p-status');
    assert.equal(checkboxOf(status).checked, false, 'чекбокс по умолчанию снят');
    assert.ok(
      editorBoxOf(status).classList.contains('prop-bulk-value-off'),
      'поле приглушено без галочки (не голый disabled)',
    );
    assert.equal(editorBoxOf(status).getAttribute('aria-disabled'), 'true');
    assert.equal(footerButton('Применить').disabled, true, '«Применить» disabled без отмеченных');
  });

  it('пустая таблица — подсказка «добавьте (+)», кнопка (+) остаётся', async () => {
    prepare();
    for (const thought of THOUGHTS) server.values.set(thought.id, []);
    const body = await open(['t-a', 't-b', 't-c']);
    assert.equal(findByClass(body, 'prop-bulk-table'), null, 'таблицы нет');
    const hint = body.flatText();
    assert.ok(hint.includes('У выделенных нет значений свойств — добавьте (+)'), 'подсказка');
    assert.ok(hasFooterButton('Закрыть'), 'диалог открыт');
    const addButton = findAllByClass(body, 'ui-btn').find(
      (button) => button.textContent === '+ свойство',
    );
    assert.ok(addButton !== undefined, 'кнопка (+) доступна и на пустой таблице');
  });

  it('больше 100 выделенных — подпись «обработаны первые 100 из N»', async () => {
    prepare();
    const many: ThoughtRow[] = [];
    for (let index = 0; index < 150; index += 1) {
      many.push({ id: `m-${index}`, title: `M${index}`, type_id: null });
    }
    server.thoughts = many;
    server.values = new Map();
    const body = await open(many.map((thought) => thought.id));
    assert.ok(body.flatText().includes('Обработаны первые 100 из 150'), 'усечение видно');
    assert.equal(findByClass(body, 'prop-bulk-table'), null, 'у новых мыслей значений нет');
  });
});

describe('диалог значений свойств выделения: применение', () => {
  it('галочка + значение — запись всем, без подтверждения; диалог не закрывается, галочки сброшены, итог N', async () => {
    prepare();
    const invalidations: string[] = [];
    const stop = onQueryInvalidated((prefix) => invalidations.push(prefix));
    const body = await open(['t-a', 't-b', 't-c']);

    const status = rowByKey(body, 'p-status');
    check(status, true);
    assert.ok(
      !editorBoxOf(status).classList.contains('prop-bulk-value-off'),
      'поле активно при галочке',
    );
    assert.equal(footerButton('Применить').disabled, false);
    type(textInputOf(status), 'готово');

    footerButton('Применить').click();
    await flush(6);

    assert.equal(server.setCalls.length, 3, 'значение записано всем трём мыслям');
    assert.deepEqual(
      server.setCalls.map((call) => call.thoughtId).sort(),
      ['t-a', 't-b', 't-c'],
      'включая C, у которой свойства не было (станет внетиповым)',
    );
    assert.equal(backdrops().length, 1, 'подтверждение очистки не спрашивалось');
    assert.equal(backdrops().length, 1, 'диалог НЕ закрылся после применения');

    const after = currentBody();
    assert.equal(checkboxOf(rowByKey(after, 'p-status')).checked, false, 'галочки сброшены');
    assert.equal(textInputOf(rowByKey(after, 'p-status')).value, 'готово', 'значения перечитаны');
    assert.ok(
      findAllByClass(topBackdrop(), 'prop-bulk-summary')[0]!.flatText().includes('Применено операций: 3'),
      'итог N в футере',
    );
    assert.ok(
      dispatched.some((event) => event.type === PROPERTY_VALUES_REFRESHED_EVENT),
      'сигнал «значения свойств перечитать» отправлен',
    );
    assert.ok(
      invalidations.includes('pub-assembly'),
      'сигнал состава публикации отправлен (G4)',
    );
    // scheduleRefresh — дебаунс 200 мс: после него инвалидируется окрестность.
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.ok(invalidations.includes('focus'), 'scheduleRefresh инвалидировал окрестность фокуса');
    stop();
  });

  it('частичная неудача не останавливает проход: итог «N, не удалось M» с причинами в диалоге', async () => {
    prepare();
    server.failPairs.add('t-b|Статус');
    const body = await open(['t-a', 't-b', 't-c']);
    const status = rowByKey(body, 'p-status');
    check(status, true);
    type(textInputOf(status), 'готово');

    footerButton('Применить').click();
    await flush(6);

    const after = currentBody();
    assert.ok(
      topBackdrop().flatText().includes('Применено операций: 2, не удалось: 1'),
      'итог N/M в диалоге',
    );
    assert.ok(after.flatText().includes('B, свойство «Статус»: цель недопустимого типа'), 'причина списком');
    assert.equal(backdrops().length, 1, 'диалог открыт');
    assert.equal(server.setCalls.length, 2, 'остальные пары применены');
  });

  it('очистка спрашивает подтверждение и удаляет только там, где было', async () => {
    prepare();
    const body = await open(['t-a', 't-b', 't-c']);
    const owner = rowByKey(body, 'p-owner');
    check(owner, true);
    assert.ok(hintsOf(owner).includes('будет очищено у 2'), 'пометка «будет очищено у K»');

    footerButton('Применить').click();
    await flush(4);

    assert.equal(backdrops().length, 2, 'поверх диалога — подтверждение очистки');
    const confirmBody = currentBody();
    assert.ok(confirmBody.flatText().includes('Очистить значения у 2 мыслей?'), 'вопрос с K');

    // Отказ — ничего не удалено, основной диалог остаётся.
    footerButton('Отмена').click();
    await flush(2);
    assert.equal(server.removeCalls.length, 0, 'отмена подтверждения ничего не удаляет');
    assert.equal(backdrops().length, 1, 'основной диалог открыт');

    footerButton('Применить').click();
    await flush(4);
    footerButton('Очистить').click();
    await flush(6);

    assert.equal(server.removeCalls.length, 2, 'удалено ровно там, где было (B и C)');
    assert.deepEqual(server.removeCalls.map((call) => call.thoughtId).sort(), ['t-b', 't-c']);
    const after = currentBody();
    assert.equal(
      rowsOf(after).some((row) => row.dataset['rowKey'] === 'p-owner'),
      false,
      'строка исчезла: значений не осталось ни у кого',
    );
    assert.ok(topBackdrop().flatText().includes('Применено операций: 2'), 'итог очистки');
  });

  it('снятая галочка: введённое сохраняется, подпись «не будет применено», «Применить» недоступна', async () => {
    prepare();
    const body = await open(['t-a', 't-b', 't-c']);
    const status = rowByKey(body, 'p-status');
    check(status, true);
    type(textInputOf(status), 'архив');
    check(status, false);

    assert.equal(textInputOf(status).value, 'архив', 'введённое сохранено');
    assert.ok(
      editorBoxOf(status).classList.contains('prop-bulk-value-off'),
      'поле приглушено',
    );
    assert.ok(hintsOf(status).includes('не будет применено'), 'подпись «не будет применено»');
    assert.equal(footerButton('Применить').disabled, true, 'нет отмеченных — применять нечего');
  });

  it('«Закрыть» при грязной форме закрывает молча, Esc — через подтверждение', async () => {
    prepare();
    const body = await open(['t-a', 't-b', 't-c']);
    check(rowByKey(body, 'p-status'), true);
    // «Закрыть» — явная отмена без подтверждения.
    footerButton('Закрыть').click();
    assert.equal(backdrops().length, 0, '«Закрыть» закрывает сразу');

    const again = await open(['t-a', 't-b', 't-c']);
    check(rowByKey(again, 'p-status'), true);
    pressEscape();
    await flush(2);
    assert.equal(backdrops().length, 2, 'Esc при изменениях спрашивает подтверждение');
    assert.ok(currentBody().flatText().includes('Данные изменены'), 'подтверждение закрытия');
  });
});

describe('диалог значений свойств выделения: пикер (+)', () => {
  it('исключает показанные и структурные строки; «Создать новое…» нет; выбор ставит галочку', async () => {
    prepare();
    const body = await open(['t-a', 't-b', 't-c']);
    const addButton = findAllByClass(body, 'ui-btn').find(
      (button) => button.textContent === '+ свойство',
    );
    assert.ok(addButton !== undefined, 'кнопка (+) есть');
    addButton!.click();
    await flush(4);

    assert.equal(backdrops().length, 2, 'пикер открылся поверх диалога');
    const picker = currentBody();
    assert.equal(hasFooterButton('Создать новое…'), false, '«Создать новое…» в пикере нет');

    const grid = findByClass(picker, 'vaadin-grid') ?? findTag(picker, 'vaadin-grid');
    assert.ok(grid !== null, 'список свойств смонтирован');
    const items = (grid as unknown as { items: Array<{ name: string; id: string; structural: boolean }> }).items;
    const names = items.map((item) => item.name);
    assert.ok(!names.includes('Статус'), 'показанный «Статус» исключён');
    assert.ok(!names.includes('Ответственный'), 'показанный «Ответственный» исключён');
    assert.ok(names.includes('Приоритет'), 'непоказанное свойство доступно');
    assert.ok(!items.some((item) => item.structural), 'структурные строки исключены');

    // Выбор строки: активация через двойной клик по сетке (адаптер считает
    // индекс через getEventContext; в шиме его подменяем точечно).
    const priorityIndex = items.findIndex((item) => item.name === 'Приоритет');
    assert.ok(priorityIndex >= 0, 'строка «Приоритет» есть в сетке');
    (grid as unknown as { getEventContext: () => { index: number } }).getEventContext = () => ({
      index: priorityIndex,
    });
    grid!.emit('click', { detail: 2, clientX: 0, clientY: 0 });
    await flush(4);

    assert.equal(backdrops().length, 1, 'пикер закрылся после выбора');
    const after = currentBody();
    const priority = rowByKey(after, 'p-priority');
    assert.equal(checkboxOf(priority).checked, true, 'добавленная строка — с галочкой');
    assert.equal(footerButton('Применить').disabled, false, 'галочка включила «Применить»');
  });
});

/** Esc верхнего диалога: все слушатели keydown окна. */
function pressEscape(): void {
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
}
