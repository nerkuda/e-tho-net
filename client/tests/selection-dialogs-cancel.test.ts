/**
 * Отмена в диалогах выбора типа связи/мысли резолвит промис (ошибка a68bacff
 * «Диалоги выбора типа связи/мысли (selection/dialogs.ts) не резолвят промис
 * при закрытии каркаса», 0.8.2).
 *
 * Контракт функций `selection/dialogs.ts`: `pickLinkType` / `pickThoughtType`
 * резолвятся выбранным id, `null` — «без типа», `undefined` — отмена. Отмена —
 * ЛЮБОЙ штатный путь закрытия каркаса («Отмена», Esc, ×, клик по подложке):
 * завершение повешено на `onClose`, а не на кнопки футера (та же правка, что
 * 5c47601 для пикера и 4c7fc0f для обёрток).
 *
 * Дом — минимальный шим (конвенция `entity-picker.test.ts`, чьё встроенное
 * комбо `buildEntityCombo` эти диалоги и используют).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pickLinkType, pickThoughtType } from '../src/renderer/selection/dialogs.js';
import { store } from '../src/renderer/state.js';

class ShimClassList {
  private tokens = new Set<string>();
  add(...names: string[]): void {
    names.forEach((n) => this.tokens.add(n));
  }
  remove(...names: string[]): void {
    names.forEach((n) => this.tokens.delete(n));
  }
  contains(name: string): boolean {
    return this.tokens.has(name);
  }
  toggle(name: string, force?: boolean): void {
    const next = force ?? !this.tokens.has(name);
    if (next) this.tokens.add(name);
    else this.tokens.delete(name);
  }
}

class ShimElement {
  tagName: string;
  children: ShimElement[] = [];
  parent: ShimElement | null = null;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  innerHTML = '';
  tabIndex = -1;
  textContent = '';
  value = '';
  title = '';
  type = '';
  placeholder = '';
  spellcheck = false;
  inputMode = '';
  disabled = false;
  isConnected = true;
  classList = new ShimClassList();
  private _className = '';
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Array<(event: any) => void>>();

  constructor(tag: string, className?: string, text?: string) {
    this.tagName = tag;
    if (className !== undefined) this.className = className;
    if (text !== undefined) this.textContent = text;
  }

  get className(): string {
    return this._className;
  }
  set className(value: string) {
    this._className = value;
    this.classList = new ShimClassList();
    for (const token of value.split(/\s+/)) if (token !== '') this.classList.add(token);
  }

  get firstChild(): ShimElement | null {
    return this.children[0] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  append(...nodes: Array<ShimElement | string>): void {
    for (const node of nodes) {
      const el = typeof node === 'string' ? new ShimElement('#text', undefined, node) : node;
      el.parent = this;
      this.children.push(el);
    }
  }
  removeChild(node: ShimElement): void {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parent = null;
  }
  remove(): void {
    // Снятие узла из DOM — путь закрытия диалога (`showDialog` вешает на него
    // событие `remove`, по которому снимает слушатели клавиш и зовёт `onClose`).
    // Шим повторяет контракт: узел без родителя не снимается и события не даёт,
    // поэтому повторный `remove()` не переигрывает `onClose`.
    if (this.parent === null) return;
    this.parent.removeChild(this);
    this.emit('remove');
  }
  replaceChildren(...nodes: ShimElement[]): void {
    this.children = [];
    this.append(...nodes);
  }
  contains(node: ShimElement | null): boolean {
    if (node === null) return false;
    return node === this || this.children.some((child) => child.contains(node));
  }
  focus(): void {
    this.emit('focus');
  }
  addEventListener(type: string, listener: (event: any) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, listener: (event: any) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((fn) => fn !== listener),
    );
  }
  emit(type: string, event: any = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
  click(): void {
    this.emit('click');
  }
  /** Простой тег/класс-селектор (его использует `focusCombo` диалогов). */
  querySelectorAll(selector: string): ShimElement[] {
    const byTag = !selector.startsWith('.');
    const token = byTag ? selector : selector.slice(1);
    const hits: ShimElement[] = [];
    const walk = (node: ShimElement): void => {
      const match = byTag ? node.tagName === token : node.classList.contains(token);
      if (match) hits.push(node);
      node.children.forEach(walk);
    };
    this.children.forEach(walk);
    return hits;
  }
  querySelector(selector: string): ShimElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  getBoundingClientRect(): {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  } {
    return { left: 10, top: 10, right: 210, bottom: 34, width: 200, height: 24 };
  }
  scrollIntoView(): void {
    /* без движка раскладки не нужен */
  }
}

function installShim(): { body: ShimElement; pressEscape: () => void } {
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body,
  };
  /** Слушатели `window` — каркас диалога вешает сюда Esc и Ctrl+Enter. */
  const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type: string, listener: (event: any) => void) => {
      windowListeners.push({ type, listener });
    },
    removeEventListener: (type: string, listener: (event: any) => void) => {
      const index = windowListeners.findIndex((l) => l.type === type && l.listener === listener);
      if (index >= 0) windowListeners.splice(index, 1);
    },
  };
  /** Нажатие Esc — реальный путь каркаса: его `keydown`-слушатель закрывает диалог. */
  const pressEscape = (): void => {
    const event = {
      key: 'Escape',
      repeat: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false,
      preventDefault: () => {
        event.defaultPrevented = true;
      },
    };
    for (const { type, listener } of [...windowListeners]) {
      if (type === 'keydown') listener(event);
    }
  };
  return { body, pressEscape };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Рекурсивный поиск элементов по классу (тело диалога вложено под backdrop). */
