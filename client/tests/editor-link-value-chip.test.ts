/**
 * Unit tests for `buildLinkValueEditor` (задача 8ab775d9, 0.8.1, единая
 * модель связей) — редактор значения свойства-ссылки на мысль. Single-режим
 * (автокомплит по заголовку мысли) и multiple-режим (чипы + добавление +
 * контекстное меню облачка) проверяются через DOM-shim, как соседние editor-*
 * тесты.
 *
 * Здесь намеренно избегаем dispatch('input') (внутренняя `wireTokenCombo`
 * запускает асинхронную цепочку `etn.thoughts.search → document.body.append`
 * → positionBodyDropdown → requestAnimationFrame, в shim-среде
 * зависающую на неопределённое время) — тесты покрывают статическую
 * структуру DOM и факт регистрации click/dblclick/contextmenu/keydown
 * обработчиков чипов; интерактивный автокомплит покрывается отдельным
 * value-combo test'ом.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Element-stub с поддержкой keydown / contextmenu / setAttribute. */
class ShimElement {
  tagName: string;
  className = '';
  children: ShimElement[] = [];
  textContent = '';
  value = '';
  type = '';
  checked = false;
  title = '';
  placeholder = '';
  isConnected = true;
  tabIndex = -1;
  attributes: Record<string, string> = {};
  listeners: Record<string, Array<(event?: any) => void>> = {};
  style: Record<string, string> = {};
  parent: ShimElement | null = null;
  classList = {
    add: () => undefined,
    remove: () => undefined,
    toggle: () => undefined,
    contains: () => false,
  };
  constructor(tag: string, className?: string, text?: string) {
    this.tagName = tag;
    if (className !== undefined) this.className = className;
    if (text !== undefined) this.textContent = text;
  }
  append(...nodes: ShimElement[]): void {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: ShimElement[]): void {
    this.children = nodes;
  }
  removeChild(node: ShimElement): void {
    this.children = this.children.filter((c) => c !== node);
  }
  remove(): void {
    this.parent = null;
  }
  addEventListener(type: string, handler: (event?: any) => void): void {
    (this.listeners[type] ??= []).push(handler);
  }
  removeEventListener(): void {}
  dispatch(type: string, event?: any): void {
    for (const handler of this.listeners[type] ?? []) handler(event);
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
  contains(): boolean {
    return false;
  }
  focus(): void {}
  click(): void {
    this.dispatch('click');
  }
  querySelector(): ShimElement | null {
    return null;
  }
  querySelectorAll(): ShimElement[] {
    return [];
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };
  }
}

let sharedWindow: Record<string, unknown> = {};
let seenGets: string[] = [];

/**
 * Установка шима: document/window + минимальный `etn.thoughts.get` для
 * подписи чипа. `lib/etn.ts` привязывается к `window.etn` при первом
 * импорте — оставляем ОДИН глобальный объект на весь test-файл.
 */
function installShim(): void {
  seenGets = [];
  if ((globalThis as any).document === undefined) {
    (globalThis as any).document = {
      createElement: (tag: string) => new ShimElement(tag),
      createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
      documentElement: { style: {} },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => undefined,
      querySelector: () => null,
      activeElement: null,
      body: new ShimElement('body'),
    };
  }
  sharedWindow = (globalThis as any).window ?? {};
  (globalThis as any).window = sharedWindow;
  if (sharedWindow['etn'] === undefined) sharedWindow['etn'] = {};
  const etnApi = sharedWindow['etn'] as Record<string, unknown>;
  // `search` не нужен этим тестам — пробрасываем заглушку, чтобы случайный
  // позыв из `wireTokenCombo` не уходил в undefined.
  etnApi['thoughts'] = {
    search: async () => ({ by_names: [] }),
    get: async (_n: string, id: string) => {
      seenGets.push(id);
      return {
        id,
        title: `Title of ${id}`,
        type_id: null,
        icon: null,
        icon_kind: 'emoji',
        icon_attachment_id: null,
        active: true,
        marked_for_deletion: false,
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
      };
    },
  };
  if (etnApi['system'] === undefined) etnApi['system'] = {};
  (etnApi['system'] as Record<string, unknown>)['openExternal'] = async () => '';
  sharedWindow['innerWidth'] = 1024;
  sharedWindow['innerHeight'] = 768;
  sharedWindow['setTimeout'] = setTimeout;
  sharedWindow['clearTimeout'] = clearTimeout;
  sharedWindow['addEventListener'] = () => undefined;
  sharedWindow['removeEventListener'] = () => undefined;
  sharedWindow['dispatchEvent'] = () => undefined;
}

