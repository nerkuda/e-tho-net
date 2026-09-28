/**
 * Unit tests of the panel-scroll handler of the markdown editor (ошибка
 * f4f99e3f). Раскладку в юнит-тестах не воспроизвести — здесь проверяется
 * логика обхода: поле растёт по содержимому, поэтому скроллером признаётся
 * только предок с непрозрачным `overflow` и реальным переполнением, а
 * растянутые `overflow: visible` flex-предки (`md-field`, `ui-comment__body`)
 * пропускаются и НЕ обрезают прямоугольник каретки.
 *
 * Полная проверка поведения — зондом на Chromium (грабли f2a047ee).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EditorView } from '@codemirror/view';

import { mdEditorInternals } from '../src/renderer/editor/md-editor.js';

interface FakeStyle {
  position: string;
  overflowY: string;
}

interface FakeNode {
  className: string;
  style: FakeStyle;
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  top: number;
  parentElement: FakeNode | null;
  getBoundingClientRect(): { top: number; bottom: number };
}

function node(
  className: string,
  opts: {
    overflowY: string;
    scrollHeight: number;
    clientHeight: number;
    top: number;
    parent?: FakeNode | null;
  },
): FakeNode {
  const n: FakeNode = {
    className,
    style: { position: 'static', overflowY: opts.overflowY },
    scrollHeight: opts.scrollHeight,
    clientHeight: opts.clientHeight,
    scrollTop: 0,
    top: opts.top,
    parentElement: opts.parent ?? null,
    getBoundingClientRect() {
      return { top: n.top, bottom: n.top + n.clientHeight };
    },
  };
  return n;
}

/** Fake view: the handler reads lineBlockAt, scrollDOM and its ancestors. */
function fakeView(scrollDOM: FakeNode, blockTop: number, blockBottom: number): EditorView {
  return {
    scrollDOM,
    lineBlockAt: () => ({ top: blockTop, bottom: blockBottom }),
  } as unknown as EditorView;
}

/** Runs the handler with a getComputedStyle stub, restoring it afterwards. */
function run(view: EditorView, head = 0): boolean {
  const prev = (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
  (globalThis as { getComputedStyle?: unknown }).getComputedStyle = (el: FakeNode) => el.style;
  try {
    return mdEditorInternals.scrollCaretIntoView(view, { head, assoc: -1 } as never, {
      yMargin: 5,
      xMargin: 5,
    });
  } finally {
    (globalThis as { getComputedStyle?: unknown }).getComputedStyle = prev;
  }
}

test('f4f99e3f: скроллит реальный скроллер панели, пропуская overflow:visible предков', () => {
  const comment = node('ui-comment', { overflowY: 'auto', scrollHeight: 2000, clientHeight: 600, top: 100 });
  const mdField = node('md-field', {
    overflowY: 'visible',
    scrollHeight: 2000,
    clientHeight: 600,
    top: 100,
    parent: comment,
  });
  const scroller = node('cm-scroller', {
    overflowY: 'auto',
    scrollHeight: 2000,
    clientHeight: 2000,
    top: 100,
    parent: mdField,
  });
  const view = fakeView(scroller, 1500, 1520);

  assert.equal(run(view), true);
  // Полная прокрутка до каретки: 1620 (низ каретки) − (700 − 5) = 925.
  // Наивная обрезка прямоугольника по боксу `.md-field` дала бы всего 5px —
  // это и был дефект.
  assert.equal(comment.scrollTop, 925);
  assert.equal(mdField.scrollTop, 0, 'overflow:visible предок не прокручивается');
});

test('f4f99e3f: каретка в видимой части — прокрутки нет', () => {
  const comment = node('ui-comment', { overflowY: 'auto', scrollHeight: 2000, clientHeight: 600, top: 100 });
  const scroller = node('cm-scroller', {
    overflowY: 'auto',
    scrollHeight: 2000,
    clientHeight: 2000,
    top: 100,
    parent: comment,
  });
  const view = fakeView(scroller, 200, 220);

  assert.equal(run(view), true);
  assert.equal(comment.scrollTop, 0);
});

test('f4f99e3f: перед первым скроллером — сам редактор (поле с высотой)', () => {
  const scroller = node('cm-scroller', { overflowY: 'auto', scrollHeight: 2000, clientHeight: 600, top: 100 });
  const view = fakeView(scroller, 1500, 1520);

  assert.equal(run(view), true);
  assert.equal(scroller.scrollTop, 925);
});

test('f4f99e3f: реального скроллера над полем нет — обработчик уступает CodeMirror', () => {
  const mdField = node('md-field', { overflowY: 'visible', scrollHeight: 2000, clientHeight: 600, top: 100 });
  const scroller = node('cm-scroller', {
    overflowY: 'auto',
    scrollHeight: 2000,
    clientHeight: 2000,
    top: 100,
    parent: mdField,
  });
  const view = fakeView(scroller, 1500, 1520);

  assert.equal(run(view), false);
  assert.equal(mdField.scrollTop, 0);
});
