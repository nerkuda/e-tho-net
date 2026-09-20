/**
 * Видимость ошибки записи на любой вкладке диалога (ошибка add8d09d
 * «Сообщения об ошибках диалогов с вкладками видны на любой вкладке», 0.8.2).
 *
 * Две группы проверок:
 *
 * 1. Каркас диалога (`lib/dialog.ts`) — опция `footerError` кладёт строку
 *    ошибки в панель кнопок (`.dialog-footer`), ВНЕ тела диалога
 *    (`.dialog-body`). Поскольку тело и есть то, что переключается вкладками,
 *    ошибка в футере видна при активной любой вкладке. Проверяется на
 *    реальном `showDialog` под минимальным DOM-шимом (jsdom в проекте нет —
 *    используется приём `renderer-editor-mount.test.ts`).
 *
 * 2. Структурные якоря вкладочных диалогов: строка ошибки записи не
 *    добавляется в панель вкладки и передаётся в `showDialog` опцией
 *    `footerError` (settings.ts хранит её в своём sticky-футере).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

// ---------------------------------------------------------------------------
// Минимальный DOM-шим (хватает пути showDialog)
// ---------------------------------------------------------------------------

class ShimElement {
  tagName: string;
  className = '';
  children: ShimElement[] = [];
  parent: ShimElement | null = null;
  textContent = '';
  innerHTML = '';
  type = '';
  title = '';
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  private readonly classes = new Set<string>();

  readonly classList = {
    add: (...names: string[]): void => {
      for (const name of names) {
        for (const c of name.split(/\s+/)) {
          if (c !== '') this.classes.add(c);
        }
      }
    },
    remove: (...names: string[]): void => {
      for (const name of names) this.classes.delete(name);
    },
    toggle: (name: string, force?: boolean): void => {
      if (force === true) this.classes.add(name);
      else if (force === false) this.classes.delete(name);
      else if (this.classes.has(name)) this.classes.delete(name);
      else this.classes.add(name);
    },
    contains: (name: string): boolean => this.classes.has(name),
  };

  constructor(tag: string, className?: string, text?: string) {
    this.tagName = tag;
    if (className !== undefined) this.className = className;
    if (text !== undefined) this.textContent = text;
  }

  append(...nodes: Array<ShimElement | string>): void {
    for (const node of nodes) {
      const el = typeof node === 'string' ? new ShimElement('#text', undefined, node) : node;
      el.parent = this;
      this.children.push(el);
    }
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  setAttribute(): void {}

  remove(): void {
    if (this.parent === null) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  /** Все потомки, у которых className содержит подстроку. */
  findAll(cls: string): ShimElement[] {
    const out: ShimElement[] = [];
    const walk = (node: ShimElement): void => {
      for (const child of node.children) {
        if (child.className.includes(cls)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  isDescendantOf(node: ShimElement): boolean {
    let cur = this.parent;
    while (cur !== null) {
      if (cur === node) return true;
      cur = cur.parent;
    }
    return false;
  }
}

function shimDom(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

/** Открывает диалог с вкладками-«пустышками» и возвращает его узлы. */
async function openTabbedDialog(useFooterError: boolean): Promise<{
  document: any;
  errorLine: ShimElement | null;
  close: () => void;
}> {
  const { showDialog } = await import('../src/renderer/lib/dialog.js');
  const doc = (globalThis as any).document;
  const errorLine = useFooterError ? new ShimElement('span', 'error-text') : null;

  // Тело диалога имитирует вкладочный: две панели, активна одна.
  const bodyEl = new ShimElement('div', 'form-stack');
  const paneA = new ShimElement('div', 'demo-tab-pane');
  const paneB = new ShimElement('div', 'demo-tab-pane');
  bodyEl.append(paneA, paneB);

  const close = showDialog({
    title: 'Диалог с вкладками',
    body: bodyEl as unknown as HTMLElement,
    ...(errorLine !== null ? { footerError: errorLine as unknown as HTMLElement } : {}),
    buttons: [
      { label: 'Отмена' },
      { label: 'Записать', keepOpen: true, onClick: () => undefined },
      { label: 'Применить и закрыть', primary: true, keepOpen: true, onClick: () => undefined },
    ],
  });

  return { document: doc, errorLine, close };
}

describe('каркас диалога: ошибка в панели кнопок (add8d09d)', () => {
  it('footerError попадает в .dialog-footer, а не в .dialog-body', async () => {
    shimDom();
    const { document: doc, errorLine, close } = await openTabbedDialog(true);
    const backdrop = doc.body.children[0] as ShimElement;
    const footers = backdrop.findAll('dialog-footer');
    assert.equal(footers.length, 1, 'в диалоге ровно один футер');

    assert.equal(errorLine?.parent, footers[0], 'строка ошибки лежит прямо в футере');

    const bodies = backdrop.findAll('dialog-body');
    assert.equal(bodies.length, 1, 'в диалоге ровно одно тело');
    assert.equal(
      errorLine?.isDescendantOf(bodies[0]!),
      false,
      'строка ошибки НЕ должна лежать в теле (его скрывает неактивная вкладка)',
    );

    // Ошибка видна при любой активной вкладке: она вне тела-переключателя.
    assert.equal(
      errorLine?.isDescendantOf(backdrop.findAll('demo-tab-pane')[0]!),
      false,
      'строка ошибки не привязана к панели конкретной вкладки',
    );

    assert.ok(footers[0]!.classList.contains('dialog-footer-with-error'));
    // Кнопки остаются в футере рядом со строкой ошибки.
    assert.equal(footers[0]!.children.length, 4, 'ошибка + три кнопки');
    close();
  });

  it('без footerError футер не содержит строки ошибки', async () => {
    shimDom();
    const { document: doc, close } = await openTabbedDialog(false);
    const backdrop = doc.body.children[0] as ShimElement;
    const footers = backdrop.findAll('dialog-footer');
    assert.equal(footers.length, 1);
    assert.equal(footers[0]!.findAll('error-text').length, 0);
    assert.equal(footers[0]!.classList.contains('dialog-footer-with-error'), false);
    close();
  });
});

// ---------------------------------------------------------------------------
// Структурные якоря вкладочных диалогов
// ---------------------------------------------------------------------------

function source(rel: string): string {
  return readFileSync(resolve(import.meta.dirname, '..', 'src', 'renderer', rel), 'utf8');
}

describe('вкладочные диалоги: строка ошибки в панели кнопок (add8d09d)', () => {
  it('type-manager: редактор типа передаёт footerError и не прячет errorLine в панель вкладки', () => {
    const src = source('screens/type-manager.ts');
    assert.ok(src.includes('footerError: errorLine'), 'редактор типа не передаёт footerError');
    assert.equal(
      src.includes('descriptionPane.append(errorLine)'),
      false,
      'errorLine не должна жить в панели вкладки «Описание»',
    );
  });

  it('attachments: диалог добавления передаёт footerError и не прячет errorLine в панель вкладки', () => {
    const src = source('editor/attachments.ts');
    assert.ok(src.includes('footerError: errorLine'), 'диалог вложения не передаёт footerError');
    const start = src.indexOf('const createPanel = div(');
    assert.ok(start > 0, 'не найдена панель вкладки «Создать новое»');
    const block = src.slice(start, src.indexOf(');', start));
    assert.equal(
      block.includes('errorLine'),
      false,
      'строка ошибки добавления не должна лежать в теле вкладки',
    );
  });

  it('settings: строка ошибки лежит в sticky-футере, а не в теле', () => {
    const src = source('screens/settings.ts');
    assert.equal(
      src.includes('body.append(nav, content, errorLine)'),
      false,
      'errorLine не должна добавляться в тело настроек',
    );
    const start = src.indexOf('footer.append(');
    assert.ok(start > 0, 'не найден футер настроек');
    const block = src.slice(start, src.indexOf(');', start));
    assert.ok(block.includes('errorLine'), 'строка ошибки должна лежать в футере настроек');
  });
});