/** Возвращает все чипы (`.value-combo-chip`) в поддереве. */
function findAllChips(root: ShimElement): ShimElement[] {
  const out: ShimElement[] = [];
  const stack: ShimElement[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.className.split(' ').includes('value-combo-chip')) out.push(node);
    stack.push(...node.children);
  }
  return out;
}

const baseDefinition = {
  property_id: 'lk-prop',
  key: 'Связь',
  value_type: 'link',
  config: {},
  required: false,
  inherited: false,
  defined_on: 'thought_type',
  defined_on_name: 'Тест',
};

/**
 * Ребро-фикстура `LinkPropertyValueItem` (0.8.1: значения свойства-связи —
 * живые рёбра с `target_id`/`target_title`, не строки id). `target_title:
 * null` — заголовок до-резолвится клиентом (`etn.thoughts.get`), как раньше.
 */
function edge(id: string) {
  return {
    link_id: `link-${id}`,
    target_id: id,
    target_title: null,
    target_type_id: null,
    comment: null,
  };
}

describe('buildLinkValueEditor — single mode (8ab775d9)', () => {
  it('renders an autocomplete input with the right placeholder', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/properties.js');
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      ownerType: 'thought',
      ownerId: 't1',
      definition: baseDefinition as any,
      values: [],
      multiple: false,
      save: async () => true,
    }) as unknown as ShimElement;

    const input = editor.children[0]?.children.find(
      (c) => c.tagName === 'input' && c.type === 'text',
    ) as ShimElement | undefined;
    assert.ok(input !== undefined, 'single input rendered');
    assert.equal(
      (input as ShimElement).placeholder,
      'Введите название или id мысли…',
      'single input uses the autocomplete placeholder',
    );
  });

  it('single mode shows the resolved title next to the input when a value is set', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/properties.js');
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      ownerType: 'thought',
      ownerId: 't1',
      definition: baseDefinition as any,
      values: [edge('ta-single')],
      multiple: false,
      save: async () => true,
    }) as unknown as ShimElement;

    // Single-режим с заполненным значением: input + span с подписью.
    const row = editor.children[0];
    assert.ok(row !== undefined, 'form-row rendered');
    const label = row!.children.find((c) =>
      (c as ShimElement).className.split(' ').includes('link-value-current-label'),
    );
    assert.ok(label !== undefined, 'single mode renders a current-label span');
  });
});

