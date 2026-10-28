/**
 * Regression test for ETN error da7bbb53, круг 2 «Поколение чтения значений
 * владельца» и круг 3 «Своя мутация строки и склейка волны».
 *
 * Симптом (найден верификатором круга 1): эпоха `RestClient` запрещает
 * ПЕРЕИСПОЛЬЗОВАТЬ in-flight GET, начатый до изменения данных, но сама панель
 * «Свойства» применяла поздний ответ такого чтения по единственной проверке
 * владельца — снимала dirty-метку и заменяла строки. Если устаревший ответ
 * доезжал ПОСЛЕ свежего (придержанная доставка), панель оставалась на снимке до
 * правки навсегда.
 *
 * Круг 2 закрыл realtime-события (поколение на владельца), но своя мутация
 * через контекстное меню строки («Очистить»/«Удалить») поколение не двигала:
 * ответ чтения, начатого до удаления, доезжал последним и воскрешал удалённое
 * значение. Круг 3 добавил границу на свою мутацию и склеил realtime-волну:
 * N data-событий дают один проход перечитывания, а не 2·N GET.
 *
 * Проверяется реальный путь `mountEditor` → вкладка «Свойства» → событие через
 * `initRealtime` (роутер слоя) / контекстное меню строки:
 *  1) устаревший ответ, доставленный последним, НЕ применяется: типовая строка,
 *     внетиповая и счётчик группы остаются на свежих значениях;
 *  2) dirty-метку снимает только чтение, начатое после изменения: показ вкладки
 *     после устаревшего ответа обязан перечитать — и именно внетиповую группу
 *     (это доказывает её собственное значение, а не общий счётчик вызовов);
 *  3) своя мутация «Очистить» (скаляр типовой строки) двигает поколение;
 *  4) своя мутация «Удалить» (внетиповое значение) двигает поколение;
 *  5) волна из N data-событий (включая событие без адреса показанного
 *     владельца) даёт ограниченное число чтений — склейка работает.
 *
 * Тест — гейт для мутаций: убрать сдвиг поколения на data-событии/своей
 * мутации, применять ответ без проверки поколения, снимать метку устаревшим
 * чтением или отключить склейку — кейсы падают.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AnyRealtimeEvent, Thought } from '@etn/shared';
import { ShimElement } from './dom-shim.js';
import { t } from '../src/renderer/lib/i18n.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// DOM-шим (как в renderer-properties-stale-tab.test.ts)
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

/**
 * Дать отработать микрозадачам и уже запланированным таймерам нулевой длины:
 * после `resolve()` придержанного ответа продолжения потребителей (проверка
 * поколения, применение/отказ) выполняются в микрозадачах. Это ожидание
 * условия «ответ доставлен», а не фиксированная пауза на «успевание».
 */
