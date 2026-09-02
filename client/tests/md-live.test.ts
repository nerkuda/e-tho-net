/**
 * Unit tests of the live-preview helpers and decorations (task M6). The
 * decoration tests build a real EditorState (no DOM needed).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';

import { isIdWikiLinkTarget, isInRangeInclusive, isNearInline, livePreview, wikiLabel } from '../src/renderer/editor/md-live.js';
import { wikiLinkLanguage } from '../src/renderer/editor/wiki-link.js';

/** Каретка в одной позиции. */
const caret = (pos: number) => [EditorSelection.range(pos, pos)];

// ---------------------------------------------------------------------------
// Декорации buildDecorations: состояния собираются с тем же набором
// расширений, что и редактор (язык markdown + wiki-узлы + livePreview).
// ---------------------------------------------------------------------------

function buildState(doc: string, selection = 0): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor: selection },
    extensions: [
      markdown({ base: markdownLanguage, extensions: [wikiLinkLanguage()] }),
      livePreview,
    ],
  });
}

type DecoSpec = Record<string, unknown>;

function specs(state: EditorState, from = 0, to = state.doc.length): DecoSpec[] {
  const found: DecoSpec[] = [];
  state.field(livePreview).between(from, to, (_f, _t, deco) => {
    found.push((deco as unknown as { spec?: DecoSpec }).spec ?? {});
  });
  return found;
}

/**
 * Все декорации через iter(): в отличие от between(), включает точечные
 * (нулевой длины) диапазоны — например, line-декорации заголовков.
 */
function allSpecs(state: EditorState): Array<{ from: number; to: number; spec: DecoSpec }> {
  const found: Array<{ from: number; to: number; spec: DecoSpec }> = [];
  for (const it = state.field(livePreview).iter(); it.value !== null; it.next()) {
    const spec = (it.value as unknown as { spec?: DecoSpec }).spec ?? {};
    found.push({ from: it.from, to: it.to, spec });
  }
  return found;
}

function hasClass(state: EditorState, cls: string, from: number, to: number): boolean {
  return specs(state, from, to).some((s) => s.class === cls);
}

/** Скрытый маркер — Decoration.replace с inclusive (как в hide()). */
function hasHiddenMark(state: EditorState, from: number, to: number): boolean {
  return specs(state, from, to).some((s) => s.inclusive === true);
}

test('заголовок: класс строки cm-md-h1 всегда; маркер «# » скрыт только вне блока', () => {
  const doc = '# Заголовок\nтекст';
  // Каретка вне заголовка (в «текст»): маркер скрыт, класс строки есть.
  const away = buildState(doc, doc.length);
  assert.equal(allSpecs(away).some((r) => r.spec.class === 'cm-md-h1'), true, 'класс строки h1');
  assert.equal(hasHiddenMark(away, 0, 1), true, '«# » скрыт, каретка вне');
  // Каретка внутри заголовка: маркер виден, класс строки остаётся.
  const inside = buildState(doc, 2);
  assert.equal(hasHiddenMark(inside, 0, 1), false, '«# » виден, каретка внутри');
  assert.equal(allSpecs(inside).some((r) => r.spec.class === 'cm-md-h1'), true);
});

test('заголовок: уровень определяет класс строки (h1–h6)', () => {
  for (const level of ['1', '2', '3', '4', '5', '6'] as const) {
    const doc = `${'#'.repeat(Number(level))} Заголовок\n`;
    const state = buildState(doc, doc.length);
    assert.equal(
      allSpecs(state).some((r) => r.spec.class === `cm-md-h${level}`),
      true,
      `h${level}`,
    );
  }
});

test('line-декорации — нулевой длины (LineDecoration.range бросает при to ≠ from)', () => {
  const state = buildState('# Заголовок\n\n## Ещё\n> цитата\nтекст', 0);
  const lineSpecs = allSpecs(state).filter(
    (r) =>
      typeof r.spec.class === 'string' &&
      (r.spec.class.startsWith('cm-md-h') || r.spec.class === 'cm-md-quote-line'),
  );
  assert.equal(lineSpecs.length, 3, 'заголовки + цитата');
  for (const r of lineSpecs) {
    assert.equal(r.from, r.to, `${r.spec.class}: from === to`);
  }
});

