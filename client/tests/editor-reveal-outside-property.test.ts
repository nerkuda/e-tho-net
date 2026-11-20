/**
 * Переход к свойству ВНЕ ТИПА из «Связей дня» (0.16.1, задача 3054fe86).
 *
 * Дата-факт может ссылаться на свойство, которого нет в типе мысли (внетиповое
 * значение). Типовая таблица вкладки «Свойства» такую строку не находит и шлёт
 * событие `etn:reveal-outside`; вкладка раскрывает свёрнутую группу «Свойства
 * вне типа», её перечитывание показывает строку и снимает запрос.
 *
 * Отдельный файл (а не блок в `editor-reveal-property.test.ts`): модуль
 * редактора хранит `liveRenderedKey` и отложенный переход, и смонтированный в
 * соседнем тесте редактор перехватил бы запрос. Здесь редактор не монтируется —
 * проверяется сама панель.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Thought } from '@etn/shared';
import { ShimElement } from './dom-shim.js';

function shimDom(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).CustomEvent = class {
    type: string;
    detail: unknown;
    bubbles: boolean;
    constructor(type: string, init?: { detail?: unknown; bubbles?: boolean }) {
      this.type = type;
      this.detail = init?.detail;
      this.bubbles = init?.bubbles === true;
    }
  };
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
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

function installEtn(): void {
  const win = (globalThis as any).window as Record<string, unknown>;
  win.etn = {
    ui: { getState: async () => 'main', setState: async () => undefined },
    comments: { list: async () => [], create: async () => undefined },
    attachments: { list: async () => [] },
    thoughts: { get: async () => ({}) },
    // Свойства в типе НЕТ: определения пусты, значение — внетиповое.
    properties: {
      get: async () => [
        {
          property_id: 'p-out',
          property_name: 'дата приобретения',
          value_type: 'date',
          value: '2026-11-02',
          outside_type: true,
        },
      ],
    },
    types: { listTypeProperties: async () => [] },
  };
}

function makeThought(): Thought {
  return {
    id: 't1',
    title: 'T1',
    type_id: 'ta',
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
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('переход к внетиповому свойству из «Связей дня» (3054fe86)', () => {
  it('раскрывает группу «Свойства вне типа» и выделяет строку', async () => {
    shimDom();
    installEtn();
    const { store } = await import('../src/renderer/state.js');
    store.update({
      networkId: 'n1',
      collapsedGroups: { 'properties.outside': true },
    } as any);

    const { setThoughtEditorTarget, pendingPropertyRevealFor } =
      await import('../src/renderer/editor/editor.js');
    await setThoughtEditorTarget(makeThought(), {
      tab: 'properties',
      revealPropertyId: 'p-out',
    });

    const { propertiesInternals } = await import('../src/renderer/editor/properties.js');
    const ctx = {
      ownerType: 'thought' as const,
      ownerId: 't1',
      thought: makeThought(),
      link: null,
    };
    const box = propertiesInternals.buildPropertiesTab(ctx, {
      onDispose: () => undefined,
      onShow: () => undefined,
    }) as unknown as ShimElement;
    (globalThis as any).document.body.append(box);
    await flush();

    const row = box.querySelector('.prop-row-current');
    assert.notEqual(row, null, 'строка свойства вне типа выделена');
    assert.equal(row!.getAttribute('data-key'), 'p-out', 'выделена искомая внетиповая строка');
    assert.equal(pendingPropertyRevealFor('thought', 't1'), null, 'запрос снят показом строки');
  });
});
