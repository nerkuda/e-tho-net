/**
 * Regression test for ETN error 9667b75c «Панель "Свойства" показывает
 * устаревшее значение после возврата на мысль».
 *
 * Симптом: вкладка «Свойства» скрыта (активна другая вкладка), другой клиент
 * (или MCP) пишет значение свойства владельца; при возврате на «Свойства»
 * строка показывает прежнее значение до переоткрытия мысли.
 *
 * Корень: событие `property-value.set/deleted` адресовано ВЛАДЕЛЬЦУ
 * (`evt.data.owner_id`), а обработчик перечитывал «показанного» владельца;
 * скрытая панель отбрасывала перечитывание гардом (`!box.isConnected`), а
 * `displayTab` при повторном показе ничего не читал.
 *
 * Здесь прогоняется реальный путь: `mountEditor` → вкладка «Свойства» →
 * событие через `initRealtime` → возврат на вкладку. Проверяется:
 *  1) событие о СВОЁМ владельце при скрытой вкладке — второй `properties.get`
 *     происходит при показе, чип типовой таблицы и значение внетиповой
 *     обновляются без пересборки вкладки;
 *  2) событие о ЧУЖОМ владельце не перечитывает и не перерисовывает
 *     показанную панель (адресация по `owner_id`);
 *  3) обычный возврат на вкладку без изменений не читает (нет лишних запросов);
 *  4) транзиентный отказ чтения значений на возврате не теряет dirty-метку —
 *     следующий показ обязан перечитать (замечание верификатора к 9667b75c,
 *     круг 3: типовая таблица снимала метку до чтения значений).
 *
 * На дофиксовом HEAD оба обязательных кейса красные: (1) второго
 * `properties.get` нет и чип остаётся «срочно»; (2) показанная панель
 * перечитывается на чужое событие. Кейс 4 на дофиксовом HEAD тоже красный:
 * метка снимается до чтения значений, и после отказа следующий показ молчит.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AnyRealtimeEvent, Thought } from '@etn/shared';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// DOM-шим (минимальный, как в renderer-attachments-realtime.test.ts)
// ---------------------------------------------------------------------------

const documentListeners = new Map<string, Set<(event: any) => void>>();

class ShimCustomEvent {
  type: string;
  detail: unknown;
  constructor(type: string, init?: { detail?: unknown }) {
    this.type = type;
    this.detail = init?.detail;
  }
}

function shimDom(): void {
  (globalThis as any).HTMLElement = class {};
  (globalThis as any).CustomEvent = ShimCustomEvent;
  (globalThis as any).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  (globalThis as any).requestAnimationFrame = (cb: () => void): number => {
    cb();
    return 0;
  };
  (globalThis as any).getComputedStyle = () => ({ paddingLeft: '0px', paddingRight: '0px' });
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: { setProperty: () => undefined, removeProperty: () => undefined } },
    body: new ShimElement('body'),
    addEventListener: (type: string, handler: (event: any) => void) => {
      const set = documentListeners.get(type) ?? new Set();
      set.add(handler);
      documentListeners.set(type, set);
    },
    removeEventListener: (type: string, handler: (event: any) => void) => {
      documentListeners.get(type)?.delete(handler);
    },
    dispatchEvent: (event: any): boolean => {
      for (const handler of [...(documentListeners.get(event.type) ?? [])]) handler(event);
      return true;
    },
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

function makeThought(overrides: Partial<Thought> = {}): Thought {
  return {
    id: 't1',
    title: 'T1',
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    active: true,
    is_protected: false,
    is_root: false,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    synonyms: [],
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Фабрика realtime-события (seq растёт — иначе роутер отбросит как опоздавшее). */
function realtimeEvent(type: string, networkId: string, data: unknown, seq = 1): AnyRealtimeEvent {
  return {
    type,
    seq,
    ts: '2026-01-01T00:00:00.000Z',
    actor: { user_id: 'u2', client_id: 'c2' },
    network_id: networkId,
    audience: 'network',
    layer_id: '00000000-0000-4000-8000-000000000001',
    data,
  } as unknown as AnyRealtimeEvent;
}