test('цитата: line-класс на строку; маркер «>» виден только внутри блока', () => {
  // Пустая строка отделяет «текст»: иначе он — ленивое продолжение
  // Blockquote, и каретка в конце документа всё ещё внутри блока.
  const doc = '> цитата\n> вторая\n\nтекст';
  // Две «>»-строки — один Blockquote: каретка внутри блока показывает
  // маркеры обеих строк (правило M6 — блоком владеет Blockquote).
  const inside = buildState(doc, 3);
  const quoteLines = allSpecs(inside).filter((r) => r.spec.class === 'cm-md-quote-line');
  assert.equal(quoteLines.length, 2, 'по line-классу на каждую строку цитаты');
  assert.equal(hasHiddenMark(inside, 0, 1), false, '«>» первой строки виден');
  assert.equal(hasHiddenMark(inside, 9, 10), false, '«>» второй строки виден');
  // Каретка вне цитаты: оба маркера скрыты, классы строк остаются.
  const away = buildState(doc, doc.length);
  assert.equal(hasHiddenMark(away, 0, 1), true);
  assert.equal(hasHiddenMark(away, 9, 10), true);
  assert.equal(allSpecs(away).filter((r) => r.spec.class === 'cm-md-quote-line').length, 2);
});

test('вложенная цитата: line-класс только у внешнего блока — рамка не дублируется', () => {
  const doc = '> > вложенная\n';
  const state = buildState(doc, 5);
  const quoteLines = allSpecs(state).filter((r) => r.spec.class === 'cm-md-quote-line');
  assert.equal(quoteLines.length, 1);
});

test('inline-код: плашка cm-md-inline-code всегда; бэктики скрыты только вне', () => {
  const doc = '`код` текст';
  // Каретка вне: бэктики скрыты, плашка есть.
  const away = buildState(doc, doc.length);
  assert.equal(hasClass(away, 'cm-md-inline-code', 1, 2), true);
  assert.equal(hasHiddenMark(away, 0, 1), true, 'открывающий бэктик скрыт');
  assert.equal(hasHiddenMark(away, 4, 5), true, 'закрывающий бэктик скрыт');
  // Каретка внутри кода: бэктики видны, плашка остаётся.
  const inside = buildState(doc, 2);
  assert.equal(hasHiddenMark(inside, 0, 1), false);
  assert.equal(hasHiddenMark(inside, 4, 5), false);
  assert.equal(hasClass(inside, 'cm-md-inline-code', 1, 2), true);
});

test('wiki-ссылка: вне — виджет; внутри — исходник без виджета', () => {
  const doc = '[[Мысль]] x';
  // Каретка после ссылки (за пределами «перед/после»): ссылка — виджет.
  const away = buildState(doc, doc.length);
  assert.equal(specs(away, 0, 1).some((s) => s.widget !== undefined), true);
  // Каретка внутри: виджета нет, исходник виден.
  const inside = buildState(doc, 4);
  assert.equal(specs(inside, 0, 1).some((s) => s.widget !== undefined), false);
});

test('wiki-ссылка ID-форма: live-preview не ставит виджет (R6 плагин подтянет имя)', () => {
  const ID = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
  const doc = `[[#${ID}]] x`;
  // Каретка далеко: live-preview НЕ должен показывать `#<uuid>` как виджет —
  // это работа `wikiIdPlugin` (R6), который умеет резолвить имя асинхронно.
  const away = buildState(doc, doc.length);
  assert.equal(
    specs(away, 0, 1).some((s) => s.widget !== undefined),
    false,
    'ID-форма: live-preview не ставит виджет, чтобы не показывать `#<uuid>` как label',
  );
  // Каретка внутри — поведение прежнее (исходник виден, виджета нет).
  const inside = buildState(doc, 4);
  assert.equal(specs(inside, 0, 1).some((s) => s.widget !== undefined), false);
});

// ---------------------------------------------------------------------------
// Правила активности (M6-фикс): блочные — включительно по диапазону,
// инлайн — плюс одна позиция до/после элемента.
// ---------------------------------------------------------------------------

