/**
 * Unit tests of the live-preview helpers and decorations (task M6). The
 * decoration tests build a real EditorState (no DOM needed).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';

import {
  isIdWikiLinkTarget,
  isInRangeInclusive,
  isNearInline,
  livePreview,
  wikiLabel,
} from '../src/renderer/editor/md-live.js';
import { ShimElement } from './dom-shim.js';
import { createParsedState } from './editor-parse.js';
import { wikiLinkLanguage } from '../src/renderer/editor/wiki-link.js';

/** Каретка в одной позиции. */
const caret = (pos: number) => [EditorSelection.range(pos, pos)];

// ---------------------------------------------------------------------------
// Декорации buildDecorations: состояния собираются с тем же набором
// расширений, что и редактор (язык markdown + wiki-узлы + livePreview).
// ---------------------------------------------------------------------------

function buildState(doc: string, selection = 0): EditorState {
  // Разбор полный УЖЕ ПРИ СОЗДАНИИ: `livePreview` — ленивое StateField-поле,
  // строящее decorations из `syntaxTree`; обрезанное дерево молча теряет
  // разметку под нагрузкой (tests/editor-parse.ts, задача f9b5c36e).
  return createParsedState(() =>
    EditorState.create({
      doc,
      selection: { anchor: selection },
      extensions: [
        markdown({ base: markdownLanguage, extensions: [wikiLinkLanguage()] }),
        livePreview,
      ],
    }),
  );
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
      (r.spec.class.startsWith('cm-md-h') || r.spec.class.includes('cm-md-quote-line')),
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
  const quoteClass = (r: { spec: DecoSpec }): string =>
    typeof r.spec.class === 'string' ? r.spec.class : '';
  // Две «>»-строки — один Blockquote: каретка внутри блока показывает
  // маркеры обеих строк (правило M6 — блоком владеет Blockquote).
  const inside = buildState(doc, 3);
  const quoteLines = allSpecs(inside).filter((r) => quoteClass(r).includes('cm-md-quote-line'));
  assert.equal(quoteLines.length, 2, 'по line-классу на каждую строку цитаты');
  assert.equal(hasHiddenMark(inside, 0, 1), false, '«>» первой строки виден');
  assert.equal(hasHiddenMark(inside, 9, 10), false, '«>» второй строки виден');
  // Каретка вне цитаты: оба маркера скрыты, классы строк остаются.
  const away = buildState(doc, doc.length);
  assert.equal(hasHiddenMark(away, 0, 1), true);
  assert.equal(hasHiddenMark(away, 9, 10), true);
  const awayLines = allSpecs(away).filter((r) => quoteClass(r).includes('cm-md-quote-line'));
  assert.equal(awayLines.length, 2);
  // Вертикальные отступы — только у краёв блока (единый источник стилей
  // просмотра и редактора, ошибка 45989471): первая и последняя строка.
  assert.equal(
    awayLines.some((r) => quoteClass(r).includes('cm-md-quote-first')),
    true,
    'первая строка цитаты — с верхним отступом',
  );
  assert.equal(
    awayLines.some((r) => quoteClass(r).includes('cm-md-quote-last')),
    true,
    'последняя строка цитаты — с нижним отступом',
  );
});

