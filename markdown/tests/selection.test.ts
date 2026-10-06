/**
 * Unit tests of the selection-to-units parser in the single renderer package
 * (задача `1d15f14a`, ТП3; ADR `01ec1467`, требование `f5695a1e`). Pure — no
 * DB, no DOM: the selection text goes in, the unit forest comes out.
 *
 * Recap of the rules under test:
 *   1. list — hierarchical, nested list → children;
 *   2. sections — heading + text until the NEXT heading, nested by level;
 *   3. paragraphs — split on blank lines; code/quote/table without a blank
 *      line continue the previous unit, separated they open a new one;
 *   4. lines — a single plain line is one unit;
 *   5. combined — before the first heading by paragraphs/lists, after by
 *      sections;
 *   6./7. selection starting/ending mid-block yields a standalone paragraph.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSelectionUnits, type MarkdownUnit } from '../src/index.js';

/** Flat shape of a unit tree: kind + own text + children, offsets dropped. */
function shape(units: readonly MarkdownUnit[]): unknown[] {
  return units.map((u) => ({
    kind: u.kind,
    text: u.text,
    children: shape(u.children),
  }));
}

/** Every unit range in the tree, deepest included. */
function ranges(units: readonly MarkdownUnit[]): Array<[number, number]> {
  return units.flatMap((u) => [[u.start, u.end] as [number, number], ...ranges(u.children)]);
}

/** Asserts that every unit range sits in `src` and no two ranges overlap. */
function assertDisjointRanges(src: string, units: readonly MarkdownUnit[]): void {
  const all = ranges(units).sort((a, b) => a[0] - b[0]);
  for (const [start, end] of all) {
    assert.ok(start >= 0 && end <= src.length && start <= end, `диапазон [${start},${end}) в границах текста`);
  }
  for (let i = 1; i < all.length; i++) {
    assert.ok(
      all[i]![0] >= all[i - 1]![1],
      `диапазоны не пересекаются: [${all[i - 1]}] и [${all[i]}]`,
    );
  }
}

// ---------------------------------------------------------------------------
// Правило 1. Список
// ---------------------------------------------------------------------------

test('правило 1: список — элемент = единица, вложенный список = children', () => {
  const src = '- один\n- два\n  - вложенный\n  - ещё\n- три';
  const units = parseSelectionUnits(src);
  assert.deepEqual(shape(units), [
    { kind: 'list', text: '- один', children: [] },
    {
      kind: 'list',
      text: '- два',
      children: [
        { kind: 'list', text: '  - вложенный', children: [] },
        { kind: 'list', text: '  - ещё', children: [] },
      ],
    },
    { kind: 'list', text: '- три', children: [] },
  ]);
  assertDisjointRanges(src, units);
});

test('правило 1: нумерованный список с вложенностью', () => {
  const src = '1. один\n   1. влож\n2. два';
  const units = parseSelectionUnits(src);
  assert.equal(units.length, 2);
  assert.deepEqual(shape(units[0]!.children), [{ kind: 'list', text: '   1. влож', children: [] }]);
  assert.deepEqual(shape([units[1]!]), [{ kind: 'list', text: '2. два', children: [] }]);
  assertDisjointRanges(src, units);
});

test('правило 1: пункт без вложенности — одна единица без детей', () => {
  const units = parseSelectionUnits('- единственный пункт');
  assert.equal(units.length, 1);
  assert.equal(units[0]!.kind, 'list');
  assert.deepEqual(units[0]!.children, []);
});

// ---------------------------------------------------------------------------
// Правило 2. Разделы
// ---------------------------------------------------------------------------

test('правило 2: разделы вкладываются по уровням, текст — до следующего заголовка', () => {
  const src = '# A\nтекст A\n\n## B\nтекст B\n\n### C\nтекст C\n\n# D\nтекст D';
  const units = parseSelectionUnits(src);
  assert.deepEqual(shape(units), [
    {
      kind: 'section',
      text: '# A\nтекст A',
      children: [
        {
          kind: 'section',
          text: '## B\nтекст B',
          children: [{ kind: 'section', text: '### C\nтекст C', children: [] }],
        },
      ],
    },
    { kind: 'section', text: '# D\nтекст D', children: [] },
  ]);
  assertDisjointRanges(src, units);
});

test('правило 2: списки внутри раздела не разрезают его на единицы', () => {
  const src = '## H\nтело\n\n- раз\n- два';
  const units = parseSelectionUnits(src);
  assert.deepEqual(shape(units), [
    { kind: 'section', text: '## H\nтело\n\n- раз\n- два', children: [] },
  ]);
});

