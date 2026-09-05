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

/** Holds a reference to the first window installed by buildWithFixtures. */
let sharedWindow: Record<string, unknown> = {};

/** Installs the DOM/window shims and imports the module against fixtures. */
async function buildWithFixtures(): Promise<ShimElement> {
  shimDocument();
  // Mutate (not replace) `window` so the etn Proxy in `lib/etn.ts` keeps
  // reading the SAME object — `window` is cached on first import. Subsequent
  // tests can rebind `etn.system.openExternal` through `sharedWindow`.
  sharedWindow = (globalThis as any).window ?? {};
  (globalThis as any).window = sharedWindow;
  if (sharedWindow['etn'] === undefined) {
    sharedWindow['etn'] = {};
  }
  const etnApi = sharedWindow['etn'] as Record<string, unknown>;
  etnApi['types'] = {
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
        inherited: false,
        description: 'город, к которому относится запись',
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
      {
        id: 'p6',
        owner_type: 'thought_type',
        owner_id: 'ty1',
        key: 'Закладки',
        value_type: 'url',
        config: { multiple: true },
        required: false,
        position: 5,
      },
    ],
  };
  etnApi['properties'] = {
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
      {
        id: 'v6',
        owner_type: 'thought',
        owner_id: 't1',
        property_id: 'p6',
        value: ['https://a.test', 'https://b.test'],
        updated_at: '2026',
      },
    ],
  };
  etnApi['thoughts'] = {
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
  };
  if (etnApi['system'] === undefined) {
    etnApi['system'] = {};
  }
  (etnApi['system'] as Record<string, unknown>)['openExternal'] = async () => '';

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
    assert.equal(tbody.children.length, 6, 'one row per property definition');
    // A definition WITH a description renders the ⓘ marker next to the
    // property name and carries the hint as the cell's tooltip (task
    // «Добавить описание (description) к определениям свойств типов»).
    const hintedNameCell = tbody.children[0]?.children[0];
    const marker = hintedNameCell?.children.find((c) => c.textContent === ' ⓘ');
    assert.ok(marker !== undefined, 'ⓘ marker rendered next to the property name');
    assert.equal(hintedNameCell?.title, 'город, к которому относится запись');
    // A definition WITHOUT a description has neither the marker nor a tooltip.
    const plainNameCell = tbody.children[1]?.children[0];
    assert.equal(plainNameCell?.children.length, 0, 'no ⓘ marker without a description');
    assert.equal(plainNameCell?.title, '', 'no tooltip without a description');
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
    // A multiple url property (config.multiple) renders the multi-url editor:
    // one input row per stored URL, each with its own «Открыть» and «×», plus
    // an «+» button appending a new row (08-ui-spec.md §6.3.1, task 0.6.2).
    const multiUrlCell = tbody.children[5]?.children[1];
    const multiUrlEditor = multiUrlCell?.children[0];
    assert.ok(multiUrlEditor !== undefined, 'multi-url editor rendered for multiple url');
    assert.equal(
      multiUrlEditor?.className,
      'multi-url-editor',
      'cell renders the multi-url-editor wrapper, not the single-url input',
    );
    const urlRows =
      multiUrlEditor?.children.filter((c) =>
        (c as ShimElement).className.split(' ').includes('multi-url-row'),
      ) ?? [];
    assert.equal(urlRows.length, 2, 'one row per stored URL');
  });
});

/**
 * Regression test for the «Свойства вне типа» group (task 6a83abe4,
 * 0.6.5 «Значения вне типа сохраняются»). The group lives BELOW the main
 * properties table and renders the values whose property is no longer attached
 * to the owner's type — read-only, one «×» per row.
 */
