/**
 * Отмена в обёртках promptDialog / confirmDialog резолвит промис (ошибка
 * e0360076 «promptDialog и confirmDialog не резолвят промис при закрытии Esc
 * и ×», 0.8.2).
 *
 * Контракт обёрток `lib/dialog.ts`: `promptDialog` резолвится введённым текстом
 * либо `null` при отмене; `confirmDialog` — `true` при подтверждении либо
 * `false` при отказе. Отмена — ЛЮБОЙ штатный путь закрытия каркаса («Отмена»,
 * Esc, ×, клик по подложке): завершение повешено на `onClose`, а не на кнопки
 * футера (та же правка, что 5c47601 для пикера).
 *
 * Дом — минимальный шим (конвенция `dialog-entity-dedupe.test.ts`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

class ShimClassList {
  private owner: ShimElement | null = null;

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
  disabled = false;
  offsetWidth = 0;
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
      if (node.parent !== null) {
        const index = node.parent.children.indexOf(node);
        if (index >= 0) node.parent.children.splice(index, 1);
      }
      node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: ShimElement[]): void {
    this.children = [];
    this.append(...nodes);
  }

  remove(): void {
    if (this.parent !== null) {
      const index = this.parent.children.indexOf(this);
      if (index >= 0) this.parent.children.splice(index, 1);
      this.parent = null;
    }
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
    this.listeners.set(
      type,
      list.filter((fn) => fn !== listener),
    );
  }

  emit(type: string, event: any = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

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

  focus(): void {
    /* фокус-слой шиму не нужен */
  }

  select(): void {
    /* выделение шиму не нужно */
  }

  setAttribute(name: string, value: string): void {
    this.dataset[name] = value;
  }
}

const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];

function pressEscape(): void {
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
}

function installShim(): void {
  windowListeners.length = 0;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
  };
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
}

installShim();

const { confirmDialog, promptDialog } = await import('../src/renderer/lib/dialog.js');

function body(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

function openBackdrop(): ShimElement {
  const backdrop = body().children.find((c) => c.classList.contains('dialog-backdrop'));
  assert.ok(backdrop !== undefined, 'диалог смонтирован');
  return backdrop;
}

/** Кнопка футера по подписи. */
function footerButton(backdrop: ShimElement, label: string): ShimElement {
  const btn = backdrop
    .querySelectorAll('button')
    .find((b) => b.textContent === label);
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
  closeBtn!.emit('click');
}

async function resolvesTo<T>(promise: Promise<T>): Promise<{ value: T | undefined; settled: boolean }> {
  let value: T | undefined;
  let settled = false;
  void promise.then((v) => {
    value = v;
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { value, settled };
}

describe('promptDialog: отмена любым путём закрытия (e0360076)', () => {
  it('Esc резолвит null', async () => {
    installShim();
    const done = promptDialog('Вопрос', 'Поле');
    pressEscape();
    const { value, settled } = await resolvesTo(done);
    assert.equal(settled, true, 'промис завершён');
    assert.equal(value, null, 'Esc — отмена');
    assert.equal(body().children.length, 0, 'диалог закрыт');
  });

  it('× резолвит null', async () => {
    installShim();
    const done = promptDialog('Вопрос', 'Поле');
    clickClose(openBackdrop());
    const { value } = await resolvesTo(done);
    assert.equal(value, null, '× — отмена');
  });

  it('клик по подложке резолвит null', async () => {
    installShim();
    const done = promptDialog('Вопрос', 'Поле');
    clickBackdrop(openBackdrop());
    const { value } = await resolvesTo(done);
    assert.equal(value, null, 'клик мимо — отмена');
  });

  it('«OK» резолвит введённый текст', async () => {
    installShim();
    const done = promptDialog('Вопрос', 'Поле', 'старт');
    const backdrop = openBackdrop();
    const input = backdrop.querySelector('input');
    assert.ok(input !== null, 'в диалоге есть поле ввода');
    input!.value = 'итог';
    footerButton(backdrop, 'OK').emit('click');
    const { value } = await resolvesTo(done);
    assert.equal(value, 'итог', 'кнопка отдаёт введённый текст');
  });

  it('«Отмена» резолвит null', async () => {
    installShim();
    const done = promptDialog('Вопрос', 'Поле', 'старт');
    footerButton(openBackdrop(), 'Отмена').emit('click');
    const { value } = await resolvesTo(done);
    assert.equal(value, null, 'кнопка отмены — null');
  });
});

describe('confirmDialog: отмена любым путём закрытия (e0360076)', () => {
  it('Esc резолвит false', async () => {
    installShim();
    const done = confirmDialog('Вопрос', 'Текст');
    pressEscape();
    const { value } = await resolvesTo(done);
    assert.equal(value, false, 'Esc — отказ');
  });

  it('× резолвит false', async () => {
    installShim();
    const done = confirmDialog('Вопрос', 'Текст');
    clickClose(openBackdrop());
    const { value } = await resolvesTo(done);
    assert.equal(value, false, '× — отказ');
  });

  it('клик по подложке резолвит false', async () => {
    installShim();
    const done = confirmDialog('Вопрос', 'Текст');
    clickBackdrop(openBackdrop());
    const { value } = await resolvesTo(done);
    assert.equal(value, false, 'клик мимо — отказ');
  });

  it('«Подтвердить» резолвит true', async () => {
    installShim();
    const done = confirmDialog('Вопрос', 'Текст');
    footerButton(openBackdrop(), 'Подтвердить').emit('click');
    const { value } = await resolvesTo(done);
    assert.equal(value, true, 'подтверждение — true');
  });

  it('«Отмена» резолвит false', async () => {
    installShim();
    const done = confirmDialog('Вопрос', 'Текст', true);
    footerButton(openBackdrop(), 'Отмена').emit('click');
    const { value } = await resolvesTo(done);
    assert.equal(value, false, 'кнопка отмены — false');
  });
});
