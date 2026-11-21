/**
 * Позиционный разбор date-ссылок строки (0.16.1, задача 632eca85): правка
 * строки задачи сдвигает даты по позициям, поэтому границы ссылок и цель
 * обязаны совпадать с грамматикой единого рендерера.
 *
 * Проверяется: позиции ссылки и цели, форма с временем, алиас, а также то, что
 * inline-code и невалидные цели (`[[2026-01-05T10:00]]` — legacy-ссылка по
 * имени) date-ссылками не считаются.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findDateLinkSpans } from '../src/index.js';

describe('date-ссылки строки: позиционный разбор (findDateLinkSpans)', () => {
  it('находит date-ссылки и отдаёт позиции ссылки и цели', () => {
    const line = '- [ ] [[2026-11-20]] и [[2026-11-21 10:30]]';
    const spans = findDateLinkSpans(line);
    assert.equal(spans.length, 2);
    assert.deepEqual(spans[0]!.parts, { date: '2026-11-20', time: null });
    assert.equal(line.slice(spans[0]!.start, spans[0]!.end), '[[2026-11-20]]');
    assert.equal(line.slice(spans[0]!.targetStart, spans[0]!.targetEnd), '2026-11-20');
    assert.deepEqual(spans[1]!.parts, { date: '2026-11-21', time: '10:30' });
    assert.equal(line.slice(spans[1]!.start, spans[1]!.end), '[[2026-11-21 10:30]]');
    assert.equal(line.slice(spans[1]!.targetStart, spans[1]!.targetEnd), '2026-11-21 10:30');
  });

  it('цель с алиасом: диапазон ссылки покрывает её целиком, цель — только дата', () => {
    const line = '- [ ] [[2026-11-20|созвон]]';
    const [span] = findDateLinkSpans(line);
    assert.ok(span !== undefined);
    assert.equal(line.slice(span.start, span.end), '[[2026-11-20|созвон]]');
    assert.equal(line.slice(span.targetStart, span.targetEnd), '2026-11-20');
  });

  it('inline-code и невалидная цель датой не считаются', () => {
    const line = '- [ ] [[2026-11-20]] и [[2026-01-05T10:00]] и `[[2026-12-01]]`';
    const spans = findDateLinkSpans(line);
    assert.deepEqual(
      spans.map((span) => line.slice(span.targetStart, span.targetEnd)),
      ['2026-11-20'],
    );
  });

  it('невалидная календарная дата остаётся legacy-ссылкой по имени', () => {
    assert.deepEqual(findDateLinkSpans('[[2026-13-45]]'), []);
    assert.deepEqual(findDateLinkSpans('нет ссылок'), []);
  });
});