describe('editor properties — «Свойства вне типа» group (0.6.5)', () => {
  /**
   * Spins up `buildPropertiesBody` against a thought that has at least one
   * value flagged `outside_type: true`. The `outsideValues` parameter
   * controls which `PropertyValue` rows the mock returns with that flag.
   *
   * Reuses the SAME `sharedWindow` (set up by `buildWithFixtures` in the
   * other describe block). The etn Proxy in `lib/etn.ts` caches the very
   * first `window` it sees — creating a fresh window here would route our
   * mocks to the wrong target and leave the live Proxy staring at an
   * empty object. Mutating in place keeps the Proxy pointed at our mock.
   */
  async function renderWithOutsideType(
    outsideValues: Array<{
      id: string;
      property_id: string;
      property_name: string;
      value_type: string;
      value: unknown;
      outside_type: true;
    }>,
  ): Promise<ShimElement> {
    shimDocument();
    sharedWindow = (globalThis as any).window ?? {};
    (globalThis as any).window = sharedWindow;
    if (sharedWindow['etn'] === undefined) sharedWindow['etn'] = {};
    const etnApi = sharedWindow['etn'] as Record<string, unknown>;
    // Make sure the system sub-API exists — the existing describe block
    // installed it; we add a stub only when nothing is there yet.
    if (etnApi['system'] === undefined) etnApi['system'] = {};
    (etnApi['system'] as Record<string, unknown>)['openExternal'] = async () => '';

    // Replace only the sub-APIs this test owns. `thoughts.resolve` stays
    // whatever the earlier describe block installed — the live Proxy
    // (cached on first import) routes reads through `window.etn.thoughts`,
    // and the existing mock returns a ThoughtRef-shaped stub for every
    // requested id, which is exactly what the outside-type cell needs.
    etnApi['types'] = {
      // A fresh type with one property that DOES match the in-type value:
      // the type change carried over a single definition, the rest fell
      // out into the outside-type group.
      listTypeProperties: async () => [
        {
          id: 'pNew',
          owner_type: 'thought_type',
          owner_id: 'ty2',
          key: 'Новое',
          value_type: 'text',
          config: null,
          required: false,
          position: 0,
        },
      ],
    };
    etnApi['properties'] = {
      get: async () => [
        // One in-type value, just so the main table renders something.
        {
          id: 'v1',
          owner_type: 'thought',
          owner_id: 't1',
          property_id: 'pNew',
          property_name: 'Новое',
          value_type: 'text',
          value: 'текущее',
          outside_type: false,
          updated_at: '2026',
        },
        ...outsideValues,
      ],
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
        type_id: 'ty2',
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

  /** Locates the outside-type group wrapper inside the rendered body. */
  function findOutsideWrap(box: ShimElement): ShimElement | undefined {
    return box.children.find((c) => (c as ShimElement).className === 'prop-outside-wrap');
  }

  it('hides the group entirely when no value carries outside_type: true', async () => {
    const box = await renderWithOutsideType([]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const outside = findOutsideWrap(box);
    assert.ok(outside !== undefined, 'wrapper slot exists so it can be shown later');
    assert.equal(
      outside?.children.length ?? 0,
      0,
      'wrapper carries no children when no outside-type values are present',
    );
  });

  it('renders one read-only row per outside-type value with the «×» clear button', async () => {
    const box = await renderWithOutsideType([
      {
        id: 'v9',
        property_id: 'pOld',
        property_name: 'Город',
        value_type: 'text',
        value: 'Москва',
        outside_type: true,
      },
      {
        id: 'v10',
        property_id: 'pOld2',
        property_name: 'Автор',
        value_type: 'thought_ref',
        value: 'ta1',
        outside_type: true,
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const outside = findOutsideWrap(box);
    assert.ok(outside !== undefined, 'outside-type wrapper rendered');
    const group = outside?.children.find((c) => (c as ShimElement).className === 'prop-outside');
    assert.ok(group !== undefined, 'outside-type group rendered');

    const header = group?.children.find(
      (c) => (c as ShimElement).className === 'prop-outside-header',
    );
    assert.ok(header !== undefined, 'group header rendered');
    const titleSpan = header?.children.find(
      (c) => (c as ShimElement).className === 'prop-outside-title',
    );
    assert.equal(
      titleSpan?.textContent,
      'Свойства вне типа',
      'group title is the agreed-on label',
    );

    const table = group?.children.find(
      (c) => (c as ShimElement).className === 'table-list prop-outside-table',
    );
    assert.ok(table !== undefined, 'outside-type table rendered');
    const tbody = table?.children[0];
    assert.ok(tbody !== undefined, 'tbody present');
    assert.equal(tbody?.children.length, 2, 'one row per outside-type value');

    // First row: a text value — its cell shows the raw string, not an editor.
    const firstName = tbody?.children[0]?.children[0];
    assert.match(
      firstName?.textContent ?? '',
      /Город/,
      'first row name carries the property name',
    );
    assert.match(
      firstName?.textContent ?? '',
      /строка/,
      'first row carries the human-readable value type',
    );
    const firstValueCell = tbody?.children[0]?.children[1];
    assert.ok(firstValueCell !== undefined, 'first row value cell rendered');
    const firstText = firstValueCell?.children.find(
      (c) => (c as ShimElement).className === 'prop-outside-text',
    );
    assert.equal(
      firstText?.textContent,
      'Москва',
      'text outside-type value renders verbatim',
    );
    const firstClearBtn = firstValueCell?.children.find(
      (c) =>
        c.tagName === 'button' &&
        (c as ShimElement).className.split(' ').includes('prop-outside-remove'),
    );
    assert.ok(firstClearBtn !== undefined, 'first row carries its «×» clear button');
    assert.equal(
      (firstClearBtn as ShimElement).title,
      'Удалить значение',
      'clear button titled',
    );

    // Second row: a thought_ref outside-type value renders as the thought's
    // mini cloud — same shape as the main table, but the cloud's «×» is the
    // row's clear button (no separate per-chip remover for orphan values).
    const secondCell = tbody?.children[1]?.children[1];
    assert.ok(secondCell !== undefined, 'thought_ref row value cell rendered');
    const cloud = secondCell?.children[0]?.children.find(
      (c) => (c as ShimElement).className === 'prop-ref-cloud',
    );
    assert.ok(cloud !== undefined, 'thought_ref outside-type value rendered as mini cloud');
    assert.equal(
      cloud?.dataset['id'],
      'ta1',
      'cloud carries the thought id',
    );
    const cloudTitle = cloud?.children.find((c) => (c as ShimElement).className === 'prc-title');
    assert.equal(
      cloudTitle?.textContent,
      'Автор 1',
      'cloud label resolved from the shared ref cache (the earlier describe block installed the mock)',
    );
    const secondClearBtn = secondCell?.children.find(
      (c) =>
        c.tagName === 'button' &&
        (c as ShimElement).className.split(' ').includes('prop-outside-remove'),
    );
    assert.ok(secondClearBtn !== undefined, 'thought_ref row also carries its «×» clear button');
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

  it('propertyHint: the trimmed description or null (no hint rendered without one)', async () => {
    const { propertyHint } = await loadPropsModule();
    assert.equal(propertyHint({ description: '  город записи  ' }), 'город записи');
    assert.equal(propertyHint({ description: 'город записи' }), 'город записи');
    assert.equal(propertyHint({ description: null }), null);
    assert.equal(propertyHint({ description: undefined }), null);
    assert.equal(propertyHint({ description: '   ' }), null);
    assert.equal(propertyHint({}), null);
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

/**
 * Tests for the multi-value `url` editor (task 0.6.2). The DOM shim is the
 * same `ShimElement` used elsewhere in this file; `etn.system.openExternal` is
 * stubbed so the «Открыть» button does not hit a real OS handler.
 */
describe('buildMultiUrlEditor (DOM-shimmed)', () => {
  /** Loads the module under test with a stubbed `etn.system.openExternal`. */
  async function loadModule(): Promise<any> {
    shimDocument();
    // Mutate (not replace) `window`/`etn`/`etn.system` so the etn Proxy
    // (which caches `window` on first import via `lib/etn.ts`) keeps reading
    // the SAME object across tests — otherwise a later `loadModule()` would
    // install a fresh object the cached Proxy never sees.
    if ((globalThis as any).window === undefined) {
      (globalThis as any).window = {};
    }
    if ((globalThis as any).window.etn === undefined) {
      (globalThis as any).window.etn = {};
    }
    if ((globalThis as any).window.etn.system === undefined) {
      (globalThis as any).window.etn.system = {};
    }
    if ((globalThis as any).window.etn.system.openExternal === undefined) {
      (globalThis as any).window.etn.system.openExternal = async () => '';
    }
    return import('../src/renderer/editor/properties.js');
  }

  /** Returns true if `node` carries the given CSS class. */
  function hasClass(node: ShimElement, cls: string): boolean {
    return node.className.split(' ').includes(cls);
  }

  it('renders one input row per stored URL, each with its own «Открыть» and «×»', async () => {
    const { buildMultiUrlEditor } = await loadModule();
    const editor = buildMultiUrlEditor({
      urls: ['https://a.test', 'https://b.test'],
      save: () => undefined,
    }) as unknown as ShimElement;

    const rows = editor.children.filter((c) => hasClass(c, 'multi-url-row'));
    assert.equal(rows.length, 2, 'one row per stored URL');
    const firstRow = rows[0]!;
    const input = firstRow.children.find((c) => hasClass(c, 'multi-url-input'));
    assert.ok(input !== undefined, 'first row has an input');
    assert.equal(input?.value, 'https://a.test', 'input is pre-filled with the stored URL');
    const openBtn = firstRow.children.find(
      (c) => c.tagName === 'button' && c.textContent === 'Открыть',
    );
    assert.ok(openBtn !== undefined, 'first row has an «Открыть» button');
    assert.notEqual((openBtn as ShimElement & { disabled?: boolean }).disabled, true);
    const removeBtn = firstRow.children.find((c) => hasClass(c, 'multi-url-remove'));
    assert.ok(removeBtn !== undefined, 'first row has a «×» remove button');
  });

  it('«+» button appends a new empty row and focuses it', async () => {
    const { buildMultiUrlEditor } = await loadModule();
    const editor = buildMultiUrlEditor({
      urls: ['https://a.test'],
      save: () => undefined,
    }) as unknown as ShimElement;

    const addBtn = editor.children.find(
      (c) => c.tagName === 'button' && hasClass(c, 'multi-url-add'),
    );
    assert.ok(addBtn !== undefined, '«+» button is present');
    addBtn!.dispatch('click');

    const rows = editor.children.filter((c) => hasClass(c, 'multi-url-row'));
    assert.equal(rows.length, 2, '«+» adds a new row');
    const inputs = rows.map((r) => r.children.find((c) => hasClass(c, 'multi-url-input')));
    assert.equal(inputs[1]?.value, '', 'new row starts empty');
  });

  it('«Открыть» invokes `etn.system.openExternal` with the trimmed URL', async () => {
    const { buildMultiUrlEditor } = await loadModule();
    // Replace the spy on the SAME window object the etn Proxy cached during
    // its first import — `sharedWindow` is that object (see buildWithFixtures).
    const seen: string[] = [];
    const etnApi = sharedWindow['etn'] as Record<string, unknown>;
    const system = (etnApi['system'] ?? {}) as Record<string, unknown>;
    system['openExternal'] = async (url: string) => {
      seen.push(url);
      return '';
    };
    etnApi['system'] = system;
    const editor = buildMultiUrlEditor({
      urls: ['  https://trim.test  '],
      save: () => undefined,
    }) as unknown as ShimElement;

    const row = editor.children.find((c) => hasClass(c, 'multi-url-row'))!;
    const openBtn = row.children.find(
      (c) => c.tagName === 'button' && c.textContent === 'Открыть',
    );
    openBtn!.dispatch('click');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(seen, ['https://trim.test'], 'openExternal called with the trimmed URL');
  });

  it('removing a row writes the array without that URL', async () => {
    const { buildMultiUrlEditor } = await loadModule();
    const saved: (string[] | null)[] = [];
    const editor = buildMultiUrlEditor({
      urls: ['https://a.test', 'https://b.test'],
      save: (urls: string[]) => {
        saved.push(urls);
      },
    }) as unknown as ShimElement;

    const rows = editor.children.filter((c) => hasClass(c, 'multi-url-row'));
    const removeBtn = rows[0]!.children.find((c) => hasClass(c, 'multi-url-remove'))!;
    removeBtn.dispatch('click');
    assert.deepEqual(saved, [['https://b.test']], 'save called with the remaining URL');
  });

  it('commit on blur collapses trailing empty rows', async () => {
    const { buildMultiUrlEditor } = await loadModule();
    const saved: (string[] | null)[] = [];
    const editor = buildMultiUrlEditor({
      urls: ['https://a.test'],
      save: (urls: string[]) => {
        saved.push(urls);
      },
    }) as unknown as ShimElement;

    // Append an empty row via «+» then blur it without typing.
    const addBtn = editor.children.find((c) => hasClass(c, 'multi-url-add'))!;
    addBtn.dispatch('click');
    let rows = editor.children.filter((c) => hasClass(c, 'multi-url-row'));
    assert.equal(rows.length, 2, 'two rows before blur');
    const newInput = rows[1]!.children.find((c) => hasClass(c, 'multi-url-input'))!;
    newInput.dispatch('blur');
    rows = editor.children.filter((c) => hasClass(c, 'multi-url-row'));
    assert.equal(rows.length, 1, 'empty trailing row collapsed');
    assert.deepEqual(saved, [['https://a.test']], 'save called without the empty row');
  });
});
