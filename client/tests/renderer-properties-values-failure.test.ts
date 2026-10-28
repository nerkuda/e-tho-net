/**
 * Regression test for ETN error d720265c «Панель "Свойства" при отказе чтения
 * значений показывает пустые строки вместо прежних».
 *
 * Симптом: `properties.get` отвечает отказом (сеть, 5xx), типовая таблица
 * перерисовывается с `value: undefined` из молчаливого `catch` — пользователь
 * видит пустоту вместо прежних значений и не знает об отказе. Внетиповая
 * таблица подменяет тело технической строкой `operationError`, тоже теряя
 * показанные строки.
 *
 * Ожидание (карточка d720265c):
 *  1) при отказе чтения строки сохраняют прежние значения;
 *  2) прежних значений ещё нет (первый показ) — вместо пустого редактора
 *     строка явно помечена «не удалось прочитать», а не выглядит стёртой;
 *  3) отказ виден пользователю сообщением из словаря, без технических
 *     терминов и без дублей при повторных отказах/ретраях.
 *
 * На дофиксовом HEAD все кейсы красные: типовая строка остаётся с пустым
 * редактором, внетиповая — с `operationError`, сообщения нет.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';
import { ru } from '../src/renderer/lib/locales/ru.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// DOM-шим: минимальный набор, достаточный для панели «Свойства» и тостов
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

/** Локальный канал правок значений: по нему таблицы перечитывают `properties.get`. */
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

/** Значение первого скалярного редактора внетиповой таблицы (или null). */
function outsideScalarInput(host: ShimElement): ShimElement | undefined {
  return host.findAll(
    (node) =>
      node.tagName.toLowerCase() === 'input' &&
      node.className.split(/\s+/).includes('prop-editor'),
  )[0];
}

// ---------------------------------------------------------------------------
// Фикстура: `window.etn` с управляемым отказом `properties.get`
// ---------------------------------------------------------------------------

