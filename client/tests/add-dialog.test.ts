/**
 * Unit tests for the universal add/pick dialog (canvas/add-dialog.ts).
 *
 * Runs the REAL `pickThoughtsDialog` under Node with a minimal DOM shim and a
 * fake `window.etn` (the same approach as renderer-properties.test.ts). Covers
 * two regressions:
 *
 * 1. Mode switch «несколько» → «одна» (карточка ETN 24ad9b0e): the
 *    accumulated list must be dropped — a single-mode apply (the primary
 *    button / Ctrl+Enter path via `apply`) used to resurrect every line
 *    queued before the switch and add them all alongside the new thought.
 *
 * 2. `prefillText` (the create-from-legacy-link flow, карточка ETN 34ffbd75):
 *    the dialog opens in SINGLE mode with `имя|алиас` sitting in the name
 *    input as if typed — the duplicate search runs, Enter creates exactly one
 *    thought with the alias parsed into a synonym. Before the fix the flow
 *    passed `draftLines`, which switched the dialog to multi mode with the
 *    name already queued as a list row.
 *
 * `window` is created once and mutated per test: lib/etn.ts reads `window`
 * through a live proxy, so the fake `etn` object may be swapped between cases.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { store } from '../src/renderer/state.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Minimal class list bound to its owner's `className` string — construction
 * helpers (`div('add-list hidden')`) set classes directly on the attribute, so
 * `contains` must read it back, and toggles must rewrite it.
 */
class ShimClassList {
  private owner: ShimElement | null = null;

  /** Binds the list to its element (called from the element constructor). */
  attach(owner: ShimElement): void {
    this.owner = owner;
  }

  private tokens(): Set<string> {
    return new Set((this.owner?.className ?? '').split(/\s+/).filter((t) => t !== ''));
  }

  private write(tokens: Set<string>): void {
    if (this.owner !== null) this.owner.className = [...tokens].join(' ');
  }

  add(...names: string[]): void {
    const tokens = this.tokens();
    names.forEach((n) => tokens.add(n));
    this.write(tokens);
  }

  remove(...names: string[]): void {
    const tokens = this.tokens();
    names.forEach((n) => tokens.delete(n));
    this.write(tokens);
  }

  contains(name: string): boolean {
    return this.tokens().has(name);
  }

  toggle(name: string, force?: boolean): void {
    const tokens = this.tokens();
    const next = force ?? !tokens.has(name);
    if (next) tokens.add(name);
    else tokens.delete(name);
    this.write(tokens);
  }
}

/** Smallest element stub that survives the dialog construction + render. */
class ShimElement {
  tagName: string;
  className = '';
  children: ShimElement[] = [];
  parent: ShimElement | null = null;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  textContent = '';
  innerHTML = '';
  value = '';
  type = '';
  title = '';
  placeholder = '';
  checked = false;
  disabled = false;
  rows = 0;
  tabIndex = 0;
  isConnected = true;
  classList = new ShimClassList();
  private listeners = new Map<string, Array<(event: any) => void>>();

  constructor(tag: string, className?: string, text?: string) {
    this.tagName = tag;
    this.classList.attach(this);
    if (className !== undefined) this.className = className;
    if (text !== undefined) this.textContent = text;
  }

  append(...nodes: ShimElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: ShimElement[]): void {
    this.children = nodes;
    for (const node of nodes) node.parent = this;
  }

  remove(): void {
    if (this.parent === null) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
    // Снятие узла из DOM — путь закрытия диалога (`showDialog` вешает на него
    // событие `remove`, по которому снимает слушатели клавиш и зовёт `onClose`).
    // Шим повторяет контракт: узел без родителя не снимается и события не даёт,
    // поэтому повторный `remove()` не переигрывает `onClose`.
    this.emit('remove');
  }

