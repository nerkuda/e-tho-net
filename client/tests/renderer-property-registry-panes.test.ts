/**
 * Regression test for ETN error 98aa0889 «Правка реестрового свойства не
 * перечитывает набор свойств открытого редактора».
 *
 * Симптом: realtime-события `property-registry.created/updated/deleted` (имя
 * свойства, вид значения, `config`, описание) приходят, клиент перечитывает
 * каталоги типов и обновляет фокус холста, но таблица «Свойства» открытого
 * редактора остаётся прежней — вкладка слушала только `property-definition.*`
 * (закрыто ошибкой 74b94c26) и `property-value.*`.
 *
 * Проверяются обе половины: гейт по цепочке типов показанной сущности вместе с
 * индексом показанных определений и списками покрытия свойства-связи (чистые
 * функции `lib/type-definitions.ts`) и реальный путь события до пересборки
 * вкладки «Свойства» через `mountEditor` + `initRealtime` под DOM-шимом (как в
 * `renderer-property-definition-panes.test.ts`), включая локальное уведомление
 * менеджера свойств (своё realtime-эхо до рендерера не доходит).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { FocusResponse, Thought, ThoughtType } from '@etn/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Чистый гейт: какие правки реестра касаются показанного типа
// ---------------------------------------------------------------------------

describe('гейт правок реестровых свойств (ошибка 98aa0889)', () => {
  it('событие `updated`/`deleted` адресует свойство или покрытие — и не чужое', async () => {
    const {
      definitionChangeAffectsShown,
      definitionChangeFacts,
      isDefinitionEventType,
      rememberShownDefinitions,
    } = await import('../src/renderer/lib/type-definitions.js');

    // Показана мысль типа `child`, чья цепочка — child → parent → root.
    const shown = {
      ownerType: 'thought_type' as const,
      ids: new Set(['child', 'parent', 'root']),
    };
    // Таблица «Свойства» показала две привязки: index знает и id привязки, и
    // реестровое свойство (по нему адресует событие).
    rememberShownDefinitions([
      { id: 'bind-child', property_id: 'prop-child', owner_type: 'thought_type', owner_id: 'child' },
      { id: 'bind-parent', property_id: 'prop-parent', owner_type: 'thought_type', owner_id: 'parent' },
    ]);

    const registryUpdated = (id: string, changes: Record<string, unknown> = {}) =>
      definitionChangeFacts('property-registry.updated', { id, changes });

    assert.equal(
      definitionChangeAffectsShown(registryUpdated('prop-child', { name: 'новое' }), shown),
      true,
      'правка свойства, показанного в таблице, — перечитывать',
    );
    assert.equal(
      definitionChangeAffectsShown(registryUpdated('prop-parent', { value_type: 'text' }), shown),
      true,
      'свойство из унаследованной привязки — тоже показано',
    );
    assert.equal(
      definitionChangeAffectsShown(registryUpdated('prop-unknown', { name: 'чужое' }), shown),
      false,
      'свойство не из показанного набора и без покрытия — не перечитывать',
    );
    // Зеркало (требование dde92461): правка списков допустимых типов
    // свойства-связи меняет зеркальную строку у накрытого типа, даже если
    // самого свойства в таблице нет.
    assert.equal(
      definitionChangeAffectsShown(
        registryUpdated('prop-mirror', { config: { allowed_target_type_ids: ['parent'] } }),
        shown,
      ),
      true,
      'новое покрытие зеркалом накрывает предка показанного типа — перечитывать',
    );
    assert.equal(
      definitionChangeAffectsShown(
        registryUpdated('prop-mirror', { config: { allowed_target_type_ids: ['unrelated'] } }),
        shown,
      ),
      false,
      'покрытие не касается цепочки — не перечитывать',
    );
    assert.equal(
      definitionChangeAffectsShown(
        registryUpdated('prop-mirror', { config: { allowed_target_type_ids: ['parent'] } }),
        { ownerType: 'link_type', ids: new Set(['parent']) },
      ),
      false,
      'зеркала порождают только свойства типов МЫСЛЕЙ — показанную связь не трогаем',
    );

    const registryDeleted = (id: string) =>
      definitionChangeFacts('property-registry.deleted', { id });
    assert.equal(
      definitionChangeAffectsShown(registryDeleted('prop-child'), shown),
      true,
      'удаление показанного свойства — перечитывать',
    );
    assert.equal(
      definitionChangeAffectsShown(registryDeleted('prop-unknown'), shown),
      false,
      'удаление неотрисованного свойства — не перечитывать',
    );

    // Новое свойство реестра: привязок у него ещё нет, набор не меняется
    // (привязки приезжают своими `property-definition.created`).
    assert.equal(
      definitionChangeAffectsShown(
        definitionChangeFacts('property-registry.created', { property: { id: 'prop-new' } }),
        shown,
      ),
      false,
      'создание свойства реестра показанный набор не меняет',
    );

    // Реестр входит в тот же контракт «определения свойств изменились».
    assert.equal(isDefinitionEventType('property-registry.updated'), true);
    assert.equal(isDefinitionEventType('property-registry.deleted'), true);
    assert.equal(isDefinitionEventType('property-definition.updated'), true);
    assert.equal(isDefinitionEventType('property-value.set'), false);
  });
});

// ---------------------------------------------------------------------------
// Реальный путь: realtime-событие и локальное уведомление до пересборки вкладки
// ---------------------------------------------------------------------------

/** Minimal element stub that survives the mount/render paths. */
class ShimElement {
  tagName: string;
  className = '';
  children: ShimElement[] = [];
  style: {
    setProperty: (name: string, value: string) => void;
    removeProperty: (name: string) => void;
  } = {
    setProperty: () => undefined,
    removeProperty: () => undefined,
  };
  dataset: Record<string, string> = {};
  textContent = '';
  value = '';
  type = '';
  checked = false;
  title = '';
  placeholder = '';
  hidden = false;
  isConnected = true;
  innerHTML = '';
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
  get firstChild(): ShimElement | null {
    return this.children[0] ?? null;
  }
  append(...nodes: Array<ShimElement | string>): void {
    for (const node of nodes) {
      const el = typeof node === 'string' ? new ShimElement('#text', undefined, node) : node;
      el.parent = this;
      this.children.push(el);
    }
  }
  replaceChildren(...nodes: ShimElement[]): void {
    this.children = [...nodes];
    for (const node of nodes) node.parent = this;
  }
  removeChild(node: ShimElement): void {
    this.children = this.children.filter((c) => c !== node);
  }
  replaceChild(node: ShimElement, old: ShimElement): void {
    const idx = this.children.indexOf(old);
    if (idx === -1) return;
    this.children[idx] = node;
    node.parent = this;
    old.parent = null;
  }
  remove(): void {
    if (this.parent !== null) {
      this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    }
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  closest(): ShimElement | null {
    return null;
  }
  querySelector(): ShimElement | null {
    return null;
  }
  querySelectorAll(): ShimElement[] {
    return [];
  }
  setAttribute(): void {}
  getAttribute(): string | null {
    return null;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };
  }
  cloneNode(_deep = true): ShimElement {
    const clone = new ShimElement(this.tagName, this.className, this.textContent);
    clone.hidden = this.hidden;
    clone.title = this.title;
    clone.dataset = { ...this.dataset };
    clone.type = this.type;
    return clone;
  }
  replaceWith(node: ShimElement): void {
    if (this.parent === null) return;
    const idx = this.parent.children.indexOf(this);
    if (idx === -1) return;
    this.parent.children[idx] = node;
    node.parent = this.parent;
    this.parent = null;
  }
}

