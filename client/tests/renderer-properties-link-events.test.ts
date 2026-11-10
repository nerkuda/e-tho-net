/**
 * Регресс-тест ошибки `cb875d0c`: вкладка «Свойства» не перечитывалась по
 * событиям РЕБРА, созданного вне открытого редактора.
 *
 * Симптом: у мысли есть типовое свойство-связь со стороной `source`; второй
 * клиент (мост `window.etn`, API, MCP) создаёт ребро со второго конца. Сервер
 * отдаёт значение (`properties.get`), но открытая вкладка «Свойства» показывает
 * прежний набор связей до переоткрытия мысли: роутер гасит окрестности обоих
 * концов (`focus:@…`), а панель реагировала только на `property-value.*` —
 * события ребра она пропускала.
 *
 * Проверяется реальный путь `mountEditor` → вкладка «Свойства» → событие через
 * `initRealtime` (роутер слоя → ключи → `onQueryInvalidated`):
 *  1) внешний `link.created` показанной мысли перечитывает вкладку — чип
 *     обратной стороны появляется без переоткрытия/переключения вкладки;
 *  2) внешний `link.created` ЧУЖОЙ мысли вкладку не перечитывает;
 *  3) внешний `link.deleted` (нагрузка — только `id`) перечитывает вкладку:
 *     концы берутся из нормализованного кэша, запись ещё жива;
 *  4) внешний `link.updated` кэшированного ребра перечитывает вкладку;
 *     неизвестное ребро — нет;
 *  5) своя запись значения-связи (локальный канал `PROPERTY_VALUES_REFRESHED_EVENT`)
 *     по-прежнему перечитывает немедленно, а собственное realtime-эхо ребра
 *     даёт ОДИН склеенный проход (2 чтения), не второй залп.
 *
 * Гейт для мутаций: убрать обработку событий ребра в панели, убрать адресацию
 * концов `link.deleted`/`link.updated` в роутере или перечитывать показ на
 * любое ребро — кейсы падают.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AnyRealtimeEvent, Thought } from '@etn/shared';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// DOM-шим (как в renderer-properties-read-generation.test.ts)
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
  win.innerWidth = 1200;
  win.innerHeight = 800;
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

function makeThought(overrides: Partial<Thought> = {}): Thought {
  return {
    id: 't1',
    title: 'T1',
    type_id: 'ty1',
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
function realtimeEvent(
  type: string,
  networkId: string,
  data: unknown,
  seq: number,
  actor: { user_id: string; client_id: string } = { user_id: 'u2', client_id: 'c2' },
): AnyRealtimeEvent {
  return {
    type,
    seq,
    ts: '2026-01-01T00:00:00.000Z',
    actor,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Тексты чипов значения-связи (обе таблицы вкладки «Свойства»). Поиск — только
 * внутри панели вкладки: класс `prc-title` есть и у облачка типа в шапке
 * редактора, к значениям свойств он не относится.
 */
function chipTitles(host: ShimElement): string[] {
  const tab = findAllByClass(host, 'properties-tab')[0];
  if (tab === undefined) return [];
  return findAllByClass(tab, 'prc-title').map((node) => node.textContent);
}

// ---------------------------------------------------------------------------
// Серверный снимок значений: типовое свойство-связь (сторона source)
// и внетиповая строка той же связи (сторона target) — сценарий карточки
// ---------------------------------------------------------------------------

interface Chip {
  linkId: string;
  targetId: string;
  title: string;
}

/**
 * Снимок `properties.get` мысли `t1`: та же связь с двух сторон. Типовая строка
 * несёт сторону `source` (владелец — источник), внетиповая — сторону `target`
 * (ребро создано со второго конца, ровно как в симптоме `cb875d0c`).
 */
function snapshotRows(chips: Chip[]): unknown[] {
  const values = chips.map((chip) => ({
    link_id: chip.linkId,
    target_id: chip.targetId,
    target_title: chip.title,
    target_type_id: null,
    comment: null,
  }));
  return [
    {
      id: 'vRel-source',
      owner_type: 'thought',
      owner_id: 't1',
      property_id: 'lk1',
      property_name: 'Период проживания',
      value_type: 'link',
      outside_type: false,
      side: 'source',
      direction: 'out',
      link_type_id: 'lt1',
      structural: false,
      count: 0,
      values: [],
      updated_at: '2026-01-01',
    },
    {
      id: 'vRel-target',
      owner_type: 'thought',
      owner_id: 't1',
      property_id: 'lk1',
      property_name: 'Период проживания',
      value_type: 'link',
      outside_type: true,
      side: 'target',
      direction: 'in',
      link_type_id: 'lt1',
      structural: false,
      count: values.length,
      values,
      updated_at: '2026-01-01',
    },
  ];
}