  contains(node: ShimElement | null): boolean {
    if (node === null) return false;
    return node === this || this.children.some((child) => child.contains(node));
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((fn) => fn !== listener));
  }

  /** Test helper: dispatch a synthetic event to the registered listeners. */
  emit(type: string, event: any = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  click(): void {
    this.emit('click');
  }

  focus(): void {
    /* no layout engine — a no-op */
  }

  setSelectionRange(): void {
    /* the caret position is not observable in the shim */
  }

  setAttribute(name: string, value: string): void {
    this.dataset[name] = value;
  }

  /** Class/tag-selector query in document order (the forms the dialog uses). */
  querySelectorAll(selector: string): ShimElement[] {
    const byTag = !selector.startsWith('.');
    const token = byTag ? selector : selector.slice(1);
    const hits: ShimElement[] = [];
    const walk = (node: ShimElement): void => {
      const match = byTag ? node.tagName === token : node.className.split(/\s+/).includes(token);
      if (match) hits.push(node);
      node.children.forEach(walk);
    };
    this.children.forEach(walk);
    return hits;
  }

  querySelector(selector: string): ShimElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };
  }

  scrollIntoView(): void {
    /* not needed without a layout engine */
  }
}

/** Keydown-like event with the exact shape the dialog reads. */
function key(name: string, mods: Record<string, boolean> = {}): any {
  return {
    key: name,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
    defaultPrevented: false,
    preventDefault(): void {
      this.defaultPrevented = true;
    },
    stopPropagation(): void {},
  };
}

/** Duplicate-search calls received by the fake `window.etn`. */
const dupQueries: Array<{ title: string; synonyms: string[] }> = [];

/** Слушатели `window` — каркас диалога вешает сюда Esc и Ctrl+Enter. */
const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];

/** Нажатие Esc — реальный путь каркаса: его `keydown`-слушатель закрывает диалог. */
function pressEscape(): void {
  const event = key('Escape');
  for (const { type, listener } of [...windowListeners]) {
    if (type === 'keydown') listener(event);
  }
}

/**
 * Installs the DOM/window shims ONCE (lib/etn.ts keeps a live reference) and
 * returns per-dialog accessors. `window.setTimeout` runs synchronously so the
 * debounced duplicate search needs no real timers.
 */
function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    setTimeout: (fn: () => void) => {
      fn();
      return 1;
    },
    clearTimeout: () => undefined,
    addEventListener: (type: string, listener: (event: any) => void) => {
      windowListeners.push({ type, listener });
    },
    removeEventListener: (type: string, listener: (event: any) => void) => {
      const index = windowListeners.findIndex((l) => l.type === type && l.listener === listener);
      if (index >= 0) windowListeners.splice(index, 1);
    },
    etn: {
      thoughts: {
        findDuplicates: async (_networkId: string, title: string, synonyms: string[]) => {
          dupQueries.push({ title, synonyms });
          return [];
        },
      },
      ui: {
        setState: async () => undefined,
      },
    },
  };
}

let dialogModule: any = null;
async function loadDialog(): Promise<any> {
  if (dialogModule === null) {
    installShim();
    dialogModule = await import('../src/renderer/canvas/add-dialog.js');
  }
  return dialogModule;
}

/** Handles to one opened dialog: mode radios, input, list, primary button. */
interface DialogHandle {
  promise: Promise<any>;
  singleRadio: ShimElement;
  multiRadio: ShimElement;
  input: ShimElement;
  lineList: ShimElement;
  primaryBtn: ShimElement;
  cancelBtn: ShimElement;
  /** Dialog header text — «Добавить мысль (вниз к «…»)». */
  titleText: () => string;
  /** Queued list row titles (empty when the list holds only its header). */
  lineTitles: () => string[];
}

/** Opens the dialog with the given options and returns accessors to its DOM. */
async function openDialog(opts: Record<string, unknown> = {}): Promise<DialogHandle> {
  const mod = await loadDialog();
  const promise = mod.pickThoughtsDialog({ networkId: 'n1', ...opts });
  const body = (globalThis as any).document.body as ShimElement;
  const backdrop = body.children.find((c) => c.className === 'dialog-backdrop');
  assert.ok(backdrop !== undefined, 'dialog backdrop mounted');
  const box = backdrop.children[0];
  assert.ok(box !== undefined, 'dialog box rendered');
  const formStack = box.querySelectorAll('.form-stack')[0] ?? null;
  assert.ok(formStack !== null, 'form body rendered');
  const modeRow = formStack.children.find((c) => c.className === 'add-mode-row');
  const singleRadio = modeRow?.children[0]?.children[0] ?? new ShimElement('input');
  const multiRadio = modeRow?.children[1]?.children[0] ?? new ShimElement('input');
  const input = formStack.children.find((c) => c.tagName === 'textarea') ?? new ShimElement('textarea');
  const lineList =
    formStack.children.find((c) => c.className.split(/\s+/).includes('add-list')) ?? new ShimElement('div');
  const footer = box.children.find((c) => c.className === 'dialog-footer');
  const primaryBtn =
    footer?.children.find((c) => c.className.split(/\s+/).includes('primary')) ?? new ShimElement('button');
  const cancelBtn = footer?.children.find((c) => c !== primaryBtn) ?? new ShimElement('button');
  const lineTitles = (): string[] =>
    lineList.children
      .filter((row) => row.className === 'add-list-item')
      .map((row) => row.children.find((c) => c.className === 'al-title')?.textContent ?? '');
  const titleText = (): string => box.querySelector('.dialog-title')?.textContent ?? '';
  return { promise, singleRadio, multiRadio, input, lineList, primaryBtn, cancelBtn, titleText, lineTitles };
}