function shimDom(): void {
  (globalThis as any).HTMLElement = class {};
  (globalThis as any).CustomEvent = class {
    detail: unknown;
    constructor(_type: string, init?: { detail?: unknown }) {
      this.detail = init?.detail;
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
  const docElementStyle = {
    setProperty: () => undefined,
    removeProperty: () => undefined,
  };
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: docElementStyle },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

function makeThought(overrides: Partial<Thought> = {}): Thought {
  return {
    id: 't1',
    title: 'T1',
    type_id: null,
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
    ...overrides,
  };
}

function makeType(id: string, overrides: Partial<ThoughtType> = {}): ThoughtType {
  return {
    id,
    name: id,
    parent_id: null,
    is_root: false,
    comment_template_md: null,
    icon: null,
    icon_kind: 'emoji',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    description: null,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'u1',
    ...overrides,
  };
}

function makeFocus(focused: Thought): FocusResponse {
  return {
    focused,
    parents: [],
    siblings: [],
    children: [],
    edges: [],
    sorts: {
      parents: { sort: 'created', order: 'asc' },
      children: { sort: 'created', order: 'asc' },
      siblings: { sort: 'created', order: 'asc' },
    },
  };
}

/** Waits for the editor's own async chains (render, tab pane builds). */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('правка реестрового свойства перечитывает «Свойства» (98aa0889)', () => {
  it('свойство из показанного набора и покрытие зеркалом пересобирают вкладку, чужое — нет', async () => {
    shimDom();
    /** Какие типы редактор запрашивал за определениями свойств. */
    const typePropertyQueries: string[] = [];
    let realtimeHandler: ((raw: unknown) => void) | null = null;
    const definitionOfChild = {
      id: 'bind-child',
      property_id: 'prop-child',
      owner_type: 'thought_type',
      owner_id: 'ta',
      key: 'своё',
      value_type: 'text',
      config: null,
      required: false,
      position: 0,
      side: null,
      description: null,
      inherited: false,
      defined_on: 'ta',
      defined_on_name: 'ta',
    };
    (globalThis as any).window.etn = {
      ui: {
        setState: async () => undefined,
        // Пользователь смотрит на «Свойства» — пересборка должна быть видна
        // сразу, без переключения вкладки.
        getState: async () => 'properties',
      },
      types: {
        listTypeProperties: async (_n: string, _owner: string, typeId: string) => {
          typePropertyQueries.push(typeId);
          return typeId === 'ta' ? [definitionOfChild] : [];
        },
      },
      properties: { get: async () => [] },
      comments: { list: async () => [], create: async () => undefined },
      thoughts: {
        get: async () => makeThought({ type_id: 'ta' }),
        focus: async () => null,
      },
      realtime: {
        onStatusChange: () => undefined,
        onStale: () => undefined,
        onNetworkLost: () => undefined,
        onLayerControl: () => undefined,
        onEvent: (handler: (raw: unknown) => void) => {
          realtimeHandler = handler;
        },
        notifyOnline: () => undefined,
      },
    };

    const { mountEditor, editorInternals } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    const { initRealtime } = await import('../src/renderer/realtime.js');
    const { notifyPropertyRegistryChanged } = await import(
      '../src/renderer/lib/type-definitions.js'
    );

    // Показана мысль типа «ta»; в каталоге есть корень и чужой тип «tb».
    store.update({
      networkId: 'n1',
      focus: makeFocus(makeThought({ type_id: 'ta' })),
      thoughtTypes: [
        makeType('root', { is_root: true }),
        makeType('ta', { parent_id: 'root' }),
        makeType('tb'),
      ],
      editorTarget: null,
      collapsedGroups: {},
    } as any);

    initRealtime();
    mountEditor(new ShimElement('div') as any);
    await flush();
    assert.notEqual(realtimeHandler, null, 'realtime-мост подписан');

    const feed = async (evt: Record<string, unknown>): Promise<void> => {
      realtimeHandler!(evt);
      await flush();
    };
    const realtimeEvent = (type: string, networkId: string, data: unknown) => ({
      type,
      seq: 1,
      ts: '2026-01-01T00:00:00.000Z',
      actor: { user_id: 'u2', client_id: 'c2' },
      network_id: networkId,
      audience: 'network',
      layer_id: '00000000-0000-4000-8000-000000000001',
      data,
    });
    const builds = (): number => editorInternals.paneBuildCount('properties');

    const buildsBefore = builds();
    assert.equal(buildsBefore, 1, 'вкладка «Свойства» построена при монтировании');
    assert.deepEqual(typePropertyQueries, ['ta'], 'набор свойств строился по типу показанной мысли');
    const otherTabsBefore = {
      main: editorInternals.paneBuildCount('main'),
      attachments: editorInternals.paneBuildCount('attachments'),
      chrono: editorInternals.paneBuildCount('chrono'),
    };

    // 1. Свойство, которого нет в показанном наборе: устаревать нечему.
    await feed(
      realtimeEvent('property-registry.updated', 'n1', {
        id: 'prop-unknown',
        changes: { name: 'чужое' },
      }),
    );
    assert.equal(builds(), buildsBefore, 'правка неотрисованного свойства вкладку не пересобирает');
    assert.deepEqual(typePropertyQueries, ['ta'], 'набор свойств повторно не запрашивался');

    // 2. Чужая сеть: у такого события своё содержимое только у другой вкладки.
    await feed(
      realtimeEvent('property-registry.updated', 'n2', {
        id: 'prop-child',
        changes: { name: 'чужой сети' },
      }),
    );
    assert.equal(builds(), buildsBefore, 'событие соседней сети игнорируется');

    // 3. Показанное свойство: событие несёт только id реестрового свойства,
    //    владельца находит индекс показанных определений.
    await feed(
      realtimeEvent('property-registry.updated', 'n1', {
        id: 'prop-child',
        changes: { name: 'переименовано' },
      }),
    );
    assert.equal(builds(), buildsBefore + 1, 'правка показанного свойства пересобирает вкладку');
    assert.deepEqual(typePropertyQueries, ['ta', 'ta'], 'набор перечитан с сервера');

    // 4. По id привязки — тот же индекс (событие может адресовать любую из
    //    сторон определения).
    await feed(realtimeEvent('property-registry.deleted', 'n1', { id: 'bind-child' }));
    assert.equal(builds(), buildsBefore + 2, 'удаление показанного свойства пересобирает вкладку');

    // 5. Покрытие зеркалом: свойства в таблице нет, но его списки допустимых
    //    типов накрывают предка показанного типа — зеркальная строка меняется.
    await feed(
      realtimeEvent('property-registry.updated', 'n1', {
        id: 'prop-mirror',
        changes: { config: { allowed_target_type_ids: ['root'] } },
      }),
    );
    assert.equal(builds(), buildsBefore + 3, 'новое покрытие зеркалом пересобирает вкладку');

    await feed(
      realtimeEvent('property-registry.updated', 'n1', {
        id: 'prop-mirror',
        changes: { config: { allowed_target_type_ids: ['tb'] } },
      }),
    );
    assert.equal(builds(), buildsBefore + 3, 'покрытие чужого типа вкладку не трогает');

    // 6. Новое свойство реестра: привязок у него ещё нет.
    await feed(
      realtimeEvent('property-registry.created', 'n1', { property: { id: 'prop-new' } }),
    );
    assert.equal(builds(), buildsBefore + 3, 'создание свойства реестра вкладку не пересобирает');

    // 7. Локальный путь: свой клиент realtime-эхо не получает, менеджер
    //    свойств уведомляет редактор сам — и по id свойства, и при удалении.
    notifyPropertyRegistryChanged('prop-child');
    await flush();
    assert.equal(builds(), buildsBefore + 4, 'локальная правка показанного свойства пересобирает вкладку');
    notifyPropertyRegistryChanged('prop-unknown');
    await flush();
    assert.equal(builds(), buildsBefore + 4, 'локальная правка чужого свойства вкладку не трогает');

    // Типонезависимые вкладки кэш сохраняют (в «Комментарии» живёт CodeMirror —
    // bug 206e33a1: пересборка ради определений его уничтожать не должна).
    assert.equal(
      editorInternals.paneBuildCount('main'),
      otherTabsBefore.main,
      'вкладка «Комментарий» не пересобиралась',
    );
    assert.equal(
      editorInternals.paneBuildCount('attachments'),
      otherTabsBefore.attachments,
      'вкладка «Вложения» кэш сохранила',
    );
    assert.equal(
      editorInternals.paneBuildCount('chrono'),
      otherTabsBefore.chrono,
      'вкладка «Хроника» кэш сохранила',
    );
  });
});

// ---------------------------------------------------------------------------
// Проводка обоих путей в исходниках (подписка редактора + локальный производитель)
// ---------------------------------------------------------------------------

describe('проводка уведомлений о правке реестра (ошибка 98aa0889)', () => {
  const read = (rel: string): string =>
    readFileSync(resolve(import.meta.dirname, '..', 'src', 'renderer', rel), 'utf8');

  it('реестровые события входят в контракт, редактор подписан, менеджер уведомляет', () => {
    // Контракт: `property-registry.*` — тот же класс «определения свойств
    // изменились», что и `property-definition.*`.
    const definitions = read('lib/type-definitions.ts');
    assert.ok(
      /'property-registry\.created',\s*'property-registry\.updated',\s*'property-registry\.deleted',/.test(
        definitions,
      ),
      'реестровые события перечислены рядом с определениями',
    );
    assert.ok(
      /export function registryChangeFacts\(/.test(definitions),
      'факты о правке реестра собираются отдельной функцией',
    );
    assert.ok(
      /export function notifyPropertyRegistryChanged\(/.test(definitions),
      'локальный канал менеджера свойств объявлен',
    );
    // Редактор: одна realtime-подписка на оба класса событий + локальный канал.
    const editor = read('editor/editor.ts');
    assert.ok(
      /onPropertyRegistryChanged\(\(facts\) => \{/.test(editor),
      'редактор слушает локальную правку реестра',
    );
    assert.ok(
      /isDefinitionEventType\(evt\.type\)/.test(editor),
      'realtime-подписка фильтрует события тем же контрактом',
    );
    // Менеджер свойств: правка свойства и его удаление уведомляют редактор.
    const propertyManager = read('screens/property-manager.ts');
    assert.ok(
      /notifyPropertyRegistryChanged\(current\.id, changes\)/.test(propertyManager),
      'PATCH /properties/{id} уведомляет редактор с телом правки',
    );
    assert.ok(
      /notifyPropertyRegistryChanged\(property\.id\)/.test(propertyManager),
      'DELETE /properties/{id} уведомляет редактор',
    );
  });
});