async function flushDelivered(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/** Значение счётчика группы «Свойства вне типа» (или null). */
function outsideCount(host: ShimElement): string | null {
  const groups = findAllByClass(host, 'group');
  const outside = groups[1];
  if (outside === undefined) return null;
  const badge = findAllByClass(outside, 'ui-badge--quiet')[0];
  return badge === undefined ? null : badge.textContent;
}

/** Тексты живых тостов (`.notice-text` в `document.body`). */
function toastTexts(): string[] {
  const body = (globalThis as any).document.body as ShimElement;
  return body
    .findAll((node) => node.className.split(/\s+/).includes('notice-text'))
    .map((node) => node.textContent);
}

/** Ячейка имени строки свойства по видимому имени. */
function findNameCell(host: ShimElement, name: string): ShimElement | undefined {
  return findAllByClass(host, 'prop-name-cell').find((node) => node.textContent.includes(name));
}

/**
 * Открыть контекстное меню строки (реальный путь `contextmenu` на ячейке
 * имени) и нажать пункт по подписи — действия меню вызывают серверные
 * операции ровно как у пользователя.
 */
function clickRowMenuItem(host: ShimElement, rowName: string, label: string): void {
  const cell = findNameCell(host, rowName);
  assert.ok(cell !== undefined, `ячейка имени строки «${rowName}» найдена`);
  cell!.dispatchEvent({
    type: 'contextmenu',
    clientX: 10,
    clientY: 10,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  });
  const body = (globalThis as any).document.body as ShimElement;
  const item = body
    .findAll((node) => node.className.split(/\s+/).includes('menu-item'))
    .find((node) => node.textContent.includes(label));
  assert.ok(item !== undefined, `пункт меню «${label}» найден`);
  item!.dispatchEvent({ type: 'click', stopPropagation: () => undefined });
}

// ---------------------------------------------------------------------------
// Серверный снимок значений: типовая «Теги» + внетиповые строки
// ---------------------------------------------------------------------------

/** Снимок значений владельца `t1`: теги (чипы) + внетиповые скаляры. */
function snapshotRows(tags: string[], outside: string[]): unknown[] {
  return [
    {
      id: `vTags-${tags.join('-')}`,
      owner_type: 'thought',
      owner_id: 't1',
      property_id: 'pTags',
      property_name: 'Теги',
      value_type: 'text',
      value: [...tags],
      outside_type: false,
      updated_at: '2026-01-01',
    },
    ...outside.map((value, index) => ({
      id: `vExt-${index}-${value}`,
      owner_type: 'thought',
      owner_id: 't1',
      property_id: `pExt${index}`,
      property_name: `Внешнее ${index}`,
      value_type: 'text',
      value,
      outside_type: true,
      updated_at: '2026-01-01',
    })),
  ];
}

// ---------------------------------------------------------------------------
// Реальный путь: чтения значений в обратном порядке, своя мутация, волна
// ---------------------------------------------------------------------------

describe('поколение чтения значений владельца (ошибка da7bbb53, круги 2–3)', () => {
  it('позднее чтение не применяется, своя мутация двигает поколение, волна склеена', async () => {
    shimDom();

    /** Серверное состояние значений; меняется между чтениями. */
    let rows = snapshotRows(['срочно'], ['старое']);
    let getCalls = 0;
    let removeCalls = 0;
    let lastRemovedKey: string | null = null;
    /** Помеченные рёбра для ветки «Очистить» свойства-связи (восстановление). */
    let trashLinks: Array<Record<string, unknown>> = [];
    let linkUpdates = 0;
    /** Новые чтения придерживаются (устаревшее чтение в полёте). */
    let holdReads = false;
    /** Новые чтения отвечают отказом (проверка dirty-метки). */
    let failReads = false;
    /** Придержанные ответы: снимок на момент ЗАПРОСА + разрешение доставки. */
    const held: Array<() => void> = [];
    let realtimeHandler: ((raw: unknown) => void) | null = null;

    (globalThis as any).window.etn = {
      ui: { getState: async () => 'properties', setState: async () => undefined },
      properties: {
        get: (_networkId: string, _ownerType: string, _ownerId: string) => {
          getCalls += 1;
          // Снимок на момент запроса: придержанный ответ обязан нести данные
          // ДО изменения, иначе кейс обратного порядка ничего не проверяет.
          const snapshot = rows.map((row) => ({ ...(row as object) }));
          if (failReads) return Promise.reject(new Error('values read failure'));
          if (!holdReads) return Promise.resolve(snapshot);
          return new Promise((resolve) => {
            held.push(() => resolve(snapshot));
          });
        },
        set: async () => undefined,
        remove: async (
          _networkId: string,
          _ownerType: string,
          _ownerId: string,
          key: string,
        ) => {
          removeCalls += 1;
          lastRemovedKey = key;
          // Мутация серверного состояния: удалённое значение пропадает из
          // последующих снимков — как DELETE на сервере.
          rows = rows.filter(
            (row) => (row as { property_name: string }).property_name !== key,
          );
        },
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
          {
            // Свойство-связь: «Очистить» идёт веткой `etn.links.update`
            // (снятие пометки корзины), а не `etn.properties.remove`.
            id: 'pRel',
            property_id: 'pRel',
            owner_type: 'thought_type',
            owner_id: 'ty1',
            key: 'Связи',
            value_type: 'link',
            config: { link_type_id: 'lt1' },
            required: false,
            position: 1,
          },
        ],
      },
      trash: {
        list: async () => ({
          thoughts: [],
          links: trashLinks,
          publications: [],
          shelves: [],
        }),
      },
      links: {
        update: async (
          _networkId: string,
          _id: string,
          _patch: unknown,
          _version: number,
        ) => {
          linkUpdates += 1;
          // Восстановление ребра меняет серверный снимок: последующее чтение
          // обязано его увидеть, а чтение, начатое до операции, — прежний снимок.
          rows = snapshotRows(['после-очистки'], ['старое']);
        },
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
    const { PROPERTY_VALUES_REFRESHED_EVENT } = await import(
      '../src/renderer/lib/property-values-refresh.js'
    );

    store.update({
      networkId: 'n1',
      editorTarget: { kind: 'thought', id: 't1', thought: makeThought() },
      thoughtTypes: [{ id: 'ty1', name: 'основной тип', is_root: true, parent_id: null } as any],
      linkTypes: [
        {
          id: 'lt1',
          name_forward: 'связь',
          name_reverse: 'связи',
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
    await waitFor(() => chipTitles(host).includes('срочно'));
    await waitFor(() => outsideScalarValue(host) === 'старое');

    const failures: string[] = [];
    const check = (cond: boolean, message: string): void => {
      if (!cond) failures.push(message);
    };
    const same = (actual: unknown, expected: unknown, message: string): void => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures.push(`${message}: получено ${JSON.stringify(actual)}`);
      }
    };

    let seq = 0;
    const feed = async (type: string, data: unknown): Promise<void> => {
      seq += 1;
      realtimeHandler!(realtimeEvent(type, 'n1', data, seq));
      await sleep(20);
    };
    const feedTags = (values: string[]): Promise<void> =>
      feed('property-value.set', {
        owner_type: 'thought',
        owner_id: 't1',
        key: 'Теги',
        values,
      });

    // Группа «Свойства вне типа» (вторая сворачиваемая группа вкладки): на ней
    // же проверяется третий потребитель — счётчик значений.
    const outsideGroup = findAllByClass(host, 'group')[1];
    assert.ok(outsideGroup !== undefined, 'группа «Свойства вне типа» найдена');
    const refreshCount = (): void => {
      outsideGroup!.dispatchEvent(new ShimCustomEvent('etn:refresh-count'));
    };

    /** Локальный канал правок: стартует НЕМЕДЛЕННЫЕ чтения обеих таблиц. */
    const startLocalReload = (): void => {
      (globalThis as any).document.dispatchEvent(
        new ShimCustomEvent(PROPERTY_VALUES_REFRESHED_EVENT),
      );
    };

    /**
     * Привести показанную панель к состоянию `tags/outside` realtime-волной:
     * событие отдаётся через роутер, перечитывание ждём ПО УСЛОВИЮ (чтение
     * началось и значения на экране), без фиксированной паузы.
     */
    const settleWave = async (tags: string[], outside: string[]): Promise<void> => {
      rows = snapshotRows(tags, outside);
      const before = getCalls;
      await feedTags(tags);
      await waitFor(() => getCalls > before, 2500);
      await waitFor(
        () =>
          JSON.stringify(chipTitles(host)) === JSON.stringify(tags) &&
          outsideScalarValue(host) === (outside[0] ?? null),
        2500,
      );
    };

    // --- Кейс 1: устаревший ответ приходит ПОСЛЕ свежего ---------------------
    // Устаревшие чтения (счётчик + типовая + внетиповая) стартуют до изменения
    // данных и придерживаются; свежие — после события и доставляются первыми.
    held.length = 0;
    holdReads = true;
    refreshCount();
    startLocalReload();
    await waitFor(() => held.length >= 3, 1500);
    check(held.length >= 3, `устаревших чтений придержано ${held.length} вместо трёх`);

    rows = snapshotRows(['срочно', 'смена'], ['новое', 'второе']);
    holdReads = false;
    await feedTags(['срочно', 'смена']);
    await waitFor(() => chipTitles(host).includes('смена'), 2000);
    await waitFor(() => outsideScalarValue(host) === 'новое', 2000);
    // Свежий счётчик: два внетиповых значения.
    refreshCount();
    await waitFor(() => outsideCount(host) === '(2)', 2000);

    // Устаревшие ответы доезжают последними — и не должны ничего изменить.
    for (const resolve of held) resolve();
    await flushDelivered();
    same(
      chipTitles(host),
      ['срочно', 'смена'],
      'поздний устаревший ответ вернул типовую строку к снимку до правки',
    );
    check(
      outsideScalarValue(host) === 'новое',
      `поздний устаревший ответ вернул внетиповую строку: ${JSON.stringify(outsideScalarValue(host))}`,
    );
    check(
      outsideCount(host) === '(2)',
      `поздний устаревший ответ вернул счётчик: ${JSON.stringify(outsideCount(host))}`,
    );
    // Отброшенные чтения запускают повтор в окне склейки — даём ему закрыться,
    // чтобы он не попал в следующий кейс (своих утверждений здесь нет).
    await sleep(350);

    // --- Кейс 2: dirty-метку снимает только чтение ПОСЛЕ изменения ------------
    // Устаревшее чтение придержано, свежее — отказывает. Устаревший ответ,
    // доехавший последним, не имеет права снять метку: следующий показ вкладки
    // обязан перечитать — и именно ВНЕТИПОВУЮ группу (её значение меняется
    // только новым чтением), а не довольствоваться любым `properties.get`.
    held.length = 0;
    holdReads = true;
    startLocalReload();
    await waitFor(() => held.length >= 2, 1500);
    check(held.length >= 2, `устаревших чтений метки придержано ${held.length} вместо двух`);

    rows = snapshotRows(['срочно', 'смена', 'ещё'], ['ещё-новее']);
    holdReads = false;
    failReads = true;
    await feedTags(['срочно', 'смена', 'ещё']);
    await waitFor(() => toastTexts().includes(t('properties.valuesReadFailed')), 2000);
    check(
      toastTexts().includes(t('properties.valuesReadFailed')),
      'отказ свежего чтения не сообщён пользователю',
    );

    for (const resolve of held) resolve();
    await flushDelivered();
    failReads = false;

    // Тихая смена серверных данных: увидеть её можно ТОЛЬКО новым чтением.
    // Если устаревший ответ снял метку, показ вкладки не перечитает группы.
    rows = snapshotRows(['срочно', 'смена', 'ещё'], ['после-показа']);
    editorInternals.activateTab('metadata');
    await waitFor(() => findAllByClass(host, 'properties-tab').length === 0);
    editorInternals.activateTab('properties');
    await waitFor(() => chipTitles(host).includes('ещё'), 2500);
    same(
      chipTitles(host),
      ['срочно', 'смена', 'ещё'],
      'показ после устаревшего ответа не обновил типовую строку',
    );
    check(
      outsideScalarValue(host) === 'после-показа',
      `показ после устаревшего ответа не перечитал внетиповую группу: ${JSON.stringify(outsideScalarValue(host))}`,
    );
    await sleep(350);

    // --- Кейс 3: своя мутация «Очистить» (скаляр типовой строки) -------------
    // Панель показывает «срочно»; чтение придержано; «Очистить» в меню строки
    // удаляет значение; свежее чтение даёт []; придержанное доезжает последним.
    await settleWave(['срочно'], ['старое']);
    held.length = 0;
    holdReads = true;
    startLocalReload();
    await waitFor(() => held.length >= 2, 1500);
    holdReads = false;
    const removesBeforeClear = removeCalls;
    clickRowMenuItem(host, 'Теги', 'Очистить');
    await waitFor(() => removeCalls === removesBeforeClear + 1, 2000);
    check(lastRemovedKey === 'Теги', `«Очистить» удалил ${JSON.stringify(lastRemovedKey)}`);
    await waitFor(() => chipTitles(host).length === 0, 2500);
    same(chipTitles(host), [], 'свежее чтение после «Очистить» не показало пустое значение');

    for (const resolve of held) resolve();
    await flushDelivered();
    same(
      chipTitles(host),
      [],
      'поздний ответ чтения до своей мутации вернул удалённое значение',
    );
    check(
      outsideScalarValue(host) === 'старое',
      `своя мутация скалярного значения вернула внетиповую строку: ${JSON.stringify(outsideScalarValue(host))}`,
    );
    // Отброшенное чтение запускает повтор в окне склейки — закрываем его до
    // следующего кейса (своих утверждений здесь нет).
    await sleep(350);

    // --- Кейс 3б: своя мутация «Очистить» ветки свойства-связи ----------------
    // «Очистить» у свойства-связи снимает пометку корзины с рёбер
    // (`etn.links.update`) — вторая ветка clearRowValue. Мутация меняет
    // серверный снимок; придержанное до неё чтение не должно его перекрыть.
    await settleWave(['срочно'], ['старое']);
    trashLinks = [
      {
        id: 'l-marked',
        type_id: 'lt1',
        source_id: 't1',
        target_id: 'x1',
        version: 1,
      },
    ];
    const updatesBefore = linkUpdates;
    held.length = 0;
    holdReads = true;
    startLocalReload();
    await waitFor(() => held.length >= 2, 1500);
    holdReads = false;
    clickRowMenuItem(host, 'Связи', 'Очистить');
    await waitFor(() => linkUpdates === updatesBefore + 1, 2000);
    check(linkUpdates === updatesBefore + 1, '«Очистить» связи не восстановила ребро');
    await waitFor(() => chipTitles(host).includes('после-очистки'), 2500);

    for (const resolve of held) resolve();
    await flushDelivered();
    same(
      chipTitles(host),
      ['после-очистки'],
      'поздний ответ чтения до «Очистить» связи перекрыл свежий снимок',
    );
    trashLinks = [];
    await sleep(350);

    // --- Кейс 4: своя мутация «Удалить» (внетиповое значение) -----------------
    await settleWave(['срочно'], ['старое', 'второе']);
    held.length = 0;
    holdReads = true;
    startLocalReload();
    await waitFor(() => held.length >= 2, 1500);
    holdReads = false;
    const removesBeforeOutside = removeCalls;
    clickRowMenuItem(host, 'Внешнее 0', 'Удалить');
    await waitFor(() => removeCalls === removesBeforeOutside + 1, 2000);
    check(
      lastRemovedKey === 'Внешнее 0',
      `«Удалить» внетиповой строки удалил ${JSON.stringify(lastRemovedKey)}`,
    );
    await waitFor(() => outsideScalarValue(host) === 'второе', 2500);

    for (const resolve of held) resolve();
    await flushDelivered();
    check(
      outsideScalarValue(host) === 'второе',
      `поздний ответ чтения до «Удалить» вернул внетиповое значение: ${JSON.stringify(outsideScalarValue(host))}`,
    );
    same(chipTitles(host), ['срочно'], 'своя мутация внетиповой строки тронула типовую');
    await sleep(350);

    // --- Кейс 5: волна data-событий склеена ----------------------------------
    // Четыре события показанного владельца и одно событие без адреса (двигает
    // только общую границу) — один проход перечитывания, а не 2·N GET.
    await settleWave(['срочно'], ['старое']);
    const callsBeforeWave = getCalls;
    rows = snapshotRows(['итог'], ['итоговое']);
    await feedTags(['итог']);
    await feedTags(['итог']);
    await feedTags(['итог']);
    // Событие чужого владельца двигает ОБЩУЮ границу, но не перечитывает
    // показанную панель (владелец не наблюдаемый — общая эпоха).
    await feed('property-value.set', {
      owner_type: 'thought',
      owner_id: 't2',
      key: 'Чужое',
      values: ['x'],
    });
    await feedTags(['итог']);
    await waitFor(() => chipTitles(host).includes('итог'), 2500);
    await waitFor(() => outsideScalarValue(host) === 'итоговое', 2500);
    const waveReads = getCalls - callsBeforeWave;
    check(waveReads >= 2, `волна не перечитала значения: ${waveReads} чтений`);
    check(
      waveReads <= 3,
      `волна из 5 событий дала ${waveReads} properties.get — склейка волны не работает`,
    );
    same(chipTitles(host), ['итог'], 'волна не применила свежие значения');
    check(
      outsideScalarValue(host) === 'итоговое',
      `волна не применила свежее внетиповое значение: ${JSON.stringify(outsideScalarValue(host))}`,
    );

    assert.deepEqual(failures, [], `дефекты поколения чтения:\n${failures.join('\n')}`);
  });
});
