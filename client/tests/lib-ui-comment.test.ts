/**
 * Юнит-тесты оболочки комментария `lib/ui/comment.ts` (задача 9cb87c42,
 * требование 24ca6770). DOM-shimmed, как соседние lib-ui-тесты: проверяются
 * структура каркаса, состояния загрузки/пустоты/ошибки и отражение режима
 * «просмотр / правка».
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Устанавливает шим DOM, достаточный для импорта `lib/ui/comment.ts`. */
function installShim(): void {
  (globalThis as any).HTMLElement = class {};
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
    body: new ShimElement('body'),
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

/** Рекурсивно ищет первый элемент с указанным классом. */
function findByClass(root: ShimElement, className: string): ShimElement | undefined {
  if (root.className.split(' ').includes(className)) return root;
  for (const child of root.children) {
    const hit = findByClass(child, className);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Текст элемента и потомков (шим-помощник `flatText`). */
function textOf(node: ShimElement): string {
  return node.flatText();
}

describe('оболочка комментария lib/ui/comment.ts', () => {
  it('собирает каркас и скрывает пустые панели', async () => {
    installShim();
    const { commentShell, COMMENT_CLASS, COMMENT_HEAD_CLASS } = await import(
      '../src/renderer/lib/ui/comment.js'
    );
    const shell = commentShell() as unknown as { root: ShimElement };
    const root = shell.root;
    assert.ok(root.className.split(' ').includes(COMMENT_CLASS));

    const head = findByClass(root, COMMENT_HEAD_CLASS) as unknown as ShimElement & { hidden: boolean };
    assert.equal(head.hidden, true, 'шапка без содержимого обязана быть скрыта');
  });

  it('показывает шапку с инструментами и зеркалит режим в data-mode', async () => {
    installShim();
    const { commentShell, COMMENT_HEAD_CLASS } = await import('../src/renderer/lib/ui/comment.js');
    const tools = new ShimElement('button');
    const shell = commentShell({
      tools: [tools as unknown as HTMLElement],
    }) as unknown as { root: ShimElement; setMode(mode: 'view' | 'edit'): void };

    const head = findByClass(shell.root, COMMENT_HEAD_CLASS) as unknown as ShimElement & { hidden: boolean };
    assert.equal(head.hidden, false, 'шапка с инструментами обязана быть видна');
    assert.equal(shell.root.dataset['mode'], 'view');
    shell.setMode('edit');
    assert.equal(shell.root.dataset['mode'], 'edit');
  });

  it('переключает состояния загрузки/пустоты/ошибки и возвращает поле', async () => {
    installShim();
    const { commentShell, COMMENT_BODY_CLASS } = await import('../src/renderer/lib/ui/comment.js');
    const field = new ShimElement('div');
    const shell = commentShell({
      field: field as unknown as HTMLElement,
      state: { kind: 'loading' },
    }) as unknown as {
      root: ShimElement;
      setState(state: unknown): void;
      setField(node: unknown): void;
    };

    const body = findByClass(shell.root, COMMENT_BODY_CLASS) as unknown as ShimElement;
    assert.ok(textOf(body).includes('Загрузка'), 'состояние загрузки показывает текст словаря');

    shell.setState({ kind: 'empty', text: 'Пусто' });
    assert.ok(textOf(body).includes('Пусто'));

    shell.setState({ kind: 'error', error: new Error('сбой') });
    assert.ok(findByClass(body, 'error-text') !== undefined, 'ошибка идёт строкой словаря');

    shell.setState({ kind: 'ready' });
    assert.ok(body.children.includes(field as unknown as ShimElement), 'готовое состояние показывает поле');
  });
});
