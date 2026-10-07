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
  MD_SOURCE_LEAF_ATTR,
  MD_SOURCE_SHIFT_ATTR,
  MD_SOURCE_START_ATTR,
  TEXT_NODE,
  computeLineStarts,
  nearestSourceRange,
  parseSourceRange,
  renderMarkdown,
  renderPublicationFragment,
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
// Tiny HTML parser: builds a real-structure DOM out of the rendered HTML, so
// the resolver is exercised against genuine nesting, text nodes and attributes
// (synthetic nodes with matching lengths hid the resolver drift).
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set(['br', 'input', 'img', 'hr', 'meta', 'link']);

interface ParsedNode extends SourceMapNode {
  readonly children: ParsedNode[];
}

function mkEl(attrs: Record<string, string>): ParsedNode {
  const kids: ParsedNode[] = [];
  return {
    nodeType: ELEMENT_NODE,
    parentNode: null,
    get childNodes(): ParsedNode[] {
      return kids;
    },
    get textContent(): string {
      return kids.map((k) => k.textContent ?? '').join('');
    },
    getAttribute(name: string): string | null {
      return attrs[name] ?? null;
    },
    get children(): ParsedNode[] {
      return kids;
    },
  };
}

/**
 * Decodes the five entities {@link escapeHtml} emits, so the fake DOM's
 * `textContent` matches a real browser's (which decodes character references).
 */
function decodeEntities(data: string): string {
  return data
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function mkText(data: string): ParsedNode {
  return {
    nodeType: TEXT_NODE,
    textContent: decodeEntities(data),
    parentNode: null,
    childNodes: [],
  } as unknown as ParsedNode;
}

function parseHtml(html: string): ParsedNode {
  const root = mkEl({});
  const stack: ParsedNode[] = [root];
  const push = (node: ParsedNode): void => {
    const parent = stack[stack.length - 1]!;
    (parent.children as ParsedNode[]).push(node);
    Object.defineProperty(node, 'parentNode', { value: parent, configurable: true, writable: true });
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      if (i < html.length) push(mkText(html.slice(i)));
      break;
    }
    if (lt > i) push(mkText(html.slice(i, lt)));
    const gt = html.indexOf('>', lt);
    const raw = html.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith('/')) {
      stack.pop();
      continue;
    }
    const name = raw.split(/[\s/>]/)[0]!;
    const attrs: Record<string, string> = {};
    const re = /([a-zA-Z-]+)="([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) attrs[m[1]!] = m[2]!;
    const el = mkEl(attrs);
    push(el);
    if (!VOID_TAGS.has(name) && !raw.endsWith('/')) stack.push(el);
  }
  return root;
}