// ---------------------------------------------------------------------------
// Реальный путь: вкладка «Свойства» открыта, события идут через роутер
// ---------------------------------------------------------------------------

describe('вкладка «Свойства» и события ребра (ошибка cb875d0c)', () => {
  it('внешнее ребро перечитывает открытую вкладку; чужая мысль — нет; своё эхо — один проход', async () => {
    shimDom();

    let rows: unknown[] = snapshotRows([]);
    let getCalls = 0;
    let realtimeHandler: ((raw: unknown) => void) | null = null;

    (globalThis as any).window.etn = {
      ui: { getState: async () => 'properties', setState: async () => undefined },
      properties: {
        get: async () => {
          getCalls += 1;
          return rows.map((row) => ({ ...(row as object) }));
        },
        set: async () => undefined,
        remove: async () => undefined,
      },
      types: {
        listTypeProperties: async () => [
          {
            id: 'lk1',
            property_id: 'lk1',
            owner_type: 'thought_type',
            owner_id: 'ty1',
            key: 'Период проживания',
            value_type: 'link',
            side: 'source',
            config: { link_type_id: 'lt1' },
            required: false,
            position: 0,
          },
        ],
      },
      propertyRegistry: { list: async () => [] },
      links: { update: async () => undefined },
      thoughts: {
        get: async () => null,
        focus: async () => null,
        resolve: async () => [],
      },
      comments: { list: async () => [], create: async () => undefined },
      admin: { listUsers: async () => [] },
      realtime: {
        onStatusChange: () => undefined,
        onMaintenance: () => undefined,
        onStale: () => undefined,
        onNetworkLost: () => undefined,
        onLayerControl: () => undefined,
        onLanguage: () => undefined,
        onEvent: (handler: (raw: unknown) => void) => {
          realtimeHandler = handler;
        },
        notifyOnline: () => undefined,
      },
    };

    const { resetEventRouter } = await import('../src/renderer/lib/live/index.js');
    resetEventRouter();
    const { mountEditor } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    const { initRealtime } = await import('../src/renderer/realtime.js');
    const { PROPERTY_VALUES_REFRESHED_EVENT } =
      await import('../src/renderer/lib/property-values-refresh.js');

    store.update({
      networkId: 'n1',
      editorTarget: { kind: 'thought', id: 't1', thought: makeThought() },
      thoughtTypes: [{ id: 'ty1', name: 'основной тип', is_root: true, parent_id: null } as any],
      linkTypes: [
        {
          id: 'lt1',
          name_forward: 'связано с',
          name_reverse: 'связано с',
          color: null,
          style: 'solid',
          width: 1,
        } as any,
      ],
      collapsedGroups: {},
    } as any);

    initRealtime();
    const host = new ShimElement('div');
    mountEditor(host as any);
    // Первичная сборка: типовая и внетиповая таблицы прочитали значения.
    await waitFor(() => getCalls >= 2);
    await waitFor(() => findAllByClass(host, 'properties-outside-body').length === 1);
    assert.deepEqual(chipTitles(host), [], 'до события ребра чипов быть не должно');

    const failures: string[] = [];
    const check = (cond: boolean, message: string): void => {
      if (!cond) failures.push(message);
    };

    let seq = 0;
    const feed = async (
      type: string,
      data: unknown,
      actor?: { user_id: string; client_id: string },
    ): Promise<void> => {
      seq += 1;
      realtimeHandler!(realtimeEvent(type, 'n1', data, seq, actor));
      await sleep(20);
    };

    const linkOf = (chip: Chip, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      id: chip.linkId,
      type_id: 'lt1',
      source_id: chip.targetId,
      target_id: 't1',
      active: true,
      marked_for_deletion: false,
      version: 1,
      ...extra,
    });

    // --- Кейс 1: внешний link.created показанной мысли ----------------------
    // Второй клиент создал ребро со второго конца: сервер отдаёт значение, а
    // открытая вкладка обязана перечитать его без переоткрытия мысли.
    const external: Chip = { linkId: 'l9', targetId: 'x9', title: 'Сосед-обратный' };
    rows = snapshotRows([external]);
    const beforeCreate = getCalls;
    await feed('link.created', { link: linkOf(external) });
    await waitFor(() => chipTitles(host).includes('Сосед-обратный'), 2500);
    check(
      chipTitles(host).includes('Сосед-обратный'),
      `внешнее ребро не появилось во вкладке «Свойства»: ${JSON.stringify(chipTitles(host))}`,
    );
    check(
      getCalls > beforeCreate,
      `вкладка не перечитала значения по внешнему link.created (чтений ${getCalls - beforeCreate})`,
    );

    // --- Кейс 2: внешнее ребро ЧУЖОЙ мысли — вкладку не трогает ------------
    const beforeForeign = getCalls;
    await feed('link.created', {
      link: {
        id: 'l10',
        type_id: 'lt1',
        source_id: 'x3',
        target_id: 'x4',
        active: true,
        version: 1,
      },
    });
    await sleep(450);
    check(
      getCalls === beforeForeign,
      `ребро чужой мысли перечитало открытую вкладку (${getCalls - beforeForeign} чтений)`,
    );
    check(
      chipTitles(host).includes('Сосед-обратный'),
      'ребро чужой мысли изменило показанные строки',
    );

    // --- Кейс 3: внешний link.deleted (в нагрузке только id) ----------------
    // Концы ребра берутся из нормализованного кэша: запись ещё жива (её положил
    // `link.created` выше). Удалённое ребро обязано исчезнуть из строки.
    rows = snapshotRows([]);
    const beforeDelete = getCalls;
    await feed('link.deleted', { id: external.linkId });
    await waitFor(() => chipTitles(host).length === 0, 2500);
    check(
      chipTitles(host).length === 0,
      `удалённое ребро осталось в строке свойств: ${JSON.stringify(chipTitles(host))}`,
    );
    check(
      getCalls > beforeDelete,
      `вкладка не перечитала значения по внешнему link.deleted (чтений ${getCalls - beforeDelete})`,
    );

    // --- Кейс 4: внешний link.updated кэшированного ребра ------------------
    // Пометка ребра в корзину/смена типа меняет строку свойства — вкладка
    // обязана перечитать её; ребро, которого клиент не знает, адресовать нечем.
    rows = snapshotRows([external]);
    await feed('link.created', { link: linkOf(external) });
    await waitFor(() => chipTitles(host).includes('Сосед-обратный'), 2500);
    const beforeUpdate = getCalls;
    await feed('link.updated', {
      id: external.linkId,
      changes: { marked_for_deletion: true },
      version: 2,
    });
    await waitFor(() => getCalls > beforeUpdate, 2500);
    check(
      getCalls > beforeUpdate,
      `вкладка не перечитала значения по внешнему link.updated (чтений ${getCalls - beforeUpdate})`,
    );
    const beforeUnknownUpdate = getCalls;
    await feed('link.updated', { id: 'postoronniy', changes: { active: false }, version: 2 });
    await sleep(450);
    check(
      getCalls === beforeUnknownUpdate,
      `неизвестное ребро перечитало открытую вкладку (${getCalls - beforeUnknownUpdate} чтений)`,
    );

    // --- Кейс 5: своя запись — немедленно и без второго залпа --------------
    // Своё сохранение значения-связи идёт локальным каналом (немедленное
    // перечитывание), затем приходит собственное realtime-эхо ребра: оно
    // обязано дать ОДИН склеенный проход, а не второй залп чтений.
    const own: Chip = { linkId: 'l11', targetId: 'x11', title: 'Свой сосед' };
    rows = snapshotRows([external, own]);
    const beforeOwnSave = getCalls;
    (globalThis as any).document.dispatchEvent(
      new ShimCustomEvent(PROPERTY_VALUES_REFRESHED_EVENT),
    );
    // Немедленный проход локального канала: типовая и внетиповая таблицы — два
    // чтения (плитка счётчика не участвует: она перечитывается отдельно).
    await waitFor(() => getCalls >= beforeOwnSave + 2, 2000);
    check(
      getCalls - beforeOwnSave >= 2,
      `своя запись не дала немедленного перечитывания (чтений ${getCalls - beforeOwnSave})`,
    );
    await waitFor(() => chipTitles(host).includes('Свой сосед'), 2000);
    const beforeOwnEcho = getCalls;
    await feed('link.created', { link: linkOf(own) }, { user_id: 'u1', client_id: 'c1' });
    // Один склеенный проход (окно 250 мс) на три потребителя значений вкладки:
    // типовая таблица, тело «Свойства вне типа» и счётчик группы — 3 чтения, не
    // залп на событие.
    await sleep(450);
    const ownEchoReads = getCalls - beforeOwnEcho;
    check(
      ownEchoReads <= 3,
      `своё realtime-эхо дало ${ownEchoReads} чтений вместо одного склеенного прохода (3)`,
    );
    check(
      chipTitles(host).includes('Свой сосед') && chipTitles(host).includes('Сосед-обратный'),
      `своя запись потеряла показанные чипы: ${JSON.stringify(chipTitles(host))}`,
    );

    assert.deepEqual(
      failures,
      [],
      `дефекты инвалидации вкладки «Свойства»:\n${failures.join('\n')}`,
    );
  });
});