/** Ticks the microtask queue so the async duplicate search settles. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Checks a mode radio like the browser would (sync both, fire `change`). */
function checkRadio(radio: ShimElement, other: ShimElement): void {
  radio.checked = true;
  other.checked = false;
  radio.emit('change');
}

describe('pickThoughtsDialog mode switch (карточка ETN 24ad9b0e)', () => {
  it('switching «несколько» → «одна» drops the accumulated list (primary-button path)', async () => {
    const ui = await openDialog();
    checkRadio(ui.multiRadio, ui.singleRadio);
    ui.input.value = 'Первая';
    ui.input.emit('keydown', key('Enter'));
    ui.input.value = 'Вторая';
    ui.input.emit('keydown', key('Enter'));
    assert.deepEqual(ui.lineTitles(), ['Первая', 'Вторая'], 'multi mode queued two lines');

    checkRadio(ui.singleRadio, ui.multiRadio);
    assert.equal(ui.lineList.classList.contains('hidden'), true, 'the list is hidden in single mode');
    ui.input.value = 'Третья';
    ui.primaryBtn.click();
    const result = await ui.promise;
    assert.equal(result?.items.length, 1, 'only the single-mode thought is applied');
    assert.deepEqual(result?.items[0], {
      kind: 'new',
      title: 'Третья',
      synonyms: [],
      raw: 'Третья',
    });
  });

  it('single-mode Enter after the switch resolves with exactly one thought', async () => {
    const ui = await openDialog();
    checkRadio(ui.multiRadio, ui.singleRadio);
    ui.input.value = 'Старая';
    ui.input.emit('keydown', key('Enter'));

    checkRadio(ui.singleRadio, ui.multiRadio);
    ui.input.value = 'Новая';
    const enter = key('Enter');
    ui.input.emit('keydown', enter);
    assert.ok(enter.defaultPrevented, 'Enter is consumed by the input');
    const result = await ui.promise;
    assert.equal(result?.items.length, 1);
    assert.equal(result?.items[0]?.title, 'Новая');
  });

  it('switching back to «несколько» starts from a clean list', async () => {
    const ui = await openDialog();
    checkRadio(ui.multiRadio, ui.singleRadio);
    ui.input.value = 'Была одна';
    ui.input.emit('keydown', key('Enter'));

    checkRadio(ui.singleRadio, ui.multiRadio);
    checkRadio(ui.multiRadio, ui.singleRadio);
    assert.deepEqual(ui.lineTitles(), [], 'no ghost rows after the round trip');
    ui.input.value = 'Теперь другая';
    ui.input.emit('keydown', key('Enter'));
    assert.deepEqual(ui.lineTitles(), ['Теперь другая'], 'multi mode keeps queueing normally');
    ui.cancelBtn.click();
    assert.equal(await ui.promise, null);
  });

  it('multi mode without a switch still applies the whole list', async () => {
    const ui = await openDialog();
    checkRadio(ui.multiRadio, ui.singleRadio);
    ui.input.value = 'Раз';
    ui.input.emit('keydown', key('Enter'));
    ui.input.value = 'Два';
    ui.input.emit('keydown', key('Enter'));
    ui.primaryBtn.click();
    const result = await ui.promise;
    assert.deepEqual(
      result?.items.map((item: any) => item.title),
      ['Раз', 'Два'],
    );
  });
});

