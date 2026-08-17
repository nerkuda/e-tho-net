/**
 * Unit tests of the live-preview helpers and decorations (task M6). The
 * decoration tests build a real EditorState (no DOM needed).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';

import { isInRangeInclusive, isNearInline, livePreview, wikiLabel } from '../src/renderer/editor/md-live.js';
import { wikiLinkLanguage } from '../src/renderer/editor/wiki-link.js';

/** Каретка в одной позиции. */
const caret = (pos: number) => [{ from: pos, to: pos, empty: true }];

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

test('line-декорации заголовков — нулевой длины (LineDecoration.range бросает при to ≠ from)', () => {
  const state = buildState('# Заголовок\n\n## Ещё\nтекст', 0);
  const headingSpecs = allSpecs(state).filter(
    (r) => typeof r.spec.class === 'string' && r.spec.class.startsWith('cm-md-h'),
  );
  assert.equal(headingSpecs.length, 2, 'обе line-декорации на месте');
  for (const r of headingSpecs) {
    assert.equal(r.from, r.to, `${r.spec.class}: from === to`);
  }
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
