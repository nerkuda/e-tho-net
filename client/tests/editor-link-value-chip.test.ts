/**
 * Unit tests for `buildLinkValueEditor` (задача 8ab775d9, 0.8.1, единая
 * модель связей; правка — инструкция «Использовать унифицированные поля
 * выбора ссылок в диалогах», a47947c8) — редактор значения свойства-связи на
 * мысль: мини-облачко(-а) выбранных мыслей + «✕» + кнопка «выбрать»
 * (`pickThoughtsDialog`) + живой поиск (`wireThoughtRefSearch`) для пустого
 * поля / добавления.
 *
 * Здесь намеренно избегаем dispatch('input') (внутренняя `wireThoughtRefSearch`
 * запускает асинхронную цепочку `etn.thoughts.findDuplicates →
 * document.body.append → positionBodyDropdown`, в shim-среде зависающую на
 * неопределённое время) — тесты покрывают статическую структуру DOM и факт
 * регистрации click/dblclick/contextmenu/keydown обработчиков облачка.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Element-stub с поддержкой keydown / contextmenu / dataset / setAttribute. */
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
  autocomplete = '';
  isConnected = true;
  tabIndex = -1;
  dataset: Record<string, string> = {};
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
/** Ids requested via `etn.thoughts.resolve` (style/metadata resolve). */
let seenResolves: string[] = [];

/**
 * Установка шима: document/window + минимальные `etn.thoughts.resolve` /
 * `etn.thoughts.findDuplicates` (для `wireThoughtRefSearch`, не вызывается в
 * этих тестах, но должен существовать, чтобы модуль импортировался).
 * `lib/etn.ts` привязывается к `window.etn` при первом импорте — оставляем
 * ОДИН глобальный объект на весь test-файл.
 */
function installShim(): void {
  seenResolves = [];
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
  etnApi['thoughts'] = {
    findDuplicates: async () => [],
    resolve: async (_n: string, ids: string[]) => {
      seenResolves.push(...ids);
      return ids.map((id) => ({
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
      }));
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

/** Возвращает все мини-облачка (`.prop-ref-cloud`) в поддереве, в порядке документа. */
function findAllClouds(root: ShimElement): ShimElement[] {
  const out: ShimElement[] = [];
  const walk = (node: ShimElement): void => {
    if (node.className.split(' ').includes('prop-ref-cloud')) out.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
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
 * живые рёбра с `target_id`/`target_title`, не строки id).
 */
function edge(id: string, title: string | null = null) {
  return {
    link_id: `link-${id}`,
    target_id: id,
    target_title: title,
    target_type_id: null,
    comment: null,
  };
}

describe('buildLinkValueEditor — single mode, мини-облачко (a47947c8)', () => {
  it('empty value renders a live-search input + «выбрать» button', async () => {
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

    const row = editor.children[0]!;
    const input = row.children.find(
      (c) => c.tagName === 'input' && c.type === 'text',
    ) as ShimElement | undefined;
    assert.ok(input !== undefined, 'search input rendered');
    assert.equal(
      input!.placeholder,
      'введите название для поиска…',
      'empty single input uses the live-search placeholder',
    );
    const pickBtn = row.children.find(
      (c) => c.tagName === 'button' && c.textContent === 'выбрать',
    );
    assert.ok(pickBtn !== undefined, '«выбрать» button rendered for the empty single field');
  });

  it('set value renders a mini-cloud (prop-ref-cloud) with «✕» + «выбрать» button', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/properties.js');
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      ownerType: 'thought',
      ownerId: 't1',
      definition: baseDefinition as any,
      values: [edge('ta-single', 'Единственная мысль')],
      multiple: false,
      save: async () => true,
    }) as unknown as ShimElement;

    const row = editor.children[0]!;
    const cloud = row.children.find((c) =>
      c.className.split(' ').includes('prop-ref-cloud'),
    ) as ShimElement | undefined;
    assert.ok(cloud !== undefined, 'mini-cloud rendered for the stored value');
    assert.equal(cloud!.tabIndex, 0, 'cloud is keyboard-focusable');
    assert.equal(cloud!.getAttribute('role'), 'button', 'cloud is exposed as role=button');
    assert.equal(
      cloud!.dataset['id'],
      'ta-single',
      'cloud carries the target id in dataset',
    );
    // Заголовок берётся из ребра (target_title) сразу, без ожидания резолва.
    const titleSpan = cloud!.children.find((c) => c.className === 'prc-title');
    assert.equal(titleSpan?.textContent, 'Единственная мысль');

    const removeBtn = cloud!.children.find((c) =>
      c.className.split(' ').includes('st-f-clear-inline'),
    );
    assert.ok(removeBtn !== undefined, 'cloud has a «✕» clear button');

    const pickBtn = row.children.find(
      (c) => c.tagName === 'button' && c.textContent === 'выбрать',
    );
    assert.ok(pickBtn !== undefined, '«выбрать» button rendered alongside the cloud');
  });

  it('«✕» on the cloud clears the value and persists null', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/properties.js');
    const saved: unknown[] = [];
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      ownerType: 'thought',
      ownerId: 't1',
      definition: baseDefinition as any,
      values: [edge('ta-single', 'Единственная мысль')],
      multiple: false,
      save: async (next) => {
        saved.push(next);
        return true;
      },
    }) as unknown as ShimElement;

    const cloud = findAllClouds(editor)[0]!;
    const removeBtn = cloud.children.find((c) =>
      c.className.split(' ').includes('st-f-clear-inline'),
    )!;
    removeBtn.dispatch('click', { stopPropagation: () => undefined });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(saved, [null], 'clearing the single value persists null');
  });
});

