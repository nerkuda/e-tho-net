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
import { afterEach, beforeEach, describe, it } from 'node:test';

import * as keymap from '../src/renderer/lib/keymap.js';
import { store } from '../src/renderer/state.js';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Клавиатура диалога идёт через диспетчер контекстов: стек между тестами чист.
beforeEach(() => keymap.keymapInternals.reset());

/**
 * Элемент ли это кнопки словаря (`ui-btn`). В футере диалога рядом с кнопками
 * лежит строка ошибки (`footerError`, требование 397c5a56) — её клик ничего
 * не делает, поэтому искать «неосновную кнопку» нужно среди кнопок.
 */
function isUiButton(node: ShimElement): boolean {
  return node.className.split(/\s+/).includes('ui-btn');
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
    // Общая выпадашка подсказок гасит Esc через `stopImmediatePropagation`;
    // шим считает это no-op — диалог всё равно получает Esc и закрывается.
    stopImmediatePropagation(): void {},
  };
}

/** Duplicate-search calls received by the fake `window.etn`. */
const dupQueries: Array<{ title: string; synonyms: string[] }> = [];

/** Кросс-сетевые поисковые вызовы (`findDuplicatesAcrossNetworks`). */
const crossQueries: Array<{ title: string; networkIds: string[] }> = [];

/** Слушатели `window` — каркас диалога вешает сюда Esc и Ctrl+Enter. */
const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];

/** Нажатие Esc — реальный путь каркаса: его `keydown`-слушатель закрывает диалог. */
function pressEscape(): void {
  const event = key('Escape');
  for (const { type, listener } of [...windowListeners]) {
    if (type === 'keydown') listener(event);
  }
}

/** Нажатие через диспетчер контекстов: фокус кладёт контекст элемента на стек. */
function press(target: ShimElement, event: any): void {
  target.emit('focusin', {});
  keymap.dispatchKeyEvent(event as unknown as KeyboardEvent);
  target.emit('focusout', {});
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
        findDuplicatesAcrossNetworks: async (
          _networkId: string,
          networkIds: string[],
          title: string,
        ) => {
          crossQueries.push({ title, networkIds });
          return { hits: [], networks: { networks: [] } };
        },
      },
      networks: {
        list: async () => [{ id: 'n1' }, { id: 'n2' }],
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
  /** Тело диалога — для проверки строки поиска и охвата кандидатов. */
  formStack: ShimElement;
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
  const input = formStack.querySelector('textarea') ?? new ShimElement('textarea');
  const lineList =
    formStack.children.find((c) => c.className.split(/\s+/).includes('add-list')) ?? new ShimElement('div');
  const footer = box.children.find((c) => c.className.split(/\s+/).includes('dialog-footer'));
  const primaryBtn =
    footer?.children.find((c) => c.className.split(/\s+/).includes('ui-btn--primary')) ?? new ShimElement('button');
  // Кнопка — элемент словаря (`ui-btn`): в футере рядом с ними лежит строка
  // ошибки (`footerError`), её клик ничего не делает.
  const cancelBtn =
    footer?.children.find((c) => c !== primaryBtn && isUiButton(c)) ?? new ShimElement('button');
  const lineTitles = (): string[] =>
    lineList.children
      .filter((row) => row.className === 'add-list-item')
      .map((row) => row.children.find((c) => c.className === 'al-title')?.textContent ?? '');
  const titleText = (): string => box.querySelector('.dialog-title')?.textContent ?? '';
  return { promise, singleRadio, multiRadio, input, lineList, primaryBtn, cancelBtn, titleText, lineTitles, formStack };
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
    press(ui.input, key('Enter'));
    ui.input.value = 'Вторая';
    press(ui.input, key('Enter'));
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
    press(ui.input, key('Enter'));

    checkRadio(ui.singleRadio, ui.multiRadio);
    ui.input.value = 'Новая';
    const enter = key('Enter');
    press(ui.input, enter);
    assert.ok(enter.defaultPrevented, 'Enter is consumed by the input');
    const result = await ui.promise;
    assert.equal(result?.items.length, 1);
    assert.equal(result?.items[0]?.title, 'Новая');
  });

  it('switching back to «несколько» starts from a clean list', async () => {
    const ui = await openDialog();
    checkRadio(ui.multiRadio, ui.singleRadio);
    ui.input.value = 'Была одна';
    press(ui.input, key('Enter'));

    checkRadio(ui.singleRadio, ui.multiRadio);
    checkRadio(ui.multiRadio, ui.singleRadio);
    assert.deepEqual(ui.lineTitles(), [], 'no ghost rows after the round trip');
    ui.input.value = 'Теперь другая';
    press(ui.input, key('Enter'));
    assert.deepEqual(ui.lineTitles(), ['Теперь другая'], 'multi mode keeps queueing normally');
    ui.cancelBtn.click();
    assert.equal(await ui.promise, null);
  });

  it('multi mode without a switch still applies the whole list', async () => {
    const ui = await openDialog();
    checkRadio(ui.multiRadio, ui.singleRadio);
    ui.input.value = 'Раз';
    press(ui.input, key('Enter'));
    ui.input.value = 'Два';
    press(ui.input, key('Enter'));
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
    const footer = box?.children.find((c) => c.className.split(/\s+/).includes('dialog-footer'));
    footer?.children
      .find((c) => isUiButton(c) && !c.className.split(/\s+/).includes('ui-btn--primary'))
      ?.click();
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

    press(ui.input, key('Enter'));
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
    press(ui.input, key('Enter'));
    assert.deepEqual(ui.lineTitles(), ['Имя'], 'the prefilled name can be queued in multi mode');
    ui.cancelBtn.click();
    assert.equal(await ui.promise, null);
  });
});

