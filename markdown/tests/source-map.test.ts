/**
 * Source-position mapping of the single renderer (задача ba68771d, ТП1):
 * rendered nodes carry `data-md-start`/`data-md-end` source offsets and the
 * DOM-caret resolver turns a click back into a `body_md` offset. Pure — no DOM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ELEMENT_NODE,
  MD_SOURCE_END_ATTR,
  MD_SOURCE_START_ATTR,
  TEXT_NODE,
  computeLineStarts,
  nearestSourceRange,
  parseSourceRange,
  renderMarkdown,
  sourceOffsetFromCaret,
  type SourceMapNode,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Minimal fake DOM (a real Element/Text structurally satisfies SourceMapNode)
// ---------------------------------------------------------------------------

/** Fake DOM element with attributes and children (parents wired in `element`). */
type FakeElement = SourceMapNode;

function element(attrs: Record<string, string>, kids: SourceMapNode[] = []): FakeElement {
  const node: Record<string, unknown> = {
    nodeType: ELEMENT_NODE,
    parentNode: null,
    get childNodes(): SourceMapNode[] {
      return kids;
    },
    get textContent(): string {
      return kids.map((k) => k.textContent ?? '').join('');
    },
    getAttribute(name: string): string | null {
      return attrs[name] ?? null;
    },
  };
  for (const kid of kids) {
    Object.defineProperty(kid, 'parentNode', { value: node, configurable: true, writable: true });
  }
  return node as unknown as FakeElement;
}

function textNode(data: string): SourceMapNode {
  return {
    nodeType: TEXT_NODE,
    textContent: data,
    parentNode: null,
    childNodes: [],
  };
}

// ---------------------------------------------------------------------------
// Default output is unchanged
// ---------------------------------------------------------------------------

test('без sourceMap вывод рендерера не меняется (нет data-md-атрибутов)', () => {
  const html = renderMarkdown('# Заголовок\n\nтекст с ==меткой==');
  assert.ok(!html.includes('data-md-start'), html);
  assert.ok(!html.includes('data-md-end'), html);
});

// ---------------------------------------------------------------------------
// Block constructions: heading, paragraph, list, quote, code
// ---------------------------------------------------------------------------

test('заголовок: data-md-start указывает на первый символ текста после «# »', () => {
  const src = '# Заголовок';
  const html = renderMarkdown(src, { sourceMap: true });
  const start = src.indexOf('Заголовок');
  assert.match(html, new RegExp(`<h1 data-md-start="${start}"`));
  assert.match(html, /data-md-end="\d+"/);
});

test('абзац: start — начало строки, end — начало следующей строки блока', () => {
  const src = 'первый абзац\n\nвторой абзац';
  const html = renderMarkdown(src, { sourceMap: true });
  // Первый абзац — одна строка: end совпадает с началом второй строки (13).
  assert.match(html, new RegExp(`<p data-md-start="0" data-md-end="${src.indexOf('\n') + 1}"`));
  assert.match(html, new RegExp(`<p data-md-start="${src.indexOf('второй')}"`));
});

test('маркированный список: пункт начинается с текста после «- »', () => {
  const src = '- раз\n- два';
  const html = renderMarkdown(src, { sourceMap: true });
  const first = src.indexOf('раз');
  assert.match(html, new RegExp(`<li data-md-start="${first}"`));
});

test('нумерованный список: пункт начинается после «N. »', () => {
  const src = '1. первый\n2. второй';
  const html = renderMarkdown(src, { sourceMap: true });
  assert.match(html, new RegExp(`<li data-md-start="${src.indexOf('первый')}"`));
});

test('цитата: текст абзаца внутри блока начинается после «> »', () => {
  const src = '> цитата';
  const html = renderMarkdown(src, { sourceMap: true });
  assert.match(html, new RegExp(`<p data-md-start="${src.indexOf('цитата')}"`));
});

test('fence: диапазон охватывает строки кода, а не ограждение', () => {
  const src = '```ts\nconst x = 1;\n```';
  const html = renderMarkdown(src, { sourceMap: true });
  const start = src.indexOf('const');
  const end = src.indexOf('```', 5);
  assert.ok(html.includes(`data-md-start="${start}"`), html);
  assert.ok(html.includes(`data-md-end="${end}"`), html);
});

// ---------------------------------------------------------------------------
// Новые конструкции ТП1
// ---------------------------------------------------------------------------

test('==метка== помечается диапазоном видимого текста', () => {
  const src = 'абзац с ==меткой== хвост';
  const html = renderMarkdown(src, { sourceMap: true });
  const start = src.indexOf('меткой');
  assert.match(html, new RegExp(`<mark ${MD_SOURCE_START_ATTR}="${start}" ${MD_SOURCE_END_ATTR}="${start + 'меткой'.length}"`), html);
});

test('<u>подч</u> помечается диапазоном видимого текста', () => {
  const src = 'абзац <u>подч</u> хвост';
  const html = renderMarkdown(src, { sourceMap: true });
  const start = src.indexOf('подч');
  assert.match(html, new RegExp(`<u ${MD_SOURCE_START_ATTR}="${start}" ${MD_SOURCE_END_ATTR}="${start + 'подч'.length}"`), html);
});

test('wiki-ссылка с алиасом помечается диапазоном алиаса', () => {
  const src = 'см. [[Мысль|алиас]] тут';
  const html = renderMarkdown(src, { sourceMap: true });
  const start = src.indexOf('алиас');
  assert.match(html, new RegExp(`data-md-start="${start}" data-md-end="${start + 'алиас'.length}"`), html);
});

test('wiki-ссылка без алиаса помечается диапазоном имени', () => {
  const src = 'см. [[Мысль]] тут';
  const html = renderMarkdown(src, { sourceMap: true });
  const start = src.indexOf('Мысль');
  assert.match(html, new RegExp(`data-md-start="${start}" data-md-end="${start + 'Мысль'.length}"`), html);
});

