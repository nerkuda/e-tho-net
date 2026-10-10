/**
 * Блокер приёмки задачи fd3d84f4: после перевода полей ввода на общеклиентский
 * диспетчер контекстов (`lib/keymap.ts`) потерялись МОДИФИКАТОРНЫЕ Enter —
 * прежние локальные обработчики срабатывали на `event.key === 'Enter'`
 * независимо от модификаторов (в панели «Структур» Ctrl+Enter применяет отбор,
 * в чип-поле пикера Enter фиксирует значение).
 *
 * Проверяем восстановление семантики через публичный хелпер
 * `lib/keymap-chords.ts` и реальные поля под минимальным DOM-шимом: событие
 * приходит через `keymap.dispatchKeyEvent` — тот же путь, что у
 * `installKeymap`.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import * as keymap from '../src/renderer/lib/keymap.js';
import { modifierChordVariants } from '../src/renderer/lib/keymap-chords.js';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Минимальный DOM/window-шим, достаточный панели отбора и пикеру сущностей. */
function installShim(): void {
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body,
    activeElement: body,
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    setTimeout: (fn: () => void) => {
      fn();
      return 1;
    },
    clearTimeout: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    localStorage: { getItem: () => null, setItem: () => undefined },
    etn: {
      admin: { listUsers: async () => [] },
      propertyRegistry: { list: async () => [] },
      savedFilters: { list: async () => [] },
      structures: { query: async () => ({ items: [], total: 0 }) },
      thoughts: { resolve: async () => [], findDuplicates: async () => [] },
    },
  };
}

/** Событие клавиатуры для диспетчера (он читает `key` и модификаторы). */
function keyEvent(init: {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}): KeyboardEvent {
  return {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    metaKey: init.metaKey ?? false,
    repeat: false,
    defaultPrevented: false,
    preventDefault: () => undefined,
  } as unknown as KeyboardEvent;
}

beforeEach(() => {
  installShim();
  keymap.keymapInternals.reset();
});

describe('modifierChordVariants — модификаторные Enter', () => {
  it('по умолчанию даёт чистый Enter первым и все подмножества модификаторов', () => {
    const chords = modifierChordVariants('Enter');
    assert.equal(chords[0], 'Enter', 'первым идёт сочетание по умолчанию без модификаторов');
    assert.equal(chords.length, 16, 'четыре модификатора — 2^4 подмножеств');
    for (const expected of [
      'Enter',
      'Ctrl+Enter',
      'Alt+Enter',
      'Shift+Enter',
      'Meta+Enter',
      'Ctrl+Shift+Enter',
      'Ctrl+Alt+Shift+Meta+Enter',
    ]) {
      assert.ok(chords.includes(expected), `ожидается сочетание ${expected}`);
    }
  });

  it('ограничение набора модификаторов исключает Shift (пикер сущностей)', () => {
    const chords = modifierChordVariants('Enter', ['Ctrl', 'Alt', 'Meta']);
    assert.equal(chords.length, 8, 'три модификатора — 2^3 подмножеств');
    assert.ok(
      chords.every((chord) => !chord.split('+').includes('Shift')),
      'Shift+Enter в наборе отсутствует',
    );
    assert.ok(chords.includes('Ctrl+Enter'));
    assert.ok(chords.includes('Meta+Enter'));
  });
});

