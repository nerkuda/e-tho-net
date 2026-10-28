/**
 * Regression test for ETN error f803afb6 «Полный обрыв связи: типовая таблица
 * свойств теряет строки и показывает техническую английскую ошибку».
 *
 * Симптом: при полном обрыве связи первым падает чтение ОПРЕДЕЛЕНИЙ типа
 * (`etn.types.listTypeProperties`), а не `properties.get`. Catch типовой
 * таблицы заменял всё тело `operationError(err)`: показанные строки исчезали,
 * а технический английский текст отказа main («Not connected: call
 * etn.server.connect first») попадал в интерфейс. Защита d720265c (сохранение
 * прежних строк, словарное сообщение) для этой ветки не срабатывала.
 *
 * Ожидание (карточка f803afb6):
 *  1) отказ определений при уже показанных строках — строки и их значения
 *     сохраняются, технической строки нет, отказ виден словарным сообщением;
 *  2) первый показ при отказе — вместо таблицы словарное сообщение, редакторов
 *     нет, английского текста нет;
 *  3) серия отказов не плодит одинаковые тосты (дедупликация);
 *  4) после восстановления связи (статус сети снова `connected`) панель
 *     перечитывает определения сама (onReconnected).
 *
 * На дофиксовом HEAD кейсы 1–2 красные: строки заменены «Ошибка: Not
 * connected…», редакторов нет; кейс 4 красный — повтор не взводится, потому
 * что plain-ошибка «Not connected…» не распознавалась как обрыв связи.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';
import { ru } from '../src/renderer/lib/locales/ru.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// DOM-шим (как в renderer-properties-values-failure.test.ts)
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
  documentListeners.clear();
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
    documentElement: {
      style: { setProperty: () => undefined, removeProperty: () => undefined },
    },
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
  win['setTimeout'] = setTimeout;
  win['clearTimeout'] = clearTimeout;
  win['dispatchEvent'] = () => undefined;
  win['addEventListener'] = () => undefined;
  win['removeEventListener'] = () => undefined;
}

/** Локальный канал правок значений: по нему типовая таблица перечитывается. */
function dispatchValuesRefreshed(): void {
  for (const handler of [...(documentListeners.get('etn:property-values-refreshed') ?? [])]) {
    handler({ type: 'etn:property-values-refreshed' });
  }
}

/** Ждёт выполнения условия не дольше `timeout` мс (шаг 10 мс). */
async function waitFor(cond: () => boolean, timeout = 2000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return cond();
}

/** Тексты живых тостов (`.notice-text` в `document.body`). */
function toastTexts(): string[] {
  const body = (globalThis as any).document.body as ShimElement;
  return body
    .findAll((node) => node.className.split(/\s+/).includes('notice-text'))
    .map((node) => node.flatText());
}

/** Все элементы поддерева с классом `className`. */
function findAllByClass(root: ShimElement, className: string): ShimElement[] {
  return root.findAll((node) => node.className.split(/\s+/).includes(className));
}

/** Тексты чипов значения (multiple) типовой таблицы. */
function chipTitles(host: ShimElement): string[] {
  return findAllByClass(host, 'prc-title').map((node) => node.flatText());
}

/** Тело типовой таблицы: properties-body → type-body → wrap → table → tbody. */
function typedTbody(box: ShimElement): ShimElement | undefined {
  return box.children[0]?.children[0]?.children[0]?.children[0];
}

// ---------------------------------------------------------------------------
// Фикстура: определения типа, чтение которых управляемо отказывает
// ---------------------------------------------------------------------------

interface DefinitionsSource {
  /** Отказ чтения определений: все последующие вызовы бросают. */
  fail: boolean;
  /** Сколько раз прочитали определения (проверка повтора после reconnect). */
  calls: number;
}

/** Определения одного типового свойства «Теги» (text + multiple → чипы). */
const TAGS_DEFINITION = {
  id: 'pTags',
  property_id: 'pTags',
  owner_type: 'thought_type',
  owner_id: 'ty1',
  key: 'Теги',
  value_type: 'text',
  config: { multiple: true },
  required: false,
  position: 0,
};

/** Канонический отказ main до установки соединения (`requireRest`). */
const NOT_CONNECTED = new Error('Not connected: call etn.server.connect first');

async function installEtn(source: DefinitionsSource): Promise<void> {
  const win = (globalThis as any).window as Record<string, unknown>;
  win['etn'] = {
    types: {
      listTypeProperties: async () => {
        source.calls += 1;
        if (source.fail) throw NOT_CONNECTED;
        return [TAGS_DEFINITION];
      },
    },
    properties: {
      get: async () => [
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
      ],
      set: async () => undefined,
      remove: async () => undefined,
    },
    propertyRegistry: { list: async () => [] },
    thoughts: { resolve: async () => [], findDuplicates: async () => [] },
    system: { openExternal: async () => '' },
  };
  const { store } = await import('../src/renderer/state.js');
  store.update({ networkId: 'n1', rtStatusByNetwork: { n1: 'connecting' } } as any);
}