/** Все элементы с данным классом внутри `root` (поиск в глубину). */
function findAllByClass(root: ShimElement, className: string): ShimElement[] {
  const out: ShimElement[] = [];
  const walk = (node: ShimElement): void => {
    if (node.className.split(/\s+/).includes(className)) out.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

/** Ждёт выполнения условия не дольше `timeout` мс (шаг 10 мс). */
async function waitFor(cond: () => boolean, timeout = 3000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return cond();
}

/** Тексты чипов типовой таблицы «Свойства». */
function chipTitles(host: ShimElement): string[] {
  return findAllByClass(host, 'prc-title').map((node) => node.textContent);
}

/** Значение первого скалярного редактора внетиповой таблицы (или null). */
function outsideScalarValue(host: ShimElement): string | null {
  const body = findAllByClass(host, 'properties-outside-body')[0];
  if (body === undefined) return null;
  const input = body.findAll(
    (node) =>
      node.tagName.toLowerCase() === 'input' &&
      node.className.split(/\s+/).includes('prop-editor'),
  )[0];
  return input === undefined ? null : input.value;
}

// ---------------------------------------------------------------------------
// Реальный путь: скрытая вкладка «Свойства» и realtime-событие о владельце
// ---------------------------------------------------------------------------

describe('вкладка «Свойства» после скрытия перечитывает изменённого владельца (ошибка 9667b75c)', () => {
  it('своё событие при скрытой вкладке перечитывается на показе; чужой владелец — нет', async () => {
    shimDom();

    /** Серверное состояние значений: типовая «Теги» (чипы) + внетиповая «Внешнее». */
    let propertyRows: unknown[] = [
      {
        id: 'vTags',
        owner_type: 'thought',
        owner_id: 't1',
        property_id: 'pTags',
        property_name: 'Теги',
        value_type: 'text',
        value: ['срочно'],
        outside_type: false,
        updated_at: '2026',
      },
      {
        id: 'vExt',
        owner_type: 'thought',
        owner_id: 't1',
        property_id: 'pExt',
        property_name: 'Внешнее',
        value_type: 'text',
        value: 'старое',
        outside_type: true,
        updated_at: '2026',
      },
    ];
    let getCalls = 0;
    /** Транзиентный отказ чтения значений: все `properties.get` бросают. */
    let failValuesReads = false;
    let realtimeHandler: ((raw: unknown) => void) | null = null;

    (globalThis as any).window.etn = {
      // Сохранённая активная вкладка — «Свойства»: редактор строит её сразу.
      ui: { getState: async () => 'properties', setState: async () => undefined },
      properties: {
        get: async () => {
          getCalls += 1;
          if (failValuesReads) throw new Error('transient values read failure');
          return propertyRows.map((row) => ({ ...(row as object) }));
        },
        set: async () => undefined,
        remove: async () => undefined,
      },
      types: {
        listTypeProperties: async () => [
          {
            id: 'pTags',
            property_id: 'pTags',
            owner_type: 'thought_type',
            owner_id: 'ty1',
            key: 'Теги',
            value_type: 'text',
            config: { multiple: true },
            required: false,
            position: 0,
          },
        ],
      },
      propertyRegistry: { list: async () => [] },
      thoughts: { get: async () => null, focus: async () => null, resolve: async () => [] },
      comments: { list: async () => [], create: async () => undefined },
      admin: { listUsers: async () => [] },
      realtime: {
        onStatusChange: () => undefined,
        onStale: () => undefined,
        onNetworkLost: () => undefined,
        onLayerControl: () => undefined,
        onEvent: (handler: (raw: unknown) => void) => {
          realtimeHandler = handler;
        },
        notifyOnline: () => undefined,
      },
    };

    const { resetEventRouter } = await import('../src/renderer/lib/live/index.js');
    resetEventRouter();
    const { mountEditor, editorInternals } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    const { initRealtime } = await import('../src/renderer/realtime.js');

    store.update({
      networkId: 'n1',
      editorTarget: { kind: 'thought', id: 't1', thought: makeThought() },
      // Мысль без своего типа показывает свойства корневого типа (L21).
      thoughtTypes: [{ id: 'ty1', name: 'основной тип', is_root: true, parent_id: null } as any],
      linkTypes: [],
      collapsedGroups: {},
    } as any);

    initRealtime();
    const host = new ShimElement('div');
    mountEditor(host as any);
    await waitFor(() => chipTitles(host).includes('срочно'));

    // Мягкие проверки: все кейсы должны быть видны в ОДНОМ прогоне — на
    // дофиксовом HEAD красны и «нет второго чтения», и «чужой владелец
    // перечитывает панель»; жёсткий assert остановился бы на первом.
    const failures: string[] = [];
    const check = (cond: boolean, message: string): void => {
      if (!cond) failures.push(message);
    };
    const same = (actual: unknown, expected: unknown, message: string): void => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures.push(`${message}: получено ${JSON.stringify(actual)}`);
      }
    };

    const builds = (): number => editorInternals.paneBuildCount('properties');
    check(builds() === 1, `вкладка «Свойства» построена ${builds()} раз(а) вместо одного`);
    same(chipTitles(host), ['срочно'], 'исходное значение типовой таблицы не показано');
    check(outsideScalarValue(host) === 'старое', 'исходное внетиповое значение не показано');

    // Шим считает отцепленный корень «подключённым» (у него флаг connectedRoot
    // по умолчанию true). Для панели свойств это скрывает сам предмет проверки:
    // помечаем КОРЕНЬ ПАНЕЛИ (.tab-pane — именно он отцепляется от хоста) как
    // отключаемый — пока он в хосте, isConnected считается по родителю и
    // остаётся true, после отцепления становится false, как в браузере.
    const propertiesPane = findAllByClass(host, 'tab-pane')[0];
    assert.ok(propertiesPane !== undefined, 'панель активной вкладки найдена');
    propertiesPane!.connectedRoot = false;

    let seq = 0;
    const feed = async (type: string, networkId: string, data: unknown): Promise<void> => {
      seq += 1;
      realtimeHandler!(realtimeEvent(type, networkId, data, seq));
      await waitFor(() => false, 30);
    };

    // --- Кейс 1: скрытая вкладка, событие о СВОЁМ владельце ------------------
    editorInternals.activateTab('metadata');
    await waitFor(() => findAllByClass(host, 'properties-tab').length === 0);
    const callsHidden = getCalls;
    propertyRows = [
      {
        id: 'vTags',
        owner_type: 'thought',
        owner_id: 't1',
        property_id: 'pTags',
        property_name: 'Теги',
        value_type: 'text',
        value: ['срочно', 'смена'],
        outside_type: false,
        updated_at: '2026-01-02',
      },
      {
        id: 'vExt',
        owner_type: 'thought',
        owner_id: 't1',
        property_id: 'pExt',
        property_name: 'Внешнее',
        value_type: 'text',
        value: 'новое',
        outside_type: true,
        updated_at: '2026-01-02',
      },
    ];
    await feed('property-value.set', 'n1', {
      owner_type: 'thought',
      owner_id: 't1',
      key: 'Теги',
      values: ['срочно', 'смена'],
    });
    check(getCalls === callsHidden, 'скрытая панель значения не читает (гард сохранён)');

    editorInternals.activateTab('properties');
    await waitFor(() => chipTitles(host).includes('смена'));
    check(getCalls > callsHidden, 'показ перечитал владельца — второго properties.get нет');
    same(chipTitles(host), ['срочно', 'смена'], 'типовая строка не обновилась');
    check(outsideScalarValue(host) === 'новое', 'внетиповая строка не обновилась');
    check(builds() === 1, 'вкладка пересобиралась вместо инкрементальной сверки строк');

    // --- Кейс 2: показанная панель, событие о ЧУЖОМ владельце ----------------
    const callsShown = getCalls;
    await feed('property-value.set', 'n1', {
      owner_type: 'thought',
      owner_id: 't9',
      key: 'Теги',
      values: ['чужое'],
    });
    check(getCalls === callsShown, 'чужой владелец перечитал показанную панель');
    same(chipTitles(host), ['срочно', 'смена'], 'чужой владелец перерисовал строки панели');

    // --- Кейс 3: обычный возврат без изменений — лишних запросов нет --------
    editorInternals.activateTab('metadata');
    await waitFor(() => findAllByClass(host, 'properties-tab').length === 0);
    const callsBeforeReturn = getCalls;
    editorInternals.activateTab('properties');
    await waitFor(() => chipTitles(host).includes('смена'));
    check(getCalls === callsBeforeReturn, 'показ без dirty-метки перечитал значения');
    check(builds() === 1, 'вкладка пересобиралась на обычном показе');

    // --- Кейс 4: отказ чтения значений на возврате — метка не теряется ------
    // Замечание верификатора (круг 3): снятие dirty-метки допустимо только
    // после УСПЕШНОГО чтения значений. Иначе транзиентный отказ «съедает»
    // метку, и следующий показ показывает снимок без повторного чтения.
    editorInternals.activateTab('metadata');
    await waitFor(() => findAllByClass(host, 'properties-tab').length === 0);
    propertyRows = [
      {
        id: 'vTags',
        owner_type: 'thought',
        owner_id: 't1',
        property_id: 'pTags',
        property_name: 'Теги',
        value_type: 'text',
        value: ['срочно', 'ретрей'],
        outside_type: false,
        updated_at: '2026-01-03',
      },
      {
        id: 'vExt',
        owner_type: 'thought',
        owner_id: 't1',
        property_id: 'pExt',
        property_name: 'Внешнее',
        value_type: 'text',
        value: 'повтор',
        outside_type: true,
        updated_at: '2026-01-03',
      },
    ];
    failValuesReads = true;
    await feed('property-value.set', 'n1', {
      owner_type: 'thought',
      owner_id: 't1',
      key: 'Теги',
      values: ['срочно', 'ретрей'],
    });
    const callsBeforeFailedReturn = getCalls;
    editorInternals.activateTab('properties');
    // Первый возврат: чтения значений отвечают отказом (типовая таблица,
    // внетиповая и счётчик группы — все три).
    await waitFor(() => getCalls > callsBeforeFailedReturn);
    await waitFor(() => false, 60);
    const callsAfterFailedReturn = getCalls;
    check(
      callsAfterFailedReturn > callsBeforeFailedReturn,
      'возврат при отказе чтения не пытался прочитать значения',
    );

    // Следующий показ: метка обязана пережить отказ и вызвать повторное чтение.
    editorInternals.activateTab('metadata');
    await waitFor(() => findAllByClass(host, 'properties-tab').length === 0);
    failValuesReads = false;
    editorInternals.activateTab('properties');
    await waitFor(() => getCalls > callsAfterFailedReturn, 500);
    check(
      getCalls > callsAfterFailedReturn,
      'показ после отказа чтения не перечитал значения (dirty-метка потеряна)',
    );
    await waitFor(() => chipTitles(host).includes('ретрей'), 500);
    same(chipTitles(host), ['срочно', 'ретрей'], 'после ретрая типовая строка не обновилась');
    check(outsideScalarValue(host) === 'повтор', 'после ретрая внетиповая строка не обновилась');

    assert.deepEqual(failures, [], `дефекты вкладки «Свойства»:\n${failures.join('\n')}`);
  });
});