// ---------------------------------------------------------------------------
// Охват поиска в диалоге добавления/выбора мысли
// (ошибка 81be082f, требование 79755f76): только текущая сеть, без тогла.
// ---------------------------------------------------------------------------

describe('pickThoughtsDialog: охват поиска — только текущая сеть (ошибка 81be082f)', () => {
  it('в диалоге выбора цели внутрисетевой связи нет переключателя охвата', async () => {
    const ui = await openDialog();
    assert.equal(
      ui.formStack.querySelector('.cross-network-toggle'),
      null,
      'переключателя «по всем сетям» в диалоге нет',
    );
    ui.cancelBtn.click();
    assert.equal(await ui.promise, null);
  });

  it('живой поиск кандидатов идёт только по текущей сети (штатный findDuplicates)', async () => {
    dupQueries.length = 0;
    crossQueries.length = 0;
    const ui = await openDialog();
    ui.input.value = 'Кандидат';
    ui.input.emit('input');
    await settle();
    assert.equal(dupQueries.length, 1, 'поиск ушёл в источник текущей сети');
    assert.equal(dupQueries[0]?.title, 'Кандидат', 'запрос ушёл в findDuplicates');
    assert.equal(crossQueries.length, 0, 'веерный кросс-источник не задействован');
    ui.cancelBtn.click();
    assert.equal(await ui.promise, null);
  });
});

// ---------------------------------------------------------------------------
// Подпись сети у кандидатов кросс-сетевого режима (ошибка defcd811):
// в облачке чужой мысли место родителя занимает имя сети, цветом акцента —
// чтобы пользователь сразу видел, в какой сети живёт однофамилец.
// ---------------------------------------------------------------------------

