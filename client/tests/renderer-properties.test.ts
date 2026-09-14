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
  attributes: Record<string, string> = {};
  textContent = '';
  value = '';
  type = '';
  checked = false;
  title = '';
  placeholder = '';
  readOnly = false;
  disabled = false;
  isConnected = true;
  tabIndex = -1;
  role = '';
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
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
    if (name === 'aria-label' || name === 'role') {
      if (name === 'aria-label') this.ariaLabel = value;
      if (name === 'role') this.role = value;
    }
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
  hasAttribute(name: string): boolean {
    return name in this.attributes;
  }
  focus(): void {
    /* no-op in tests */
  }
  blur(): void {
    this.dispatch('blur');
  }
  click(): void {
    this.dispatch('click');
  }
  closest(): ShimElement | null {
    return null;
  }
  querySelector(): ShimElement | null {
    return null;
  }
  querySelectorAll(): ShimElement[] {
    return [];
  }
  contains(node: ShimElement | null): boolean {
    if (node === null) return false;
    return node === this;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };
  }
  ariaLabel = '';
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
        property_id: 'rp1',
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
        property_id: 'rp2',
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
        property_id: 'rp3',
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
        property_id: 'rp4',
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
        property_id: 'rp5',
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
        property_id: 'rp6',
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
        property_id: 'rp3',
        value: 'https://example.com',
        updated_at: '2026',
      },
      {
        id: 'v4',
        owner_type: 'thought',
        owner_id: 't1',
        property_id: 'rp4',
        value: ['ta1', 'ta2'],
        updated_at: '2026',
      },
      {
        id: 'v5',
        owner_type: 'thought',
        owner_id: 't1',
        property_id: 'rp5',
        value: 'ta1',
        updated_at: '2026',
      },
      {
        id: 'v6',
        owner_type: 'thought',
        owner_id: 't1',
        property_id: 'rp6',
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

// Regression test for the editor «Свойства типа» group body (renderer).
//
// В задаче 8ab775d9 свойства типа редактируются через `buildTypePropertiesBody`
// (внутри `propertiesInternals.buildPropertiesBody` → wrapper). thought_ref-
// определения упразднены миграцией 040 — их место заняло `link`-свойство с
// автокомплитом и чипами; здесь мы тестируем URL-имущество, сохранённое
// под registry `property_id` (карточка 7d094c26).
describe('editor properties group body (DOM-shimmed)', () => {
  /**
   * Установка шима против набора определений + значений; возвращает обёртку
   * «Свойства типа» (тип рендера — `buildTypePropertiesBody`).
   */
  async function buildWithUrlFixture(
    definitions: Array<Record<string, unknown>>,
    values: Array<Record<string, unknown>>,
  ): Promise<ShimElement> {
    shimDocument();
    sharedWindow = (globalThis as any).window ?? {};
    (globalThis as any).window = sharedWindow;
    if (sharedWindow['etn'] === undefined) sharedWindow['etn'] = {};
    const etnApi = sharedWindow['etn'] as Record<string, unknown>;
    etnApi['types'] = { listTypeProperties: async () => definitions };
    etnApi['properties'] = { get: async () => values };
    if (etnApi['system'] === undefined) etnApi['system'] = {};
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

  it('matches stored values by registry property_id, not binding id (7d094c26)', async () => {
    // The fixture declares bindings whose binding `id` differs from the registry
    // `property_id` (legacy bindings created before the 0.6.5 registry split):
    // «Сайт» has id `p3` / property_id `rp3`, and the stored value is keyed by
    // `rp3`. A lookup by `definition.id` would miss it and render an empty field
    // even though the server stores the value (7d094c26).
    const definitions = [
      {
        id: 'p3',
        property_id: 'rp3',
        owner_type: 'thought_type',
        owner_id: 'ty1',
        key: 'Сайт',
        value_type: 'url',
        config: null,
        required: false,
        position: 0,
      },
    ];
    const values = [
      {
        id: 'v3',
        owner_type: 'thought',
        owner_id: 't1',
        property_id: 'rp3',
        value: 'https://example.com',
        updated_at: '2026',
      },
    ];
    const box = await buildWithUrlFixture(definitions, values);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Структура новой отрисовки: box → properties-type-body →
    // admin-table-wrap.prop-wrap → table → tbody → rows.
    const typeBody = box.children[0];
    assert.ok(typeBody !== undefined, 'type body rendered');
    const tableWrap = typeBody.children[0];
    assert.ok(tableWrap !== undefined, 'table wrapper rendered');
    const table = tableWrap.children[0];
    assert.ok(table !== undefined, 'table rendered');
    const tbody = table.children[0];
    assert.ok(tbody !== undefined, 'tbody rendered');

    // Single url property («Сайт», row index 0): the input must carry the value.
    const urlCell = tbody.children[0]?.children[1];
    const urlInput = urlCell?.children[0]?.children.find(
      (c) => c.tagName === 'input' && c.type === 'text',
    ) as ShimElement | undefined;
    assert.equal(
      urlInput?.value,
      'https://example.com',
      'single url value populated via registry property_id',
    );
  });

  it('renders link properties through the mini-cloud/chip picker path (a47947c8)', async () => {
    // link-свойство рендерится через `buildLinkValueEditor` — всегда
    // чип-режим (число целей link-свойства не ограничено, спека «properties»
    // 0.8.1): чипы-мини-облачка + поле живого поиска + «выбрать», инструкция
    // «Использовать унифицированные поля выбора ссылок в диалогах». Пустое
    // свойство без значений тоже даёт чип-поле с живым поиском — ввод не
    // пропадает после выбора значения.
    sharedWindow = (globalThis as any).window ?? {};
    (globalThis as any).window = sharedWindow;
    if (sharedWindow['etn'] === undefined) sharedWindow['etn'] = {};
    const etnApi = sharedWindow['etn'] as Record<string, unknown>;
    etnApi['types'] = {
      listTypeProperties: async () => [
        {
          id: 'lk1',
          property_id: 'lk1',
          owner_type: 'thought_type',
          owner_id: 'ty1',
          key: 'Упоминание',
          value_type: 'link',
          config: { allowed_link_type_id: 'lt1' },
          required: false,
          position: 0,
        },
        {
          id: 'lk2',
          property_id: 'lk2',
          owner_type: 'thought_type',
          owner_id: 'ty1',
          key: 'Соавторы',
          value_type: 'link',
          config: {},
          required: false,
          position: 1,
        },
      ],
    };
    etnApi['properties'] = {
      get: async () => [
        // Свойство-связь приходит формой LinkPropertyValues (0.8.1): рёбра
        // в values[], поля .value нет.
        {
          id: 'vlk2',
          owner_type: 'thought',
          owner_id: 't1',
          property_id: 'lk2',
          outside_type: false,
          property_name: 'Соавторы',
          value_type: 'link',
          direction: 'out',
          link_type_id: null,
          structural: false,
          count: 2,
          values: [
            {
              link_id: 'e1',
              target_id: 'ta1',
              target_title: 'Мысль ta1',
              target_type_id: null,
              comment: null,
            },
            {
              link_id: 'e2',
              target_id: 'ta2',
              target_title: 'Мысль ta2',
              target_type_id: null,
              comment: null,
            },
          ],
        },
      ],
    };
    etnApi['thoughts'] = {
      findDuplicates: async () => [],
      resolve: async (_n: string, ids: string[]) =>
        ids.map((id) => ({
          id,
          title: `Мысль ${id}`,
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
    const box = propertiesInternals.buildPropertiesBody(ctx as any) as unknown as ShimElement;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const typeBody = box.children[0]!;
    const tableWrap = typeBody.children[0]!;
    const table = tableWrap.children[0]!;
    const tbody = table.children[0]!;

    // Row 0 — single link property «Упоминание»: рендерится через
    // buildLinkValueEditor — всегда чип-режим (число целей link-свойства не
    // ограничено, спека «properties» 0.8.1), поле живого поиска остаётся в
    // поле вместе с чипами.
    const singleCell = tbody.children[0]?.children[1];
    assert.ok(singleCell !== undefined, 'single link cell rendered');
    // Структура: link-value-editor > form-row > [st-f-chipfield, button].
    const singleRoot = singleCell.children[0];
    const singleRow = singleRoot?.children[0];
    const singleField = singleRow?.children[0];
    const singleInput = singleField?.children.find(
      (c) => c.tagName === 'input' && c.type === 'text',
    ) as ShimElement | undefined;
    assert.ok(singleInput !== undefined, 'link chip field has a live-search input');
    assert.equal(
      singleInput!.placeholder,
      'Название мысли…',
      'empty link chip field uses the seed placeholder',
    );
    const singlePickBtn = singleRow?.children.find(
      (c) => c.tagName === 'button' && c.textContent === 'выбрать',
    );
    assert.ok(singlePickBtn !== undefined, 'link chip field has a «выбрать» button');

    // Row 1 — multiple link property «Соавторы»: два мини-облачка + поле
    // добавления + «выбрать».
    const multiCell = tbody.children[1]?.children[1];
    assert.ok(multiCell !== undefined, 'multi link cell rendered');
    // Структура: link-value-editor > form-row > [st-f-chipfield, button].
    const multiRoot = multiCell.children[0];
    const multiRow = multiRoot?.children[0];
    const multiField = multiRow?.children[0];
    const clouds = multiField?.children.filter((c) =>
      (c as ShimElement).className.split(' ').includes('prop-ref-cloud'),
    );
    assert.equal(clouds?.length, 2, 'one mini-cloud per stored id (multi link)');
    const addInput = multiField?.children.find(
      (c) => c.tagName === 'input',
    ) as ShimElement | undefined;
    assert.ok(addInput !== undefined, 'multi link has an add input');
    assert.equal(
      (addInput as ShimElement).placeholder,
      '+ ещё одну мысль',
      'multi link uses the chip add placeholder',
    );
    const multiPickBtn = multiRow?.children.find(
      (c) => c.tagName === 'button' && c.textContent === 'выбрать',
    );
    assert.ok(multiPickBtn !== undefined, 'multi link has a «выбрать» button');
  });
});

/**
 * Regression test for the «Свойства вне типа» group (task 6a83abe4,
 * 0.6.5 «Значения вне типа сохраняются»). The group lives BELOW the main
 * properties table and renders the values whose property is no longer attached
 * to the owner's type — read-only, one «×» per row.
 */
// В задаче 8ab775d9 «Свойства вне типа» переехали в собственную группу
// вкладки «Свойства» (buildOutsidePropertiesBody), а не вложены в основную
// таблицу. Этот describe проверяет, что `buildPropertiesBody` отныне НЕ
// рендерит outside-type значения — они живут в отдельной группе.
// Сама отдельная группа тестируется через editor-internals (editor.ts) и
// через mount-интеграцию (см. renderer-editor-mount.test.ts); здесь же —
// ключевая инвариантность разделения.
describe('editor properties — «Свойства вне типа» group (0.6.5)', () => {
  /**
   * Spins up `buildPropertiesBody` against a thought that has at least one
   * value flagged `outside_type: true`. The `outsideValues` parameter
   * controls which `PropertyValue` rows the mock returns with that flag.
   *
   * Reuses the SAME `sharedWindow` (set up by the first describe block).
   */
  async function renderWithOutsideType(
    outsideValues: Array<{
      id: string;
      property_id: string;
      property_name: string;
      value_type: string;
      value: unknown;
      outside_type: true;
      updated_at?: string;
    }>,
  ): Promise<ShimElement> {
    shimDocument();
    sharedWindow = (globalThis as any).window ?? {};
    (globalThis as any).window = sharedWindow;
    if (sharedWindow['etn'] === undefined) sharedWindow['etn'] = {};
    const etnApi = sharedWindow['etn'] as Record<string, unknown>;
    if (etnApi['system'] === undefined) etnApi['system'] = {};
    (etnApi['system'] as Record<string, unknown>)['openExternal'] = async () => '';

    etnApi['types'] = {
      // Одно свойство «Новое», которое есть в типе — основная таблица
      // рендерит его; outside-type значения остаются в отдельной группе.
      listTypeProperties: async () => [
        {
          id: 'pNew',
          property_id: 'pNew',
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

  /** Рекурсивно ищет элемент с классом `className` в поддереве. */
  function findByClass(root: ShimElement, className: string): ShimElement | undefined {
    if (root.className === className) return root;
    for (const child of root.children) {
      const hit = findByClass(child, className);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  it('outside-type values are not rendered in the main «Свойства типа» table (8ab775d9)', async () => {
    // outside-type значение с property_name, отличным от определений типа —
    // оно НЕ должно появиться в основной таблице «Свойства типа».
    const box = await renderWithOutsideType([
      {
        id: 'vOut1',
        property_id: 'pDropped',
        property_name: 'Отвалившееся',
        value_type: 'text',
        value: 'историческое значение',
        outside_type: true,
        updated_at: '2026',
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // prop-outside-* — маркеры отдельной группы; их быть не должно в
    // buildPropertiesBody (это «Свойства типа», не «Свойства вне типа»).
    assert.equal(
      findByClass(box, 'prop-outside'),
      undefined,
      'main table must not contain the outside-type root',
    );
    assert.equal(
      findByClass(box, 'prop-outside-table'),
      undefined,
      'main table must not contain the outside-type table',
    );
    assert.equal(
      findByClass(box, 'prop-outside-wrap'),
      undefined,
      'main table must not contain the legacy outside-type wrapper',
    );
    // И само название свойства «Отвалившееся» нигде в дереве нет —
    // иначе оно бы отрисовалось в основной таблице.
    const haystack = JSON.stringify(box);
    assert.equal(
      haystack.includes('Отвалившееся'),
      false,
      'outside-type property name must not leak into the main table',
    );
  });

  it('hides the group entirely when no value carries outside_type: true (smoke)', async () => {
    // Архитектурный smoke: без outside-type значений buildPropertiesBody
    // возвращает «Свойства типа» без каких-либо outside-type артефактов.
    const box = await renderWithOutsideType([]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      findByClass(box, 'prop-outside'),
      undefined,
      'no outside-type root when there are no outside-type values',
    );
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
 * Regression test for the date/number editor cells (error cefb4db0): focusing
 * a property field and leaving it (Tab / click away) WITHOUT entering a value
 * must not fire `properties.remove` when nothing was stored — an empty value
 * is a legitimate state, and the server's former 404 flashed as
 * «Ошибка: no value stored…» in the cell. Mirrors the text field's baseline
 * approach: blur commits the value only when it actually changed.
 */
// Skipped: задача 8ab775d9 — структура свойств переехала в отдельную
// Тесты date/number (задача 8ab775d9, 0.8.1): buildPropertiesBody теперь
// обёртка над buildTypePropertiesBody (новый уровень `properties-type-body`).
// Всё остальное — те же blur-коммиты на инпуты даты/числа, что и раньше.
describe('editor properties — date/number blur commits (error cefb4db0)', () => {
  /** What the etn.properties stub recorded: remove/set calls with keys. */
  interface PropertyCalls {
    removed: string[];
    set: Array<{ key: string; value: unknown }>;
  }

  /**
   * Renders buildPropertiesBody against one date and one number definition
   * (`withValues` toggles whether each has a stored value) and returns the
   * body plus the recorded etn.properties write calls.
   */
  async function renderDateNumber(withValues: boolean): Promise<{
    box: ShimElement;
    calls: PropertyCalls;
  }> {
    shimDocument();
    // The autocomplete describe block above REPLACES globalThis.window with a
    // bare object, but the etn Proxy in lib/etn.ts captured the ORIGINAL
    // window (first import) and still reads it. The module-level sharedWindow
    // variable keeps that original object — realign the global and install
    // the mocks on the object the Proxy actually sees. If `sharedWindow.etn`
    // somehow got lost (e.g. a later helper reassigned it to a fresh `{}`),
    // recreate the minimal `etn` stub here — the test only cares about
    // `types` / `properties` / `thoughts` calls in this describe.
    if (sharedWindow['etn'] === undefined) sharedWindow['etn'] = {};
    (globalThis as any).window = sharedWindow;
    const etnApi = sharedWindow['etn'] as Record<string, unknown>;
    const calls: PropertyCalls = { removed: [], set: [] };
    etnApi['types'] = {
      listTypeProperties: async () => [
        {
          id: 'pDate',
          property_id: 'pDate',
          owner_type: 'thought_type',
          owner_id: 'ty1',
          key: 'Плановый срок',
          value_type: 'date',
          config: null,
          required: false,
          position: 0,
        },
        {
          id: 'pNumber',
          property_id: 'pNumber',
          owner_type: 'thought_type',
          owner_id: 'ty1',
          key: 'Оценка',
          value_type: 'number',
          config: null,
          required: false,
          position: 1,
        },
      ],
    };
    etnApi['properties'] = {
      get: async () =>
        withValues
          ? [
              {
                id: 'vDate',
                owner_type: 'thought',
                owner_id: 't1',
                property_id: 'pDate',
                value: '2026-09-01',
                updated_at: '2026',
              },
              {
                id: 'vNumber',
                owner_type: 'thought',
                owner_id: 't1',
                property_id: 'pNumber',
                value: 5,
                updated_at: '2026',
              },
            ]
          : [],
      remove: async (_networkId: string, _ownerType: string, _ownerId: string, key: string) => {
        calls.removed.push(key);
      },
      set: async (
        _networkId: string,
        _ownerType: string,
        _ownerId: string,
        key: string,
        value: unknown,
      ) => {
        calls.set.push({ key, value });
      },
    };
    etnApi['thoughts'] = { resolve: async () => [] };

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
    const box = propertiesInternals.buildPropertiesBody(ctx as any) as unknown as ShimElement;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { box, calls };
  }

  /** Returns the value CELL of row `index` (0 = date, 1 = number). */
  function rowCell(box: ShimElement, index: number): ShimElement | undefined {
    // Новая вложенность (8ab775d9): box → properties-type-body →
    // admin-table-wrap.prop-wrap → table → tbody → tr.
    const typeBody = box.children[0];
    const tableWrap = typeBody?.children[0];
    const table = tableWrap?.children[0];
    const tbody = table?.children[0];
    return tbody?.children[index]?.children[1];
  }

  /** Returns the input element of row `index` (0 = date, 1 = number). */
  function rowInput(box: ShimElement, index: number): ShimElement | undefined {
    return rowCell(box, index)?.children[0];
  }

  it('blur on an already-empty date/number field fires no remove and shows no error', async () => {
    const { box, calls } = await renderDateNumber(false);
    const dateInput = rowInput(box, 0);
    const numberInput = rowInput(box, 1);
    assert.ok(dateInput !== undefined, 'date input rendered');
    assert.ok(numberInput !== undefined, 'number input rendered');

    dateInput!.dispatch('blur');
    numberInput!.dispatch('blur');
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(calls.removed, [], 'no remove for a never-stored value');
    assert.deepEqual(calls.set, [], 'no set either');
    // No error text appeared next to the fields (the former 404 flash).
    assert.equal(
      rowCell(box, 0)?.children.length,
      1,
      'date cell still holds only the input',
    );
    assert.equal(
      rowCell(box, 1)?.children.length,
      1,
      'number cell still holds only the input',
    );
  });

  it('blur on an unchanged stored date/number value writes nothing', async () => {
    const { box, calls } = await renderDateNumber(true);
    const dateInput = rowInput(box, 0);
    const numberInput = rowInput(box, 1);
    assert.equal(dateInput?.value, '2026-09-01', 'date input pre-filled');
    assert.equal(numberInput?.value, '5', 'number input pre-filled');

    dateInput!.dispatch('blur');
    numberInput!.dispatch('blur');
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(calls.removed, [], 'unchanged value — no remove');
    assert.deepEqual(calls.set, [], 'unchanged value — no set');
  });

  it('clearing a stored value blurs into remove; entering a new one blurs into set', async () => {
    const { box, calls } = await renderDateNumber(true);
    const dateInput = rowInput(box, 0);
    const numberInput = rowInput(box, 1);

    // Clear the date → blur commits remove once; a SECOND blur of the now
    // empty field must not repeat the remove.
    dateInput!.value = '';
    dateInput!.dispatch('blur');
    dateInput!.dispatch('blur');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(calls.removed, ['Плановый срок'], 'remove fired exactly once');

    // Change the number → blur commits the new value.
    numberInput!.value = '7';
    numberInput!.dispatch('blur');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(calls.set, [{ key: 'Оценка', value: 7 }], 'set fired with the new number');

    // Clearing the number now also removes it.
    numberInput!.value = '';
    numberInput!.dispatch('blur');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(
      calls.removed,
      ['Плановый срок', 'Оценка'],
      'clearing a stored number removes the value',
    );
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
    // Replace the spy on `window.etn.system.openExternal` — the live target
    // the etn Proxy reads from on every property access (lib/etn.ts). Other
    // describe blocks in this file occasionally REPLACE `globalThis.window`
    // (the autocomplete-helpers describe), so we go through the live global
    // instead of the captured `sharedWindow` reference.
    const seen: string[] = [];
    const win = (globalThis as any).window as Record<string, unknown>;
    const etnApi = win['etn'] as Record<string, unknown>;
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
    await new Promise((resolve) => setTimeout(resolve, 30));
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

/**
 * Regression test for карточка 7d094c26 «Не сохраняются значения свойств типа
 * "строка"». The baseline-guard for `text`/`url` cells used to be updated
 * *before* the save promise settled (`baseline = next; void save(next)`):
 * if save failed — typically a 5xx / network error retried up to 3 times for
 * ~30s, plenty of time to outlive the rebuild — the baseline already carried
 * the unsaved value, the error was appended to an orphaned `<td>`, and the
 * next blur saw `next === baseline` and skipped the write. Reopening the
 * thought showed the old value, with no visible cue that the edit had been
 * dropped.
 *
 * The fix makes `commitValue` await `save` and roll `baseline` back on a
 * `false` return; `save` itself now surfaces failures through the document
 * toast (`notice`) instead of mutating an orphan cell. The tests below
 * pin the three observable consequences of that contract:
 *  1. a failed save leaves baseline at the stored value, so a second blur
 *     with the same edit re-saves (the original symptom: silent drop);
 *  2. a failed save leaves baseline at the stored value, so a second blur
 *     with a *different* edit saves the new one and succeeds;
 *  3. a successful save updates baseline normally, so the baseline guard
 *     still suppresses redundant writes of the unchanged value.
 */
// Тест text/url rollback (задача 8ab775d9, 0.8.1): buildPropertiesBody теперь
// обёртка над buildTypePropertiesBody (новый уровень `properties-type-body`).
// Логика blur-коммитов и rollback baseline не менялась — обновлён только
// обход DOM к инпуту.
describe('editor properties — text/url save failure rolls back baseline (7d094c26)', () => {
  /** What the etn.properties stub recorded. */
  interface PropertyCalls {
    set: Array<{ key: string; value: unknown }>;
    removed: string[];
  }

  /**
   * Renders buildPropertiesBody for a thought whose type has ONE text
   * property with predefined options (the dropdown picker path is also
   * exercised by the render). The mock `etn.properties.set` follows the
   * `mode` toggle so each test can script success/failure per call.
   */
  async function renderTextProperty(
    mode: { fail: boolean },
  ): Promise<{ box: ShimElement; calls: PropertyCalls }> {
    shimDocument();
    // Realign with the module-shared window — the Proxy in lib/etn.ts cached
    // the very first window it saw during `buildWithFixtures`. If the etn
    // stub got lost (an earlier describe replaced `globalThis.window`),
    // recreate the minimal shape so this describe can install its own mocks.
    if (sharedWindow['etn'] === undefined) sharedWindow['etn'] = {};
    (globalThis as any).window = sharedWindow;
    // `save` failures go through `notice(...)` which arms `window.setTimeout`
    // to auto-dismiss the toast. The other describe blocks in this file
    // never trigger that path; install a synchronous setTimeout so the
    // rejection from the failed save doesn't escape the test as an
    // unhandled `window.setTimeout is not a function`.
    Object.assign(sharedWindow, {
      setTimeout: (fn: () => void) => {
        fn();
        return 1;
      },
      clearTimeout: () => undefined,
    });
    const etnApi = sharedWindow['etn'] as Record<string, unknown>;
    const calls: PropertyCalls = { set: [], removed: [] };
    etnApi['types'] = {
      listTypeProperties: async () => [
        {
          id: 'pStatus',
          property_id: 'pStatus',
          owner_type: 'thought_type',
          owner_id: 'ty1',
          key: 'Статус',
          value_type: 'text',
          config: { options: ['Открыт', 'Закрыт'], multiple: false },
          required: false,
          position: 0,
        },
      ],
    };
    etnApi['properties'] = {
      get: async () => [
        {
          id: 'vStatus',
          owner_type: 'thought',
          owner_id: 't1',
          property_id: 'pStatus',
          value: 'Открыт',
          updated_at: '2026',
        },
      ],
      remove: async (_n: string, _o: string, _i: string, key: string) => {
        calls.removed.push(key);
      },
      set: async (
        _n: string,
        _o: string,
        _i: string,
        key: string,
        value: unknown,
      ) => {
        calls.set.push({ key, value });
        if (mode.fail) throw new Error('network down');
      },
    };
    etnApi['thoughts'] = { resolve: async () => [] };

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
    const box = propertiesInternals.buildPropertiesBody(ctx as any) as unknown as ShimElement;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { box, calls };
  }

  /** The text cell's input — wrapped in row > cell (with-options layout). */
  function rowInput(box: ShimElement): ShimElement | undefined {
    // Новая вложенность (8ab775d9): box → properties-type-body →
    // admin-table-wrap.prop-wrap → table → tbody → tr → td(cell).
    const typeBody = box.children[0];
    const tableWrap = typeBody?.children[0];
    const table = tableWrap?.children[0];
    const tbody = table?.children[0];
    const cell = tbody?.children[0]?.children[1];
    return cell?.children[0]?.children[0];
  }

  /** The value cell of the only row (with-options layout: row > cell). */
  function rowCell(box: ShimElement): ShimElement | undefined {
    const typeBody = box.children[0];
    const tableWrap = typeBody?.children[0];
    const table = tableWrap?.children[0];
    const tbody = table?.children[0];
    return tbody?.children[0]?.children[1];
  }

  it('failed save leaves baseline at the stored value — same-value blur retries', async () => {
    const mode = { fail: true };
    const { box, calls } = await renderTextProperty(mode);
    const input = rowInput(box);
    assert.ok(input !== undefined, 'text input rendered');
    assert.equal(input?.value, 'Открыт', 'input pre-filled with the stored value');

    input!.value = 'Закрыт';
    input!.dispatch('blur');
    // commitValue is async (awaits save); yield enough cycles for the
    // rejection to land and the baseline to roll back.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(
      calls.set,
      [{ key: 'Статус', value: 'Закрыт' }],
      'save was attempted once with the new value',
    );

    // The same input is blurred again WITHOUT a change — the buggy code
    // would treat baseline='Закрыт' as the new ground truth and skip the
    // write. With the rollback, baseline='Открыт' is restored and the
    // input's value ('Закрыт') differs from it again, so the retry fires.
    input!.dispatch('blur');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      calls.set.length,
      2,
      'second blur re-saves because the first failure rolled baseline back',
    );
    assert.deepEqual(
      calls.set[1],
      { key: 'Статус', value: 'Закрыт' },
      'retry carries the same new value the first attempt lost',
    );
  });

  it('failed save leaves baseline at the stored value — different-value blur saves the new one', async () => {
    const mode = { fail: true };
    const { box, calls } = await renderTextProperty(mode);
    const input = rowInput(box);

    input!.value = 'Закрыт';
    input!.dispatch('blur');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls.set.length, 1, 'first save attempted');

    // Switch to a different value while still in failure mode — the
    // rollback ensures baseline='Открыт' so 'Новый' is treated as a fresh
    // edit and saves (fails again, rolls back again).
    input!.value = 'Новый';
    input!.dispatch('blur');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls.set.length, 2, 'second save attempted');
    assert.deepEqual(
      calls.set[1],
      { key: 'Статус', value: 'Новый' },
      'second blur saved the new value (not skipped as a no-op)',
    );
  });

  it('after a failed save followed by a successful one, the baseline guard skips re-saves of the same value', async () => {
    const mode = { fail: true };
    const { box, calls } = await renderTextProperty(mode);
    const input = rowInput(box);

    input!.value = 'Закрыт';
    input!.dispatch('blur');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls.set.length, 1, 'failed first attempt');

    // Flip to success and blur again — this time save resolves, baseline
    // advances to 'Закрыт', and any further blur with 'Закрыт' is a no-op.
    mode.fail = false;
    input!.dispatch('blur');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls.set.length, 2, 'retry succeeded');

    input!.dispatch('blur');
    await new Promise((resolve) => setTimeout(resolve, 30));
    input!.dispatch('blur');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      calls.set.length,
      2,
      'unchanged value after a successful save does not re-save (baseline guard intact)',
    );
  });

  it('a failure does not leave an inline error-text span in the cell', async () => {
    const mode = { fail: true };
    const { box } = await renderTextProperty(mode);
    const input = rowInput(box);
    const cell = rowCell(box);
    assert.ok(cell !== undefined, 'cell located');

    input!.value = 'Закрыт';
    input!.dispatch('blur');
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The bug used to write ` Ошибка: …` into the cell — a fragment that
    // was orphaned on the very next rebuild and so invisible. The fix
    // surfaces errors through `notice` (document.body) instead. The cell
    // must keep its original children — only the form-row with the input
    // and the picker caret.
    const errorText = cell?.children.find((c) =>
      (c as ShimElement).className.split(' ').includes('error-text'),
    );
    assert.equal(errorText, undefined, 'no inline error-text span left in the cell');
  });
});