interface ValuesSource {
  /** Отказ чтения значений: все последующие `properties.get` бросают. */
  fail: boolean;
  values: Array<Record<string, unknown>>;
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

/** Внетиповое скалярное значение «Внешнее». */
function outsideValue(value: string): Record<string, unknown> {
  return {
    id: 'vExt',
    owner_type: 'thought',
    owner_id: 't1',
    property_id: 'pExt',
    property_name: 'Внешнее',
    value_type: 'text',
    value,
    outside_type: true,
    updated_at: '2026',
  };
}

async function installEtn(source: ValuesSource): Promise<void> {
  const win = (globalThis as any).window as Record<string, unknown>;
  win['etn'] = {
    types: {
      listTypeProperties: async () => [TAGS_DEFINITION],
    },
    properties: {
      get: async () => {
        if (source.fail) throw new Error('values read failure');
        return source.values.map((row) => ({ ...row }));
      },
      set: async () => undefined,
      remove: async () => undefined,
    },
    propertyRegistry: { list: async () => [] },
    thoughts: { resolve: async () => [], findDuplicates: async () => [] },
    system: { openExternal: async () => '' },
  };
  const { store } = await import('../src/renderer/state.js');
  store.update({ networkId: 'n1' } as any);
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
const UNREADABLE_MARK = ru['properties.valueUnreadable'];

describe('панель «Свойства»: отказ чтения значений (ошибка d720265c)', () => {
  it('типовая таблица при отказе сохраняет прежние значения и сообщает об отказе', async () => {
    shimDom();
    const source: ValuesSource = {
      fail: false,
      values: [
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
    };
    await installEtn(source);
    const { propertiesInternals } = await import('../src/renderer/editor/properties.js');
    const box = propertiesInternals.buildPropertiesBody(thoughtContext() as any) as unknown as ShimElement;
    assert.ok(await waitFor(() => chipTitles(box).includes('срочно')), 'исходное значение показано');

    // Отказ чтения при перечитывании (realtime/локальный канал).
    source.fail = true;
    dispatchValuesRefreshed();
    await waitFor(() => false, 80);

    assert.deepEqual(
      chipTitles(box),
      ['срочно'],
      'при отказе чтения прежнее значение подменено пустотой',
    );
    assert.ok(
      toastTexts().includes(FAILED_MESSAGE),
      `отказ чтения не сообщён пользователю: тосты ${JSON.stringify(toastTexts())}`,
    );
  });

  it('первый показ при отказе: строки помечены «не удалось прочитать», не пустые', async () => {
    shimDom();
    const source: ValuesSource = { fail: true, values: [] };
    await installEtn(source);
    const { propertiesInternals } = await import('../src/renderer/editor/properties.js');
    const box = propertiesInternals.buildPropertiesBody(thoughtContext() as any) as unknown as ShimElement;

    assert.ok(
      await waitFor(() => typedTbody(box)?.children.length === 1),
      'типовая таблица построена по определениям',
    );
    const tbody = typedTbody(box)!;
    assert.ok(
      tbody.flatText().includes(UNREADABLE_MARK),
      `вместо пометки «${UNREADABLE_MARK}» показано: ${JSON.stringify(tbody.flatText())}`,
    );
    assert.equal(
      tbody.querySelectorAll('input').length,
      0,
      'пустой редактор значения выглядит как «значение стёрто»',
    );
    assert.ok(
      toastTexts().includes(FAILED_MESSAGE),
      `отказ чтения не сообщён пользователю: тосты ${JSON.stringify(toastTexts())}`,
    );
  });

  it('внетиповая таблица при отказе сохраняет прежние значения и сообщает об отказе', async () => {
    shimDom();
    const source: ValuesSource = { fail: false, values: [outsideValue('старое')] };
    await installEtn(source);
    const { propertiesInternals } = await import('../src/renderer/editor/properties.js');
    const box = propertiesInternals.buildOutsidePropertiesBody({
      ownerType: 'thought',
      ownerId: 't1',
      typeId: 'ty1',
      hasOwnType: true,
    }) as unknown as ShimElement;
    assert.ok(
      await waitFor(() => outsideScalarInput(box)?.value === 'старое'),
      'исходное внетиповое значение показано',
    );
    const inputBefore = outsideScalarInput(box);

    source.fail = true;
    dispatchValuesRefreshed();
    await waitFor(() => false, 80);

    assert.equal(
      outsideScalarInput(box)?.value,
      'старое',
      'при отказе чтения внетиповое значение стёрто',
    );
    assert.equal(outsideScalarInput(box), inputBefore, 'строка пересобрана вместо сохранения');
    assert.ok(
      toastTexts().includes(FAILED_MESSAGE),
      `отказ чтения не сообщён пользователю: тосты ${JSON.stringify(toastTexts())}`,
    );
  });

  it('первый показ внетиповой при отказе: сообщение из словаря вместо технической ошибки', async () => {
    shimDom();
    const source: ValuesSource = { fail: true, values: [] };
    await installEtn(source);
    const { propertiesInternals } = await import('../src/renderer/editor/properties.js');
    const box = propertiesInternals.buildOutsidePropertiesBody({
      ownerType: 'thought',
      ownerId: 't1',
      typeId: 'ty1',
      hasOwnType: true,
    }) as unknown as ShimElement;
    await waitFor(() => box.flatText().includes(FAILED_MESSAGE), 1000);

    assert.ok(
      box.flatText().includes(FAILED_MESSAGE),
      `внетиповая таблица не сообщила об отказе: ${JSON.stringify(box.flatText())}`,
    );
    assert.ok(
      !box.flatText().includes('Ошибка:'),
      'техническая строка «Ошибка: …» вместо понятного сообщения',
    );
    assert.ok(
      toastTexts().includes(FAILED_MESSAGE),
      `отказ чтения не сообщён пользователю: тосты ${JSON.stringify(toastTexts())}`,
    );
  });

  it('повторные отказы не плодят одинаковые сообщения', async () => {
    shimDom();
    const source: ValuesSource = { fail: true, values: [] };
    await installEtn(source);
    const { propertiesInternals } = await import('../src/renderer/editor/properties.js');
    propertiesInternals.buildOutsidePropertiesBody({
      ownerType: 'thought',
      ownerId: 't1',
      typeId: 'ty1',
      hasOwnType: true,
    });
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
});
