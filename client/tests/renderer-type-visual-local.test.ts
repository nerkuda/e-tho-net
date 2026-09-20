/**
 * Regression test for ETN error 8dd5dfed «Правка оформления типа не
 * перерисовывает шапку открытого редактора этого же клиента».
 *
 * Симптом: пользователь правит оформление типа (иконка/цвета/имя) в редакторе
 * типа того же клиента — открытый редактор мысли этого типа не перерисовывает
 * шапку: значок и подпись типа прежние до следующей пересборки редактора.
 * Realtime-случай закрыт ошибкой 94b28014 (`thought-type.updated` →
 * `patchHeader`), но своё realtime-эхо до рендерера не доходит (главный процесс
 * его отбрасывает, G8 applier), а локального уведомления о правке САМОГО типа у
 * производителя не было — он уведомлял только канал определений свойств
 * (`notifyTypeDefinitionsChanged` → «Свойства», ошибка 74b94c26).
 *
 * Проверяются: чистый построитель фактов `typeUpdateFacts` (какие поля правки
 * касаются шапки), локальный канал `notifyTypeChanged`/`onTypeChanged` под
 * DOM-шимом (свой тип перерисовывает шапку, чужой и невизуальная правка — нет,
 * вкладки не трогаются, каталог не перезапрашивается — производитель перечитал
 * его сам) и проводка производителя (`screens/type-manager.ts`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { Thought, ThoughtType } from '@etn/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Чистые факты: что из правки типа касается шапки редактора
// ---------------------------------------------------------------------------

describe('факты локальной правки типа (ошибка 8dd5dfed)', () => {
  it('оформление и подпись типа — шапка; описание и привязки — нет', async () => {
    const { typeUpdateFacts } = await import('../src/renderer/lib/type-definitions.js');

    const owner = { ownerType: 'thought_type' as const, ownerId: 'ta' };
    const visual = (changes: Record<string, unknown>): boolean =>
      typeUpdateFacts(owner, changes).visualChanged;

    for (const field of [
      'name',
      'icon',
      'icon_kind',
      'fg_color',
      'bg_color',
      'font_bold',
      'font_italic',
      'font_underline',
      'font_strike',
    ]) {
      assert.equal(visual({ [field]: 'x' }), true, `${field} касается шапки`);
    }
    // Описание типа в редакторе мысли не показывается, шаблон комментария —
    // содержимое вкладки «Комментарий» (её кэш сбрасывает смена типа).
    assert.equal(visual({ description: 'текст' }), false);
    assert.equal(visual({ comment_template_md: 'шаблон' }), false);
    assert.deepEqual(typeUpdateFacts(owner, { parent_id: 'root' }), {
      owner,
      deleted: false,
      setChanged: true,
      visualChanged: false,
    });
    assert.deepEqual(typeUpdateFacts(owner, {}), {
      owner,
      deleted: false,
      setChanged: false,
      visualChanged: false,
    });

    // Тип связи: в его редакторе видны пара имён и параметры линии, а полей
    // иконки/цветов у него нет.
    const linkOwner = { ownerType: 'link_type' as const, ownerId: 'la' };
    assert.equal(typeUpdateFacts(linkOwner, { name_forward: 'x' }).visualChanged, true);
    assert.equal(typeUpdateFacts(linkOwner, { width: 2 }).visualChanged, true);
    assert.equal(typeUpdateFacts(linkOwner, { icon: '🅰' }).visualChanged, false);
  });
});

// ---------------------------------------------------------------------------
// Локальный канал: уведомление производителя доходит до шапки редактора
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

/** Waits for the editor's own async chains (render, pane builds). */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** Text of every element in the subtree (для проверки содержимого шапки). */
function collectText(node: ShimElement, out: string[] = []): string[] {
  if (node.textContent !== '') out.push(node.textContent);
  for (const child of node.children) collectText(child, out);
  return out;
}

