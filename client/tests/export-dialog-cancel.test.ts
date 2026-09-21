/**
 * Отмена в диалоге экспорта .etnx резолвит промис (ошибка e5ec74de «Диалог
 * экспорта .etnx не резолвит промис при закрытии Esc, × и кликом мимо», 0.8.2).
 *
 * Контракт `showExportEtnxDialog`: выбранные опции + путь при «Экспортировать»,
 * иначе `{ options: undefined, targetPath: undefined }`. Отмена — штатные пути
 * закрытия каркаса («Отмена», Esc, ×): завершение повешено на `onClose` (та же
 * правка, что 5c47601 / 4c7fc0f). Клик по подложке диалог НЕ закрывает и промис
 * не резолвит (задача c9353ce1) — отдельный кейс проверяет это.
 *
 * Дом — минимальный шим (конвенция `add-dialog.test.ts`).
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
  id = '';
  children: ShimElement[] = [];
  parent: ShimElement | null = null;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  textContent = '';
  innerHTML = '';
  value = '';
  valueAsNumber = 0;
  type = '';
  title = '';
  placeholder = '';
  spellcheck = false;
  readOnly = false;
  htmlFor = '';
  checked = false;
  min = '';
  max = '';
  step = '';
  disabled = false;
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
    this.children = [];
    this.append(...nodes);
  }

  remove(): void {
    if (this.parent === null) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
    // Снятие узла из DOM — путь закрытия диалога (`showDialog` вешает на него
    // событие `remove` и зовёт `onClose`); повторный `remove()` его не даёт.
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

  click(): void {
    this.emit('click');
  }

  focus(): void {
    /* no-op */
  }

  setAttribute(name: string, value: string): void {
    this.dataset[name] = value;
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

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };
  }

  scrollIntoView(): void {
    /* no-op */
  }
}

/** Слушатели `window` — каркас диалога вешает сюда Esc. */
const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];

function installShim(): { body: ShimElement } {
  windowListeners.length = 0;
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body,
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
  return { body };
}

/** Нажатие Esc — реальный путь каркаса. */
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

installShim();

const { showExportEtnxDialog, defaultExportName } = await import(
  '../src/renderer/import-export/export-dialog.js'
);

function body(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

function openBackdrop(): ShimElement {
  const backdrop = body().children.find((c) => c.className.split(/\s+/).includes('dialog-backdrop'));
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
  await new Promise((resolve) => setImmediate(resolve));
  return { value, settled };
}

const CANCELLED = { options: undefined, targetPath: undefined };

describe('showExportEtnxDialog: отмена любым путём закрытия (e5ec74de)', () => {
  it('Esc резолвит отмену и снимает диалог', async () => {
    const { body: b } = installShim();
    const done = showExportEtnxDialog(3);
    pressEscape();
    const { value, settled } = await resolvesTo(done);
    assert.equal(settled, true, 'промис завершён, а не висит');
    assert.deepEqual(value, CANCELLED, 'Esc — отмена');
    assert.equal(b.children.length, 0, 'диалог закрыт');
  });

  it('× в заголовке резолвит отмену', async () => {
    installShim();
    const done = showExportEtnxDialog(3);
    clickClose(openBackdrop());
    const { value } = await resolvesTo(done);
    assert.deepEqual(value, CANCELLED, '× — отмена');
  });

  it('клик по подложке НЕ закрывает диалог и не резолвит отмену', async () => {
    installShim();
    const done = showExportEtnxDialog(3);
    clickBackdrop(openBackdrop());
    const { settled } = await resolvesTo(done);
    assert.equal(settled, false, 'клик мимо не резолвит промис');
    assert.equal(body().children.length, 1, 'диалог остался открыт');
    footerButton(openBackdrop(), 'Отмена').click();
    const { value } = await resolvesTo(done);
    assert.deepEqual(value, CANCELLED, 'после клика мимо кнопка «Отмена» всё ещё закрывает');
  });

  it('«Отмена» резолвит отмену', async () => {
    installShim();
    const done = showExportEtnxDialog(3);
    footerButton(openBackdrop(), 'Отмена').click();
    const { value } = await resolvesTo(done);
    assert.deepEqual(value, CANCELLED, 'кнопка отмены');
  });

  it('«Экспортировать» отдаёт опции и путь и не переигрывается поздним onClose', async () => {
    installShim();
    const done = showExportEtnxDialog(3);
    footerButton(openBackdrop(), 'Экспортировать').click();
    const { value, settled } = await resolvesTo(done);
    assert.equal(settled, true, 'промис завершён');
    assert.deepEqual(value, {
      options: {
        include_types: true,
        include_attachments: true,
        include_chronology: true,
        include_subtree: false,
        subtree_depth: 1,
      },
      targetPath: defaultExportName(),
    });
  });
});
