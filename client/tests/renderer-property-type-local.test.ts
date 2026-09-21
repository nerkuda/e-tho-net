/**
 * Regression test for ETN error 7dfad7d4 «Локальная правка типа в менеджере
 * свойств и удаление типа не уведомляют открытый редактор» (+ ошибка 270b8454 —
 * та же локальная правка не пересчитывает холст и панели).
 *
 * Симптом: пользователь правит свойство-связь в менеджере «Свойства» того же
 * клиента — единый диалог свойства правит и связанный ТИП СВЯЗИ (пара имён,
 * оформление линии через `PATCH /properties/{id}`, родитель через
 * `PATCH /link-types/{id}`), а открытый редактор показанной СВЯЗИ этого типа
 * шапку не перерисовывает. Удаление свойства-связи (`DELETE /properties/{id}`)
 * уносит и связанный тип связи — открытый редактор не помечает тип удалённым и
 * не перечитывает отвязанную связь. Симметрично удаление типа мысли в редакторе
 * типов (`screens/type-manager.ts`, `removeRow`): тип уходит из цепочки, а
 * открытый редактор мысли об этом не узнаёт.
 *
 * Прецеденты: realtime закрыт ошибками 94b28014/34a9ef10, локальная правка САМОГО
 * типа мысли — 8dd5dfed (коммит 5d41589, канал `notifyTypeChanged`). Своё
 * realtime-эхо до рендерера не доходит (главный процесс его отбрасывает, G8
 * applier), поэтому недостающие локальные производители обязаны уведомлять сами.
 *
 * Проверяются: чистые факты (`linkTypeFieldsFromPropertyChanges`,
 * `typeDeletedFacts`), путь локального уведомления до редактора показанной связи
 * через `mountEditor` под DOM-шимом (правка пары имён перерисовывает шапку,
 * чужой тип — нет, удаление помечает тип и перечитывает связь) и проводка
 * производителей (`screens/property-manager.ts`, `screens/type-manager.ts`).
 * Там же (270b8454) — тот же локальный производитель доводит правку/удаление
 * типа связи до холста, «Структур» и «Хроники» общим набором пересчёта
 * `scheduleTypeRepaint` (эталон — realtime-ветка `*-type.*`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { Link, LinkType, Thought } from '@etn/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Чистые факты: тело правки свойства-связи и факты удаления типа
// ---------------------------------------------------------------------------

describe('факты локального изменения типа из менеджера свойств (ошибка 7dfad7d4)', () => {
  it('поля типа связи из PATCH /properties приводятся к каноническим ключам', async () => {
    const { linkTypeFieldsFromPropertyChanges, typeUpdateFacts } = await import(
      '../src/renderer/lib/type-definitions.js'
    );

    const owner = { ownerType: 'link_type' as const, ownerId: 'la' };
    const fields = linkTypeFieldsFromPropertyChanges({
      name: 'состоит в',
      name_forward: 'состоит в',
      name_reverse: 'включает',
      link_color: '#fff',
      link_style: 'dashed',
      link_width: 3,
      description: 'текст',
      config: { link_type_id: 'la' },
    });
    // Ключи запроса свойства (`link_color`/`link_style`/`link_width`) переведены
    // в канонические ключи типа связи (`color`/`style`/`width`); поля, которых
    // у типа связи нет (имя свойства/описание/конфиг), в факты не попадают.
    assert.deepEqual(fields, {
      name_forward: 'состоит в',
      name_reverse: 'включает',
      color: '#fff',
      style: 'dashed',
      width: 3,
    });
    assert.deepEqual(typeUpdateFacts(owner, fields), {
      owner,
      deleted: false,
      setChanged: false,
      visualChanged: true,
    });
    // Правка только родителя (идёт отдельным PATCH /link-types) — сдвиг набора,
    // но не оформления: шапку перерисовывать нечего.
    assert.deepEqual(typeUpdateFacts(owner, { parent_id: 'lb' }), {
      owner,
      deleted: false,
      setChanged: true,
      visualChanged: false,
    });
    // Пустое тело правки (ничего из полей типа не ушло) — фактов нет.
    assert.deepEqual(linkTypeFieldsFromPropertyChanges({ name: 'x' }), {});
  });

  it('факты удаления типа совпадают с realtime-`*-type.deleted`', async () => {
    const { typeDeletedFacts, isTypeDeleted, markTypeDeleted } = await import(
      '../src/renderer/lib/type-definitions.js'
    );
    const owner = { ownerType: 'link_type' as const, ownerId: 'la' };
    assert.deepEqual(typeDeletedFacts(owner), {
      owner,
      deleted: true,
      setChanged: true,
      visualChanged: true,
    });
    const thoughtOwner = { ownerType: 'thought_type' as const, ownerId: 'ta' };
    assert.equal(typeDeletedFacts(thoughtOwner).owner, thoughtOwner);
    // Пометка удалённого типа (её делает подписчик редактора) живёт до конца
    // сессии — id типов не переиспользуются.
    assert.equal(isTypeDeleted(owner), false);
    markTypeDeleted(owner);
    assert.equal(isTypeDeleted(owner), true);
  });
});

// ---------------------------------------------------------------------------
// Локальный путь: уведомление производителя доходит до редактора связи
// ---------------------------------------------------------------------------

/** How many DOM nodes the editor created (the shim counts them). */
let createdElements = 0;