describe('локальная правка типа перерисовывает шапку редактора (8dd5dfed)', () => {
  it('свой тип — шапка обновляется по свежему каталогу, чужой тип и невизуальная правка — нет', async () => {
    shimDom();
    /** Сколько раз редактор запрашивал каталоги типов (локальный путь не должен). */
    let catalogueFetches = 0;
    (globalThis as any).window.etn = {
      ui: { setState: async () => undefined, getState: async () => 'metadata' },
      admin: { listUsers: async () => [] },
      types: {
        listThoughtTypes: async () => {
          catalogueFetches++;
          return storeRef.thoughtTypes;
        },
        listLinkTypes: async () => {
          catalogueFetches++;
          return storeRef.linkTypes;
        },
      },
      properties: { get: async () => [] },
      comments: { list: async () => [], create: async () => undefined },
      thoughts: { get: async () => null, focus: async () => null },
      realtime: {
        onStatusChange: () => undefined,
        onStale: () => undefined,
        onNetworkLost: () => undefined,
        onLayerControl: () => undefined,
        onEvent: () => undefined,
        notifyOnline: () => undefined,
      },
    };

    const { mountEditor, editorInternals } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    const { notifyTypeChanged, typeUpdateFacts } = await import(
      '../src/renderer/lib/type-definitions.js'
    );
    const storeRef = store.state;

    // Показана мысль типа «ta» (цепочка ta → root); в каталоге есть чужой «tb».
    store.update({
      networkId: 'n1',
      thoughtTypes: [
        makeType('root', { is_root: true }),
        makeType('ta', { parent_id: 'root' }),
        makeType('tb'),
      ],
      editorTarget: { kind: 'thought', id: 't1', thought: makeThought({ type_id: 'ta' }) },
      collapsedGroups: {},
    } as any);

    const host = new ShimElement('div');
    mountEditor(host as any);
    await flush();
    const headerText = (): string => collectText(host).join(' | ');
    assert.ok(headerText().includes('ta'), 'в шапке показан тип мысли «ta»');

    // Локальная запись: производитель уже перечитал каталог (как type-manager
    // после `refreshThoughtTypes`) и уведомил подписчиков.
    store.update({
      thoughtTypes: [
        makeType('root', { is_root: true }),
        makeType('ta', { parent_id: 'root', name: 'ИМЯ-НОВОЕ' }),
        makeType('tb'),
      ],
    } as any);
    const fetchesBefore = catalogueFetches;
    const elementsBefore = createdElements;
    const panesBefore = editorInternals.paneBuildCount('metadata');
    const meta = { ownerType: 'thought_type' as const, ownerId: 'ta' };

    // 1. Чужой тип: в цепочке показанной мысли его нет — шапка не трогается.
    notifyTypeChanged(typeUpdateFacts({ ownerType: 'thought_type', ownerId: 'tb' }, { icon: '🅱' }));
    await flush();
    assert.equal(createdElements, elementsBefore, 'правка чужого типа шапку не перерисовывает');

    // 2. Свой тип, но правка без видимых в шапке полей (описание) — не трогаем.
    notifyTypeChanged(typeUpdateFacts(meta, { description: 'текст' }));
    await flush();
    assert.equal(createdElements, elementsBefore, 'описание типа шапку не перерисовывает');

    // 3. Правка имени своего типа: шапка перерисовывается СРАЗУ и по свежему
    //    каталогу (производитель его перечитал до уведомления).
    notifyTypeChanged(typeUpdateFacts(meta, { name: 'ИМЯ-НОВОЕ' }));
    await flush();
    assert.ok(createdElements > elementsBefore, 'правка оформления типа перерисовывает шапку');
    assert.ok(headerText().includes('ИМЯ-НОВОЕ'), `шапка показывает новое имя: ${headerText()}`);
    assert.equal(
      catalogueFetches,
      fetchesBefore,
      'локальный путь не перезапрашивает каталог: производитель уже это сделал',
    );
    assert.equal(
      editorInternals.paneBuildCount('metadata'),
      panesBefore,
      'локальная правка типа вкладки не пересобирает',
    );
  });
});

// ---------------------------------------------------------------------------
// Проводка: производитель и подписка редактора
// ---------------------------------------------------------------------------

describe('проводка локального канала изменения типа (ошибка 8dd5dfed)', () => {
  const read = (rel: string): string =>
    readFileSync(resolve(import.meta.dirname, '..', 'src', 'renderer', rel), 'utf8');

  it('редактор типа уведомляет редактор после перечитывания каталога', () => {
    const definitions = read('lib/type-definitions.ts');
    assert.ok(
      /export function onTypeChanged\(/.test(definitions) &&
        /export function notifyTypeChanged\(/.test(definitions),
      'локальный канал «тип изменился» объявлен',
    );
    assert.ok(
      /export function typeUpdateFacts\(/.test(definitions),
      'факты правки строятся из тела запроса',
    );

    const typeManager = read('screens/type-manager.ts');
    assert.ok(
      /await refreshThoughtTypes\(\);[\s\S]{0,700}?notifyTypeChanged\([\s\S]{0,200}?typeUpdateFacts\(/.test(
        typeManager,
      ),
      'уведомление идёт после перечитывания каталога типов',
    );
    assert.ok(
      /savedTypeFields = input;/.test(typeManager),
      'поля, ушедшие на сервер, сохраняются для фактов',
    );
    // Прежний канал определений свойств остаётся: он отвечает за «Свойства».
    assert.ok(
      /props\.applyChanges\(current\.id\)[\s\S]{0,400}?notifyTypeDefinitionsChanged\(\{[\s\S]{0,120}?ownerId: current\.id/.test(
        typeManager,
      ),
      'канал определений свойств не потерян',
    );

    const editor = read('editor/editor.ts');
    assert.ok(
      /onTypeChanged\(\(facts\) => \{[\s\S]{0,120}?applyLocalTypeChange\(facts\);\s*\}\);/.test(editor),
      'редактор подписан на локальное изменение типа',
    );
    // Канал расширен удалением типа (ошибка 7dfad7d4): подписчик сначала
    // помечает тип исчезнувшим (как realtime-путь), затем применяет факты.
    assert.ok(
      /onTypeChanged\(\(facts\) => \{\s*if \(facts\.deleted\) markTypeDeleted\(facts\.owner\);/.test(editor),
      'локальное удаление типа помечается до применения фактов',
    );
    assert.ok(
      /function applyLocalTypeChange\(facts: TypeChangeFacts\): void \{[\s\S]{0,700}?repaintEditorHeader\(\)/.test(
        editor,
      ),
      'локальная правка перерисовывает шапку',
    );
  });
});