test('правило 2: заголовок без тела — единица из одного заголовка', () => {
  const units = parseSelectionUnits('# Только заголовок');
  assert.deepEqual(shape(units), [{ kind: 'section', text: '# Только заголовок', children: [] }]);
});

// ---------------------------------------------------------------------------
// Правило 3. Абзацы, код/цитаты/таблицы
// ---------------------------------------------------------------------------

test('правило 3: абзацы делятся по пустым строкам', () => {
  const src = 'Абзац один\nвторая строка\n\nВторой абзац';
  const units = parseSelectionUnits(src);
  assert.deepEqual(shape(units), [
    { kind: 'paragraph', text: 'Абзац один\nвторая строка', children: [] },
    { kind: 'line', text: 'Второй абзац', children: [] },
  ]);
  assertDisjointRanges(src, units);
});

test('правило 3: код без пустой строки — продолжение абзаца, с пустой — новая единица', () => {
  const merged = parseSelectionUnits('абзац\n```\ncode\n```\nконец');
  assert.deepEqual(shape(merged), [
    { kind: 'paragraph', text: 'абзац\n```\ncode\n```\nконец', children: [] },
  ]);

  const separated = parseSelectionUnits('абзац\n\n```\ncode\n```');
  assert.deepEqual(shape(separated), [
    { kind: 'line', text: 'абзац', children: [] },
    { kind: 'paragraph', text: '```\ncode\n```', children: [] },
  ]);
});

test('правило 3: цитата и таблица ведут себя как блок кода', () => {
  const quote = parseSelectionUnits('абзац\n> цитата');
  assert.deepEqual(shape(quote), [{ kind: 'paragraph', text: 'абзац\n> цитата', children: [] }]);

  const table = parseSelectionUnits('до\n\n| a | b |\n| - | - |\n| 1 | 2 |');
  assert.deepEqual(shape(table), [
    { kind: 'line', text: 'до', children: [] },
    { kind: 'paragraph', text: '| a | b |\n| - | - |\n| 1 | 2 |', children: [] },
  ]);
});

// ---------------------------------------------------------------------------
// Правило 4. Строки
// ---------------------------------------------------------------------------

test('правило 4: одна строка простого текста — одна единица вида line', () => {
  const src = 'несколько слов в одной строке';
  const units = parseSelectionUnits(src);
  assert.deepEqual(shape(units), [{ kind: 'line', text: src, children: [] }]);
  assert.deepEqual([units[0]!.start, units[0]!.end], [0, src.length]);
});

// ---------------------------------------------------------------------------
// Правило 5. Комбинированный случай
// ---------------------------------------------------------------------------

test('правило 5: до первого заголовка — абзацы и списки, после — разделы', () => {
  const src = 'вступление\n\n- пункт\n\n## H\nтело H\n\n- список в разделе';
  const units = parseSelectionUnits(src);
  assert.deepEqual(shape(units), [
    { kind: 'line', text: 'вступление', children: [] },
    { kind: 'list', text: '- пункт', children: [] },
    { kind: 'section', text: '## H\nтело H\n\n- список в разделе', children: [] },
  ]);
  assertDisjointRanges(src, units);
});

// ---------------------------------------------------------------------------
// Правила 6 и 7. Начало/конец выделения в середине блока
// ---------------------------------------------------------------------------

test('правило 6: неполное начало блока — самостоятельный абзац', () => {
  const src = 'продолжение строки\n- следующий пункт';
  const units = parseSelectionUnits(src);
  assert.deepEqual(shape(units), [
    { kind: 'line', text: 'продолжение строки', children: [] },
    { kind: 'list', text: '- следующий пункт', children: [] },
  ]);
  assertDisjointRanges(src, units);
});

test('правило 7: неполный конец блока — самостоятельная единица', () => {
  const src = 'первый абзац\n\nвторой абза';
  const units = parseSelectionUnits(src);
  assert.equal(units.length, 2);
  assert.equal(units[1]!.text, 'второй абза');
  assert.deepEqual(shape([units[1]!]), [{ kind: 'line', text: 'второй абза', children: [] }]);
});

// ---------------------------------------------------------------------------
// Границы: пустое выделение, одна единица, только заголовки, вложенность
// ---------------------------------------------------------------------------