describe('панель «Структур»: модификаторные Enter применяют отбор', () => {
  async function mountKeywordsInput(): Promise<{ input: ShimElement; applied: () => number }> {
    const { store } = await import('../src/renderer/state.js');
    store.state.networkId = '00000000-0000-4000-8000-0000000000aa';
    const panel = await import('../src/renderer/screens/structures/filter-panel.js');
    let count = 0;
    const host = new ShimElement('div');
    panel.mountFilterPanel(host as unknown as HTMLElement, {
      onApply: () => {
        count += 1;
      },
      onStatePersist: () => undefined,
      onCommands: () => undefined,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const input = host.querySelector('.st-f-keywords');
    assert.ok(input !== undefined, 'поле «Ключевые слова» обязано быть в панели');
    return { input: input!, applied: () => count };
  }

  it('чистый Enter и Ctrl+Enter применяют отбор; фокус держит контекст поля', async () => {
    const { input, applied } = await mountKeywordsInput();
    input.value = 'счет*';
    input.emit('focusin', {});

    assert.equal(keymap.dispatchKeyEvent(keyEvent({ key: 'Enter' })), true, 'чистый Enter обработан');
    assert.equal(applied(), 1, 'чистый Enter применил отбор');

    assert.equal(
      keymap.dispatchKeyEvent(keyEvent({ key: 'Enter', ctrlKey: true })),
      true,
      'Ctrl+Enter обработан',
    );
    assert.equal(applied(), 2, 'Ctrl+Enter применил отбор (блокер приёмки)');

    assert.equal(
      keymap.dispatchKeyEvent(keyEvent({ key: 'Enter', shiftKey: true })),
      true,
      'Shift+Enter обработан',
    );
    assert.equal(applied(), 3, 'Shift+Enter применил отбор, как раньше');

    input.emit('focusout', {});
    assert.equal(
      keymap.dispatchKeyEvent(keyEvent({ key: 'Enter', ctrlKey: true })),
      false,
      'после потери фокуса контекст поля снят — событие не обработано',
    );
    assert.equal(applied(), 3, 'без фокуса отбор не применяется');
  });
});

describe('чип-поле пикера сущностей: модификаторные Enter фиксируют значение', () => {
  async function buildField(): Promise<{
    wrapper: ShimElement;
    input: ShimElement;
    values: () => string[];
  }> {
    const { buildEntityChipField } = await import('../src/renderer/lib/entity-picker.js');
    let values: string[] = [];
    const field = buildEntityChipField({
      getValues: () => values,
      onChange: (next) => {
        values = next;
      },
      loadOptions: () => [{ id: 'x', title: 'Икс', cloud: { id: 'x', title: 'Икс' } }],
    });
    const root = field.root as unknown as ShimElement;
    const wrapper = findClass(root, 'entity-chip-field-inner');
    assert.ok(wrapper !== undefined, 'у чип-поля есть обёртка с контекстом клавиатуры');
    const input = findClass(root, 'entity-chip-input');
    assert.ok(input !== undefined, 'у чип-поля есть строка ввода');
    return { wrapper: wrapper!, input: input!, values: () => values };
  }

  /** Рекурсивный поиск элемента по классу (DOM-шим без CSS-селекторов). */
  function findClass(root: ShimElement, cls: string): ShimElement | undefined {
    if (root.classList.contains(cls)) return root;
    for (const child of root.children) {
      const found = findClass(child, cls);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  it('Enter и Ctrl+Enter фиксируют свободный текст; Shift+Enter — нет, как раньше', async () => {
    const { wrapper, input, values } = await buildField();
    wrapper.emit('focusin', {});

    input.value = 'один';
    assert.equal(keymap.dispatchKeyEvent(keyEvent({ key: 'Enter' })), true, 'чистый Enter обработан');
    assert.deepEqual(values(), ['один'], 'чистый Enter зафиксировал значение');

    input.value = 'два';
    assert.equal(
      keymap.dispatchKeyEvent(keyEvent({ key: 'Enter', ctrlKey: true })),
      true,
      'Ctrl+Enter обработан',
    );
    assert.deepEqual(values(), ['один', 'два'], 'Ctrl+Enter зафиксировал значение (блокер приёмки)');

    input.value = 'три';
    assert.equal(
      keymap.dispatchKeyEvent(keyEvent({ key: 'Enter', shiftKey: true })),
      false,
      'Shift+Enter не обработан контекстом поля — уходит ниже, как раньше',
    );
    assert.deepEqual(values(), ['один', 'два'], 'Shift+Enter значение не фиксирует');

    wrapper.emit('focusout', {});
  });
});