describe('buildLinkValueEditor — multiple mode, чипы мини-облачков (a47947c8)', () => {
  it('renders one mini-cloud per stored id with a «+ ещё одну мысль» add input', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/properties.js');
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      ownerType: 'thought',
      ownerId: 't1',
      definition: { ...baseDefinition, config: { multiple: true } } as any,
      values: [edge('ta-1', 'Мысль 1'), edge('ta-2', 'Мысль 2')],
      multiple: true,
      save: async () => true,
    }) as unknown as ShimElement;

    const clouds = findAllClouds(editor);
    assert.equal(clouds.length, 2, 'one mini-cloud per stored id');
    for (const cloud of clouds) {
      assert.ok(cloud.getAttribute('aria-label') !== null, 'cloud has aria-label');
      assert.equal(cloud.tabIndex, 0, 'cloud is keyboard-focusable (tabIndex=0)');
      assert.equal(cloud.getAttribute('role'), 'button', 'cloud is exposed as role=button');
    }

    const row = editor.children[0]!;
    const field = row.children[0]!;
    const addInput = field.children.find((c) => c.tagName === 'input') as
      | ShimElement
      | undefined;
    assert.ok(addInput !== undefined, '«add» input is present');
    assert.equal(
      addInput!.placeholder,
      '+ ещё одну мысль',
      'non-empty multi field uses the add placeholder',
    );
    const pickBtn = row.children.find(
      (c) => c.tagName === 'button' && c.textContent === 'выбрать',
    );
    assert.ok(pickBtn !== undefined, '«выбрать» button rendered next to the chip field');
  });

  it('empty multi-mode renders the «Название мысли…» seed placeholder', async () => {
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
    const field = editor.children[0]!.children[0]!;
    const addInput = field.children.find((c) => c.tagName === 'input') as
      | ShimElement
      | undefined;
    assert.ok(addInput !== undefined, 'add input rendered');
    assert.equal(
      addInput!.placeholder,
      'Название мысли…',
      'empty multi mode uses the seed placeholder',
    );
  });

  it('cloud registers click / dblclick / contextmenu / keydown listeners', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/properties.js');
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      ownerType: 'thought',
      ownerId: 't1',
      definition: { ...baseDefinition, config: { multiple: true } } as any,
      values: [edge('ta-1', 'Мысль 1')],
      multiple: true,
      save: async () => true,
    }) as unknown as ShimElement;

    const cloud = findAllClouds(editor)[0]!;
    for (const type of ['click', 'dblclick', 'contextmenu', 'keydown']) {
      assert.ok(
        cloud.listeners[type] !== undefined && cloud.listeners[type]!.length > 0,
        `cloud must register a «${type}» listener`,
      );
    }
  });

  it('cloud click handler is wired (smoke: dispatch does not throw)', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/properties.js');
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      ownerType: 'thought',
      ownerId: 't1',
      definition: { ...baseDefinition, config: { multiple: true } } as any,
      values: [edge('ta-1', 'Мысль 1')],
      multiple: true,
      save: async () => true,
    }) as unknown as ShimElement;

    const cloud = findAllClouds(editor)[0]!;
    // click handler зовёт openLinkRefInEditor, который внутри делает
    // динамический import('./editor.js'). Это не должно падать с нашим
    // шимом — проверяем контракт регистрации listener'а.
    assert.doesNotThrow(() => {
      cloud.dispatch('click', { preventDefault: () => undefined });
    });
  });

  it('«✕» on a chip cloud removes only that id and persists the rest', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/properties.js');
    const saved: unknown[] = [];
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      ownerType: 'thought',
      ownerId: 't1',
      definition: { ...baseDefinition, config: { multiple: true } } as any,
      values: [edge('ta-1', 'Мысль 1'), edge('ta-2', 'Мысль 2')],
      multiple: true,
      save: async (next) => {
        saved.push(next);
        return true;
      },
    }) as unknown as ShimElement;

    const clouds = findAllClouds(editor);
    const firstRemove = clouds[0]!.children.find((c) =>
      c.className.split(' ').includes('st-f-clear-inline'),
    )!;
    firstRemove.dispatch('click', { stopPropagation: () => undefined });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(
      saved,
      [['ta-2']],
      'removing the first chip persists the remaining id array',
    );
  });

  it('uses the edge target_title as the cloud label without waiting for resolve', async () => {
    // 0.8.1 / dde92461-фикс: значения свойства-связи приходят рёбрами
    // LinkPropertyValues — готовый target_title подставляется в облачко
    // сразу, синхронно с первым рендером.
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/properties.js');
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      ownerType: 'thought',
      ownerId: 't1',
      definition: { ...baseDefinition, config: { multiple: true } } as any,
      values: [edge('ta-known', 'Готовый заголовок'), edge('ta-unknown')],
      multiple: true,
      save: async () => true,
    }) as unknown as ShimElement;

    const clouds = findAllClouds(editor);
    assert.equal(clouds.length, 2, 'one cloud per edge');
    const knownTitle = clouds
      .find((c) => c.dataset['id'] === 'ta-known')!
      .children.find((c) => c.className === 'prc-title');
    assert.equal(
      knownTitle?.textContent,
      'Готовый заголовок',
      'known title renders synchronously from the edge',
    );
    const unknownTitle = clouds
      .find((c) => c.dataset['id'] === 'ta-unknown')!
      .children.find((c) => c.className === 'prc-title');
    assert.equal(
      unknownTitle?.textContent,
      'ta-unkno…',
      'unknown title falls back to the truncated id before resolve',
    );
  });

  it('resolves full metadata (icon/colours/active) for every current id via etn.thoughts.resolve', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/properties.js');
    buildLinkValueEditor({
      networkId: 'n1',
      ownerType: 'thought',
      ownerId: 't1',
      definition: { ...baseDefinition, config: { multiple: true } } as any,
      values: [edge('ta-known', 'Готовый заголовок'), edge('ta-unknown')],
      multiple: true,
      save: async () => true,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Стиль облачка (значок/цвета/актуальность) резолвится даже для рёбер с
    // уже известным заголовком — заголовок и стиль приходят из разных мест.
    assert.deepEqual(
      [...seenResolves].sort(),
      ['ta-known', 'ta-unknown'],
      'resolve is requested for every current id, known-title or not',
    );
  });
});