/** Контекст редактора для мысли t1 с собственным типом ty1. */
function thoughtContext(): Record<string, unknown> {
  return {
    ownerType: 'thought',
    ownerId: 't1',
    thought: {
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
      created_at: '2026',
      updated_at: '2026',
    },
    link: null,
  };
}

const FAILED_MESSAGE = ru['properties.valuesReadFailed'];

describe('панель «Свойства»: отказ чтения определений типа (ошибка f803afb6)', () => {
  it('показанные строки и значения сохраняются, отказ словарный', async () => {
    shimDom();
    const source: DefinitionsSource = { fail: false, calls: 0 };
    await installEtn(source);
    const { propertiesInternals } = await import('../src/renderer/editor/properties.js');
    const box = propertiesInternals.buildPropertiesBody(
      thoughtContext() as any,
    ) as unknown as ShimElement;
    assert.ok(await waitFor(() => chipTitles(box).includes('срочно')), 'исходное значение показано');
    const renderedRow = typedTbody(box)?.children[0];

    // Полный обрыв: определения перестали читаться.
    source.fail = true;
    dispatchValuesRefreshed();
    assert.ok(
      await waitFor(() => toastTexts().includes(FAILED_MESSAGE)),
      `отказ определений не сообщён словарным текстом: ${JSON.stringify(toastTexts())}`,
    );

    assert.deepEqual(
      chipTitles(box),
      ['срочно'],
      'при отказе определений строки/значения потеряны или заменены технической строкой',
    );
    assert.equal(
      typedTbody(box)?.children[0],
      renderedRow,
      'строка пересобрана вместо сохранения прежнего снимка',
    );
    assert.equal(
      box.flatText().includes('Ошибка:'),
      false,
      `техническая строка «Ошибка: …» в панели: ${JSON.stringify(box.flatText())}`,
    );
    assert.equal(
      box.flatText().includes('Not connected'),
      false,
      'английский текст отказа main попал в интерфейс',
    );
  });

  it('первый показ при отказе: словарное сообщение, редакторов нет', async () => {
    shimDom();
    const source: DefinitionsSource = { fail: true, calls: 0 };
    await installEtn(source);
    const { propertiesInternals } = await import('../src/renderer/editor/properties.js');
    const box = propertiesInternals.buildPropertiesBody(
      thoughtContext() as any,
    ) as unknown as ShimElement;

    assert.ok(
      await waitFor(() => box.flatText().includes(FAILED_MESSAGE)),
      `панель не показала словарное сообщение: ${JSON.stringify(box.flatText())}`,
    );
    assert.equal(
      box.flatText().includes('Ошибка:'),
      false,
      `техническая строка «Ошибка: …» вместо сообщения из словаря: ${JSON.stringify(box.flatText())}`,
    );
    assert.equal(
      box.flatText().includes('Not connected'),
      false,
      'английский текст отказа main попал в интерфейс',
    );
    assert.equal(
      box.findAll((node) => node.tagName.toLowerCase() === 'input').length,
      0,
      'у нечитаемых строк есть редакторы',
    );
    assert.ok(
      toastTexts().includes(FAILED_MESSAGE),
      `отказ определений не сообщён пользователю: тосты ${JSON.stringify(toastTexts())}`,
    );
  });

  it('серия отказов определений не плодит одинаковые сообщения', async () => {
    shimDom();
    const source: DefinitionsSource = { fail: true, calls: 0 };
    await installEtn(source);
    const { propertiesInternals } = await import('../src/renderer/editor/properties.js');
    propertiesInternals.buildPropertiesBody(thoughtContext() as any);
    await waitFor(() => toastTexts().includes(FAILED_MESSAGE), 1000);

    dispatchValuesRefreshed();
    await waitFor(() => false, 40);
    dispatchValuesRefreshed();
    await waitFor(() => false, 40);

    assert.equal(
      toastTexts().filter((text) => text === FAILED_MESSAGE).length,
      1,
      `повторы отказа дали ${JSON.stringify(toastTexts())} вместо одного сообщения`,
    );
  });

  it('после восстановления связи панель перечитывает определения', async () => {
    shimDom();
    const source: DefinitionsSource = { fail: true, calls: 0 };
    await installEtn(source);
    const { propertiesInternals } = await import('../src/renderer/editor/properties.js');
    const box = propertiesInternals.buildPropertiesBody(
      thoughtContext() as any,
    ) as unknown as ShimElement;
    await waitFor(() => box.flatText().includes(FAILED_MESSAGE), 1000);
    const callsAfterFailure = source.calls;
    // Связь восстановлена: статус активной сети снова `connected`.
    source.fail = false;
    const { store } = await import('../src/renderer/state.js');
    store.update({ rtStatusByNetwork: { n1: 'connected' } } as any);

    assert.ok(
      await waitFor(() => chipTitles(box).includes('срочно')),
      'после переподключения панель не перечитала определения',
    );
    assert.ok(
      source.calls > callsAfterFailure,
      'чтение определений не повторено после переподключения',
    );
  });
});
