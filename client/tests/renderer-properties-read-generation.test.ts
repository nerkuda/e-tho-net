/**
 * Regression test for ETN error da7bbb53, круг 2 «Поколение чтения значений
 * владельца».
 *
 * Симптом (найден верификатором круга 1): эпоха `RestClient` запрещает
 * ПЕРЕИСПОЛЬЗОВАТЬ in-flight GET, начатый до изменения данных, но сама панель
 * «Свойства» применяла поздний ответ такого чтения по единственной проверке
 * владельца — снимала dirty-метку и заменяла строки. Если устаревший ответ
 * доезжал ПОСЛЕ свежего (придержанная доставка), панель оставалась на снимке до
 * правки навсегда.
 *
 * Проверяется реальный путь `mountEditor` → вкладка «Свойства» → событие через
 * `initRealtime` (роутер слоя) → ответы `properties.get` в обратном порядке:
 *  1) устаревший ответ, доставленный последним, НЕ применяется: типовая строка,
 *     внетиповая и счётчик группы остаются на свежих значениях (на HEAD
 *     `0d18d56a` кейс красный — панель возвращается к снимку до правки);
 *  2) dirty-метку снимает только чтение, начатое после изменения: устаревший
 *     ответ её не снимает и следующий показ вкладки обязан перечитать (на HEAD
 *     `0d18d56a` кейс красный — метка снята, показ молчит).
 *
 * Тест — гейт для мутаций: убрать сдвиг поколения на data-событии, применять
 * ответ без проверки поколения или снимать метку устаревшим чтением — кейсы
 * падают.
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
// Реальный путь: чтения значений в обратном порядке
// ---------------------------------------------------------------------------

describe('поколение чтения значений владельца (ошибка da7bbb53, круг 2)', () => {
  it('поздний ответ устаревшего чтения не применяется и не снимает dirty-метку', async () => {
    shimDom();

    /** Серверное состояние значений; меняется между чтениями. */
    let rows = snapshotRows(['срочно'], ['старое']);
    let getCalls = 0;
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
      thoughtTypes: [{ id: 'ty1', name: 'основной тип', is_root: true, parent_id: null } as any],
      linkTypes: [],
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
      await waitFor(() => false, 30);
    };

    // Группа «Свойства вне типа» (вторая сворачиваемая группа вкладки): на ней
    // же проверяется третий потребитель — счётчик значений.
    const outsideGroup = findAllByClass(host, 'group')[1];
    assert.ok(outsideGroup !== undefined, 'группа «Свойства вне типа» найдена');
    const refreshCount = (): void => {
      outsideGroup!.dispatchEvent(new ShimCustomEvent('etn:refresh-count'));
    };

    // --- Кейс 1: устаревший ответ приходит ПОСЛЕ свежего ---------------------
    // Устаревшие чтения (счётчик + типовая + внетиповая) стартуют до изменения
    // данных и придерживаются; свежие — после события и доставляются первыми.
    holdReads = true;
    refreshCount();
    await waitFor(() => held.length >= 1, 1000);
    await feed('property-value.set', {
      owner_type: 'thought',
      owner_id: 't1',
      key: 'Теги',
      values: ['срочно', 'смена'],
    });
    await waitFor(() => held.length >= 3, 1500);
    check(held.length >= 3, `устаревших чтений придержано ${held.length} вместо трёх`);

    rows = snapshotRows(['срочно', 'смена'], ['новое', 'второе']);
    holdReads = false;
    await feed('property-value.set', {
      owner_type: 'thought',
      owner_id: 't1',
      key: 'Теги',
      values: ['срочно', 'смена'],
    });
    await waitFor(() => chipTitles(host).includes('смена'), 1500);
    await waitFor(() => outsideScalarValue(host) === 'новое', 1500);
    // Свежий счётчик: два внетиповых значения.
    refreshCount();
    await waitFor(() => outsideCount(host) === '(2)', 1500);

    // Устаревшие ответы доезжают последними — и не должны ничего изменить.
    for (const resolve of held) resolve();
    await waitFor(() => false, 200);
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

    // --- Кейс 2: dirty-метку снимает только чтение ПОСЛЕ изменения ------------
    // Устаревшее чтение придержано, свежее — отказывает. Устаревший ответ,
    // доехавший последним, не имеет права снять метку: следующий показ вкладки
    // обязан перечитать значения.
    held.length = 0;
    holdReads = true;
    await feed('property-value.set', {
      owner_type: 'thought',
      owner_id: 't1',
      key: 'Теги',
      values: ['срочно', 'смена', 'ещё'],
    });
    await waitFor(() => held.length >= 2, 1500);
    check(held.length >= 2, `устаревших чтений метки придержано ${held.length} вместо двух`);

    rows = snapshotRows(['срочно', 'смена', 'ещё'], ['ещё-новее']);
    holdReads = false;
    failReads = true;
    await feed('property-value.set', {
      owner_type: 'thought',
      owner_id: 't1',
      key: 'Теги',
      values: ['срочно', 'смена', 'ещё'],
    });
    await waitFor(() => toastTexts().includes(t('properties.valuesReadFailed')), 1500);
    check(
      toastTexts().includes(t('properties.valuesReadFailed')),
      'отказ свежего чтения не сообщён пользователю',
    );

    for (const resolve of held) resolve();
    await waitFor(() => false, 200);
    failReads = false;

    const callsBeforeShow = getCalls;
    editorInternals.activateTab('metadata');
    await waitFor(() => findAllByClass(host, 'properties-tab').length === 0);
    editorInternals.activateTab('properties');
    await waitFor(() => chipTitles(host).includes('ещё'), 1500);
    check(
      getCalls > callsBeforeShow,
      'показ после устаревшего ответа не перечитал значения (dirty-метка снята снимком)',
    );
    same(
      chipTitles(host),
      ['срочно', 'смена', 'ещё'],
      'показ после устаревшего ответа не обновил типовую строку',
    );
    check(
      outsideScalarValue(host) === 'ещё-новее',
      `показ после устаревшего ответа не обновил внетиповую строку: ${JSON.stringify(outsideScalarValue(host))}`,
    );

    assert.deepEqual(failures, [], `дефекты поколения чтения:\n${failures.join('\n')}`);
  });
});
