/**
 * Первый день недели сети во ВСЕХ календарных виджетах (задача b5278f9a,
 * версия 0.13.2, требование 1b77decd).
 *
 * Блокер независимой проверки: настройка менялась в «Все настройки», но
 * календарь диалога «Точная дата», открытый из панели отбора, оставался с
 * прежними подписями `[Пн…Вс]` — значение запоминалось при сборке панели.
 *
 * Что закрепляем:
 *   1. `MonthCalendarHandle.setFirstDayOfWeek` перестраивает подписи и сетку
 *      БЕЗ пересоздания календаря (раньше не было покрыто);
 *   2. открытый редактор панели читает `store.state.network.first_day_of_week`
 *      в момент открытия диалога — после `store.update` календарь строит `Вс`
 *      первым (регресс-тест блокера);
 *   3. смонтированная панель отбора перестраивается подпиской на store при
 *      смене настройки (пример — панель «Структур»);
 *   4. функция-резолвер `resolveFirstDayOfWeek` читается на каждый вызов.
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.js`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

function installShim(): void {
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
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win['innerWidth'] = 1200;
  win['innerHeight'] = 800;
  win['setTimeout'] = (fn: () => void) => {
    fn();
    return 1;
  };
  win['clearTimeout'] = () => undefined;
  win['addEventListener'] = () => undefined;
  win['removeEventListener'] = () => undefined;
  win['dispatchEvent'] = () => undefined;
  win['matchMedia'] = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  win['localStorage'] = {
    getItem: () => null,
    setItem: () => undefined,
  };
  win['etn'] = {
    propertyRegistry: { list: async () => [] },
    savedFilters: {
      list: async () => [],
      create: async () => ({}),
      update: async () => ({}),
      remove: async () => undefined,
    },
  };
}

installShim();

const calendarMod = await import('../src/renderer/lib/month-calendar.js');
const datesMod = await import('../src/renderer/lib/dates.js');
const editorMod = await import('../src/renderer/lib/filter-editor.js');
const builder = await import('../src/renderer/lib/filter-builder.js');
const stateMod = await import('../src/renderer/state.js');

/** Дождаться динамического импорта диалога и его синхронной сборки. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function labels(root: ShimElement): string[] {
  return root.findAll((n) => n.classList.contains('cal-wd')).map((n) => n.flatText().trim());
}

function all(root: ShimElement, cls: string): ShimElement[] {
  return root.findAll((n) => n.classList.contains(cls));
}

/** Редактор отбора «Дневника» с точной датой в дереве. */
function buildDateEditor(): { root: ShimElement; destroy: () => void } {
  const state = builder.defaultFilterCriteriaState();
  state.tree = {
    kind: 'group',
    op: 'and',
    children: [
      {
        kind: 'leaf',
        entity: { kind: 'created_at' },
        operator: 'eq',
        value: { kind: 'scalar', value: '2026-03-04' },
      },
    ],
  } as any;
  const handle = editorMod.buildFilterEditor({
    profile: 'chronicle',
    networkId: 'net-1',
    // Ключевой контракт фикса: не снимок, а чтение на момент открытия.
    firstDayOfWeek: () => stateMod.store.state.network?.first_day_of_week,
    data: { registry: new Map(), linkTypes: [], thoughtTypes: [] },
    getState: () => state,
    host: {
      apply: () => undefined,
      save: () => undefined,
      reset: () => undefined,
    },
  } as any);
  return { root: handle.root as unknown as ShimElement, destroy: () => handle.destroy() };
}

describe('первый день недели: календарные виджеты (b5278f9a)', () => {
  it('MonthCalendarHandle.setFirstDayOfWeek перестраивает подписи и сетку без пересоздания', () => {
    const calendar = calendarMod.buildMonthCalendar({
      from: '2026-10-17',
      to: '2026-10-17',
      today: '2026-10-17',
      weekNumbers: false,
      firstDayOfWeek: 1,
    });
    const root = calendar.root as unknown as ShimElement;
    const sameRoot = root;
    assert.deepEqual(labels(root), ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']);
    assert.equal(all(root, 'cal-day')[0]?.title, '2026-09-28', 'сетка от понедельника');

    calendar.setFirstDayOfWeek(7);

    assert.equal(root, sameRoot, 'календарь не пересоздаётся');
    assert.deepEqual(labels(root), ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']);
    assert.equal(all(root, 'cal-day')[0]?.title, '2026-09-27', 'сетка от воскресенья');
    assert.deepEqual(calendar.getMonth(), { year: 2026, month: 10 }, 'показанный месяц сохранён');

    // Некорректное значение трактуется как понедельник.
    calendar.setFirstDayOfWeek(0 as number);
    assert.deepEqual(labels(root), ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']);
  });

  it('редактор читает первый день недели в момент открытия: после store.update — «Вс» первой', async () => {
    const body = (globalThis as any).document.body as ShimElement;
    body.replaceChildren();
    stateMod.store.update({ network: { first_day_of_week: 1 } as any, networkId: 'net-1' });

    const editor = buildDateEditor();
    // Значение поменялось ПОСЛЕ сборки редактора — старый снимок дал бы «Пн».
    stateMod.store.update({ network: { first_day_of_week: 7 } as any, networkId: 'net-1' });

    const pick = all(editor.root, 'date-field-pick')[0];
    assert.ok(pick !== undefined, 'у точной даты есть кнопка календаря');
    pick!.click();
    await flush();

    const dialog = all(body, 'dpd')[0];
    assert.ok(dialog !== undefined, 'диалог «Точная дата» открыт');
    assert.deepEqual(
      labels(dialog!),
      ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'],
      'календарь диалога построен по актуальному значению 7',
    );

    const cancel = body
      .findAll((n) => n.tagName.toUpperCase() === 'BUTTON')
      .find((n) => n.flatText().trim() === 'Отмена');
    cancel?.click();
    await flush();
    editor.destroy();
    stateMod.store.update({ network: null, networkId: null });
  });

  it('смонтированная панель «Структур» перестраивается при смене настройки', async () => {
    stateMod.store.update({ network: { first_day_of_week: 1 } as any, networkId: 'net-1' });
    const panelMod = await import('../src/renderer/screens/structures/filter-panel.js');
    const host = new ShimElement('div');
    panelMod.mountFilterPanel(host as unknown as HTMLElement, {
      onApply: () => undefined,
      onStatePersist: () => undefined,
      onCommands: () => undefined,
    });
    const before = host.querySelector('.fe');
    assert.ok(before !== null, 'редактор смонтирован');

    stateMod.store.update({ network: { first_day_of_week: 7 } as any, networkId: 'net-1' });

    const after = host.querySelector('.fe');
    assert.ok(after !== null, 'редактор на месте');
    assert.notEqual(after, before, 'панель пересобрана подпиской на store');
    panelMod.unmountFilterPanel();
    stateMod.store.update({ network: null, networkId: null });
  });

  it('resolveFirstDayOfWeek читает функцию-источник на каждый вызов и нормализует значение', () => {
    let current: number | undefined = 1;
    const source = (): number | undefined => current;
    assert.equal(datesMod.resolveFirstDayOfWeek(source), 1);
    current = 7;
    assert.equal(datesMod.resolveFirstDayOfWeek(source), 7, 'значение не кэшируется');
    current = undefined;
    assert.equal(datesMod.resolveFirstDayOfWeek(source), 1, 'нет настройки — понедельник');
    assert.equal(datesMod.resolveFirstDayOfWeek(9), 1, 'вне ISO 1…7 — понедельник');
  });
});
