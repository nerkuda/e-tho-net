/**
 * Клик по подложке закрывает диалог (ошибка cc28ee10 «Диалог не закрывается
 * кликом по подложке», 0.8.2).
 *
 * Что закрепляем (каркас `lib/dialog.ts`):
 *   1. Клик по затемнённой подложке мимо тела диалога закрывает ВЕРХНИЙ диалог
 *      стека — как Esc; диалог ниже остаётся.
 *   2. Клик по телу диалога (сам бокс и его содержимое) диалог не закрывает.
 *   3. Клик по подложке гасится (`preventDefault` + `stopPropagation`) и не
 *      проваливается на холст и панели, закрывающиеся кликом вне себя.
 *   4. Диалог с `closeOnBackdrop: false` кликом по подложке не закрывается
 *      (остальные пути — Esc, ×, кнопки — работают как прежде).
 *
 * Дом — минимальный шим (конвенция `dialog-entity-dedupe.test.ts`): поведение
 * каркаса наблюдаемо только с DOM, поэтому шим, а не якоря исходника.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** Элемент с класс-листом, привязанным к `className` (как в соседних тестах). */
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

/** Минимальный элемент, переживающий сборку и снятие диалога. */
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

  setAttribute(name: string, value: string): void {
    this.dataset[name] = value;
  }
}

/** Слушатели `window` (каркас вешает туда Esc) — для проверки пути Esc. */
const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];

/** Нажатие Esc — штатный путь каркаса (capture-слушатель `keydown`). */
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

const { closeDialog, showDialog } = await import('../src/renderer/lib/dialog.js');

function body(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

/** Открытые backdrop'и в DOM (порядок = порядок отрисовки). */
function backdrops(): ShimElement[] {
  return body().children.filter((child) => child.classList.contains('dialog-backdrop'));
}

/** Реальный клик по подложке: цель события — сама подложка. */
function clickBackdrop(backdrop: ShimElement): { defaultPrevented: boolean; propagated: boolean } {
  const result = { defaultPrevented: false, propagated: false };
  backdrop.emit('click', {
    target: backdrop,
    preventDefault: () => {
      result.defaultPrevented = true;
    },
    stopPropagation: () => {
      result.propagated = true;
    },
  });
  return result;
}

/** Клик по телу диалога: цель — сам бокс (содержимое), не подложка. */
function clickBox(backdrop: ShimElement): void {
  const box = backdrop.querySelector('.dialog-box');
  assert.ok(box !== null, 'в диалоге есть тело');
  backdrop.emit('click', { target: box, preventDefault: () => undefined, stopPropagation: () => undefined });
}

/** Открывает диалог и возвращает его backdrop. */
function openDialog(title: string, closeOnBackdrop?: false): ShimElement {
  const dialogBody = new ShimElement('div', 'dialog-body');
  showDialog({
    title,
    body: dialogBody as unknown as HTMLElement,
    ...(closeOnBackdrop === false ? { closeOnBackdrop: false } : {}),
  });
  return backdrops()[backdrops().length - 1]!;
}

describe('клик по подложке закрывает верхний диалог (cc28ee10)', () => {
  it('клик мимо тела диалога закрывает его', () => {
    installShim();
    const backdrop = openDialog('Диалог');
    assert.equal(backdrops().length, 1);
    clickBackdrop(backdrop);
    assert.equal(backdrops().length, 0, 'клик по подложке закрыл диалог');
  });

  it('закрывает только верхний диалог стека — нижний остаётся', () => {
    installShim();
    openDialog('Нижний');
    const top = openDialog('Верхний');
    assert.equal(backdrops().length, 2);
    clickBackdrop(top);
    const left = backdrops();
    assert.equal(left.length, 1, 'снят ровно один диалог');
    assert.equal(
      left[0]!.querySelector('.dialog-title')?.textContent,
      'Нижний',
      'остался нижний диалог',
    );
    closeDialog();
  });

  it('клик по подложке НЕ верхнего диалога ничего не закрывает', () => {
    installShim();
    const lower = openDialog('Нижний');
    openDialog('Верхний');
    clickBackdrop(lower);
    assert.equal(backdrops().length, 2, 'подложка нижнего диалога не закрывает стек');
    closeDialog();
    closeDialog();
  });

  it('клик по телу диалога не закрывает его', () => {
    installShim();
    const backdrop = openDialog('Диалог');
    clickBox(backdrop);
    assert.equal(backdrops().length, 1, 'клик по телу диалога — не отмена');
    closeDialog();
  });

  it('клик по подложке гасит событие — оно не проваливается на холст', () => {
    installShim();
    const backdrop = openDialog('Диалог');
    const seen = clickBackdrop(backdrop);
    assert.equal(seen.defaultPrevented, true, 'preventDefault помечает клик потреблённым');
    assert.equal(seen.propagated, true, 'stopPropagation не пускает клик к холсту/панелям');
  });

  it('closeOnBackdrop: false — клик по подложке не закрывает, Esc закрывает', () => {
    installShim();
    const backdrop = openDialog('Несмахиваемый', false);
    clickBackdrop(backdrop);
    assert.equal(backdrops().length, 1, 'диалог с флагом запрета остаётся открытым');
    pressEscape();
    assert.equal(backdrops().length, 0, 'Esc по-прежнему закрывает диалог');
  });
});
