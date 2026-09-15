/**
 * Owner-less режим `buildLinkValueEditor` (ошибка bb67e546, 0.8.1): дефолт
 * свойства-связи редактируется в редакторе типа и в диалоге природы свойства —
 * там нет мысли-владельца, и контекстное меню чипа (операции над ребром
 * владельца) должно молча отсутствовать, а сам набор — жить целиком в `save`.
 *
 * Харнесс повторяет editor-link-value-chip.test.ts (DOM-shim без dispatch
 * асинхронных цепочек живого поиска).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Element-stub с keydown / contextmenu / dataset / setAttribute. */
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

/** Установка шима: document/window + `etn.thoughts.resolve/findDuplicates`. */
function installShim(): void {
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
    resolve: async (_n: string, ids: string[]) =>
      ids.map((id) => ({
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
      })),
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

/** Все мини-облачка `.prop-ref-cloud` в поддереве. */
function findAllClouds(root: ShimElement): ShimElement[] {
  const out: ShimElement[] = [];
  const walk = (node: ShimElement): void => {
    if (node.className.split(' ').includes('prop-ref-cloud')) out.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

const definition = {
  property_id: 'lk-prop',
  key: 'работает в',
  value_type: 'link',
  config: { link_type_id: 'lt-1', direction: 'out' },
  required: false,
  inherited: false,
  defined_on: 'thought_type',
  defined_on_name: 'Тест',
};

describe('buildLinkValueEditor — owner-less режим (дефолт свойства-связи, bb67e546)', () => {
  it('renders the target-set chips without an owner', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/properties.js');
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      definition: definition as any,
      values: [
        { link_id: '', target_id: 'firm-1', target_title: 'Фирма 1С', target_type_id: null, comment: null },
        { link_id: '', target_id: 'firm-2', target_title: 'Фирка 2', target_type_id: null, comment: null },
      ],
      save: async () => true,
    }) as unknown as ShimElement;

    const clouds = findAllClouds(editor);
    assert.equal(clouds.length, 2, 'чип-облачка целей дефолта');
    assert.ok(
      clouds.every((c) => c.title.length > 0 || c.textContent.length > 0),
      'подписи целей резолвятся',
    );
  });

  it('chip ✕ and clear-all persist the remaining set via save (null when empty)', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/properties.js');
    const saved: unknown[] = [];
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      definition: definition as any,
      values: [
        { link_id: '', target_id: 'firm-1', target_title: 'A', target_type_id: null, comment: null },
        { link_id: '', target_id: 'firm-2', target_title: 'B', target_type_id: null, comment: null },
      ],
      save: async (next) => {
        saved.push(next);
        return true;
      },
    }) as unknown as ShimElement;

    // «✕» на первом чипе — набор без него уходит в save.
    const clouds = findAllClouds(editor);
    const firstRemove = clouds[0]!.children.find((c) =>
      c.className.split(' ').includes('st-f-clear-inline'),
    )!;
    firstRemove.dispatch('click', { stopPropagation: () => undefined });
    assert.deepEqual(saved, [['firm-2']]);

    // Угловая «✕» — очистка всего набора: save(null), не пустой массив.
    const wrap = (editor.children[0] as ShimElement).children[0] as ShimElement;
    const corner = wrap.children.find((c) =>
      c.className.split(' ').includes('link-value-corner'),
    )!;
    const clearAll = corner.children.find((c) => c.textContent === '✕')!;
    clearAll.click();
    assert.deepEqual(saved, [['firm-2'], null]);
  });

  it('chip context menu is suppressed without an owner (no edge operations)', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/properties.js');
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      definition: definition as any,
      values: [
        { link_id: '', target_id: 'firm-1', target_title: 'A', target_type_id: null, comment: null },
      ],
      save: async () => true,
    }) as unknown as ShimElement;

    const cloud = findAllClouds(editor)[0]!;
    // Путь к showLinkChipMenu в shim-среде завис бы на document.body.append —
    // ранний выход владельца должен держать и это, и семантику «меню нет».
    assert.doesNotThrow(() => cloud.dispatch('contextmenu', { preventDefault: () => undefined }));
    assert.doesNotThrow(() =>
      cloud.dispatch('keydown', { preventDefault: () => undefined, key: 'ContextMenu' }),
    );
  });
});