test('вложенная цитата: line-класс только у внешнего блока — рамка не дублируется', () => {
  const doc = '> > вложенная\n';
  const state = buildState(doc, 5);
  const quoteLines = allSpecs(state).filter(
    (r) => typeof r.spec.class === 'string' && r.spec.class.includes('cm-md-quote-line'),
  );
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

test('выделение ==…==: вне — маркеры скрыты и содержимое подсвечено; внутри — маркеры видны', () => {
  const doc = '==m== text';
  const away = buildState(doc, doc.length);
  assert.equal(hasHiddenMark(away, 0, 2), true, 'открывающий `==` скрыт');
  assert.equal(hasHiddenMark(away, 3, 5), true, 'закрывающий `==` скрыт');
  assert.equal(hasClass(away, 'cm-md-mark', 2, 3), true, 'содержимое подсвечено (как <mark>)');
  // Каретка внутри: маркеры видны, подсветка содержимого остаётся.
  const inside = buildState(doc, 2);
  assert.equal(hasHiddenMark(inside, 0, 2), false, 'открывающий `==` виден');
  assert.equal(hasHiddenMark(inside, 3, 5), false, 'закрывающий `==` виден');
  assert.equal(hasClass(inside, 'cm-md-mark', 2, 3), true, 'содержимое подсвечено и при активности');
});

test('подчёркивание <u>…</u>: вне — маркеры скрыты и содержимое подчёркнуто; внутри — маркеры видны', () => {
  const doc = '<u>u</u> text';
  const away = buildState(doc, doc.length);
  assert.equal(hasHiddenMark(away, 0, 3), true, '`<u>` скрыт');
  assert.equal(hasHiddenMark(away, 4, 8), true, '`</u>` скрыт');
  assert.equal(hasClass(away, 'cm-md-underline', 3, 4), true, 'содержимое подчёркнуто');
  const inside = buildState(doc, 3);
  assert.equal(hasHiddenMark(inside, 0, 3), false, '`<u>` виден');
  assert.equal(hasHiddenMark(inside, 4, 8), false, '`</u>` виден');
  assert.equal(hasClass(inside, 'cm-md-underline', 3, 4), true, 'подчёркивание остаётся и при активности');
});

test('пустые пары `====` и `<u></u>` — маркеры НЕ скрываются (паритет с рендерером)', () => {
  // Рендерер пустую пару оставляет литералом (`markdown/src/mark.ts`,
  // `underline.ts` — `close === openEnd → false`), правка не должна её стирать.
  const markEmpty = buildState('==== text', 9);
  assert.deepEqual(allSpecs(markEmpty), [], 'пустая пара `====` — без декораций');
  const markInline = buildState('x ==== y', 8);
  assert.equal(hasHiddenMark(markInline, 2, 4), false, 'открывающий `==` не скрыт');
  assert.equal(hasHiddenMark(markInline, 4, 6), false, 'закрывающий `==` не скрыт');
  // `========` — четыре пары, обе пары пустые: текст не стирается.
  const eight = buildState('========', 8);
  for (const [f, t] of [[0, 2], [2, 4], [4, 6], [6, 8]] as const) {
    assert.equal(hasHiddenMark(eight, f, t), false, `восемь «=»: [${f},${t})`);
  }
  const uEmpty = buildState('<u></u> text', 10);
  assert.deepEqual(allSpecs(uEmpty), [], 'пустая пара `<u></u>` — без декораций');
  const uInline = buildState('x <u></u> y', 11);
  assert.equal(hasHiddenMark(uInline, 2, 5), false, '`<u>` не скрыт');
  assert.equal(hasHiddenMark(uInline, 5, 9), false, '`</u>` не скрыт');
});

test('несбалансированные пары `==`/`<u>` — литерал без декораций', () => {
  for (const doc of ['== x', 'x ==', 'x == y', '<u>u', 'u</u>']) {
    assert.deepEqual(allSpecs(buildState(doc, doc.length)), [], `литерал: ${JSON.stringify(doc)}`);
  }
});

test('зачёркивание ~~…~~: вне — маркеры скрыты; внутри — видны (как жирный)', () => {
  const doc = '~~s~~ text';
  const away = buildState(doc, doc.length);
  assert.equal(hasHiddenMark(away, 0, 2), true, 'открывающий `~~` скрыт');
  assert.equal(hasHiddenMark(away, 3, 5), true, 'закрывающий `~~` скрыт');
  const inside = buildState(doc, 3);
  assert.equal(hasHiddenMark(inside, 0, 2), false, 'открывающий `~~` виден');
  assert.equal(hasHiddenMark(inside, 3, 5), false, 'закрывающий `~~` виден');
});

test('жирный/курсив не сломаны: маркеры вне скрыты, внутри видны', () => {
  const bold = '**b** text';
  assert.equal(hasHiddenMark(buildState(bold, bold.length), 0, 2), true, '`**` вне скрыт');
  assert.equal(hasHiddenMark(buildState(bold, bold.length), 3, 5), true, '`**` вне скрыт');
  assert.equal(hasHiddenMark(buildState(bold, 2), 0, 2), false, '`**` внутри виден');

  const ital = '*i* text';
  assert.equal(hasHiddenMark(buildState(ital, ital.length), 0, 1), true, '`*` вне скрыт');
  assert.equal(hasHiddenMark(buildState(ital, ital.length), 2, 3), true, '`*` вне скрыт');
  assert.equal(hasHiddenMark(buildState(ital, 1), 0, 1), false, '`*` внутри виден');
});

test('task-список: вне — маркер `[ ]` заменён чекбоксом, `-` скрыт; внутри — исходные маркеры', () => {
  const doc = '- [ ] todo\n\nпара';
  // Каретка вне пункта (во второй строке): чекбокс на месте `[ ]`, дефис скрыт.
  const away = buildState(doc, doc.length);
  const checkbox = allSpecs(away).find(
    (r) => r.from === 2 && r.to === 5 && r.spec.widget !== undefined,
  );
  assert.ok(checkbox, 'маркер `[ ]` заменён виджетом-чекбоксом');
  assert.equal(hasHiddenMark(away, 0, 1), true, 'маркер списка `-` скрыт вне пункта');
  // Каретка внутри пункта: исходные маркеры видны, виджета нет.
  const inside = buildState(doc, 3);
  assert.equal(allSpecs(inside).some((r) => r.spec.widget !== undefined), false);
  assert.equal(hasHiddenMark(inside, 0, 1), false, 'маркер списка `-` виден');
  assert.equal(hasHiddenMark(inside, 2, 5), false, 'маркер `[ ]` виден');
});

/** Текст виджета-маркера списка на диапазоне `[from,to)` (или null). */
function listMarker(state: EditorState, from: number, to: number): string | null {
  const r = allSpecs(state).find((x) => x.from === from && x.to === to);
  const w = r?.spec.widget as { marker?: string } | undefined;
  return w?.marker ?? null;
}

test('маркированный список: вне — отрисован маркер `•`; внутри и вплотную — исходный `-`', () => {
  // ListItem [0,6), ListMark [0,1); «пара» отделена пустой строкой от списка.
  const doc = '- item\n\nпара';
  // Вне пункта: `-` заменён отрисованным маркером списка (как `•` в просмотре),
  // не скрыт и не оставлен исходником.
  const away = buildState(doc, doc.length);
  assert.equal(listMarker(away, 0, 1), '•', '`-` заменён маркером `•`');
  assert.equal(hasHiddenMark(away, 0, 1), false, 'маркер не «скрыт» — он отрисован');
  // Внутри пункта и вплотную: исходный `-`, виджета нет.
  assert.equal(listMarker(buildState(doc, 3), 0, 1), null, 'внутри — исходник');
  assert.equal(listMarker(buildState(doc, 0), 0, 1), null, 'вплотную — исходник');
});

test('нумерованный список: вне — номер `N.` отрисован (не теряется); внутри — исходник', () => {
  // "1. one\n2) two\n\nпара": ListItem1 [0,6) ListMark [0,2); ListItem2 [7,13) ListMark [7,9).
  const doc = '1. one\n2) two\n\nпара';
  const away = buildState(doc, doc.length);
  // Номер сохраняется как в просмотре; `2)` нормализуется к `2.` (decimal).
  assert.equal(listMarker(away, 0, 2), '1.', 'номер первого пункта отрисован');
  assert.equal(listMarker(away, 7, 9), '2.', 'номер второго пункта отрисован (2) → 2.)');
  assert.equal(hasHiddenMark(away, 0, 2), false, 'номер не скрыт');
  // Внутри первого пункта: исходник без виджета; маркер соседнего пункта отрисован.
  const insideFirst = buildState(doc, 3);
  assert.equal(listMarker(insideFirst, 0, 2), null, '`1.` внутри — исходник');
  assert.equal(listMarker(insideFirst, 7, 9), '2.', 'соседний пункт вне каретки — отрисован');
});

test('task-список: отмеченный `[x]` даёт чекбокс с checked', () => {
  const doc = '- [x] todo\n\nпара';
  const away = buildState(doc, doc.length);
  const checkbox = allSpecs(away).find((r) => r.from === 2 && r.to === 5);
  assert.ok(checkbox, 'маркер `[x]` заменён виджетом');
  const widget = checkbox.spec.widget as { checked?: boolean } | undefined;
  assert.equal(widget?.checked, true, 'чекбокс отмечен');
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

// ---------------------------------------------------------------------------
// HTML-комментарий в правке (ТЗ4 «Дневник без псевдослота»): весь узел серым
// (класс `cm-md-html-comment`), маркеры `<!--`/`-->` скрыты вне курсора.
// ---------------------------------------------------------------------------

const HTML_COMMENT_CLASS = 'cm-md-html-comment';

test('HTML-комментарий (инлайн): серый весь узел, маркеры скрыты вне курсора', () => {
  const doc = 'text <!-- c --> more';
  // Comment [5,15): `<!--` [5,9), `-->` [12,15).
  const away = buildState(doc, doc.length);
  assert.equal(hasClass(away, HTML_COMMENT_CLASS, 5, 15), true, 'весь узел серым');
  assert.equal(hasHiddenMark(away, 5, 9), true, 'открывающий `<!--` скрыт вне');
  assert.equal(hasHiddenMark(away, 12, 15), true, 'закрывающий `-->` скрыт вне');
  // Каретка внутри комментария: маркеры видны, серость остаётся.
  const inside = buildState(doc, 7);
  assert.equal(hasHiddenMark(inside, 5, 9), false, '`<!--` виден внутри');
  assert.equal(hasHiddenMark(inside, 12, 15), false, '`-->` виден внутри');
  assert.equal(hasClass(inside, HTML_COMMENT_CLASS, 5, 15), true, 'серость остаётся');
});

test('HTML-комментарий: маркеры видны и в смежной позиции (как у парных `**`)', () => {
  const doc = 'x <!-- c --> y';
  // Comment [2,12): `<!--` [2,6), `-->` [9,12).
  const before = buildState(doc, 2 - 1);
  assert.equal(hasHiddenMark(before, 2, 6), false, 'вплотную ПЕРЕД — маркеры видны');
  const after = buildState(doc, 12);
  assert.equal(hasHiddenMark(after, 9, 12), false, 'вплотную ПОСЛЕ — маркеры видны');
});

test('HTML-комментарий (блочный CommentBlock): серый, маркеры скрыты вне курсора', () => {
  const doc = 'текст\n\n<!-- block\ncomment -->\nконец';
  const away = buildState(doc, doc.length);
  const block = allSpecs(away).find((r) => r.spec.class === HTML_COMMENT_CLASS);
  assert.ok(block, 'блочный комментарий найден');
  assert.ok(block.to - block.from > 1, 'узел непустой');
  assert.equal(hasHiddenMark(away, block.from, block.from + 4), true, '`<!--` скрыт вне');
  assert.equal(hasHiddenMark(away, block.to - 3, block.to), true, '`-->` скрыт вне');
  const inside = buildState(doc, block.from + 4);
  assert.equal(hasHiddenMark(inside, block.from, block.from + 4), false, 'маркеры видны внутри');
  assert.equal(hasHiddenMark(inside, block.to - 3, block.to), false);
});


// ---------------------------------------------------------------------------
// HTML-виджет (`HtmlWidget`) и сдвиг позиций (ошибка 4df5e284): печать выше
// блока меняет `from/to`, но содержимое остаётся прежним — виджет обязан
// обновиться на месте (`updateDOM`), а не пересобираться. Пересоздание заново
// рендерило mermaid на каждый символ и мигало таблицей/картинкой.
// ---------------------------------------------------------------------------

/** Виджет HTML-блока так, как его отдаёт декорация (`spec.widget`). */
interface HtmlWidgetLike {
  from: number;
  to: number;
  html: string;
  eq(other: HtmlWidgetLike): boolean;
  toDOM(): ShimElement;
  updateDOM(dom: ShimElement, view: unknown): boolean;
}

/** HTML-виджеты состояния (fence, таблица, картинка — все на `HtmlWidget`). */
function htmlWidgets(state: EditorState): HtmlWidgetLike[] {
  const found: HtmlWidgetLike[] = [];
  for (const it = state.field(livePreview).iter(); it.value !== null; it.next()) {
    const widget = (it.value as unknown as { spec?: { widget?: unknown } }).spec?.widget;
    if (widget !== undefined && typeof (widget as { html?: unknown }).html === 'string') {
      found.push(widget as HtmlWidgetLike);
    }
  }
  return found;
}

/** `document` для `toDOM`/`updateDOM` (в шиме нет глобального DOM). */
function installDocumentShim(): void {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new ShimElement(tag),
  };
}

/**
 * Счётчик childList-мутаций внутри виджета: обёртки методов вставки/снятия
 * детей (в шиме нет MutationObserver).
 */
function watchWidgetMutations(box: ShimElement): () => number {
  let mutations = 0;
  const target = box as unknown as Record<string, unknown>;
  for (const method of [
    'append',
    'prepend',
    'appendChild',
    'insertBefore',
    'removeChild',
    'replaceChildren',
    'replaceWith',
  ]) {
    const original = target[method] as ((...args: unknown[]) => unknown) | undefined;
    if (typeof original !== 'function') continue;
    target[method] = (...args: unknown[]): unknown => {
      mutations += 1;
      return original.apply(box, args);
    };
  }
  for (const child of [...box.children]) {
    const original = child.remove.bind(child);
    child.remove = (): void => {
      mutations += 1;
      original();
    };
  }
  return () => mutations;
}

/**
 * Журнал присваиваний `innerHTML` виджету — независимое свидетельство
 * пересборки содержимого. Читать `box.innerHTML` для этого НЕЛЬЗЯ: геттер
 * подменён здесь же и отдаёт ровно то, что положил сеттер, поэтому
 * `box.innerHTML === html` тавтологичен (замечание верификатора к `4df5e284`).
 * Пересборка в браузере — это `innerHTML = …`, то есть всегда присваивание;
 * мемо-путь обновления до сеттера не доходит.
 */
interface InnerHtmlLog {
  /** Сколько присваиваний дошло до сеттера (пересборка — одно и больше). */
  count(): number;
  /** Что именно присваивали, по порядку (для сверки с ожидаемым `html`). */
  written(): readonly string[];
}

/** Подменяет `innerHTML` виджета сеттером-журналом. */
function watchWidgetInnerHtml(box: ShimElement): InnerHtmlLog {
  const written: string[] = [];
  let value = box.innerHTML;
  Object.defineProperty(box, 'innerHTML', {
    configurable: true,
    get: () => value,
    set: (next: string) => {
      written.push(String(next));
      value = next;
    },
  });
  return { count: () => written.length, written: () => written };
}

const MERMAID_BLOCK = '```mermaid\ngraph TD\n  A-->B\n```';
const TABLE_BLOCK = '| a | b |\n| --- | --- |\n| 1 | 2 |';
const IMAGE_BLOCK = '![схема](pic.png)';
/** Три вида HTML-блока в одном документе: fence (mermaid), таблица, картинка. */
const HTML_DOC = `${MERMAID_BLOCK}\n\n${TABLE_BLOCK}\n\n${IMAGE_BLOCK}\n\nпара`;
/** Печать выше блоков: две строки текста — смещения растут на их длину. */
const TYPED_ABOVE = 'печать\n\n';

test('HtmlWidget: печать выше блока не пересобирает DOM, меняя лишь data-md-from/to (4df5e284)', () => {
  installDocumentShim();
  const widgets = htmlWidgets(buildState(HTML_DOC, HTML_DOC.length));
  assert.equal(widgets.length, 3, 'виджеты fence, таблицы и картинки найдены');
  const shiftedWidgets = htmlWidgets(
    buildState(`${TYPED_ABOVE}${HTML_DOC}`, HTML_DOC.length + TYPED_ABOVE.length),
  );
  assert.equal(shiftedWidgets.length, 3, 'после сдвига те же три виджета');

  widgets.forEach((widget, index) => {
    const box = widget.toDOM();
    const mutations = watchWidgetMutations(box);
    const htmlWrites = watchWidgetInnerHtml(box);
    const shifted = shiftedWidgets[index]!;

    assert.equal(shifted.from, widget.from + TYPED_ABOVE.length, `#${index}: from сдвинут`);
    assert.equal(shifted.to, widget.to + TYPED_ABOVE.length, `#${index}: to сдвинут`);
    assert.equal(shifted.html, widget.html, `#${index}: HTML содержимого не изменился`);
    assert.equal(
      widget.eq(shifted),
      false,
      `#${index}: смещения отличают виджеты (триггер updateDOM)`,
    );
    assert.equal(shifted.updateDOM(box, {}), true, `#${index}: updateDOM обновляет DOM на месте`);

    assert.equal(htmlWrites.count(), 0, `#${index}: innerHTML не переназначался`);
    assert.equal(mutations(), 0, `#${index}: ни одной childList-мутации`);
    assert.equal(box.dataset.mdFrom, String(shifted.from), `#${index}: data-md-from актуален`);
    assert.equal(box.dataset.mdTo, String(shifted.to), `#${index}: data-md-to актуален`);
  });
});

test('HtmlWidget: мемо per-DOM — виджеты с РАЗНЫМ html помнят каждый своё (4df5e284)', () => {
  installDocumentShim();
  // «Несколько живых полей одновременно»: у каждого DOM своя запись мемо, и
  // «последний отрисованный HTML» в модульной переменной ломает соседа.
  // Проверка обязана это ловить, поэтому html у виджетов РАЗНЫЙ: с одинаковым
  // содержимым (две одинаковые таблицы) подмена `WeakMap` на «последний
  // отрисованный» проходит незамеченной — замечание верификатора.
  const baseDoc = `${MERMAID_BLOCK}\n\n${TABLE_BLOCK}\n\nпара`;
  /** Свежие DOM двух виджетов документа и журналы их `innerHTML`. */
  const freshBoxes = (
    doc: string,
  ): { widgets: HtmlWidgetLike[]; boxes: ShimElement[]; logs: InnerHtmlLog[] } => {
    const widgets = htmlWidgets(buildState(doc, doc.length));
    assert.equal(widgets.length, 2, 'в документе два HTML-виджета');
    const boxes = widgets.map((widget) => widget.toDOM());
    return { widgets, boxes, logs: boxes.map((box) => watchWidgetInnerHtml(box)) };
  };

  // 1. Внешняя правка сдвигает ОБА виджета, содержимое прежнее — ни один не
  //    пересобирается (сдвиг идёт первым по позиции, потом второй).
  {
    const { widgets, boxes, logs } = freshBoxes(baseDoc);
    assert.notEqual(widgets[0]!.html, widgets[1]!.html, 'у соседей разный HTML');
    const shiftedDoc = `${TYPED_ABOVE}${baseDoc}`;
    const shifted = htmlWidgets(buildState(shiftedDoc, shiftedDoc.length));
    assert.equal(shifted.length, 2, 'после сдвига те же два виджета');
    boxes.forEach((box, index) => {
      assert.equal(shifted[index]!.html, widgets[index]!.html, `#${index}: содержимое прежнее`);
      assert.equal(
        widgets[index]!.eq(shifted[index]!),
        false,
        `#${index}: сдвиг — триггер updateDOM`,
      );
      assert.equal(shifted[index]!.updateDOM(box, {}), true, `#${index}: обновление на месте`);
    });
    assert.deepEqual(
      logs.map((log) => log.count()),
      [0, 0],
      'сдвиг обоих не пересобирает ни один (у каждого своя запись мемо)',
    );
    assert.equal(boxes[0]!.dataset.mdFrom, String(shifted[0]!.from), 'первый: data-md-from');
    assert.equal(boxes[1]!.dataset.mdFrom, String(shifted[1]!.from), 'второй: data-md-from');
  }

  // 2. Правка меняет ТОЛЬКО диаграмму (та же длина исходника) — пересобрана
  //    диаграмма, таблица рядом (её смещения сдвинуты, HTML тот же) — нет.
  {
    const { widgets, boxes, logs } = freshBoxes(baseDoc);
    const editedDoc = `${TYPED_ABOVE}${baseDoc.replace('A-->B', 'A-->C')}`;
    const edited = htmlWidgets(buildState(editedDoc, editedDoc.length));
    assert.equal(edited.length, 2);
    assert.notEqual(edited[0]!.html, widgets[0]!.html, 'диаграмма изменилась');
    assert.equal(edited[1]!.html, widgets[1]!.html, 'таблица не изменилась');
    // Порядок важен: сперва обновляется ИЗМЕНЁННЫЙ виджет, потом сосед —
    // «последний отрисованный» на этом порядке пересобрал бы и соседа.
    assert.equal(edited[0]!.updateDOM(boxes[0]!, {}), true, 'диаграмма: обновление на месте');
    assert.equal(edited[1]!.updateDOM(boxes[1]!, {}), true, 'таблица: обновление на месте');
    assert.deepEqual(
      logs.map((log) => log.count()),
      [1, 0],
      'пересобрана только диаграмма',
    );
    assert.deepEqual(logs[0]!.written(), [edited[0]!.html], 'в диаграмму записан её новый HTML');
    assert.equal(
      boxes[1]!.dataset.mdFrom,
      String(edited[1]!.from),
      'таблица: свежие смещения без пересборки',
    );

    // Повтор с теми же инстансами: мемо своего DOM держит и новое содержимое.
    assert.equal(edited[0]!.updateDOM(boxes[0]!, {}), true);
    assert.equal(edited[1]!.updateDOM(boxes[1]!, {}), true);
    assert.deepEqual(
      logs.map((log) => log.count()),
      [1, 0],
      'повтор содержимое не трогает',
    );
  }

  // 3. Обратное направление: правка меняет ТОЛЬКО таблицу — пересобрана она,
  //    диаграмма рядом остаётся прежней.
  {
    const { widgets, boxes, logs } = freshBoxes(baseDoc);
    const editedDoc = `${TYPED_ABOVE}${baseDoc.replace('| 1 | 2 |', '| 1 | 3 |')}`;
    const edited = htmlWidgets(buildState(editedDoc, editedDoc.length));
    assert.equal(edited.length, 2);
    assert.equal(edited[0]!.html, widgets[0]!.html, 'диаграмма не изменилась');
    assert.notEqual(edited[1]!.html, widgets[1]!.html, 'таблица изменилась');
    assert.equal(edited[1]!.updateDOM(boxes[1]!, {}), true, 'таблица: обновление на месте');
    assert.equal(edited[0]!.updateDOM(boxes[0]!, {}), true, 'диаграмма: обновление на месте');
    assert.deepEqual(
      logs.map((log) => log.count()),
      [0, 1],
      'пересобрана только таблица',
    );
    assert.deepEqual(logs[1]!.written(), [edited[1]!.html], 'в таблицу записан её новый HTML');
    assert.equal(
      boxes[0]!.dataset.mdFrom,
      String(edited[0]!.from),
      'диаграмма: свежие смещения без пересборки',
    );
  }
});

test('HtmlWidget: смена содержимого при живом виджете пересобирает его ровно один раз (4df5e284)', () => {
  installDocumentShim();
  const doc = `${MERMAID_BLOCK}\n\nпара`;
  const widget = htmlWidgets(buildState(doc, doc.length))[0]!;
  const box = widget.toDOM();
  const mutations = watchWidgetMutations(box);
  const htmlWrites = watchWidgetInnerHtml(box);

  // Внешняя установка текста (`setValue`): у блока сменился исходник.
  const edited = doc.replace('A-->B', 'A-->C');
  const updated = htmlWidgets(buildState(edited, edited.length))[0]!;
  assert.equal(widget.eq(updated), false, 'смена HTML отличает виджеты');
  assert.notEqual(updated.html, widget.html, 'HTML действительно новый (иначе проверка вакуумна)');
  assert.equal(updated.updateDOM(box, {}), true, 'DOM пригоден к обновлению на месте');

  // Содержимое пересобрано ровно один раз ИМЕННО новым HTML: доказательство —
  // журнал сеттера (`written`), а не чтение `box.innerHTML`, чей геттер подменён
  // здесь же и вернул бы любое записанное значение (замечание верификатора).
  assert.equal(htmlWrites.count(), 1, 'содержимое пересобрано ровно один раз');
  assert.deepEqual(htmlWrites.written(), [updated.html], 'присвоен новый HTML диаграммы');
  assert.ok(
    htmlWrites.written()[0]!.includes('A--&gt;C'),
    'в присвоенном HTML — новый исходник диаграммы (A--&gt;C)',
  );
  assert.equal(mutations(), 0, 'дети не переставлялись вручную');
  assert.equal(box.dataset.mdFrom, String(updated.from), 'data-md-from актуален');
  assert.equal(box.dataset.mdTo, String(updated.to), 'data-md-to актуален');

  // Повторное обновление тем же HTML пересборки не даёт (мемо).
  assert.equal(updated.updateDOM(box, {}), true);
  assert.equal(htmlWrites.count(), 1, 'повторный updateDOM содержимое не трогает');
  assert.deepEqual(htmlWrites.written(), [updated.html], 'журнал присваиваний не вырос');
});

/** Первый виджет состояния, подходящий под предикат (для остальных классов). */
function widgetWhere(
  state: EditorState,
  match: (widget: Record<string, unknown>) => boolean,
): { from: number; to: number; eq(other: unknown): boolean; toDOM(): ShimElement } {
  for (const it = state.field(livePreview).iter(); it.value !== null; it.next()) {
    const widget = (it.value as unknown as { spec?: { widget?: unknown } }).spec?.widget;
    if (widget !== undefined && match(widget as Record<string, unknown>)) {
      return widget as {
        from: number;
        to: number;
        eq(other: unknown): boolean;
        toDOM(): ShimElement;
      };
    }
  }
  assert.fail('виджет не найден');
}

test('остальные виджеты: сдвиг их пересоздаёт, но DOM без удерживаемого состояния — смещения свежие (4df5e284)', () => {
  installDocumentShim();
  // Класс, а не случай: у этих виджетов `eq` тоже различает смещения, поэтому
  // сдвиг выше их пересоздаёт — это допустимо ТОЛЬКО потому, что в DOM нет
  // удерживаемого состояния (mermaid/async), а `data-md-from/to` берутся из
  // нового инстанса. Тест фиксирует границу класса, чтобы «пересоздание»
  // нельзя было молча распространить на HTML-виджет с состоянием.
  const cases: Array<{
    name: string;
    doc: string;
    match: (widget: Record<string, unknown>) => boolean;
  }> = [
    {
      name: 'HrWidget',
      doc: '---\n\nпара',
      // У HrWidget нет собственных полей, кроме смещений (в отличие от
      // HtmlWidget/wiki/чекбокса/маркера).
      match: (w) => !('html' in w) && !('target' in w) && !('marker' in w) && !('checked' in w),
    },
    { name: 'WikiLinkWidget', doc: '[[Мысль]] x\n\nпара', match: (w) => w.target === 'Мысль' },
  ];
  for (const item of cases) {
    const before = widgetWhere(buildState(item.doc, item.doc.length), item.match);
    const shiftedDoc = `${TYPED_ABOVE}${item.doc}`;
    const shifted = widgetWhere(buildState(shiftedDoc, shiftedDoc.length), item.match);
    assert.equal(
      shifted.from,
      before.from + TYPED_ABOVE.length,
      `${item.name}: смещение сдвинуто на длину печати`,
    );
    assert.equal(before.eq(shifted), false, `${item.name}: сдвиг отличает виджеты`);
    const box = shifted.toDOM();
    assert.equal(
      box.dataset.mdFrom,
      String(shifted.from),
      `${item.name}: data-md-from посчитан из нового инстанса`,
    );
    assert.equal(
      box.dataset.mdTo,
      String(shifted.to),
      `${item.name}: data-md-to посчитан из нового`,
    );
  }
});

test('HtmlWidget в цитате внутри списка: сдвиг выше не пересобирает таблицу (4df5e284)', () => {
  installDocumentShim();
  // Урок 49ebba76: блок в цитате ВНУТРИ списка — своя обёртка разметки, и класс
  // дефекта не должен зависеть от контекста (проверка «класс, а не случай»).
  const doc = '- пункт\n\n  > | a | b |\n  > | --- | --- |\n  > | 1 | 2 |\n\nпара';
  const widgets = htmlWidgets(buildState(doc, doc.length));
  assert.equal(widgets.length, 1, 'таблица в цитате внутри списка — HtmlWidget');
  const box = widgets[0]!.toDOM();
  const htmlWrites = watchWidgetInnerHtml(box);
  const mutations = watchWidgetMutations(box);

  const shiftedDoc = `${TYPED_ABOVE}${doc}`;
  const shifted = htmlWidgets(buildState(shiftedDoc, shiftedDoc.length));
  assert.equal(shifted.length, 1, 'виджет на месте после сдвига');
  assert.equal(shifted[0]!.html, widgets[0]!.html, 'HTML содержимого не изменился');
  assert.equal(widgets[0]!.eq(shifted[0]!), false, 'смещения отличают виджеты');
  assert.equal(shifted[0]!.updateDOM(box, {}), true, 'DOM обновлён на месте');
  assert.equal(htmlWrites.count(), 0, 'innerHTML не переназначался');
  assert.equal(mutations(), 0, 'ни одной childList-мутации');
  assert.equal(box.dataset.mdFrom, String(shifted[0]!.from), 'data-md-from актуален');
  assert.equal(box.dataset.mdTo, String(shifted[0]!.to), 'data-md-to актуален');
});

test('HtmlWidget: печать НИЖЕ блока и движение каретки — eq=true, перерисовки нет (4df5e284)', () => {
  const widgets = htmlWidgets(buildState(HTML_DOC, HTML_DOC.length));
  const belowWidgets = htmlWidgets(
    buildState(`${HTML_DOC}\n\nещё`, HTML_DOC.length + '\n\nещё'.length),
  );
  assert.equal(belowWidgets.length, widgets.length, 'состав виджетов прежний');
  widgets.forEach((widget, index) => {
    assert.equal(widget.eq(belowWidgets[index]!), true, `#${index}: печать ниже — виджеты равны`);
  });

  // Движение каретки вне блоков не меняет ни смещений, ни HTML.
  const caretBefore = buildState(HTML_DOC, HTML_DOC.length);
  const caretAfter = buildState(HTML_DOC, HTML_DOC.indexOf('пара'));
  const a = htmlWidgets(caretBefore);
  const b = htmlWidgets(caretAfter);
  assert.equal(a.length, b.length, 'состав виджетов прежний');
  a.forEach((widget, index) => {
    assert.equal(widget.eq(b[index]!), true, `#${index}: движение каретки — виджеты равны`);
  });
});