test('wiki-ссылка [[#id]] без алиаса: рендер не падает и диапазон не ставится', () => {
  const id = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
  const src = `см. [[#${id}]] тут`;
  const html = renderMarkdown(src, { sourceMap: true });
  assert.match(html, /class="wiki-link"/, html);
  assert.ok(!/wiki-link[^>]*data-md-start/.test(html), html);
});

test('wiki-ссылка [[#id|алиас]] помечается диапазоном алиаса', () => {
  const id = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
  const src = `см. [[#${id}|алиас]] тут`;
  const html = renderMarkdown(src, { sourceMap: true });
  const start = src.indexOf('алиас');
  assert.ok(html.includes(`data-md-start="${start}"`), html);
});

test('task-список: текст пункта начинается после «- [ ] »', () => {
  const src = '- [ ] задача раз';
  const html = renderMarkdown(src, { sourceMap: true });
  const start = src.indexOf('задача');
  assert.match(html, new RegExp(`<li data-md-start="${start}"`), html);
});

test('HTML-комментарий скрыт, но сдвигает смещения следующих блоков', () => {
  const src = '<!-- скрыто -->\n\nпосле коммент';
  const html = renderMarkdown(src, { sourceMap: true });
  assert.ok(!html.includes('скрыто'), html);
  assert.ok(!html.includes('<!--'), html);
  const start = src.indexOf('после');
  assert.match(html, new RegExp(`<p data-md-start="${start}"`));
});

test('== и <u> внутри label ссылки не роняют рендер и получают диапазоны', () => {
  const src = '[==a==](http://e.com) и [<u>x</u>](http://e.com)';
  let html = '';
  assert.doesNotThrow(() => {
    html = renderMarkdown(src, { sourceMap: true });
  });
  assert.ok(html.includes(`data-md-start="${src.indexOf('a==')}"`), html);
  assert.ok(html.includes(`data-md-start="${src.indexOf('x</u>')}"`), html);
});

// ---------------------------------------------------------------------------
// Resolver: DOM caret → source offset
// ---------------------------------------------------------------------------

test('sourceOffsetFromCaret: ближайший аннотированный предок + смещение внутри', () => {
  const p = element({ [MD_SOURCE_START_ATTR]: '100', [MD_SOURCE_END_ATTR]: '120' }, [
    textNode('привет '),
    element({ [MD_SOURCE_START_ATTR]: '107', [MD_SOURCE_END_ATTR]: '111' }, [textNode('мир')]),
    textNode(' конец'),
  ]);
  const inner = p.childNodes[1] as FakeElement;
  const innerText = inner.childNodes[0]!;

  // Клик по 'и' в «мир»: ближайший аннотированный — сам <mark>-подобный узел.
  assert.equal(sourceOffsetFromCaret(innerText, 1), 108);
  // Клик по 'к' в «привет»: предок — абзац, смещение внутри абзаца.
  assert.equal(sourceOffsetFromCaret(p.childNodes[0]!, 5), 105);
  // Клик по 'о' в «конец»: предок — абзац, учитываются предыдущие сиблинги.
  assert.equal(sourceOffsetFromCaret(p.childNodes[2]!, 1), 100 + 'привет '.length + 'мир'.length + 1);
});

test('sourceOffsetFromCaret: клик по элементу (не тексту) даёт start диапазона', () => {
  const node = element({ [MD_SOURCE_START_ATTR]: '40', [MD_SOURCE_END_ATTR]: '50' }, [textNode('x')]);
  assert.equal(sourceOffsetFromCaret(node, 0), 40);
});

test('sourceOffsetFromCaret: результат зажимается в диапазон и null без разметки', () => {
  const node = element({ [MD_SOURCE_START_ATTR]: '10', [MD_SOURCE_END_ATTR]: '12' }, [
    textNode('длинный текст'),
  ]);
  assert.equal(sourceOffsetFromCaret(node.childNodes[0]!, 999), 12);
  assert.equal(sourceOffsetFromCaret(textNode('без разметки'), 0), null);
  assert.equal(sourceOffsetFromCaret(null, 0), null);
});

test('nearestSourceRange поднимается к ближайшему предку с диапазоном', () => {
  const outer = element({ [MD_SOURCE_START_ATTR]: '0', [MD_SOURCE_END_ATTR]: '99' }, [
    element({ [MD_SOURCE_START_ATTR]: '5', [MD_SOURCE_END_ATTR]: '9' }, [textNode('внутри')]),
  ]);
  const inner = outer.childNodes[0] as FakeElement;
  const found = nearestSourceRange(inner.childNodes[0]!);
  assert.equal(found?.range.start, 5);
  assert.equal(found?.range.end, 9);
});

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------

test('parseSourceRange: валидные значения и отказ на мусоре', () => {
  assert.deepEqual(parseSourceRange('5', '9'), { start: 5, end: 9 });
  assert.equal(parseSourceRange(null, '9'), null);
  assert.equal(parseSourceRange('5', null), null);
  assert.equal(parseSourceRange('9', '5'), null);
  assert.equal(parseSourceRange('x', '9'), null);
});

test('computeLineStarts: смещения начал строк', () => {
  assert.deepEqual(computeLineStarts('ab\ncd\n'), [0, 3, 6]);
  assert.deepEqual(computeLineStarts(''), [0]);
});

test('смещения считаются в исходной строке с CRLF', () => {
  const src = 'первый\r\n\r\n# Заголовок';
  const html = renderMarkdown(src, { sourceMap: true });
  const start = src.indexOf('Заголовок');
  assert.match(html, new RegExp(`data-md-start="${start}"`), html);
});