/** Finds the text node whose content contains `needle`. */
function findText(node: SourceMapNode, needle: string): SourceMapNode | null {
  if (node.nodeType === TEXT_NODE) return (node.textContent ?? '').includes(needle) ? node : null;
  const kids = node.childNodes;
  if (kids !== null) {
    for (let i = 0; i < kids.length; i++) {
      const found = findText(kids[i]!, needle);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Source offset of clicking `char` inside the text node containing `needle`. */
function clickOffset(src: string, needle: string, char: string): number | null {
  const root = parseHtml(renderMarkdown(src, { sourceMap: true }));
  const target = findText(root, needle);
  if (target === null) return null;
  const at = (target.textContent ?? '').indexOf(char);
  return sourceOffsetFromCaret(target, at === -1 ? 0 : at);
}

/** `[start, end)` of the first `<tag … data-md-start data-md-end …>`. */
function firstRange(html: string, tag: string): [number, number] | null {
  const re = new RegExp(`<${tag}[^>]*data-md-start="(\\d+)"[^>]*data-md-end="(\\d+)"`);
  const m = re.exec(html);
  return m === null ? null : [Number(m[1]), Number(m[2])];
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

// ---------------------------------------------------------------------------
// Резолвер: клики ПОСЛЕ inline-конструкций (анкеры data-md-after)
// ---------------------------------------------------------------------------

test('клик по тексту после ==метка== даёт исходное смещение (анкер)', () => {
  const src = 'абзац с ==меткой== хвост';
  assert.equal(clickOffset(src, ' хвост', 'х'), src.indexOf('хвост'));
});

test('клик по тексту после <u>подч</u> даёт исходное смещение', () => {
  const src = 'абзац <u>подч</u> хвост';
  assert.equal(clickOffset(src, ' хвост', 'х'), src.indexOf('хвост'));
});

test('клик по тексту после wiki-ссылки даёт исходное смещение', () => {
  const src = 'см. [[Мысль|алиас]] тут';
  assert.equal(clickOffset(src, ' тут', 'т'), src.indexOf('тут'));
});

test('клик ВНУТРИ ==метка== по-прежнему точен', () => {
  const src = 'абзац с ==меткой== хвост';
  assert.equal(clickOffset(src, 'меткой', 'т'), src.indexOf('меткой') + 2);
});

test('клик после softbreak (одиночный перенос) даёт исходное смещение', () => {
  const src = 'x\ny';
  assert.equal(clickOffset(src, 'y', 'y'), src.indexOf('y'));
});

test('клик после hardbreak двумя пробелами и обратным слэшем', () => {
  const bs = 'a  \nb';
  assert.equal(clickOffset(bs, 'b', 'b'), bs.indexOf('b'));
  const slash = 'a' + String.fromCharCode(92) + '\nb';
  assert.equal(clickOffset(slash, 'b', 'b'), slash.indexOf('b'));
});

test('**bold** имеет точный диапазон и анкер (задача 86598085)', () => {
  // Раньше сильный акцент не аннотировался (ADR-ограничение) и текст после него
  // мапился от начала блока. Теперь позиции маркеров снимаются со встроенного
  // правила markdown-it без второго парсера.
  const src = '**bold** текст';
  assert.equal(clickOffset(src, 'текст', 'т'), src.indexOf('текст'));
  assert.equal(clickOffset(src, 'bold', 'l'), src.indexOf('bold') + 'bold'.indexOf('l'));
});

// ---------------------------------------------------------------------------
// Blocker 2: база inline-смещений на CRLF и строках-продолжениях
// ---------------------------------------------------------------------------

test('CRLF: диапазон ==м== и wiki-ссылки считается в исходной строке', () => {
  const markSrc = 'первый\r\n==м==';
  assert.deepEqual(firstRange(renderMarkdown(markSrc, { sourceMap: true }), 'mark'), [
    markSrc.indexOf('м'),
    markSrc.indexOf('м') + 1,
  ]);
  const wikiSrc = 'x\r\n[[Мысль]]';
  assert.deepEqual(firstRange(renderMarkdown(wikiSrc, { sourceMap: true }), 'span'), [
    wikiSrc.indexOf('Мысль'),
    wikiSrc.indexOf('Мысль') + 'Мысль'.length,
  ]);
});

test('строка-продолжение цитаты: диапазон конструкции не смещается', () => {
  const src = '> первая\n> вторая ==м==';
  assert.deepEqual(firstRange(renderMarkdown(src, { sourceMap: true }), 'mark'), [
    src.indexOf('м'),
    src.indexOf('м') + 1,
  ]);
});

test('строка-продолжение списка: диапазон конструкции не смещается', () => {
  const src = '- item a\n  продолжение ==м==';
  assert.deepEqual(firstRange(renderMarkdown(src, { sourceMap: true }), 'mark'), [
    src.indexOf('м'),
    src.indexOf('м') + 1,
  ]);
});

test('клик по тексту после конструкции на строке-продолжении цитаты', () => {
  const src = '> первая\n> вторая ==м== хвост';
  assert.equal(clickOffset(src, ' хвост', 'х'), src.indexOf('хвост'));
});

// ---------------------------------------------------------------------------
// [на усмотрение] end заголовка не захватывает закрывающие «##»
// ---------------------------------------------------------------------------

test('data-md-end заголовка не захватывает закрывающие «##»', () => {
  const src = '# Заголовок ##';
  const html = renderMarkdown(src, { sourceMap: true });
  const range = firstRange(html, 'h1');
  assert.deepEqual(range, [src.indexOf('Заголовок'), src.indexOf('Заголовок') + 'Заголовок'.length]);
});

// ---------------------------------------------------------------------------
// Задача 86598085: точные якоря для strong/em/code_inline/s и вложенность
// ---------------------------------------------------------------------------

/** Ожидает: клик `char` внутри `word` даёт исходное смещение этого символа. */
function assertClickInText(src: string, word: string, char: string): void {
  const at = word.indexOf(char);
  assert.notEqual(at, -1, `символ ${char} не найден в ${word}`);
  assert.equal(clickOffset(src, word, char), src.indexOf(word) + at);
}

test('strong: диапазон, клик внутри и клик после', () => {
  const src = 'абзац с **жирным** хвост';
  const html = renderMarkdown(src, { sourceMap: true });
  assert.deepEqual(firstRange(html, 'strong'), [
    src.indexOf('жирным'),
    src.indexOf('жирным') + 'жирным'.length,
  ]);
  assertClickInText(src, 'жирным', 'н');
  assert.equal(clickOffset(src, ' хвост', 'х'), src.indexOf('хвост'));
});

test('em: диапазон, клик внутри и клик после', () => {
  const src = 'абзац с *курсивом* хвост';
  const html = renderMarkdown(src, { sourceMap: true });
  assert.deepEqual(firstRange(html, 'em'), [
    src.indexOf('курсивом'),
    src.indexOf('курсивом') + 'курсивом'.length,
  ]);
  assertClickInText(src, 'курсивом', 'с');
  assert.equal(clickOffset(src, ' хвост', 'х'), src.indexOf('хвост'));
});

test('code_inline: диапазон, клик внутри и клик после', () => {
  const src = 'пред `код` после';
  const html = renderMarkdown(src, { sourceMap: true });
  assert.deepEqual(firstRange(html, 'code'), [
    src.indexOf('код'),
    src.indexOf('код') + 'код'.length,
  ]);
  assertClickInText(src, 'код', 'о');
  assert.equal(clickOffset(src, ' после', 'п'), src.indexOf('после'));
});

test('code_inline: снимается выравнивающий пробел по краям (CommonMark)', () => {
  const src = '` код `';
  const html = renderMarkdown(src, { sourceMap: true });
  assert.deepEqual(firstRange(html, 'code'), [2, 5]);
  assertClickInText(src, 'код', 'о');
});

test('s (зачёркивание): диапазон, клик внутри и клик после', () => {
  const src = 'абзац ~~зачёркнутым~~ хвост';
  const html = renderMarkdown(src, { sourceMap: true });
  assert.deepEqual(firstRange(html, 's'), [
    src.indexOf('зачёркнутым'),
    src.indexOf('зачёркнутым') + 'зачёркнутым'.length,
  ]);
  assertClickInText(src, 'зачёркнутым', 'ч');
  assert.equal(clickOffset(src, ' хвост', 'х'), src.indexOf('хвост'));
});

test('вложенный mark внутри strong не делает strong листом', () => {
  const src = '**a ==b== c**';
  const html = renderMarkdown(src, { sourceMap: true });
  const strong = /<strong([^>]*)>/.exec(html)?.[1] ?? '';
  assert.ok(strong.includes(MD_SOURCE_START_ATTR), html);
  assert.ok(!strong.includes(MD_SOURCE_LEAF_ATTR), html);
  // Клик по тексту после вложенного ==b== идёт через его анкер.
  assertClickInText(src, 'a ', 'a');
  assertClickInText(src, ' c', 'c');
  assertClickInText(src, 'b', 'b');
});

test('wiki-ссылка внутри mark: mark не лист, клики точны (замечание верификатора)', () => {
  const src = '==a [[Мысль]] b==';
  const html = renderMarkdown(src, { sourceMap: true });
  const mark = /<mark([^>]*)>/.exec(html)?.[1] ?? '';
  assert.ok(mark.includes(MD_SOURCE_START_ATTR), html);
  assert.ok(!mark.includes(MD_SOURCE_LEAF_ATTR), html);
  assert.ok(mark.includes(MD_SOURCE_END_ATTR), html);
  assertClickInText(src, 'a ', 'a');
  assertClickInText(src, ' b', 'b');
  assertClickInText(src, 'Мысль', 'ы');
});

test('вложенные ***x***: em не лист, strong лист, клик по x точен', () => {
  const src = '***x***';
  const html = renderMarkdown(src, { sourceMap: true });
  const em = /<em([^>]*)>/.exec(html)?.[1] ?? '';
  const strong = /<strong([^>]*)>/.exec(html)?.[1] ?? '';
  assert.ok(!em.includes(MD_SOURCE_LEAF_ATTR), html);
  assert.ok(strong.includes(MD_SOURCE_LEAF_ATTR), html);
  assertClickInText(src, 'x', 'x');
});

test('вложенные **a *b* c**: strong не лист, em лист, клики точны', () => {
  const src = '**a *b* c**';
  const html = renderMarkdown(src, { sourceMap: true });
  const strong = /<strong([^>]*)>/.exec(html)?.[1] ?? '';
  const em = /<em([^>]*)>/.exec(html)?.[1] ?? '';
  assert.ok(!strong.includes(MD_SOURCE_LEAF_ATTR), html);
  assert.ok(em.includes(MD_SOURCE_LEAF_ATTR), html);
  assertClickInText(src, 'a ', 'a');
  assertClickInText(src, 'b', 'b');
  assertClickInText(src, ' c', 'c');
});

// Регресс из проверки приёмки: многострочные конструкции с мягким/жёстким
// переносом рендерятся через <br> (0 текстовых символов), поэтому не могут
// быть leaf — иначе leaf-ветка резолвера теряет символы переноса.

test('soft break внутри strong: не лист, клик по тексту после переноса точен', () => {
  const src = '**a\nb**';
  const html = renderMarkdown(src, { sourceMap: true });
  assert.ok(!/<strong[^>]*data-md-leaf/.test(html), html);
  assert.match(html, /<br [^>]*data-md-after="4"/, html);
  assert.equal(clickOffset(src, 'b', 'b'), src.indexOf('b'));
});

test('soft break внутри em и s: клик по тексту после переноса точен', () => {
  assert.equal(clickOffset('*a\nb*', 'b', 'b'), '*a\nb*'.indexOf('b'));
  assert.equal(clickOffset('~~a\nb~~', 'b', 'b'), '~~a\nb~~'.indexOf('b'));
});

test('soft break внутри mark и underline: клик по тексту после переноса точен', () => {
  assert.equal(clickOffset('==a\nb==', 'b', 'b'), '==a\nb=='.indexOf('b'));
  assert.equal(clickOffset('<u>a\nb</u>', 'b', 'b'), '<u>a\nb</u>'.indexOf('b'));
});

test('hard break внутри strong: клик по тексту после переноса точен', () => {
  const src = '**a  \nb**';
  assert.equal(clickOffset(src, 'b', 'b'), src.indexOf('b'));
});

test('escape внутри конструкции: клик по тексту после escape точен (1b9cf949)', () => {
  // Рендер `\*` короче исходника на символ (обратный слэш отбрасывается);
  // карта сдвига `data-md-shift` на leaf-конструкции компенсирует разницу.
  const bs = String.fromCharCode(92);
  const src = '**a ' + bs + '* b**';
  assert.equal(src.indexOf('b'), 7);
  assert.equal(clickOffset(src, 'b', 'b'), 7);
  // до escape смещение не сдвигается
  assert.equal(clickOffset(src, 'a', 'a'), src.indexOf('a'));
});

test('HTML-entity внутри конструкции: клик по тексту после entity точен (1b9cf949)', () => {
  const src = '**a &amp; b**';
  assert.equal(src.indexOf('b'), 10);
  assert.equal(clickOffset(src, 'b', 'b'), 10);
});

test('escape/entity внутри em, s, mark и underline: клик после них точен', () => {
  const bs = String.fromCharCode(92);
  for (const [src, needle] of [
    ['*a ' + bs + '* b*', 'b'],
    ['~~a &amp; b~~', 'b'],
    ['==a ' + bs + '* b==', 'b'],
    ['<u>a &amp; b</u>', 'b'],
  ] as const) {
    assert.equal(clickOffset(src, needle, needle), src.indexOf(needle), src);
  }
});

test('несколько escape/entity внутри одной конструкции суммируются', () => {
  const bs = String.fromCharCode(92);
  const src = '**' + bs + '* &amp; ' + bs + '* z**';
  assert.equal(clickOffset(src, 'z', 'z'), src.indexOf('z'));
});

// ---------------------------------------------------------------------------
// Ошибка d2ad1345: сдвиг на НЕ-leaf (вложенной) инлайновой конструкции
// ---------------------------------------------------------------------------

test('не-leaf конструкция несёт карту сдвига и не помечена листом', () => {
  const bs = String.fromCharCode(92);
  const html = renderMarkdown('**a ==c== b ' + bs + '* d**', { sourceMap: true });
  const strong = /<strong([^>]*)>/.exec(html)?.[1] ?? '';
  assert.ok(strong.includes(MD_SOURCE_SHIFT_ATTR), html);
  assert.ok(!strong.includes(MD_SOURCE_LEAF_ATTR), html);
});

test('escape ПОСЛЕ вложенной конструкции: клик точен (d2ad1345)', () => {
  const bs = String.fromCharCode(92);
  // `**a ==c== b \* d**` — escape в «хвосте» после вложенного ==c==.
  const src = '**a ==c== b ' + bs + '* d**';
  assert.equal(src.indexOf('d'), 15);
  assert.equal(clickOffset(src, 'd', 'd'), 15);
  // до и внутри вложенной конструкции клики по-прежнему точны
  assertClickInText(src, 'a ', 'a');
  assertClickInText(src, 'c', 'c');
  assertClickInText(src, ' b ', 'b');
});

test('escape ПЕРЕД вложенной конструкцией: клик точен (d2ad1345)', () => {
  const bs = String.fromCharCode(92);
  // `**b \* d ==c==**` — escape до единственного анкера, база — начало strong.
  const src = '**b ' + bs + '* d ==c==**';
  assert.equal(src.indexOf('d'), 7);
  assert.equal(clickOffset(src, 'd', 'd'), 7);
  assertClickInText(src, 'b ', 'b');
  assertClickInText(src, 'c', 'c');
});

test('escape в не-leaf em-конструкции: клик точен (d2ad1345)', () => {
  const bs = String.fromCharCode(92);
  const src = '**a _x_ b ' + bs + '* d**';
  assert.equal(src.indexOf('d'), 13);
  assert.equal(clickOffset(src, 'd', 'd'), 13);
});

test('HTML-entity в не-leaf конструкции: клик после неё точен (d2ad1345)', () => {
  const src = '**a ==c== b &amp; d**';
  assert.equal(clickOffset(src, 'd', 'd'), src.indexOf('d'));
  assertClickInText(src, 'a ', 'a');
  assertClickInText(src, 'c', 'c');
});

test('escape внутри вложенной конструкции не задваивается внешним анкером (d2ad1345)', () => {
  const bs = String.fromCharCode(92);
  const src = '**a ' + bs + '* b ==c' + bs + '*d== e**';
  assert.equal(src.indexOf('e'), 18);
  // клик после вложенной конструкции идёт через её анкер: сдвиг внутри уже
  // поглощён анкером и повторно не прибавляется.
  assert.equal(clickOffset(src, 'e', 'e'), 18);
  // внутри вложенной конструкции — её собственная карта сдвига
  assert.equal(clickOffset(src, 'c*d', 'd'), src.indexOf('d', src.indexOf('c')));
  assertClickInText(src, 'b ', 'b');
});

test('code_inline внутри конструкции: граница сдвига считается с его текстом', () => {
  const bs = String.fromCharCode(92);
  // Без учёта видимого текста code_inline граница escape упала бы до её анкера
  // и сдвиг не применился бы.
  const src = '**`xxxxx` ' + bs + '* b**';
  assert.equal(clickOffset(src, 'b', 'b'), src.indexOf('b'));
});

test('wiki-ссылка внутри конструкции: граница сдвига считается с её текстом', () => {
  const bs = String.fromCharCode(92);
  const src = '**a [[Мысль]] b ' + bs + '* c**';
  assert.equal(clickOffset(src, 'c', 'c'), src.indexOf('c'));
});

test('байт-паритет: не-leaf конструкции с escape вне sourceMap не меняются', () => {
  const bs = String.fromCharCode(92);
  assert.equal(
    renderMarkdown('**a ==c== b ' + bs + '* d**'),
    '<p><strong>a <mark>c</mark> b * d</strong></p>\n',
  );
  assert.equal(renderMarkdown('**b ' + bs + '* d ==c==**'), '<p><strong>b * d <mark>c</mark></strong></p>\n');
});

test('ограничение: markdown-ссылка внутри конструкции смещает leaf-клик', () => {
  // Ссылка рендерится меткой (не аннотируется и не считается текстовым
  // прогоном), поэтому карта сдвига её не компенсирует — честное ограничение
  // задокументировано в шапке source-map.ts.
  const src = '**[метка](http://e) хвост**';
  assert.notEqual(clickOffset(src, 'хвост', 'хвост'), src.indexOf('хвост'));
});

// ---------------------------------------------------------------------------
// Ошибка 29aa3108: inline HTML-комментарий внутри конструкции/абзаца
// ---------------------------------------------------------------------------

test('HTML-комментарий внутри strong: клик после него точен (29aa3108)', () => {
  const src = '**a <!-- c --> b**';
  assert.equal(src.indexOf('b'), 15);
  assert.equal(clickOffset(src, 'b', 'b'), 15);
});

test('HTML-комментарий в начале strong: клик по тексту после него точен (29aa3108)', () => {
  const src = '**<!--c--> a**';
  assert.equal(clickOffset(src, 'a', 'a'), src.indexOf('a'));
});

test('HTML-комментарий вне конструкции (в абзаце): клик после него точен (29aa3108)', () => {
  const src = 'a <!--c--> b';
  assert.equal(src.indexOf('b'), 11);
  assert.equal(clickOffset(src, 'b', 'b'), 11);
});

test('HTML-комментарий у границы анкера (не-leaf): клик точен (29aa3108)', () => {
  // Комментарий стоит вплотную после вложенного ==b==, поэтому его скрытый
  // прогон начинается ровно на границе анкера и должен примениться включительно.
  const src = '**a ==b==<!--c--> d**';
  assert.equal(clickOffset(src, 'd', 'd'), src.indexOf('d'));
});

test('комментарий и entity внутри strong: клик после обоих точен (29aa3108)', () => {
  const src = '**a <!-- c --> &amp; b**';
  assert.equal(clickOffset(src, 'b', 'b'), src.indexOf('b'));
});

test('карта сдвига помечает скрытый прогон комментария «!» (29aa3108)', () => {
  const html = renderMarkdown('**a <!-- c --> b**', { sourceMap: true });
  const strong = /<strong([^>]*)>/.exec(html)?.[1] ?? '';
  assert.match(strong, new RegExp(`${MD_SOURCE_SHIFT_ATTR}="2:10!"`), html);
});

test('байт-паритет: комментарий внутри конструкции без sourceMap не меняет вывод', () => {
  assert.equal(renderMarkdown('**a <!-- c --> b**'), '<p><strong>a  b</strong></p>\n');
});

test('escape в абзаце после вложенной конструкции: клик точен (блочная карта сдвига)', () => {
  // Блочная карта сдвига должна считать видимый текст вложенной конструкции,
  // иначе её границы разъезжаются с координатами резолвера (ошибка 29aa3108).
  const bs = String.fromCharCode(92);
  const src = '==xxxxx== ' + bs + '* d';
  assert.equal(clickOffset(src, 'd', 'd'), src.indexOf('d'));
  const src2 = 'a ' + bs + '* b ==c== d';
  assert.equal(clickOffset(src2, 'd', 'd'), src2.indexOf('d'));
});

test('маркеры трансклюзий остаются скрытыми и без sourceMap, и с ним (29aa3108)', () => {
  const marker = '<!-- etn:transclusion begin depth=1 source="x" -->';
  const src = `до\n\n${marker}\n\nпосле`;
  for (const html of [renderMarkdown(src), renderMarkdown(src, { sourceMap: true })]) {
    assert.ok(!html.includes('etn:transclusion'), html);
    assert.ok(!html.includes('<!--'), html);
    assert.ok(html.includes('до') && html.includes('после'), html);
  }
});

// Регресс проверки 0602db42: скрытая запись вложенной конструкции не должна
// протекать в блочную карту (иначе дельта применяется повторно поверх анкера).

test('комментарий в КОНЦЕ strong: клик по тексту снаружи точен (регресс 0602db42)', () => {
  const src = '**a <!--c-->** tail more text here';
  assert.equal(clickOffset(src, 'tail', 't'), src.indexOf('tail'));
});

test('комментарий в КОНЦЕ em: клик снаружи точен', () => {
  const src = '*a <!--c-->* x';
  assert.equal(clickOffset(src, ' x', 'x'), src.indexOf('x'));
});

test('комментарий в конце strong и текст сразу после: клик точен', () => {
  const src = '**a <!--c-->** x';
  assert.equal(clickOffset(src, ' x', 'x'), src.indexOf('x'));
});

test('два комментария подряд (в конструкции и вне): клик точен', () => {
  const src = '**a <!--c-->**<!--d--> x';
  assert.equal(clickOffset(src, ' x', 'x'), src.indexOf('x'));
});

test('комментарий в конце вложенной конструкции: клик по хвосту внешней точен', () => {
  const src = '**x *a <!--c-->* tail**';
  assert.equal(clickOffset(src, 'tail', 't'), src.indexOf('tail'));
  const src2 = '**a ==b<!--c-->== tail**';
  assert.equal(clickOffset(src2, 'tail', 't'), src2.indexOf('tail'));
});

test('блочная карта не дублирует скрытую запись вложенной конструкции', () => {
  const html = renderMarkdown('**a <!--c-->** tail', { sourceMap: true });
  const p = /<p([^>]*)>/.exec(html)?.[1] ?? '';
  assert.ok(!p.includes(MD_SOURCE_SHIFT_ATTR), html);
  const strong = /<strong([^>]*)>/.exec(html)?.[1] ?? '';
  assert.ok(strong.includes(MD_SOURCE_SHIFT_ATTR), html);
});

test('скрытая запись самого блока (комментарий вне конструкции) сохраняется', () => {
  const src = 'a <!--c--> b';
  const html = renderMarkdown(src, { sourceMap: true });
  const p = /<p([^>]*)>/.exec(html)?.[1] ?? '';
  assert.ok(p.includes(MD_SOURCE_SHIFT_ATTR), html);
  assert.equal(clickOffset(src, 'b', 'b'), src.indexOf('b'));
});

// ---------------------------------------------------------------------------
// Ошибка 2c6a6f64: блочная карта сдвига в tight-списке (скрытый paragraph_open)
// ---------------------------------------------------------------------------

test('tight-список: блочная карта сдвига садится на <li>, клик по хвосту точен (2c6a6f64)', () => {
  const src = '- a <!--c--> b';
  const html = renderMarkdown(src, { sourceMap: true });
  // В tight-списке hidden `paragraph_open` рендерер не выводит, поэтому карта
  // сдвига должна остаться на отрендеренном `<li>`, а не потеряться.
  assert.match(html, /<li[^>]*data-md-shift/, html);
  assert.match(html, /<li[^>]*data-md-start/, html);
  assert.equal(clickOffset(src, 'b', 'b'), src.indexOf('b'));
  assert.notEqual(src.indexOf('b'), 5);
});

test('tight-нумерованный список: карта сдвига на <li>, клик точен (2c6a6f64)', () => {
  const src = '1. a <!--c--> b';
  const html = renderMarkdown(src, { sourceMap: true });
  assert.match(html, /<li[^>]*data-md-shift/, html);
  assert.equal(clickOffset(src, 'b', 'b'), src.indexOf('b'));
});

test('байт-паритет: tight-список с комментарием без sourceMap не меняется', () => {
  assert.equal(renderMarkdown('- a <!--c--> b'), '<ul>\n<li>a  b</li>\n</ul>\n');
});

test('байт-паритет: вне sourceMap вывод стандартных конструкций не меняется', () => {
  assert.equal(renderMarkdown('**жирным**'), '<p><strong>жирным</strong></p>\n');
  assert.equal(renderMarkdown('*курсивом*'), '<p><em>курсивом</em></p>\n');
  assert.equal(renderMarkdown('`кодом`'), '<p><code>кодом</code></p>\n');
  assert.equal(renderMarkdown('~~зачёркнутым~~'), '<p><s>зачёркнутым</s></p>\n');
  assert.equal(
    renderMarkdown('**a ==b== c**'),
    '<p><strong>a <mark>b</mark> c</strong></p>\n',
  );
  assert.equal(renderMarkdown('***x***'), '<p><em><strong>x</strong></em></p>\n');
});

// ---------------------------------------------------------------------------
// Публикационный фрагмент: opt-in sourceMap (задача 59774016)
// ---------------------------------------------------------------------------

test('публикационный фрагмент: без sourceMap вывод не размечается', () => {
  const src = 'aaa bbb aaa ccc';
  const html = renderPublicationFragment(src).html;
  assert.ok(!html.includes(MD_SOURCE_START_ATTR), html);
  assert.ok(!html.includes(MD_SOURCE_END_ATTR), html);
});

test('публикационный фрагмент: opt-in sourceMap размечает позиции относительно body_md', () => {
  const src = 'aaa bbb aaa ccc';
  const html = renderPublicationFragment(src, { sourceMap: true }).html;
  assert.match(html, new RegExp(`<p data-md-start="0" data-md-end="${src.length}"`));
});

test('публикационный фрагмент: сдвиг заголовка сохраняет разметку позиций', () => {
  const src = '# Заголовок\n\nтекст';
  const html = renderPublicationFragment(src, { baseLevel: 1, sourceMap: true }).html;
  const start = src.indexOf('Заголовок');
  // Заголовок сдвинут на уровень ниже (H1 → H2), разметка осталась на тексте.
  assert.match(html, new RegExp(`<h2[^>]*data-md-start="${start}"`));
});

test('повтор слова: каретка во втором вхождении даёт ЕГО позицию, а не первого', () => {
  const src = 'aaa bbb aaa ccc';
  const second = src.lastIndexOf('aaa');
  const root = parseHtml(renderPublicationFragment(src, { sourceMap: true }).html);
  const target = findText(root, 'aaa');
  assert.ok(target !== null);
  // Ориентир по первому вхождению дал бы 0; разметка позиций даёт место клика.
  assert.equal(sourceOffsetFromCaret(target, second), second);
  assert.notEqual(second, 0);
});