test('границы: пустое и пробельное выделение — пустой лес', () => {
  assert.deepEqual(parseSelectionUnits(''), []);
  assert.deepEqual(parseSelectionUnits('\n\n   \n'), []);
});

test('границы: только заголовки', () => {
  const src = '# A\n## B';
  const units = parseSelectionUnits(src);
  assert.deepEqual(shape(units), [
    { kind: 'section', text: '# A', children: [{ kind: 'section', text: '## B', children: [] }] },
  ]);
  assertDisjointRanges(src, units);
});

test('границы: одна единица на любом виде', () => {
  assert.equal(parseSelectionUnits('слово').length, 1);
  assert.equal(parseSelectionUnits('- пункт').length, 1);
  assert.equal(parseSelectionUnits('# Раздел').length, 1);
  assert.equal(parseSelectionUnits('абзац\nвторая строка').length, 1);
});

test('границы: глубокая вложенность списка', () => {
  const src = '- a\n  - b\n    - c';
  const units = parseSelectionUnits(src);
  assert.deepEqual(shape(units), [
    {
      kind: 'list',
      text: '- a',
      children: [
        { kind: 'list', text: '  - b', children: [{ kind: 'list', text: '    - c', children: [] }] },
      ],
    },
  ]);
  assertDisjointRanges(src, units);
});

test('инвариант: текст ЛЮБОЙ единицы (включая списки) — точный срез своего диапазона', () => {
  const src =
    'вступление\n\n- один\n- два\n  - вложенный\n\n# Раздел\nтело\n\n## Подраздел\nтело 2';
  const units = parseSelectionUnits(src);
  const check = (u: MarkdownUnit): void => {
    assert.equal(u.text, src.slice(u.start, u.end), `text !== slice для ${u.kind}`);
    u.children.forEach(check);
  };
  units.forEach(check);
  assertDisjointRanges(src, units);
});

// ---------------------------------------------------------------------------
// Хвост после вложенного списка: диапазоны родителя и детей не пересекаются
// ---------------------------------------------------------------------------

test('содержимое после вложенного списка: родитель до ребёнка, хвост — абзац-ребёнок', () => {
  const src = '- a\n\n  - b\n\n  c';
  const units = parseSelectionUnits(src);
  assert.deepEqual(shape(units), [
    {
      kind: 'list',
      text: '- a',
      children: [
        { kind: 'list', text: '  - b', children: [] },
        { kind: 'paragraph', text: '  c', children: [] },
      ],
    },
  ]);
  assert.deepEqual(ranges(units).sort((a, b) => a[0] - b[0]), [
    [0, 3],
    [5, 10],
    [12, 15],
  ]);
  assertDisjointRanges(src, units);
});

test('содержимое после вложенного списка: длинный пункт и фенс в хвосте', () => {
  const withText = '- пункт первый\n\n  - вложенный\n\n  хвост пункта';
  const units = parseSelectionUnits(withText);
  assert.deepEqual(shape(units), [
    {
      kind: 'list',
      text: '- пункт первый',
      children: [
        { kind: 'list', text: '  - вложенный', children: [] },
        { kind: 'paragraph', text: '  хвост пункта', children: [] },
      ],
    },
  ]);
  assertDisjointRanges(withText, units);

  const withFence = '- a\n\n  - b\n\n  ```\n  code\n  ```';
  const fenced = parseSelectionUnits(withFence);
  assert.deepEqual(shape(fenced), [
    {
      kind: 'list',
      text: '- a',
      children: [
        { kind: 'list', text: '  - b', children: [] },
        { kind: 'paragraph', text: '  ```\n  code\n  ```', children: [] },
      ],
    },
  ]);
  assertDisjointRanges(withFence, fenced);
});

test('многоабзацный пункт без вложенности: text сохраняет пустую строку', () => {
  const src = '- первый абзац\n\n  второй абзац';
  const units = parseSelectionUnits(src);
  assert.equal(units.length, 1);
  assert.equal(units[0]!.kind, 'list');
  assert.equal(units[0]!.text, src);
  assert.equal(units[0]!.text, src.slice(units[0]!.start, units[0]!.end));
});

test('пустой пункт единицы не даёт', () => {
  const units = parseSelectionUnits('-\n- второй');
  assert.deepEqual(shape(units), [{ kind: 'list', text: '- второй', children: [] }]);
});

test('не-строка отвергается', () => {
  assert.throws(() => parseSelectionUnits(42 as unknown as string), /must be a string/);
});