/** Minimal element stub that survives the mount/render/patchHeader paths. */
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
  /** `patchHeader` replaces the header node in place on a version-only change. */
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
  (globalThis as any).document = {
    createElement: (tag: string) => {
      createdElements++;
      return new ShimElement(tag);
    },
    createElementNS: (_ns: string, tag: string) => {
      createdElements++;
      return new ShimElement(tag);
    },
    documentElement: { style: { setProperty: () => undefined, removeProperty: () => undefined } },
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

function makeLink(overrides: Partial<Link> = {}): Link {
  return {
    id: 'l1',
    source_id: 't1',
    target_id: 't2',
    type_id: null,
    color: null,
    style: null,
    width: null,
    active: true,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeLinkType(id: string, overrides: Partial<LinkType> = {}): LinkType {
  return {
    id,
    name_forward: id,
    name_reverse: `${id} (обратно)`,
    parent_id: null,
    is_root: false,
    color: null,
    style: null,
    width: null,
    description: null,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'u1',
    ...overrides,
  };
}

/** Waits for the editor's own async chains (render, refetch, pane builds). */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** Text of every element in the subtree (для проверки содержимого шапки). */
function collectText(node: ShimElement, out: string[] = []): string[] {
  if (node.textContent !== '') out.push(node.textContent);
  for (const child of node.children) collectText(child, out);
  return out;
}

describe('локальное уведомление менеджера свойств доходит до редактора связи (7dfad7d4)', () => {
  it('правка типа связи перерисовывает шапку, удаление помечает тип и перечитывает связь', async () => {
    shimDom();
    /** Какие связи редактор перечитывал (удаление типа отвязывает их на сервере). */
    const linkGets: string[] = [];
    /** Серверный каталог типов связи — меняется правками (как на сервере). */
    let serverLinkTypes: LinkType[] = [
      makeLinkType('root', { is_root: true }),
      makeLinkType('la', { parent_id: 'root' }),
      makeLinkType('lb'),
    ];
    /** Сколько раз редактор запрашивал каталог типов (локальный путь — производитель уже перечитал). */
    let catalogueFetches = 0;
    (globalThis as any).window.etn = {
      ui: { setState: async () => undefined, getState: async () => 'metadata' },
      admin: { listUsers: async () => [] },
      types: {
        listThoughtTypes: async () => [],
        listLinkTypes: async () => {
          catalogueFetches++;
          return serverLinkTypes;
        },
      },
      properties: { get: async () => [] },
      comments: { list: async () => [], create: async () => undefined },
      thoughts: { get: async () => null, focus: async () => null, resolve: async () => [] },
      links: {
        // Сервер отвязал связь удалённого типа: `type_id = NULL`, версия +1.
        get: async (_n: string, id: string) => {
          linkGets.push(id);
          return makeLink({ id, type_id: null, version: 2 });
        },
      },
      realtime: {
        onStatusChange: () => undefined,
        onStale: () => undefined,
        onNetworkLost: () => undefined,
        onLayerControl: () => undefined,
        onEvent: () => undefined,
        notifyOnline: () => undefined,
      },
    };

    const { mountEditor } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    const { notifyTypeChanged, typeDeletedFacts, typeUpdateFacts, isTypeDeleted } =
      await import('../src/renderer/lib/type-definitions.js');
    const { linkTypeFieldsFromPropertyChanges } = await import(
      '../src/renderer/lib/type-definitions.js'
    );

    // Показана связь типа «la» (цепочка la → root); в каталоге есть чужой «lb».
    store.update({
      networkId: 'n1',
      linkTypes: serverLinkTypes,
      editorTarget: { kind: 'link', id: 'l1', link: makeLink({ type_id: 'la' }) },
      selectedLinkId: 'l1',
      collapsedGroups: {},
    } as any);

    const host = new ShimElement('div');
    mountEditor(host as any);
    await flush();
    const headerText = (): string => collectText(host).join(' | ');
    assert.ok(headerText().includes('la /'), 'в шапке показан тип связи «la»');

    // 1. Производитель (менеджер свойств) перечитал каталог типов и уведомил
    //    подписчиков о правке пары имён СВОЕГО типа связи. Каталог уже свежий,
    //    поэтому шапка перерисовывается сразу и по новому имени.
    serverLinkTypes = [
      makeLinkType('root', { is_root: true }),
      makeLinkType('la', { parent_id: 'root', name_forward: 'НОВОЕ' }),
      makeLinkType('lb'),
    ];
    store.update({ linkTypes: serverLinkTypes } as any);
    const fetchesBefore = catalogueFetches;
    let before = createdElements;
    notifyTypeChanged(
      typeUpdateFacts(
        { ownerType: 'link_type', ownerId: 'la' },
        linkTypeFieldsFromPropertyChanges({
          name_forward: 'НОВОЕ',
          name_reverse: 'включает',
          link_color: '#fff',
        }),
      ),
    );
    await flush();
    assert.ok(createdElements > before, 'правка типа связи из менеджера свойств перерисовывает шапку');
    assert.ok(headerText().includes('НОВОЕ /'), `шапка показывает новое имя: ${headerText()}`);
    assert.equal(
      catalogueFetches,
      fetchesBefore,
      'локальный путь не перезапрашивает каталог: производитель уже это сделал',
    );

    // 2. Чужой тип связи: в цепочке показанной связи его нет — шапка не трогается.
    before = createdElements;
    notifyTypeChanged(
      typeUpdateFacts(
        { ownerType: 'link_type', ownerId: 'lb' },
        linkTypeFieldsFromPropertyChanges({ name_forward: 'чужое' }),
      ),
    );
    await flush();
    assert.equal(createdElements, before, 'правка чужого типа связи шапку не перерисовывает');

    // 3. Удаление свойства-связи унесло и связанный тип связи: производитель
    //    перечитал каталог (типа в нём больше нет) и уведомил подписчиков.
    //    Редактор обязан пометить тип удалённым и перечитать отвязанную связь.
    serverLinkTypes = [makeLinkType('root', { is_root: true }), makeLinkType('lb')];
    store.update({ linkTypes: serverLinkTypes } as any);
    before = createdElements;
    notifyTypeChanged(typeDeletedFacts({ ownerType: 'link_type', ownerId: 'la' }));
    await flush();
    assert.equal(isTypeDeleted({ ownerType: 'link_type', ownerId: 'la' }), true);
    assert.deepEqual(linkGets, ['l1'], 'показанная связь перечитана с сервера');
    const liveTarget = store.state.editorTarget as { kind: string; link: Link } | null;
    assert.equal(liveTarget?.kind, 'link');
    assert.equal(liveTarget?.link.type_id, null, 'шапка получает отвязанный тип с сервера');
    assert.ok(createdElements > before, 'шапка перерисована после перечитывания связи');
    assert.ok(!headerText().includes('la /'), 'исчезнувший тип больше не рисуется в шапке');

    // 4. Удаление ЧУЖОГО типа связи — связь не перечитывается.
    notifyTypeChanged(typeDeletedFacts({ ownerType: 'link_type', ownerId: 'lb' }));
    await flush();
    assert.deepEqual(linkGets, ['l1'], 'удаление чужого типа связи связи не трогает');
  });
});

// ---------------------------------------------------------------------------
// Проводка: недостающие локальные производители уведомляют открытый редактор
// ---------------------------------------------------------------------------

describe('проводка локального уведомления о типе (ошибка 7dfad7d4)', () => {
  const read = (rel: string): string =>
    readFileSync(resolve(import.meta.dirname, '..', 'src', 'renderer', rel), 'utf8');

  it('менеджер свойств уведомляет о правке и удалении связанного типа связи', () => {
    const propertyManager = read('screens/property-manager.ts');

    // Правка свойства-связи: после PATCH /properties (и, если нужно, PATCH
    // /link-types для родителя) шапка открытого редактора связи получает факты
    // правки самого типа.
    assert.ok(
      /linkTypeFieldsFromPropertyChanges\(changes\)[\s\S]{0,700}?notifyTypeChanged\([\s\S]{0,200}?typeUpdateFacts\(\{ ownerType: 'link_type'/.test(
        propertyManager,
      ),
      'правка типа связи в редакторе свойства уведомляет открытый редактор',
    );
    assert.ok(
      /const parentChanged = await syncLinkTypeParent\(/.test(propertyManager),
      'смена родителя типа связи сообщает, что PATCH был отправлен',
    );
    // Каталог типов перечитывается ДО уведомления: шапка резолвит подпись и
    // вид линии из него.
    assert.ok(
      /await reloadTypeCatalogues\(\);[\s\S]{0,200}?notifyTypeChanged\(/.test(propertyManager),
      'перед уведомлением каталог типов перечитан',
    );
    // Удаление свойства-связи: после DELETE /properties тип связи исчезает —
    // открытый редактор помечает его удалённым и перечитывает связь.
    assert.ok(
      /links_becoming_structural === 'number'[\s\S]{0,500}?notifyTypeChanged\(\s*typeDeletedFacts\(\s*\{ ownerType: 'link_type'/.test(
        propertyManager,
      ),
      'удаление свойства-связи уведомляет об удалении связанного типа связи',
    );
  });

  it('редактор типов уведомляет об удалении типа мысли', () => {
    const typeManager = read('screens/type-manager.ts');
    assert.ok(
      /await refreshThoughtTypes\(\);[\s\S]{0,800}?notifyTypeChanged\(typeDeletedFacts\(\{ ownerType: 'thought_type'/.test(
        typeManager,
      ),
      'удаление типа мысли уведомляет открытый редактор после перечитывания каталога',
    );
  });

  it('редактор помечает удалённый тип и реагирует на смену набора и оформление', () => {
    const editor = read('editor/editor.ts');
    assert.ok(
      /onTypeChanged\(\(facts\) => \{\s*if \(facts\.deleted\) markTypeDeleted\(facts\.owner\);[\s\S]{0,80}?applyLocalTypeChange\(facts\);/.test(
        editor,
      ),
      'локальное удаление типа помечается тем же путём, что и realtime',
    );
    assert.ok(
      /function applyLocalTypeChange\(facts: TypeChangeFacts\): void \{[\s\S]{0,600}?refreshShownEntityAfterTypeDetach\(\)[\s\S]{0,200}?if \(facts\.setChanged\) invalidateDefinitionDependentPanes\(\);[\s\S]{0,200}?repaintEditorHeader\(\)/.test(
        editor,
      ),
      'удаление/смена набора/оформление типа обрабатываются локально как в realtime',
    );
  });
});

// ---------------------------------------------------------------------------
// Локальная правка типа связи доводится до холста и панелей (ошибка 270b8454)
// ---------------------------------------------------------------------------

function makeThought(overrides: Record<string, unknown> = {}): Thought {
  return {
    id: 't1',
    title: 'T1',
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    active: true,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as unknown as Thought;
}

/** Минимальный ответ `focus()` — форма, которую переваривает `refreshFocusOrNull`. */
function makeFocusResponse(): unknown {
  return {
    focused: makeThought(),
    parents: [],
    children: [],
    siblings: [],
    edges: [],
    sorts: {
      parents: { sort: 'created', order: 'asc' },
      children: { sort: 'created', order: 'asc' },
      siblings: { sort: 'created', order: 'asc' },
    },
  };
}

describe('локальная правка типа связи пересчитывает холст и панели (270b8454)', () => {
  it('общий пересчёт дёргает тот же путь, что realtime-ветка типа', async () => {
    shimDom();
    /** Перезапросы фокуса — так виден `scheduleRefresh` (пересчёт холста). */
    let focusFetches = 0;
    (globalThis as any).window.etn = {
      ui: { setState: async () => undefined },
      types: {
        listThoughtTypes: async () => [],
        listLinkTypes: async () => [],
      },
      thoughts: {
        focus: async () => {
          focusFetches++;
          return makeFocusResponse();
        },
      },
    };
    const { store } = await import('../src/renderer/state.js');
    const { scheduleTypeRepaint, applyRealtimeToUi } =
      await import('../src/renderer/realtime-ui.js');

    store.update({
      networkId: 'n1',
      activeView: 'structures',
      activeTabId: 'tab1',
      focus: makeFocusResponse(),
    } as any);

    // Локальный производитель (менеджер свойств) уже перечитал каталог и зовёт
    // общий пересчёт: холст обязан перечитаться (фокус), «Структуры» и
    // «Хроника» — перестроиться (их разбудит тот же набор, см. проводку ниже).
    scheduleTypeRepaint();
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(
      focusFetches,
      1,
      'пересчёт после локальной правки типа связи перечитывает фокус (холст перерисовывается)',
    );

    // Эталон: realtime-событие того же типа идёт этим же путём — «тот же набор
    // обновлений» значит сравнение с ним, а не самостоятельный список.
    applyRealtimeToUi({
      type: 'link-type.updated',
      seq: 1,
      ts: '2026-01-01T00:00:00.000Z',
      actor: { user_id: 'u2', client_id: 'c2' },
      audience: 'network',
      network_id: 'n1',
      layer_id: 'base',
      data: { id: 'la', changes: { name_forward: 'X' }, version: 2 },
      meta: { version: 1 },
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(
      focusFetches,
      2,
      'realtime-ветка типа перечитывает фокус (эталон, с которым сверяется локальный путь)',
    );
  });

  it('набор пересчёта задан одним помощником и зовётся обоими путями', () => {
    const read = (rel: string): string =>
      readFileSync(resolve(import.meta.dirname, '..', 'src', 'renderer', rel), 'utf8');
    const realtimeUi = read('realtime-ui.ts');

    // Набор «холст + Структуры + Хроника» задан одним помощником
    // `scheduleNeighbourhoodRepaint` (0.8.2, ошибка f0b959dd вынесла его сюда
    // для правок рёбер); пересчёт типов делегирует ему — набор остаётся в
    // одном месте.
    assert.ok(
      /export function scheduleNeighbourhoodRepaint\(\): void \{[\s\S]{0,120}?scheduleRefresh\(\);[\s\S]{0,80}?scheduleStructuresRefresh\(\);[\s\S]{0,80}?scheduleChronicleRefresh\(\);/.test(
        realtimeUi,
      ),
      'scheduleNeighbourhoodRepaint пересчитывает холст, «Структуры» и «Хронику»',
    );
    assert.ok(
      /export function scheduleTypeRepaint\(\): void \{\s*scheduleNeighbourhoodRepaint\(\);\s*\}/.test(
        realtimeUi,
      ),
      'scheduleTypeRepaint делегирует общий пересчёт окрестности',
    );
    // Каталог перечитывается отдельно и ДО пересчёта: повторного перезапроса
    // каталога из пересчёта нет (прецедент in-flight дележа).
    assert.ok(
      !/export function scheduleTypeRepaint\(\): void \{[\s\S]{0,400}?reloadTypeCatalogues\(\)/.test(
        realtimeUi,
      ),
      'пересчёт не перезапрашивает каталог типов повторно',
    );
    assert.ok(
      /case 'link-type\.deleted':[\s\S]{0,500}?void reloadTypeCatalogues\(\);[\s\S]{0,80}?scheduleTypeRepaint\(\);/.test(
        realtimeUi,
      ),
      'realtime-ветка типа зовёт общий пересчёт',
    );
  });

  it('менеджер свойств доводит локальную правку и удаление типа связи до холста и панелей', () => {
    const read = (rel: string): string =>
      readFileSync(resolve(import.meta.dirname, '..', 'src', 'renderer', rel), 'utf8');
    const propertyManager = read('screens/property-manager.ts');

    // Правка свойства-связи: каталог перечитан ДО уведомления редактора —
    // затем уведомление и пересчёт холста/панелей.
    assert.ok(
      /await reloadTypeCatalogues\(\);[\s\S]{0,400}?notifyTypeChanged\([\s\S]{0,300}?typeUpdateFacts\(\{ ownerType: 'link_type'[\s\S]{0,800}?scheduleTypeRepaint\(\);/.test(
        propertyManager,
      ),
      'правка типа связи в редакторе свойства пересчитывает холст и панели',
    );
    // Удаление свойства-связи вместе с типом связи: пометка типа удалённым →
    // пересчёт (отвязанные рёбра получают свежий фокус, панели — свежие данные).
    assert.ok(
      /notifyTypeChanged\(typeDeletedFacts\(\{ ownerType: 'link_type'[\s\S]{0,500}?scheduleTypeRepaint\(\);/.test(
        propertyManager,
      ),
      'удаление типа связи вместе со свойством пересчитывает холст и панели',
    );
  });
});