describe('pickThoughtsDialog: подпись сети у чужих мыслей (ошибка defcd811)', () => {
  /** Сеть-владелец чужой мысли с display_name. */
  const FOREIGN_NET = 'n2';
  const FOREIGN_TITLE = 'Чужая';

  /** Хит с подложкой — выдача кросс-поиска, мысль с заполненным network_id. */
  function foreignHit(id: string, netId: string, title: string): any {
    return {
      id,
      network_id: netId,
      title,
      synonyms: [],
      matched_on: 'title',
      type_id: null,
      icon: null,
      icon_kind: 'emoji',
      fg_color: null,
      bg_color: null,
      font_bold: null,
      font_italic: null,
      font_underline: null,
      font_strike: null,
      parent_title: 'какой-то родитель',
    };
  }

  it('в кросс-режиме вместо parent_title рисуется имя сети (display_name)', async () => {
    // Подменяем `etn.networks.list` — каталог сетей с display_name.
    (globalThis as any).window.etn.networks.list = async () => [
      { id: 'n1', display_name: 'Текущая' },
      { id: FOREIGN_NET, display_name: 'Заметки по работе' },
    ];
    // И подсовываем хит с network_id = FOREIGN_NET.
    (globalThis as any).window.etn.thoughts.findDuplicatesAcrossNetworks = async () => ({
      hits: [foreignHit('T-foreign', FOREIGN_NET, FOREIGN_TITLE)],
      networks: { networks: [] },
    });

    const ui = await openDialog({ crossNetwork: { excludeNetworkId: 'n1' } });
    ui.input.value = 'Чужая';
    ui.input.emit('input');
    await settle();

    const rows = ui.formStack.querySelectorAll('.type-combo-item');
    assert.equal(rows.length, 1, 'один кандидат в выдаче');
    const notes = rows[0]!.querySelectorAll('.type-combo-note');
    const net = notes.find((n) => n.classList.contains('type-combo-note--accent'));
    assert.ok(net !== undefined, 'есть подпись сети (акцентная метка `.type-combo-note--accent`)');
    assert.equal(net!.textContent, 'Заметки по работе', 'подпись — display_name чужой сети');
    assert.equal(
      notes.some((n) => !n.classList.contains('type-combo-note--accent')),
      false,
      'родитель НЕ показывается в кросс-режиме',
    );
    ui.cancelBtn.click();
    await ui.promise;
  });

  it('если display_name сети нет в каталоге, подпись — короткий id', async () => {
    (globalThis as any).window.etn.networks.list = async () => [
      { id: 'n1', display_name: 'Текущая' },
    ];
    (globalThis as any).window.etn.thoughts.findDuplicatesAcrossNetworks = async () => ({
      hits: [foreignHit('T-f2', FOREIGN_NET, FOREIGN_TITLE)],
      networks: { networks: [] },
    });

    const ui = await openDialog({ crossNetwork: { excludeNetworkId: 'n1' } });
    ui.input.value = 'Чужая';
    ui.input.emit('input');
    await settle();
    const net = ui.formStack
      .querySelectorAll('.type-combo-item')[0]!
      .querySelectorAll('.type-combo-note')
      .find((n) => n.classList.contains('type-combo-note--accent'));
    assert.ok(net !== undefined, 'подпись сети есть даже без display_name');
    assert.equal(net!.textContent, 'n2', 'фолбэк — короткий id сети');
    ui.cancelBtn.click();
    await ui.promise;
  });

  it('в обычном режиме остаётся прежняя подпись parent_title', async () => {
    // findDuplicates — обычный путь, parent_title заполнен.
    (globalThis as any).window.etn.thoughts.findDuplicates = async () => [
      {
        id: 'L',
        network_id: 'n1',
        title: 'Своя',
        synonyms: [],
        matched_on: 'title',
        type_id: null,
        icon: null,
        icon_kind: 'emoji',
        fg_color: null,
        bg_color: null,
        font_bold: null,
        font_italic: null,
        font_underline: null,
        font_strike: null,
        parent_title: 'Локальный родитель',
      },
    ];

    const ui = await openDialog();
    ui.input.value = 'Своя';
    ui.input.emit('input');
    await settle();
    const row = ui.formStack.querySelectorAll('.type-combo-item')[0]!;
    const notes = row.querySelectorAll('.type-combo-note');
    assert.equal(notes[0]?.textContent, 'Локальный родитель');
    assert.equal(
      notes.some((n) => n.classList.contains('type-combo-note--accent')),
      false,
      'в обычном режиме сеть НЕ подписывается',
    );
    ui.cancelBtn.click();
    await ui.promise;
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
  const closeBtn = backdrop.querySelector('.ui-btn--ghost');
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

  it('клик по подложке НЕ закрывает диалог и не резолвит отмену', async () => {
    const ui = await openDialog();
    clickBackdrop(openBackdrop());
    const { settled } = await resolvesTo(ui.promise);
    assert.equal(settled, false, 'клик мимо не резолвит промис');
    assert.equal(
      ((globalThis as any).document.body as ShimElement).children.length,
      1,
      'диалог остался открыт',
    );
    pressEscape();
    const { value } = await resolvesTo(ui.promise);
    assert.equal(value, null, 'после клика мимо Esc всё ещё закрывает диалог');
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
    press(ui.input, key('Enter'));
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

// ---------------------------------------------------------------------------
// Поле «Свойство связи» в диалоге добавления с карты (ошибка 1dd08949):
// вместо типа связи пользователь выбирает СВОЙСТВО-связь, отдельными пунктами
// имена его сторон; выбранное свойство заполняется у добавляемой мысли
// значением якоря — ребро ложится в типизированное свойство, а не «вне типа».
// ---------------------------------------------------------------------------

const LT_ID = 'lt1';
const SIDE_FORWARD = 'запланировано в версию';
const SIDE_REVERSE = 'включает работы';
/** Реестр: свойство-связь (две стороны) + скаляр (в список не попадает). */
const REGISTRY: any[] = [
  {
    id: 'p1',
    name: SIDE_FORWARD,
    value_type: 'link',
    config: { link_type_id: LT_ID },
    description: null,
    created_at: '',
    updated_at: '',
    types_count: 2,
    values_count: 0,
    types_source_count: 1,
    types_target_count: 1,
  },
  {
    id: 'p2',
    name: 'Скаляр',
    value_type: 'text',
    config: null,
    description: null,
    created_at: '',
    updated_at: '',
    types_count: 0,
    values_count: 0,
  },
];

/** Открытый список-подсказчик поля «Свойство связи» (общая выпадашка, живой поиск). */
function propertySuggestList(): ShimElement {
  const body = (globalThis as any).document.body as ShimElement;
  const list = body.children.find((c) => c.className.split(/\s+/).includes('type-combo-list'));
  assert.ok(list !== undefined, 'список поля «Свойство связи» открыт');
  return list!;
}

/** Обёртка поля «Свойство связи» — четвёртый источник общего комбо-пикера. */
function propertyCombo(formStack: ShimElement): ShimElement {
  const wrap = formStack.querySelector('.add-link-property-combo');
  assert.ok(wrap !== null, 'поле «Свойство связи» есть в диалоге');
  return wrap!;
}

/** Строка ввода поля «Свойство связи» (общий комбо-пикер, не отдельное поле). */
function propertyInput(formStack: ShimElement): ShimElement {
  const input = propertyCombo(formStack).querySelector('.entity-combo-input');
  assert.ok(input !== null, 'поле «Свойство связи» — строка ввода общего комбо');
  return input!;
}

/** Подписи-имена пунктов открытого списка поля (без значков и уточнений). */
function propertySuggestNames(list: ShimElement): string[] {
  return list
    .querySelectorAll('.type-combo-item')
    .map((row) => row.querySelectorAll('.type-combo-label')[0]?.textContent ?? '');
}

/** Выбирает пункт поля «Свойство связи» по имени стороны (через живой поиск). */
async function choosePropertySide(formStack: ShimElement, label: string): Promise<void> {
  const input = propertyInput(formStack);
  input.focus();
  await settle();
  const row = propertySuggestList()
    .querySelectorAll('.type-combo-item')
    .find((r) => r.querySelectorAll('.type-combo-label')[0]?.textContent === label);
  assert.ok(row !== undefined, `в списке есть пункт «${label}»`);
  row!.click();
}

/**
 * Модификаторные Enter в диалоге добавления (задача fd3d84f4): прежние
 * локальные обработчики реагировали на `event.key === 'Enter'` НЕЗАВИСИМО от
 * модификаторов — поле добавляло строку (Ctrl+Enter применяло список), строка
 * кандидата выбирала кандидата (Shift+Enter — составное имя). После перевода
 * на диспетчер сочетаний эти нажатия восстановлены через `modifierChordVariants`.
 */
describe('add-dialog: модификаторные Enter поля и кандидатов (задача fd3d84f4)', () => {
  // Клавиатура строк кандидатов работает через `instanceof HTMLElement`
  // (проверка цели события) — даём шиму глобальный конструктор на время сьюта.
  beforeEach(() => {
    (globalThis as any).HTMLElement = ShimElement;
  });
  afterEach(() => {
    delete (globalThis as any).HTMLElement;
  });

  /** Хит дубля-кандидата в форме, которую читает диалог. */
  function hit(id: string, title: string, parentTitle: string | null = null): any {
    return {
      id,
      network_id: 'n1',
      title,
      synonyms: [],
      matched_on: 'title',
      type_id: null,
      icon: null,
      icon_kind: 'emoji',
      fg_color: null,
      bg_color: null,
      font_bold: null,
      font_italic: null,
      font_underline: null,
      font_strike: null,
      parent_title: parentTitle,
    };
  }

  it('Shift/Alt/Meta+Enter в поле добавляют строку, как прежде', async () => {
    const ui = await openDialog();
    checkRadio(ui.multiRadio, ui.singleRadio);
    ui.input.value = 'Раз';
    press(ui.input, key('Enter', { shiftKey: true }));
    ui.input.value = 'Два';
    press(ui.input, key('Enter', { altKey: true }));
    ui.input.value = 'Три';
    press(ui.input, key('Enter', { metaKey: true }));
    assert.deepEqual(
      ui.lineTitles(),
      ['Раз', 'Два', 'Три'],
      'каждый модификаторный Enter добавляет строку (прежде — любой Enter)',
    );
    ui.cancelBtn.click();
    assert.equal(await ui.promise, null);
  });

  it('Ctrl+Enter на строке кандидата выбирает кандидата', async () => {
    (globalThis as any).window.etn.thoughts.findDuplicates = async () => [
      hit('E1', 'Существующая', 'Родитель'),
    ];
    const ui = await openDialog();
    checkRadio(ui.multiRadio, ui.singleRadio);
    ui.input.value = 'Существующая';
    ui.input.emit('input');
    await settle();
    const candidatesEl = ui.formStack.querySelector('.add-candidates');
    assert.ok(candidatesEl !== null, 'контейнер кандидатов отрисован');
    const row = candidatesEl!.querySelectorAll('.type-combo-item')[0];
    assert.ok(row !== undefined, 'кандидат найден');
    // Ctrl+Enter на строке прежде ВЫБИРАЛ кандидата (не применял список).
    const ev = key('Enter', { ctrlKey: true });
    ev.target = row;
    press(candidatesEl!, ev);
    assert.deepEqual(
      ui.lineTitles(),
      ['Существующая'],
      'Ctrl+Enter на кандидате выбрал его (строка в списке выбранного)',
    );
    const state = await resolvesTo(ui.promise);
    assert.equal(state.settled, false, 'Ctrl+Enter выбрал кандидата, а не применил список');
    ui.cancelBtn.click();
    assert.equal(await ui.promise, null);
  });

  it('Shift+Enter на строке кандидата по-прежнему составляет составное имя', async () => {
    (globalThis as any).window.etn.thoughts.findDuplicates = async () => [hit('E2', 'Родитель')];
    const ui = await openDialog();
    checkRadio(ui.multiRadio, ui.singleRadio);
    ui.input.value = 'Род';
    ui.input.emit('input');
    await settle();
    const candidatesEl = ui.formStack.querySelector('.add-candidates')!;
    const row = candidatesEl.querySelectorAll('.type-combo-item')[0]!;
    const ev = key('Enter', { shiftKey: true });
    ev.target = row;
    press(candidatesEl, ev);
    assert.equal(ui.input.value, 'Родитель.', 'Shift+Enter подставил составное имя');
    assert.deepEqual(ui.lineTitles(), [], 'составное имя не выбирает кандидата');
    ui.cancelBtn.click();
    assert.equal(await ui.promise, null);
  });
});

describe('openAddDialog: поле «Свойство связи» (ошибка 1dd08949, доработка dc175a5b)', () => {
  const writes: any[][] = [];
  const creates: any[] = [];
  const batches: any[][] = [];

  /** Подменяет реестр и операции записи в фейковом `window.etn`. */
  function armEtn(): void {
    writes.length = 0;
    creates.length = 0;
    batches.length = 0;
    store.update({
      networkId: 'n1',
      linkTypes: [
        {
          id: LT_ID,
          name_forward: SIDE_FORWARD,
          name_reverse: SIDE_REVERSE,
          parent_id: null,
          is_root: false,
          color: null,
          style: null,
          width: null,
          description: null,
        } as any,
      ],
    });
    const etn = (globalThis as any).window.etn;
    etn.propertyRegistry = { list: async () => REGISTRY };
    etn.properties = {
      set: async (...args: any[]) => {
        writes.push(args);
      },
      remove: async () => undefined,
      get: async () => [],
    };
    etn.thoughts.create = async (_n: string, input: any) => {
      creates.push(input);
      return {
        id: 'new1',
        title: input.title,
        synonyms: input.synonyms ?? [],
        type_id: input.type_id ?? null,
        version: 1,
      };
    };
    etn.thoughts.batch = async (...args: any[]) => {
      batches.push(args);
      return { affected: 1, failures: [] };
    };
  }

  /** Открывает холстовый диалог добавления (путь карты) и ждёт его монтирования. */
  async function openCanvasDialog(): Promise<{
    done: Promise<unknown>;
    formStack: ShimElement;
    backdrop: ShimElement;
  }> {
    const mod = await loadDialog();
    const done = mod.openAddDialog({ anchorId: 'A', anchorTitle: 'Версия', direction: 'child' });
    await settle();
    const backdrop = openBackdrop();
    const box = backdrop.children[0];
    const formStack = box?.querySelectorAll('.form-stack')[0] ?? new ShimElement('div');
    return { done, formStack, backdrop };
  }

  it('поле — ввод с живым поиском; в списке имена сторон со значком и подписью', async () => {
    armEtn();
    const { done, formStack } = await openCanvasDialog();
    const input = propertyInput(formStack);
    assert.equal(input.tagName, 'input', 'никакой «открывашки»-select нет');
    assert.ok(
      propertyCombo(formStack).querySelector('.entity-combo-field') !== null,
      'поле «Свойство связи» — та же рамка общего комбо, что у поля «Тип мысли»',
    );
    input.focus();
    await settle();
    const list = propertySuggestList();
    assert.deepEqual(
      propertySuggestNames(list),
      ['без свойства', SIDE_REVERSE, SIDE_FORWARD],
      'в списке — «без свойства» и обе стороны свойства-связи (единый алфавит имён), скаляр не попал',
    );
    // Проверяемая структура пункта: значок направления + подпись стороны/пары.
    const rows = list.querySelectorAll('.type-combo-item');
    const sideRows = rows.filter((r) => r.querySelectorAll('.property-list-link-icon').length === 1);
    assert.equal(sideRows.length, 2, 'у каждого пункта-стороны — единый значок конца связи');
    const targetRow = rows[1]!;
    const sourceRow = rows[2]!;
    // Подписи пунктов — пара имён типа связи в скобках через « -> »; прежних
    // «источник/назначение · связь …» больше нет (ошибка 5817b009).
    assert.equal(sourceRow.querySelectorAll('.type-combo-note')[0]?.textContent, `(${SIDE_FORWARD} -> ${SIDE_REVERSE})`);
    assert.equal(targetRow.querySelectorAll('.type-combo-note')[0]?.textContent, `(${SIDE_FORWARD} -> ${SIDE_REVERSE})`);
    const sourceIcon = sourceRow.querySelectorAll('.property-list-link-icon')[0]!;
    const targetIcon = targetRow.querySelectorAll('.property-list-link-icon')[0]!;
    // Направление — вертикальное (задача 88def930): исходящая сторона вниз,
    // входящая вверх; проверяемо структурно (атрибут и точки шеврона), карта
    // и структуры кладут предков сверху, потомков снизу.
    assert.equal(sourceIcon.getAttribute('data-direction'), 'down', 'источник — стрелка вниз');
    assert.equal(targetIcon.getAttribute('data-direction'), 'up', 'назначение — стрелка вверх');
    assert.equal(sourceIcon.style.transform, undefined, 'зеркалирования значка больше нет');
    assert.equal(
      sourceIcon.children[1]?.getAttribute('points'),
      '4,9 9,14 14,9',
      'шеврон исходящей стороны смотрит вниз',
    );
    assert.equal(
      targetIcon.children[1]?.getAttribute('points'),
      '4,8 9,3 14,8',
      'шеврон входящей стороны смотрит вверх',
    );
    const labels = formStack.querySelectorAll('.ui-field-label').map((l) => l.textContent);
    assert.ok(labels.includes('Свойство связи'), 'есть метка «Свойство связи»');
    assert.equal(labels.includes('Тип связи'), false, 'метки «Тип связи» в диалоге карты нет');
    assert.ok(
      propertyCombo(formStack).querySelector('.entity-combo-pick') !== null,
      'у поля «Свойство связи» есть кнопка «…» — тот же паттерн, что у поля типа мысли (ошибка a7abe50e)',
    );
    pressEscape();
    await done;
  });

  it('ширина выпадашек диалога — 560px, однообразно у типа мысли и свойства связи (ошибка 5c7f8376)', async () => {
    armEtn();
    const mod = await loadDialog();
    const WIDTH = mod.ADD_DIALOG_DROPDOWN_MIN_WIDTH as number;
    assert.equal(WIDTH, 560, 'ширина выпадашек диалога — 560px');
    const { done, formStack } = await openCanvasDialog();

    const typeInput = formStack.querySelectorAll('.entity-combo-input')[0];
    assert.ok(typeInput !== undefined, 'поле «Тип мысли» есть в диалоге');
    typeInput!.focus();
    await settle();
    assert.equal(
      propertySuggestList().style.minWidth,
      `${WIDTH}px`,
      'список типа мысли — 560px',
    );
    typeInput!.blur();

    const propInput = propertyInput(formStack);
    propInput.focus();
    await settle();
    assert.equal(
      propertySuggestList().style.minWidth,
      `${WIDTH}px`,
      'список свойства связи — та же ширина 560px',
    );

    pressEscape();
    await done;
  });

  it('живой поиск сужает список до свойства (обе его стороны), скаляры не предлагаются', async () => {
    armEtn();
    const { done, formStack } = await openCanvasDialog();
    const input = propertyInput(formStack);
    input.focus();
    await settle();
    input.value = 'включает';
    input.emit('input');
    await settle();
    assert.deepEqual(
      propertySuggestNames(propertySuggestList()),
      [SIDE_REVERSE, SIDE_FORWARD],
      'по обратному имени нашлось свойство — обе его стороны (как поиск общего списка свойств)',
    );
    input.value = 'Скаляр';
    input.emit('input');
    await settle();
    const body = (globalThis as any).document.body as ShimElement;
    assert.equal(
      body.children.some((c) => c.className.split(/\s+/).includes('type-combo-list')),
      false,
      'скалярное свойство в поле не предлагается — вариантов нет, список закрыт',
    );
    pressEscape();
    await done;
  });

  it('выбор стороны-источника заполняет свойство новой мысли значением якоря', async () => {
    armEtn();
    const { done, formStack } = await openCanvasDialog();
    await choosePropertySide(formStack, SIDE_FORWARD);
    const input = formStack.querySelector('textarea')!;
    input.value = 'Задача';
    press(input, key('Enter'));
    await done;
    assert.deepEqual(
      writes,
      [['n1', 'thought', 'new1', SIDE_FORWARD, ['A']]],
      'свойство записано добавляемой мысли ключом-именем стороны со значением якоря',
    );
    assert.equal(batches.length, 0, 'бестиповая пакетная связь не создаётся — ребро даёт свойство');
    assert.equal(creates[0]?.create_link, undefined, 'новая мысль создана без create_link');
  });

  it('выбор стороны-назначения пишет обратное имя (ребро развернётся сервером)', async () => {
    armEtn();
    const { done, formStack } = await openCanvasDialog();
    await choosePropertySide(formStack, SIDE_REVERSE);
    const input = formStack.querySelector('textarea')!;
    input.value = 'Задача';
    press(input, key('Enter'));
    await done;
    assert.deepEqual(writes, [['n1', 'thought', 'new1', SIDE_REVERSE, ['A']]]);
  });

  it('без выбора свойства — прежняя бестиповая связь в направлении диалога', async () => {
    armEtn();
    const { done, formStack } = await openCanvasDialog();
    const input = formStack.querySelector('textarea')!;
    input.value = 'Задача';
    press(input, key('Enter'));
    await done;
    assert.equal(writes.length, 0, 'свойство не пишется');
    assert.deepEqual(
      creates[0]?.create_link,
      { direction: 'parent', target_thought_id: 'A', type_id: null },
      'бестиповая связь в направлении «вниз» (нетипизированное ребро)',
    );
  });

  it('выбор свойства для существующей мысли пишет свойство ей', async () => {
    armEtn();
    (globalThis as any).window.etn.thoughts.findDuplicates = async () => [
      {
        id: 'E1',
        title: 'Существующая',
        synonyms: [],
        matched_on: 'title',
        type_id: null,
        icon: null,
        icon_kind: 'emoji',
        fg_color: null,
        bg_color: null,
        font_bold: null,
        font_italic: null,
        font_underline: null,
        font_strike: null,
        parent_title: null,
      },
    ];
    const { done, formStack } = await openCanvasDialog();
    // Мультирежим + клик по найденному кандидату — существующая мысль в списке.
    const modeRow = formStack.children.find((c) => c.className === 'add-mode-row')!;
    const multiRadio = modeRow.children[1]!.children[0]!;
    multiRadio.checked = true;
    multiRadio.emit('change');
    await choosePropertySide(formStack, SIDE_FORWARD);
    const input = formStack.querySelector('textarea')!;
    input.value = 'Существующая';
    input.emit('input');
    await settle();
    const candidate = formStack.querySelectorAll('.type-combo-item')[0];
    assert.ok(candidate !== undefined, 'кандидат-существующая мысль найден');
    candidate!.emit('click');
    const primary = openBackdrop()
      .querySelectorAll('button')
      .find((b) => b.textContent === 'Добавить');
    assert.ok(primary !== undefined, 'кнопка «Добавить» есть в футере');
    primary!.click();
    await done;
    assert.deepEqual(
      writes,
      [['n1', 'thought', 'E1', SIDE_FORWARD, ['A']]],
      'свойство записано существующей мысли',
    );
    assert.equal(creates.length, 0, 'новая мысль не создаётся');
  });

  it('существующие значения свойства не теряются (набор объединяется)', async () => {
    armEtn();
    (globalThis as any).window.etn.thoughts.findDuplicates = async () => [
      {
        id: 'E1',
        title: 'Существующая',
        synonyms: [],
        matched_on: 'title',
        type_id: null,
        icon: null,
        icon_kind: 'emoji',
        fg_color: null,
        bg_color: null,
        font_bold: null,
        font_italic: null,
        font_underline: null,
        font_strike: null,
        parent_title: null,
      },
    ];
    // У мысли уже есть значение свойства p1 → цель X.
    (globalThis as any).window.etn.properties.get = async () => [
      {
        property_id: 'p1',
        property_name: SIDE_FORWARD,
        value_type: 'link',
        direction: 'out',
        values: [{ link_id: 'l1', target_id: 'X', target_title: 'X', target_type_id: null, comment: null }],
      },
    ];
    const { done, formStack } = await openCanvasDialog();
    const modeRow = formStack.children.find((c) => c.className === 'add-mode-row')!;
    modeRow.children[1]!.children[0]!.emit('change');
    await choosePropertySide(formStack, SIDE_FORWARD);
    const input = formStack.querySelector('textarea')!;
    input.value = 'Существующая';
    input.emit('input');
    await settle();
    formStack.querySelectorAll('.type-combo-item')[0]!.emit('click');
    openBackdrop()
      .querySelectorAll('button')
      .find((b) => b.textContent === 'Добавить')!
      .click();
    await done;
    assert.deepEqual(writes, [['n1', 'thought', 'E1', SIDE_FORWARD, ['X', 'A']]], 'якорь добавлен к существующему набору');
  });
});