describe('заголовок диалога называет якорь, а не мысль в фокусе (ошибка c8bd4676)', () => {
  /** Минимальный ответ фокуса: диалогу нужно только имя мысли в фокусе. */
  const focusWith = (title: string): any => ({
    focused: { id: 'F', title },
    parents: [],
    siblings: [],
    children: [],
    edges: [],
    sorts: {
      parents: { sort: 'created', order: 'asc' },
      children: { sort: 'created', order: 'asc' },
      siblings: { sort: 'created', order: 'asc' },
    },
  });

  it('имя источника драга перебивает имя мысли в фокусе', async () => {
    store.update({ focus: focusWith('Мысль в фокусе') });
    const ui = await openDialog({
      anchor: { id: 'X', direction: 'child' },
      anchorTitle: 'Источник драга',
    });
    assert.equal(ui.titleText(), 'Добавить мысль (вниз к «Источник драга»)');
    ui.cancelBtn.click();
    assert.equal(await ui.promise, null);
  });

  it('openAddDialog доносит имя якоря до заголовка (путь эллипса)', async () => {
    const mod = await loadDialog();
    store.update({ networkId: 'n1', focus: focusWith('Мысль в фокусе') });
    const done = mod.openAddDialog({
      anchorId: 'X',
      anchorTitle: 'Источник драга',
      direction: 'child',
    });
    const body = (globalThis as any).document.body as ShimElement;
    const backdrop = body.children.find((c) => c.className === 'dialog-backdrop');
    const box = backdrop?.children[0];
    assert.equal(
      box?.querySelector('.dialog-title')?.textContent ?? '',
      'Добавить мысль (вниз к «Источник драга»)',
    );
    // Отмена: диалог закрывается, ничего не создаётся.
    const footer = box?.children.find((c) => c.className === 'dialog-footer');
    footer?.children.find((c) => !c.className.split(/\s+/).includes('primary'))?.click();
    assert.equal(await done, undefined);
    store.update({ networkId: null, focus: null });
  });

  it('направление берётся из эллипса: верхний даёт «вверх к якорю»', async () => {
    store.update({ focus: focusWith('Мысль в фокусе') });
    const ui = await openDialog({
      anchor: { id: 'X', direction: 'parent' },
      anchorTitle: 'Источник драга',
    });
    assert.equal(ui.titleText(), 'Добавить мысль (вверх к «Источник драга»)');
    ui.cancelBtn.click();
    assert.equal(await ui.promise, null);
  });

  it('без имени якоря остаётся прежний откат на мысль в фокусе', async () => {
    store.update({ focus: focusWith('Мысль в фокусе') });
    const ui = await openDialog({ anchor: { id: 'X', direction: 'child' } });
    assert.equal(ui.titleText(), 'Добавить мысль (вниз к «Мысль в фокусе»)');
    ui.cancelBtn.click();
    assert.equal(await ui.promise, null);
    store.update({ focus: null });
  });

  it('без якоря суффикса направления нет', async () => {
    store.update({ focus: null });
    const ui = await openDialog();
    assert.equal(ui.titleText(), 'Добавить мысли');
    ui.cancelBtn.click();
    assert.equal(await ui.promise, null);
  });
});

describe('pickThoughtsDialog prefillText (карточка ETN 34ffbd75, приёмка)', () => {
  it('opens in single mode with `имя|алиас` in the input; Enter creates one thought with the synonym', async () => {
    dupQueries.length = 0;
    const ui = await openDialog({ prefillText: 'Имя из ссылки|Алиас' });
    assert.equal(ui.singleRadio.checked, true, 'single mode stays on');
    assert.equal(ui.multiRadio.checked, false, 'multi mode is NOT switched on');
    assert.equal(ui.input.value, 'Имя из ссылки|Алиас', 'the input is prefilled');
    assert.equal(ui.lineList.classList.contains('hidden'), true, 'no accumulated list');

    // The debounced duplicate check ran as if the text were typed — the alias
    // participates in the search together with the title.
    await settle();
    assert.deepEqual(
      dupQueries.map((q) => [q.title, ...q.synonyms]).at(-1),
      ['Имя из ссылки', 'Алиас'],
    );

    ui.input.emit('keydown', key('Enter'));
    const result = await ui.promise;
    assert.equal(result?.items.length, 1, 'exactly one thought is created');
    assert.deepEqual(result?.items[0], {
      kind: 'new',
      title: 'Имя из ссылки',
      synonyms: ['Алиас'],
      raw: 'Имя из ссылки|Алиас',
    });
  });

  it('a prefilled dialog still allows switching to multi', async () => {
    const ui = await openDialog({ prefillText: 'Имя' });
    checkRadio(ui.multiRadio, ui.singleRadio);
    ui.input.value = 'Имя';
    ui.input.emit('keydown', key('Enter'));
    assert.deepEqual(ui.lineTitles(), ['Имя'], 'the prefilled name can be queued in multi mode');
    ui.cancelBtn.click();
    assert.equal(await ui.promise, null);
  });
});

