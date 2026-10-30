/**
 * Пустые строки markdown-исходника в просмотре (ошибка `7f017ce1`:
 * «При просмотре комментариев исчезают переводы строк»).
 *
 * Симптом: в режиме правки каждая пустая строка исходника видна, а в просмотре
 * они исчезают — между пунктами списка пропадают полностью, две и более пустых
 * строки между блоками схлопываются в одну, ведущие и хвостовые пустые строки
 * не показываются вовсе. Причина — markdown-it нормализует пустые строки, а
 * зазор в просмотре задавал только CSS-отступ у `p/ul/ol/pre/table`
 * (`--md-block-gap`): у `li` его нет, а несколько пустых строк дают тот же
 * один отступ.
 *
 * Фикстуры (`tests/fixtures/`) — снимки РЕАЛЬНЫХ данных (стандарт планки тестов
 * `cf236d42`/`004c2c96`), а не рукодельные мини-сеты:
 *   * `real-list-blank-lines.md` — байт-в-байт слайс постоянного комментария
 *     `d03269f3-e7d2-5091-abe3-b8c50b2c8bf5` (мысль `5de0332d`): вступление и
 *     два пункта нумерованного списка, между пунктами — пустая строка;
 *   * `real-map-blocks.md` — байт-в-байт слайс реального документа
 *     `client/tests/fixtures/real-markdown/etn-map-desktop.md` (строки 1–13):
 *     заголовок, цитата, абзац, таблица и блок кода без пустых строк между
 *     ними — сторож «ложных» пустых строк.
 *
 * Краевые случаи, которых в реальных комментариях пока нет (серии из 2+
 * пустых строк, ведущие/хвостовые пустые строки, пустая строка внутри цитаты),
 * получены из этих же снимков минимальной правкой исходника — так проверяется
 * ВЕСЬ класс, а не одна встреченная обёртка.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { renderMarkdown } from '../src/index.ts';

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures');

/** Снимок фикстуры байт-в-байт (файлы записаны без завершающего перевода строки). */
function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

/** Маркер пустой строки в выводе рендерера. */
const MARKER_RE = /<div class="md-blank-line" aria-hidden="true">((?:<br>)*)<\/div>/g;

/** Число пустых строк в каждом маркере вывода, в порядке документа. */
function blankCounts(html: string): number[] {
  return [...html.matchAll(MARKER_RE)].map((m) => (m[1]!.match(/<br>/g) ?? []).length);
}

/** Исходник фикстуры с серией из `lines` пустых строк в заданном месте. */
function withBlankRun(source: string, insertBefore: string, lines: number): string {
  const at = source.indexOf(insertBefore);
  assert.notEqual(at, -1, `в фикстуре нет фрагмента «${insertBefore}»`);
  // Одна пустая строка в месте вставки уже есть (между блоками) — добавляем остальные.
  return `${source.slice(0, at)}${'\n'.repeat(lines - 1)}${source.slice(at)}`;
}

describe('пустые строки исходника в просмотре (7f017ce1)', () => {
  it('реальный список: пустая строка между пунктами — пустая строка в просмотре', () => {
    const html = renderMarkdown(readFixture('real-list-blank-lines.md'));
    assert.deepEqual(
      blankCounts(html),
      [1, 1],
      'два разрыва: абзац → список и между пунктами списка (по одной пустой строке)',
    );
    assert.match(
      html,
      /<li>\s*<p>[^]*?<\/p>\s*<div class="md-blank-line" aria-hidden="true"><br><\/div>\s*<\/li>/,
      'пустая строка между пунктами списка принадлежит пункту — иначе она теряется (li без полей)',
    );
  });

  it('реальные блоки без пустых строк: лишних маркеров нет (в т.ч. в таблице)', () => {
    const html = renderMarkdown(readFixture('real-map-blocks.md'));
    assert.deepEqual(
      blankCounts(html),
      [1],
      'единственная пустая строка снимка — между абзацем и блоком кода',
    );
    assert.doesNotMatch(
      html,
      /<thead>[^]*?md-blank-line[^]*?<tbody>/,
      'между thead и tbody пустой строки нет: строка разделителя таблицы — не пустая строка исходника',
    );
    assert.match(html, /<blockquote>[\s\S]*?<\/blockquote>/, 'цитата реального снимка отрисована');
  });

  it('серия из трёх пустых строк между пунктами даёт три пустые строки', () => {
    const source = withBlankRun(readFixture('real-list-blank-lines.md'), '2. **Двойной клик', 3);
    assert.deepEqual(blankCounts(renderMarkdown(source)), [1, 3]);
  });

  it('ведущие пустые строки показываются', () => {
    const source = `\n\n${readFixture('real-list-blank-lines.md')}`;
    assert.deepEqual(blankCounts(renderMarkdown(source)), [2, 1, 1]);
  });

  it('хвостовые пустые строки показываются', () => {
    const source = `${readFixture('real-list-blank-lines.md')}\n\n\n`;
    const html = renderMarkdown(source);
    const counts = blankCounts(html);
    // Разрыв абзац → список (1) + между пунктами (1) + хвостовые (3). Хвостовые
    // строки markdown-it относит к последнему пункту списка, поэтому они делятся
    // между маркером внутри `li` и маркером после списка — на просмотр это не
    // влияет, важна суммарная высота.
    assert.equal(counts.reduce((sum, n) => sum + n, 0), 5);
    assert.match(
      html,
      /<\/ol>\s*<div class="md-blank-line" aria-hidden="true"><br><\/div>\s*$/,
      'после списка в конце документа остаётся пустая строка',
    );
  });

  it('пустая строка внутри цитаты показывается (реальная цитата + пустая строка цитаты)', () => {
    const source = '> Это - выдержка из документации пользователя.\n>\n> Вторая строка цитаты.';
    const html = renderMarkdown(source);
    assert.deepEqual(blankCounts(html), [1]);
    assert.match(
      html,
      /<blockquote>\s*<p>[^]*?<\/p>\s*<div class="md-blank-line" aria-hidden="true"><br><\/div>\s*<p>Вторая строка цитаты\.<\/p>\s*<\/blockquote>/,
      'пустая строка цитаты — внутри блока цитаты, между её абзацами',
    );
  });

  it('пустые строки внутри пункта списка между абзацами показываются', () => {
    const source = '- пункт A\n\n  второй абзац пункта\n\n- пункт B';
    assert.deepEqual(blankCounts(renderMarkdown(source)), [1, 1]);
  });

  it('экранированный HTML-блок не ломает подсчёт пустых строк', () => {
    const html = renderMarkdown('<div>a</div>\n\n\n<div>b</div>');
    assert.deepEqual(blankCounts(html), [2]);
    assert.doesNotMatch(html, /<div>a<\/div>/, 'сырой HTML остаётся экранированным (html: false)');
  });

  it('разметка позиций не мешает маркерам пустых строк', () => {
    const source = readFixture('real-list-blank-lines.md');
    const plain = renderMarkdown(source);
    const mapped = renderMarkdown(source, { sourceMap: true });
    assert.deepEqual(blankCounts(mapped), blankCounts(plain));
    assert.doesNotMatch(
      mapped,
      /md-blank-line" data-md-/,
      'маркер пустой строки не участвует в маппинге позиций',
    );
  });

  it('пустой документ и документ из одних пустых строк не дают блоков', () => {
    assert.deepEqual(blankCounts(renderMarkdown('')), []);
    assert.equal(renderMarkdown('').trim(), '');
  });
});