test('wikiLabel: имя без алиаса', () => {
  assert.deepEqual(wikiLabel('[[имя мысли]]'), {
    target: 'имя мысли',
    label: 'имя мысли',
  });
});

test('wikiLabel: алиас после |', () => {
  assert.deepEqual(wikiLabel('[[имя мысли|синоним]]'), {
    target: 'имя мысли',
    label: 'синоним',
  });
});

test('wikiLabel: не-ссылка и неполные формы — null; пустой алиас = имя', () => {
  for (const source of ['не ссылка', '[[без закрытия', '[[]]', '[[|b]]', '[[a\nb]]']) {
    assert.equal(wikiLabel(source), null, JSON.stringify(source));
  }
  // Пустой алиас допустим — рендерер показывает имя (паритет с markdown-пакетом).
  assert.deepEqual(wikiLabel('[[a|]]'), { target: 'a', label: 'a' });
});

// ---------------------------------------------------------------------------
// Распознавание ID-формы wiki-ссылки (`[[#<uuid>]]` / `[[n:<net>#<uuid>]]`).
// Для таких форм live-preview не ставит свой виджет: имя подтягивает на лету
// `wikiIdPlugin` (R6), который умеет асинхронный резолв и atomic range.
// Без этого проверка бы показала `#<uuid>` как label.
// ---------------------------------------------------------------------------

const ID_UUID = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
const NET_UUID = 'c4f9a3b2-1111-2222-3333-444455556666';

test('isIdWikiLinkTarget: id-форма [[#<uuid>]]', () => {
  assert.equal(isIdWikiLinkTarget(`#${ID_UUID}`), true);
  assert.equal(isIdWikiLinkTarget(`#${ID_UUID.toUpperCase()}`), true);
});

test('isIdWikiLinkTarget: кросс-сеть [[n:<net>#<id>]]', () => {
  assert.equal(isIdWikiLinkTarget(`n:${NET_UUID}#${ID_UUID}`), true);
});

test('isIdWikiLinkTarget: legacy [[Имя|алиас]] — false', () => {
  assert.equal(isIdWikiLinkTarget('Имя мысли'), false);
  assert.equal(isIdWikiLinkTarget('Имя|алиас'), false);
});

test('isIdWikiLinkTarget: невалидный UUID — false', () => {
  assert.equal(isIdWikiLinkTarget('#not-a-uuid'), false);
  assert.equal(isIdWikiLinkTarget(`n:not-a-uuid#${ID_UUID}`), false);
  assert.equal(isIdWikiLinkTarget(`n:${NET_UUID}#not-a-uuid`), false);
  assert.equal(isIdWikiLinkTarget('n:without-hash'), false);
});

// ---------------------------------------------------------------------------
// Правила активности (M6-фикс): блочные — включительно по диапазону,
// инлайн — плюс одна позиция до/после элемента.
// ---------------------------------------------------------------------------

test('блочное правило: активен от первого до последнего символа включительно', () => {
  const ranges = (pos: number) => caret(pos);
  // [10, 20): каретка на границах и внутри — активна.
  assert.equal(isInRangeInclusive(ranges(10), 10, 20), true);
  assert.equal(isInRangeInclusive(ranges(19), 10, 20), true);
  assert.equal(isInRangeInclusive(ranges(20), 10, 20), true, 'последний символ включён');
  assert.equal(isInRangeInclusive(ranges(9), 10, 20), false);
  assert.equal(isInRangeInclusive(ranges(21), 10, 20), false);
});

test('инлайн-правило: внутри и непосредственно перед/после', () => {
  const ranges = (pos: number) => caret(pos);
  // Элемент [10, 13): каретка в 9 — перед, в 13 — сразу после.
  assert.equal(isNearInline(ranges(9), 10, 13), true, 'непосредственно перед');
  assert.equal(isNearInline(ranges(12), 10, 13), true, 'внутри');
  assert.equal(isNearInline(ranges(13), 10, 13), true, 'непосредственно после');
  assert.equal(isNearInline(ranges(8), 10, 13), false, 'через символ до');
  assert.equal(isNearInline(ranges(14), 10, 13), false, 'через символ после');
});
