/**
 * Regression test for the editor properties group body (renderer).
 *
 * Runs the REAL buildPropertiesBody under Node with a minimal DOM shim and a
 * fake window.etn. Guards the failure class where the group gets stuck at
 * «Загрузка…»: a throw anywhere on the reload path (e.g. the temporal-dead-zone
 * ReferenceError shipped in the everMounted guard) rejects the fire-and-forget
 * reload promise and leaves the placeholder forever.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Smallest element stub that survives the properties render path. */
class ShimElement {
  tagName: string;
  className = '';
  children: ShimElement[] = [];
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  textContent = '';
  value = '';
  type = '';
  checked = false;
  title = '';
  placeholder = '';
  readOnly = false;
  isConnected = false;
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
  parent: ShimElement | null = null;
  listeners: Record<string, Array<(event?: any) => void>> = {};
  addEventListener(type: string, handler: (event?: any) => void): void {
    (this.listeners[type] ??= []).push(handler);
  }
  removeEventListener(type: string, handler: (event?: any) => void): void {
    const list = this.listeners[type];
    if (list === undefined) return;
    this.listeners[type] = list.filter((h) => h !== handler);
  }
  dispatch(type: string, event?: any): void {
    for (const handler of this.listeners[type] ?? []) handler(event);
  }
  closest(): ShimElement | null {
    return null;
  }
  querySelector(): ShimElement | null {
    return null;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };
  }
}

/** Memoized properties module for the pure-helper tests. */
let loadedModule: any = null;

/**
 * Minimal `document` shim. `documentElement.style` covers CodeMirror 6's
 * import-time browser probing (the markdown editor is imported through the
 * editor chain).
 */
function shimDocument(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    body: new ShimElement('body'),
  };
}