function findAllByClass(root: ShimElement, cls: string): ShimElement[] {
  const out: ShimElement[] = [];
  if (root.classList.contains(cls)) out.push(root);
  for (const child of root.children) out.push(...findAllByClass(child, cls));
  return out;
}

/** Подложка единственного открытого диалога. */
function openBackdrop(body: ShimElement): ShimElement {
  const backdrop = body.children.find((c) => c.classList.contains('dialog-backdrop'));
  assert.ok(backdrop !== undefined, 'диалог смонтирован');
  return backdrop!;
}

/** Кнопка футера по подписи. */
function footerButton(backdrop: ShimElement, label: string): ShimElement {
  const btn = findAllByClass(backdrop, 'dialog-btn').find((b) => b.textContent === label);
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
  const closeBtn = findAllByClass(backdrop, 'dialog-close')[0];
  assert.ok(closeBtn !== undefined, 'в заголовке есть ×');
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
  await flush();
  return { value, settled };
}

/** Общий фон для обоих диалогов: сеть активна. */
function prepare(): void {
  store.update({ networkId: 'n1' });
}

describe('pickLinkType: отмена любым путём закрытия (a68bacff)', () => {
  it('Esc резолвит undefined и снимает диалог', async () => {
    const { body, pressEscape } = installShim();
    prepare();
    const done = pickLinkType('Тип связи');
    pressEscape();
    const { value, settled } = await resolvesTo(done);
    assert.equal(settled, true, 'промис завершён, а не висит');
    assert.equal(value, undefined, 'Esc — отмена');
    assert.equal(findAllByClass(body, 'dialog-backdrop').length, 0, 'диалог закрыт');
  });

  it('× в заголовке резолвит undefined', async () => {
    const { body } = installShim();
    prepare();
    const done = pickLinkType('Тип связи');
    clickClose(openBackdrop(body));
    const { value } = await resolvesTo(done);
    assert.equal(value, undefined, '× — отмена');
  });

  it('клик по подложке резолвит undefined', async () => {
    const { body } = installShim();
    prepare();
    const done = pickLinkType('Тип связи');
    clickBackdrop(openBackdrop(body));
    const { value } = await resolvesTo(done);
    assert.equal(value, undefined, 'клик мимо — отмена');
  });

  it('«Отмена» резолвит undefined', async () => {
    const { body } = installShim();
    prepare();
    const done = pickLinkType('Тип связи');
    footerButton(openBackdrop(body), 'Отмена').click();
    const { value } = await resolvesTo(done);
    assert.equal(value, undefined, 'кнопка отмены — undefined');
  });

  it('«OK» отдаёт значение поля и не переигрывается поздним onClose', async () => {
    const { body } = installShim();
    prepare();
    store.update({ lastUsedLinkTypeId: null });
    const done = pickLinkType('Тип связи');
    footerButton(openBackdrop(body), 'OK').click();
    const { value, settled } = await resolvesTo(done);
    assert.equal(settled, true, 'промис завершён');
    assert.equal(value, null, 'основной путь отдал значение поля («без типа»), а не undefined');
    assert.equal(findAllByClass(body, 'dialog-backdrop').length, 0, 'диалог закрыт');
  });
});

describe('pickThoughtType: отмена любым путём закрытия (a68bacff)', () => {
  it('Esc резолвит undefined', async () => {
    const { body, pressEscape } = installShim();
    prepare();
    const done = pickThoughtType('a');
    pressEscape();
    const { value } = await resolvesTo(done);
    assert.equal(value, undefined, 'Esc — отмена');
    assert.equal(findAllByClass(body, 'dialog-backdrop').length, 0, 'диалог закрыт');
  });

  it('× в заголовке резолвит undefined', async () => {
    const { body } = installShim();
    prepare();
    const done = pickThoughtType('a');
    clickClose(openBackdrop(body));
    const { value } = await resolvesTo(done);
    assert.equal(value, undefined, '× — отмена');
  });

  it('клик по подложке резолвит undefined', async () => {
    const { body } = installShim();
    prepare();
    const done = pickThoughtType('a');
    clickBackdrop(openBackdrop(body));
    const { value } = await resolvesTo(done);
    assert.equal(value, undefined, 'клик мимо — отмена');
  });

  it('«Отмена» резолвит undefined', async () => {
    const { body } = installShim();
    prepare();
    const done = pickThoughtType('a');
    footerButton(openBackdrop(body), 'Отмена').click();
    const { value } = await resolvesTo(done);
    assert.equal(value, undefined, 'кнопка отмены — undefined');
  });

  it('«OK» отдаёт значение поля и не переигрывается поздним onClose', async () => {
    const { body } = installShim();
    prepare();
    const done = pickThoughtType('a');
    footerButton(openBackdrop(body), 'OK').click();
    const { value, settled } = await resolvesTo(done);
    assert.equal(settled, true, 'промис завершён');
    assert.equal(value, 'a', 'основной путь отдал выбранный тип, а не undefined');
    assert.equal(findAllByClass(body, 'dialog-backdrop').length, 0, 'диалог закрыт');
  });
});
