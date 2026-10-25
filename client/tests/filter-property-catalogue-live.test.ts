/**
 * Регресс ошибки 6d25c224: справочник свойств в условиях AST обновляется по
 * realtime-событиям реестра — на уже открытой панели «Структур», без перезапуска
 * клиента, очистки условий и переключения экранов.
 *
 * Симптом карточки: свойство сети создано (удалено/переименовано), а список
 * «Что» панели отбора показывает прежний справочник — реестр читался один раз
 * при монтировании, а realtime-события онтологии его не инвалидировали.
 *
 * Тест идёт через НАСТОЯЩИЙ путь события: `routeRealtimeEvent` (роутер слоя
 * гасит ключ каталогов) → живой справочник свойств → перерисовка дерева условий
 * уже смонтированной панели. Заглушка — только сетевой вход
 * `window.etn.propertyRegistry.list`.
 *
 * Три кейса = три критерия готовности карточки:
 *   1. создание — новое свойство появляется в списке «Что» открытой панели;
 *   2. переименование — подпись уже построенного условия показывает новое имя;
 *   3. удаление — свойство исчезает из списка, а построенное условие не ломает
 *      отбор (модель и AST остаются прежними, панель не падает).
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.js`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { NetworkProperty } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

/** Сеть теста: события роутера адресуются ей же. */
const NET = 'net-6d25c224';
const PROP_A = '00000000-0000-4000-8000-0000000000a1';
const PROP_B = '00000000-0000-4000-8000-0000000000b2';

/** Текущее содержимое реестра на «сервере» (меняется между событиями). */
let rows: NetworkProperty[] = [];
/** Монотонный seq realtime-событий: роутер отбрасывает опоздавшие. */
let seq = 0;