/** Installs the DOM/window shims and imports the module against fixtures. */
async function buildWithFixtures(): Promise<ShimElement> {
  shimDocument();
  (globalThis as any).window = {
    etn: {
      types: {
        listTypeProperties: async () => [
          {
            id: 'p1',
            owner_type: 'thought_type',
            owner_id: 'ty1',
            key: 'Город',
            value_type: 'text',
            config: { options: ['Москва', 'СПб'], multiple: true },
            required: false,
            position: 0,
          },
          {
            id: 'p2',
            owner_type: 'thought_type',
            owner_id: 'ty1',
            key: 'Автор',
            value_type: 'thought_ref',
            config: { allowed_type_ids: ['ty2'] },
            required: false,
            position: 1,
          },
          {
            id: 'p3',
            owner_type: 'thought_type',
            owner_id: 'ty1',
            key: 'Сайт',
            value_type: 'url',
            config: null,
            required: false,
            position: 2,
          },
          {
            id: 'p4',
            owner_type: 'thought_type',
            owner_id: 'ty1',
            key: 'Соавторы',
            value_type: 'thought_ref',
            config: { multiple: true },
            required: false,
            position: 3,
          },
          {
            id: 'p5',
            owner_type: 'thought_type',
            owner_id: 'ty1',
            key: 'Источник',
            value_type: 'thought_ref',
            config: {},
            required: false,
            position: 4,
          },
        ],
      },
      properties: {
        get: async () => [
          {
            id: 'v3',
            owner_type: 'thought',
            owner_id: 't1',
            property_id: 'p3',
            value: 'https://example.com',
            updated_at: '2026',
          },
          {
            id: 'v4',
            owner_type: 'thought',
            owner_id: 't1',
            property_id: 'p4',
            value: ['ta1', 'ta2'],
            updated_at: '2026',
          },
          {
            id: 'v5',
            owner_type: 'thought',
            owner_id: 't1',
            property_id: 'p5',
            value: 'ta1',
            updated_at: '2026',
          },
        ],
      },
      thoughts: {
        resolve: async () => [
          {
            id: 'ta1',
            title: 'Автор 1',
            type_id: null,
            icon: '📚',
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
          },
          {
            id: 'ta2',
            title: 'Автор 2',
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
          },
        ],
      },
    },
  };

  const { propertiesInternals } = await import('../src/renderer/editor/properties.js');
  const { store } = await import('../src/renderer/state.js');
  store.update({ networkId: 'n1' } as any);

  const ctx = {
    ownerType: 'thought' as const,
    ownerId: 't1',
    thought: {
      id: 't1',
      title: 'T',
      type_id: 'ty1',
      icon: null,
      icon_kind: 'emoji',
      active: true,
      is_protected: false,
      is_root: false,
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
  return propertiesInternals.buildPropertiesBody(ctx as any) as unknown as ShimElement;
}

describe('editor properties group body (DOM-shimmed)', () => {
  it('renders the definitions table instead of getting stuck on «Загрузка…»', async () => {
    const box = await buildWithFixtures();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const tableWrap = box.children[0];
    assert.ok(tableWrap !== undefined, 'table wrapper rendered');
    const table = tableWrap.children[0];
    assert.ok(table !== undefined, 'table replaced the loading placeholder');
    assert.match(table.className, /table-list/);

    // Headerless table (L7, 08-ui-spec.md §6.3.1): the tbody is the first child.
    const tbody = table.children[0];
    assert.ok(tbody !== undefined, 'tbody present');
    assert.equal(tbody.children.length, 5, 'one row per property definition');
    // The text property with options carries the picker caret button.
    const textCell = tbody.children[0]?.children[1];
    const buttons = textCell?.children[0]?.children.filter((c) => c.tagName === 'button') ?? [];
    assert.equal(buttons.length, 1, 'options picker caret rendered');
    // An EMPTY single thought_ref property is an editable search field plus the
    // dialog picker button (no value stored — nothing to show as a cloud).
    const refCell = tbody.children[1]?.children[1];
    const refRow = refCell?.children[0];
    const refInput = refRow?.children.find((c) => c.tagName === 'input');
    const refButtons = refRow?.children.filter((c) => c.tagName === 'button') ?? [];
    assert.ok(refInput !== undefined, 'thought_ref input rendered');
    assert.notEqual(refInput?.readOnly, true, 'thought_ref input is editable');
    assert.equal(refButtons.length, 1, 'dialog picker button rendered');
    // The url property renders the input plus an «Открыть» button, enabled
    // while a value is stored (08-ui-spec.md §6.3.1).
    const urlCell = tbody.children[2]?.children[1];
    const urlRow = urlCell?.children[0];
    const urlInput = urlRow?.children.find((c) => c.tagName === 'input');
    const openBtn = urlRow?.children.find(
      (c) => c.tagName === 'button' && c.textContent === 'Открыть',
    );
    assert.ok(urlInput !== undefined, 'url input rendered');
    assert.ok(openBtn !== undefined, 'url «Открыть» button rendered');
    assert.notEqual((openBtn as ShimElement & { disabled?: boolean }).disabled, true);
    // A STORED single thought_ref value renders as the thought's mini cloud
    // (icon + title + the «×» clear button); the live-search input appears
    // only while the value is empty; «выбрать» stays available
    // (08-ui-spec.md §6.3.1).
    const srcCell = tbody.children[4]?.children[1];
    const srcRow = srcCell?.children[0];
    assert.ok(srcRow !== undefined, 'stored single thought_ref row rendered');
    const cloud = srcRow?.children.find((c) => c.className === 'prop-ref-cloud');
    assert.ok(cloud !== undefined, 'stored value rendered as a mini cloud');
    assert.equal(cloud?.dataset['id'], 'ta1', 'cloud carries the thought id');
    const cloudIcon = cloud?.children.find((c) => c.className === 'mini-icon');
    assert.equal(cloudIcon?.textContent, '📚', 'cloud carries the thought icon');
    const cloudTitle = cloud?.children.find((c) => c.className === 'prc-title');
    assert.equal(cloudTitle?.textContent, 'Автор 1', 'cloud carries the thought title');
    const cloudRemove = cloud?.children.find((c) => c.tagName === 'button');
    assert.ok(cloudRemove !== undefined, 'cloud carries the «×» clear button');
    assert.equal(
      (cloudRemove as ShimElement).title,
      'Очистить значение',
      'clear button titled',
    );
    assert.ok(
      srcRow?.children.find((c) => c.tagName === 'input') === undefined,
      'no live-search input while a value is stored',
    );
    const srcPick = srcRow?.children.find(
      (c) => c.tagName === 'button' && c.textContent === 'выбрать',
    );
    assert.ok(srcPick !== undefined, '«выбрать» stays available next to the cloud');
    // A multiple thought_ref property (config.multiple) renders the chip field
    // with one removable mini-cloud chip per stored id plus the «выбрать»
    // button that opens the search dialog in multi mode (08-ui-spec.md §6.3.1).
    const multiCell = tbody.children[3]?.children[1];
    const multiRow = multiCell?.children[0];
    assert.ok(multiRow !== undefined, 'multi thought_ref editor rendered');
    const chipField = multiRow?.children.find((c) => c.className === 'st-f-chipfield');
    assert.ok(chipField !== undefined, 'chip field rendered');
    // Let the background title resolve settle, then check the chips.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const chips = chipField?.children.filter((c) => c.className === 'st-f-chip') ?? [];
    assert.equal(chips.length, 2, 'one chip per stored id');
    // Each chip is a mini cloud of the thought: icon node + styled label
    // (08-ui-spec.md §6.3.1) + the «×» removing that single value.
    const chipIcon = chips[0]?.children.find((c) => c.className === 'st-f-chip-icon');
    assert.ok(chipIcon !== undefined, 'chip carries the thought icon node');
    assert.equal(chipIcon?.textContent, '📚', 'chip icon resolved from the ref');
    const chipLabel = chips[0]?.children.find((c) => c.className === 'st-f-chip-label');
    assert.equal(chipLabel?.textContent, 'Автор 1', 'chip label resolved from the ref');
    const chipRemove = chips[0]?.children.find((c) => c.tagName === 'button');
    assert.ok(chipRemove !== undefined, 'each chip carries a remove button');
    const pickBtn = multiRow?.children.find(
      (c) => c.tagName === 'button' && c.textContent === 'выбрать',
    );
    assert.ok(pickBtn !== undefined, 'multi picker button rendered');
  });
});

describe('property value autocomplete helpers (pure)', () => {
  /** Imports the module (once) with the DOM shims installed. */
  async function loadPropsModule(): Promise<any> {
    if (loadedModule === null) {
      shimDocument();
      (globalThis as any).window = { etn: {} };
      loadedModule = await import('../src/renderer/editor/properties.js');
    }
    return loadedModule;
  }

  it('autocompleteFragment: whole input in single mode, tail after the last comma otherwise', async () => {
    const { autocompleteFragment } = await loadPropsModule();
    assert.equal(autocompleteFragment('Москва', false), 'москва');
    assert.equal(autocompleteFragment('  СПб ', false), 'спб');
    assert.equal(autocompleteFragment('Москва,  СПб', true), 'спб');
    assert.equal(autocompleteFragment('Москва,', true), '');
    assert.equal(autocompleteFragment('Москва', true), 'москва');
  });

  it('filterOptionsByFragment: case-insensitive substring, empty fragment shows all', async () => {
    const { filterOptionsByFragment } = await loadPropsModule();
    const options = ['Москва', 'СПб', 'Нижний Новгород'];
    assert.deepEqual(filterOptionsByFragment(options, ''), options);
    assert.deepEqual(filterOptionsByFragment(options, 'спб'), ['СПб']);
    assert.deepEqual(filterOptionsByFragment(options, 'ниж'), ['Нижний Новгород']);
    assert.deepEqual(filterOptionsByFragment(options, 'нет такого'), []);
  });

  it('splitMultiValue keeps trimmed non-empty parts only', async () => {
    const { splitMultiValue } = await loadPropsModule();
    assert.deepEqual(splitMultiValue('a, b ,, в '), ['a', 'b', 'в']);
    assert.deepEqual(splitMultiValue(''), []);
  });

  /** Extracts the option labels currently rendered in the dropdown list. */
  function visibleRowLabels(list: ShimElement): string[] {
    return list.children
      .filter((row) => row.className === 'type-combo-item')
      .map((row) => row.children[row.children.length - 1]?.textContent ?? '');
  }

  it('buildValueOptionsCaret: caret click on a filled field shows the whole catalogue, typing narrows it (defect 19105687)', async () => {
    const { buildValueOptionsCaret } = await loadPropsModule();
    (globalThis as any).window = {
      etn: {},
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };

    const input = new ShimElement('input') as unknown as HTMLInputElement;
    (input as unknown as ShimElement).value = 'Москва';
    const options = ['Москва', 'СПб', 'Нижний Новгород'];
    const caret = buildValueOptionsCaret(
      input,
      options,
      false,
      () => undefined,
      () => undefined,
    ) as unknown as ShimElement;

    // Explicit open via the caret button (no typing) must show every option,
    // not just the one matching the field's current value.
    caret.dispatch('click');
    const body = (globalThis as any).document.body as ShimElement;
    const list = body.children[body.children.length - 1];
    assert.ok(list !== undefined, 'options list must be mounted');
    assert.deepEqual(visibleRowLabels(list), options);

    // Typing narrows the already-open list down to the typed fragment.
    (input as unknown as ShimElement).value = 'моск';
    (input as unknown as ShimElement).dispatch('input');
    assert.deepEqual(visibleRowLabels(list), ['Москва']);
  });
});
