/**
 * Юнит-тесты маппинга выделения просмотра в диапазон исходника markdown
 * (0.12.1, задача 189da39e; требование bac754e4, ADR ee4e721b).
 *
 * Проверяются контракты `sourceRangeFromSelection` из `editor/markdown-field.ts`:
 *  - для размеченного рендера (`@etn/markdown` с `sourceMap`) выделение DOM
 *    переводится в смещения исходника (лист — 1:1 внутри, блок — от якоря
 *    `data-md-after`);
 *  - узлы вне размеченного рендера дают `null` — поле откатывается к
 *    каретке в конец (старое поведение);
 *  - `null`-узлы (выделение потеряно) тоже дают `null`.
 *
 * DOM-shim, как в соседних тестах поля (`clipboard-system.test.ts`):
 * `markdown-field.ts` тянет граф модулей рендерера, читающий `window`/
 * `document` при импорте. Дерево рендера строится вручную — резолвер
 * `sourceOffsetFromCaret` структурный и раскладку не требует.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MD_SOURCE_AFTER_ATTR,
  MD_SOURCE_END_ATTR,
  MD_SOURCE_LEAF_ATTR,
  MD_SOURCE_START_ATTR,
} from '@etn/markdown';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Минимальный `document`/`window` шим — до первого импорта поля. */
function shimDom(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body: new ShimElement('body'),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

shimDom();
const { sourceRangeFromSelection } = await import('../src/renderer/editor/markdown-field.js');

/** Текстовый узел структурной модели резолвера. */
function textNode(value: string): any {
  return { nodeType: 3, textContent: value, parentNode: null, childNodes: null };
}

/** Элемент с `data-md-*` атрибутами; `children` прописывает `parentNode`. */
function element(attrs: Record<string, string>, children: any[]): any {
  const node: any = {
    nodeType: 1,
    getAttribute: (name: string) => attrs[name] ?? null,
    parentNode: null,
    childNodes: children,
    get textContent(): string {
      return children.map((c) => c.textContent ?? '').join('');
    },
  };
  for (const child of children) child.parentNode = node;
  return node;
}

/**
 * Дерево рендера фрагмента `абзац с ==меткой== хвост`:
 * блок `<p data-md-start=0 data-md-end=25>`, лист `<mark>` над «меткой».
 */
function annotatedParagraph(): { root: any; paragraph: any; mark: any; tail: any } {
  const lead = textNode('абзац с ');
  const mark = element(
    {
      [MD_SOURCE_START_ATTR]: '10',
      [MD_SOURCE_END_ATTR]: '16',
      [MD_SOURCE_LEAF_ATTR]: '1',
      [MD_SOURCE_AFTER_ATTR]: '18',
    },
    [textNode('меткой')],
  );
  const space = textNode(' ');
  const tail = textNode('хвост');
  const paragraph = element(
    { [MD_SOURCE_START_ATTR]: '0', [MD_SOURCE_END_ATTR]: '25' },
    [lead, mark, space, tail],
  );
  const root = element({}, [paragraph]);
  return { root, paragraph, mark, tail };
}

describe('маппинг выделения просмотра в исходник (189da39e)', () => {
  it('клик внутри листа даёт смещение start + символов до каретки', () => {
    const { mark } = annotatedParagraph();
    const range = sourceRangeFromSelection(
      { node: mark.childNodes[0], offset: 2 },
      { node: mark.childNodes[0], offset: 6 },
    );
    assert.deepEqual(range, { anchor: 12, head: 16 });
  });

  it('клик на уровне блока отсчитывается от предыдущего data-md-after', () => {
    const { tail } = annotatedParagraph();
    // «хвост» — после ' ' (15-й отрисованный символ), якорь mark.after=18.
    const range = sourceRangeFromSelection(
      { node: tail, offset: 0 },
      { node: tail, offset: 5 },
    );
    assert.deepEqual(range, { anchor: 19, head: 24 });
  });

  it('узлы вне размеченного рендера дают null (откат к каретке в конец)', () => {
    const plain = element({}, [textNode('обычный html')]);
    assert.equal(
      sourceRangeFromSelection(
        { node: plain.childNodes[0], offset: 0 },
        { node: plain.childNodes[0], offset: 3 },
      ),
      null,
    );
  });

  it('потерянное выделение (null-узлы) даёт null', () => {
    assert.equal(
      sourceRangeFromSelection({ node: null, offset: 0 }, { node: null, offset: 0 }),
      null,
    );
  });
});
