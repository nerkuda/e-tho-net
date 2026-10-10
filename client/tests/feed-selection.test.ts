/**
 * Резолвер позиции источника для ленты публикаций (задача 59774016):
 * DOM-выделение двойного клика переводится в диапазон `body_md` общим
 * `sourceOffsetFromCaret`. Проверяем главное требование — при повторе слова
 * позиция попадает ИМЕННО во вхождение под кликом, а не в первое.
 *
 * Дом подменяется минимальным структурным видом узлов (реальный DOM
 * удовлетворяет тому же интерфейсу), поэтому DOM-окружение не требуется.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ELEMENT_NODE, TEXT_NODE, type SourceMapNode } from '@etn/markdown';

import {
  feedSelectionFromDom,
  type DomSelectionLike,
} from '../src/renderer/screens/publications/feed-selection.js';

/** Fake text node. */
function textNode(data: string): SourceMapNode {
  return {
    nodeType: TEXT_NODE,
    textContent: data,
    parentNode: null,
    childNodes: [],
  } as unknown as SourceMapNode;
}

/** Fake annotated block element wrapping one text node. */
function block(
  start: number,
  end: number,
  text: string,
): { el: SourceMapNode; text: SourceMapNode } {
  const child = textNode(text);
  const node = {
    nodeType: ELEMENT_NODE,
    parentNode: null,
    get childNodes(): SourceMapNode[] {
      return [child];
    },
    get textContent(): string {
      return text;
    },
    getAttribute(name: string): string | null {
      if (name === 'data-md-start') return String(start);
      if (name === 'data-md-end') return String(end);
      return null;
    },
  } as unknown as SourceMapNode;
  Object.defineProperty(child, 'parentNode', { value: node, configurable: true, writable: true });
  return { el: node, text: child };
}

/** Selection anchored to a caret range inside a TEXT node (as a real DOM does). */
function selection(
  node: SourceMapNode,
  from: number,
  to: number,
): DomSelectionLike {
  return {
    isCollapsed: from === to,
    rangeCount: 1,
    anchorNode: node,
    anchorOffset: from,
    focusNode: node,
    focusOffset: to,
  };
}

test('повтор слова: выделение второго вхождения даёт его позицию, а не первого', () => {
  const body = 'aaa bbb aaa ccc';
  const second = body.lastIndexOf('aaa');
  const { text } = block(0, body.length, body);
  const result = feedSelectionFromDom(selection(text, second, second + 3));
  assert.deepEqual(result, { anchor: second, head: second + 3 });
  assert.notEqual(result?.anchor, 0);
});

test('выделение в первом вхождении резолвится в начало', () => {
  const body = 'aaa bbb aaa ccc';
  const { text } = block(0, body.length, body);
  assert.deepEqual(feedSelectionFromDom(selection(text, 0, 3)), { anchor: 0, head: 3 });
});

test('смещение блока учитывается: позиция внутри последующих абзацев не сбивается', () => {
  const body = 'первый\n\nвторой абзац';
  const start = body.indexOf('второй');
  const { text } = block(start, body.length, 'второй абзац');
  const result = feedSelectionFromDom(selection(text, 0, 'второй абзац'.length));
  assert.deepEqual(result, { anchor: start, head: body.length });
});

test('концы выделения нормализуются (anchor <= head)', () => {
  const body = 'aaa bbb aaa ccc';
  const { text } = block(0, body.length, body);
  assert.deepEqual(feedSelectionFromDom(selection(text, 8, 0)), { anchor: 0, head: 8 });
});

test('без разметки позиций или без выделения резолвер возвращает null', () => {
  const plain = textNode('aaa bbb');
  assert.equal(feedSelectionFromDom(selection(plain, 0, 3)), null);
  const { text } = block(0, 7, 'aaa bbb');
  assert.equal(feedSelectionFromDom(selection(text, 3, 3)), null);
  assert.equal(feedSelectionFromDom(null), null);
  assert.equal(feedSelectionFromDom({ ...selection(text, 0, 3), rangeCount: 0 }), null);
});