describe('buildLinkValueEditor — multiple mode (chips, 8ab775d9)', () => {
  it('renders one chip per stored id with a «+ ещё одну мысль» add input', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/properties.js');
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      ownerType: 'thought',
      ownerId: 't1',
      definition: { ...baseDefinition, config: { multiple: true } } as any,
      values: [edge('ta-1'), edge('ta-2')],
      multiple: true,
      save: async () => true,
    }) as unknown as ShimElement;

    const chips = findAllChips(editor);
    assert.equal(chips.length, 2, 'one chip per stored id');
    for (const chip of chips) {
      const idAttr = chip.getAttribute('aria-label');
      assert.ok(idAttr !== null, 'chip has aria-label for screen readers');
      assert.equal(chip.tabIndex, 0, 'chip is keyboard-focusable (tabIndex=0)');
      assert.equal(
        chip.getAttribute('role'),
        'button',
        'chip is exposed as role=button',
      );
    }

    const addInput = editor.children[0]?.children.find(
      (c) => c.tagName === 'input',
    ) as ShimElement | undefined;
    assert.ok(addInput !== undefined, '«add» input is present');
    assert.equal(
      (addInput as ShimElement).placeholder,
      '+ ещё одну мысль',
      'multi link uses chip-add placeholder',
    );
  });

  it('empty multi-mode renders the «Введите мысль или id…» placeholder', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/properties.js');
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      ownerType: 'thought',
      ownerId: 't1',
      definition: { ...baseDefinition, config: { multiple: true } } as any,
      values: [],
      multiple: true,
      save: async () => true,
    }) as unknown as ShimElement;
    const addInput = editor.children[0]?.children.find(
      (c) => c.tagName === 'input',
    ) as ShimElement | undefined;
    assert.ok(addInput !== undefined, 'add input rendered');
    assert.equal(
      (addInput as ShimElement).placeholder,
      'Введите мысль или id…',
      'empty multi mode uses the seed placeholder',
    );
  });

  it('chip registers click / dblclick / contextmenu / keydown listeners', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/properties.js');
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      ownerType: 'thought',
      ownerId: 't1',
      definition: { ...baseDefinition, config: { multiple: true } } as any,
      values: [edge('ta-1')],
      multiple: true,
      save: async () => true,
    }) as unknown as ShimElement;

    const chip = findAllChips(editor)[0]!;
    for (const type of ['click', 'dblclick', 'contextmenu', 'keydown']) {
      assert.ok(
        chip.listeners[type] !== undefined && chip.listeners[type]!.length > 0,
        `chip must register a «${type}» listener`,
      );
    }
  });

  it('chip click handler is wired (smoke: dispatch does not throw)', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/properties.js');
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      ownerType: 'thought',
      ownerId: 't1',
      definition: { ...baseDefinition, config: { multiple: true } } as any,
      values: [edge('ta-1')],
      multiple: true,
      save: async () => true,
    }) as unknown as ShimElement;

    const chip = findAllChips(editor)[0]!;
    // click handler зовёт openLinkRefInEditor, который внутри делает
    // динамический import('./editor.js'). Это не должно падать с нашим
    // шимом — проверяем контракт регистрации listener'а.
    assert.doesNotThrow(() => {
      chip.dispatch('click', { preventDefault: () => undefined });
    });
  });

  it('chip shows the resolved thought title as label after `etn.thoughts.get`', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/properties.js');
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      ownerType: 'thought',
      ownerId: 't1',
      definition: { ...baseDefinition, config: { multiple: true } } as any,
      values: [edge('ta-42')],
      multiple: true,
      save: async () => true,
    }) as unknown as ShimElement;

    const chip = findAllChips(editor)[0]!;
    const label = chip.children[0];
    assert.ok(label !== undefined, 'chip has a label child');
    assert.equal(label.textContent, 'ta-42…', 'pre-fetch placeholder is the truncated id');

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(label.textContent, 'Title of ta-42', 'post-fetch label is the resolved title');
    assert.ok(
      seenGets.includes('ta-42'),
      'chip must request the thought title via `etn.thoughts.get`',
    );
  });

  it('uses the edge target_title as the chip label without an extra fetch', async () => {
    // 0.8.1 / dde92461-фикс: значения свойства-связи приходят рёбрами
    // LinkPropertyValues — готовый target_title подставляется в чип сразу,
    // без по-мысльного `etn.thoughts.get` на каждое значение.
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/properties.js');
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      ownerType: 'thought',
      ownerId: 't1',
      definition: { ...baseDefinition, config: { multiple: true } } as any,
      values: [
        { ...edge('ta-known'), target_title: 'Готовый заголовок' },
        edge('ta-unknown'),
      ],
      multiple: true,
      save: async () => true,
    }) as unknown as ShimElement;

    const chips = findAllChips(editor);
    assert.equal(chips.length, 2, 'one chip per edge');
    const knownChip = chips.find((c) => c.children[0]!.textContent === 'Готовый заголовок');
    assert.ok(knownChip !== undefined, 'known title renders synchronously');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      seenGets.includes('ta-known'),
      false,
      'no extra fetch for an edge that carries target_title',
    );
    assert.equal(
      seenGets.includes('ta-unknown'),
      true,
      'a null-title edge still resolves via etn.thoughts.get',
    );
  });
});

describe('buildLinkValueEditor — multiple-mode save dispatch (8ab775d9)', () => {
  it('persists the new value list when the user picks a chip-candidate', async () => {
    // Smoke на save-канал: мы не запускаем UI (input → wireTokenCombo →
    // dropdown click → onPick → save), а напрямую имитируем «уже
    // разрешённый выбор через addInput», подменяя save и проверяя
    // контракт вызова. Также здесь видно, что multiple-режим сериализует
    // пустой список как `null` (см. `persist` в buildLinkValueEditor).
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/properties.js');
    const saved: unknown[] = [];
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      ownerType: 'thought',
      ownerId: 't1',
      definition: { ...baseDefinition, config: { multiple: true } } as any,
      values: [],
      multiple: true,
      save: async (next: unknown) => {
        saved.push(next);
        return true;
      },
    }) as unknown as ShimElement;

    // Sanity: для empty multiple в DOM должна быть ровно пустая чип-обёртка
    // и инпут для добавления.
    const field = editor.children[0];
    assert.ok(field !== undefined, 'chip-field rendered');
    const chips = findAllChips(editor);
    assert.equal(chips.length, 0, 'no chips for empty values');
    const addInput = field!.children.find((c) => c.tagName === 'input') as ShimElement;
    assert.ok(addInput !== undefined, 'add input is present even when empty');

    // Имитируем ввод id руками через keydown Enter — это документированный
    // сценарий для вставки id из буфера обмена / хроники (см. wirePicker
    // в properties.ts: input.addEventListener('keydown', ...)).
    (addInput as ShimElement).value = 'paste-id';
    (addInput as ShimElement).dispatch('keydown', {
      key: 'Enter',
      preventDefault: () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(
      saved,
      [['paste-id']],
      'multi mode persists the id wrapped in an array',
    );
  });
});