function propertyRow(id: string, name: string): NetworkProperty {
  return {
    id,
    name,
    value_type: 'text',
    config: null,
    description: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function installShims(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    activeElement: null,
    querySelector: () => null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, any>;
  win.innerWidth = 1400;
  win.innerHeight = 900;
  win.setTimeout = (fn: () => void) => {
    fn();
    return 1;
  };
  win.clearTimeout = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.dispatchEvent = () => undefined;
  win.matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  win.localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  (globalThis as any).ResizeObserver = class {
    observe(): void {
      /* раскладки в шиме нет */
    }
    unobserve(): void {
      /* раскладки в шиме нет */
    }
    disconnect(): void {
      /* раскладки в шиме нет */
    }
  };
  win.etn = {
    propertyRegistry: {
      list: async (): Promise<NetworkProperty[]> => rows.map((row) => ({ ...row })),
    },
    savedFilters: {
      list: async () => [],
      create: async () => ({}),
      update: async () => ({}),
      remove: async () => undefined,
    },
    thoughts: { resolve: async () => [] },
    tabs: { updateState: async () => undefined },
    ui: { getState: async () => null, setState: async () => undefined },
  };
}

installShims();

const stateMod = await import('../src/renderer/state.js');
const panelMod = await import('../src/renderer/screens/structures/filter-panel.js');
const builderMod = await import('../src/renderer/lib/filter-builder.js');
const routerMod = await import('../src/renderer/lib/live/event-router.js');
const liveMod = await import('../src/renderer/lib/live/index.js');

/** Дождаться асинхронных чтений реестра и их продолжений. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** Пропустить одно realtime-событие онтологии через роутер слоя. */
function route(type: string, data: Record<string, unknown>): void {
  seq += 1;
  routerMod.routeRealtimeEvent(
    {
      id: `evt-${seq}`,
      network_id: NET,
      seq,
      ts: new Date().toISOString(),
      type,
      data,
    } as any,
    { networkId: NET },
  );
}

let host: ShimElement;

/** Смонтировать панель «Структур» в отсоединённый хост шима. */
function mount(): void {
  host = new ShimElement('div');
  panelMod.mountFilterPanel(host as unknown as HTMLElement, {
    onApply: () => undefined,
    onStatePersist: () => undefined,
    onCommands: () => undefined,
  });
}

/** Подпись ячейки «Что» строки условий (первой по умолчанию). */
function rowWhatText(index = 0): string {
  const row = host.querySelectorAll('.ft-row')[index];
  assert.ok(row !== undefined, `строка условий ${index + 1} на месте`);
  const what = row.querySelector('.ft-row__what');
  assert.ok(what !== null, 'у строки есть ячейка «Что»');
  return what.flatText();
}

/** Открыть список «Что» первой строки условий; вернуть подписи пунктов. */
function openOperandPicker(): string[] {
  const row = host.querySelectorAll('.ft-row')[0];
  assert.ok(row !== undefined, 'в дереве условий есть строка');
  const what = row.querySelector('.ft-row__what');
  assert.ok(what !== null, 'у строки есть ячейка «Что»');
  what.click();
  return (globalThis as any).document.body
    .querySelectorAll('.ft-choice__item')
    .map((item: ShimElement) => item.flatText().trim());
}

/** Закрыть поповер списка, если он открыт. */
function closePicker(): void {
  for (const popover of (globalThis as any).document.body.querySelectorAll('.ui-popover')) {
    popover.remove();
  }
}

describe('панель «Структур»: живой справочник свойств (6d25c224)', () => {
  beforeEach(() => {
    liveMod.resetQueryRegistry();
    routerMod.resetEventRouter();
    stateMod.store.update({ networkId: NET, network: null, thoughtTypes: [], linkTypes: [] });
    rows = [propertyRow(PROP_A, 'Свойство А')];
    seq = 0;
    // Модель панели — модульная: кейсы делят её, поэтому каждый начинается с
    // пустого дерева (иначе условия предыдущего кейса попадают в разметку).
    panelMod.unmountFilterPanel();
    panelMod.setFilterState({
      ...panelMod.getFilterState(),
      tree: builderMod.defaultFilterTreeGroup('and'),
      sortKeys: [],
    });
    mount();
  });

  it('создание свойства появляется в списке «Что» открытой панели', async () => {
    await flush();
    const add = host.querySelector('.ft-add-condition');
    assert.ok(add !== null, 'кнопка «Добавить условие» на месте');
    add.click();

    const before = openOperandPicker().join('\n');
    assert.match(before, /Свойство А/, 'исходное свойство в списке');
    assert.doesNotMatch(before, /Свойство Б/, 'нового свойства ещё нет');
    closePicker();

    // Другой клиент/MCP создал свойство — сервер шлёт событие реестра.
    rows = [...rows, propertyRow(PROP_B, 'Свойство Б')];
    route('property-registry.created', { property: propertyRow(PROP_B, 'Свойство Б') });
    await flush();

    const after = openOperandPicker().join('\n');
    assert.match(after, /Свойство Б/, 'новое свойство появилось без перезапуска и смены экрана');
    closePicker();
  });

  it('переименование свойства отражается в подписи уже построенного условия', async () => {
    await flush();
    const add = host.querySelector('.ft-add-condition');
    assert.ok(add !== null);
    add.click();

    // Выбираем свойство А в условие.
    openOperandPicker();
    const item = (globalThis as any).document.body.querySelector(
      `.ft-choice__item[data-key="property:${PROP_A}"]`,
    );
    assert.ok(item !== null, 'пункт исходного свойства найден');
    item.click();
    assert.match(rowWhatText(), /Свойство А/);

    rows = [propertyRow(PROP_A, 'Свойство А (новое имя)')];
    route('property-registry.updated', { id: PROP_A, changes: { name: 'Свойство А (новое имя)' } });
    await flush();

    assert.match(rowWhatText(), /Свойство А \(новое имя\)/, 'условие показывает новое имя свойства');
  });

  it('удаление свойства убирает его из списка и не ломает построенное условие', async () => {
    await flush();
    const add = host.querySelector('.ft-add-condition');
    assert.ok(add !== null);
    add.click();
    openOperandPicker();
    const item = (globalThis as any).document.body.querySelector(
      `.ft-choice__item[data-key="property:${PROP_A}"]`,
    );
    assert.ok(item !== null);
    item.click();
    const treeBefore = JSON.stringify(panelMod.getFilterState().tree);

    rows = [];
    route('property-registry.deleted', { id: PROP_A });
    await flush();

    const listed = openOperandPicker().join('\n');
    assert.doesNotMatch(listed, /Свойство А/, 'удалённое свойство исчезло из списка');
    closePicker();

    // Условие остаётся в модели и отборе: правка справочника не чистит отбор.
    assert.equal(JSON.stringify(panelMod.getFilterState().tree), treeBefore);
    const rowsAfter = host.querySelectorAll('.ft-row').length;
    assert.equal(rowsAfter, 1, `строка условия осталась на месте (панель не упала), строк: ${rowsAfter}`);
  });
});