// ---------------------------------------------------------------------------
// Отмена диалога добавления/выбора мыслей резолвит промис (ошибка 5069a508)
// ---------------------------------------------------------------------------

/** Подложка открытого диалога (единственный ребёнок `document.body`). */
function openBackdrop(): ShimElement {
  const backdrop = ((globalThis as any).document.body as ShimElement).children.find((c) =>
    c.className.split(/\s+/).includes('dialog-backdrop'),
  );
  assert.ok(backdrop !== undefined, 'диалог смонтирован');
  return backdrop!;
}

/** Кнопка футера по подписи. */
function footerButton(backdrop: ShimElement, label: string): ShimElement {
  const btn = backdrop.querySelectorAll('button').find((b) => b.textContent === label);
  assert.ok(btn !== undefined, `в футере есть кнопка «${label}»`);
  return btn!;
}

/** Клик по подложке мимо тела диалога. */
function clickBackdrop(backdrop: ShimElement): void {
  backdrop.emit('click', {
    target: backdrop,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  });
}

/** Клик по × в заголовке. */
function clickClose(backdrop: ShimElement): void {
  const closeBtn = backdrop.querySelector('.dialog-close');
  assert.ok(closeBtn !== null, 'в заголовке есть ×');
  closeBtn!.click();
}

async function resolvesTo<T>(
  promise: Promise<T>,
): Promise<{ value: T | undefined; settled: boolean }> {
  let value: T | undefined;
  let settled = false;
  void promise.then((v) => {
    value = v;
    settled = true;
  });
  await settle();
  return { value, settled };
}

describe('pickThoughtsDialog: отмена любым путём закрытия (ошибка 5069a508)', () => {
  it('Esc резолвит null и снимает диалог', async () => {
    const ui = await openDialog();
    pressEscape();
    const { value, settled } = await resolvesTo(ui.promise);
    assert.equal(settled, true, 'промис завершён, а не висит');
    assert.equal(value, null, 'Esc — отмена');
    assert.equal(((globalThis as any).document.body as ShimElement).children.length, 0, 'диалог закрыт');
  });

  it('× в заголовке резолвит null', async () => {
    const ui = await openDialog();
    clickClose(openBackdrop());
    const { value } = await resolvesTo(ui.promise);
    assert.equal(value, null, '× — отмена');
  });

  it('клик по подложке резолвит null', async () => {
    const ui = await openDialog();
    clickBackdrop(openBackdrop());
    const { value } = await resolvesTo(ui.promise);
    assert.equal(value, null, 'клик мимо — отмена');
  });

  it('«Отмена» резолвит null', async () => {
    const ui = await openDialog();
    footerButton(openBackdrop(), 'Отмена').click();
    const { value } = await resolvesTo(ui.promise);
    assert.equal(value, null, 'кнопка отмены — null');
  });

  it('применение списка отдаёт его и не переигрывается поздним onClose', async () => {
    const ui = await openDialog();
    checkRadio(ui.multiRadio, ui.singleRadio);
    ui.input.value = 'Раз';
    ui.input.emit('keydown', key('Enter'));
    footerButton(openBackdrop(), 'Добавить').click();
    const { value } = await resolvesTo(ui.promise);
    assert.deepEqual(
      value?.items.map((item: any) => item.title),
      ['Раз'],
      'основной путь отдал применённый список',
    );
    assert.equal(((globalThis as any).document.body as ShimElement).children.length, 0, 'диалог закрыт');
  });
});
