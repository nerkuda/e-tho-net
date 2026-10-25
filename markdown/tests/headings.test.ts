/**
 * Unit tests of the heading API of the single renderer package
 * (ошибка f15f389e, круги 2–3; ADR `01ec1467`). Pure: source in, headings or
 * a heading block out — no DB, no DOM.
 *
 * Правила под тестом:
 *   1. заголовки берутся из block-токенов markdown-it, а не строчной
 *      регуляркой: fenced/indented-код и контейнеры учитываются так же, как
 *      у рендерера;
 *   2. `tokenLevel > 0` — заголовок внутри списка/цитаты (секцией документа
 *      не является, решает вызывающий код);
 *   3. ATX: 0–3 ведущих пробела, закрывающие решётки и окружающие пробелы в
 *      текст не входят; пустой `##` даёт текст `''`;
 *   4. setext: одна или несколько строк текста + подчёркивание; `line` —
 *      первая строка текста, `contentLine` — строка после подчёркивания;
 *   5. `formatHeading` — обратная операция: многострочный текст печатается
 *      setext-блоком (ATX его не выражает — строки стали бы абзацем).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractHeadings, formatHeading } from '../src/index.js';

test('ATX: уровни, 0–3 ведущих пробела, закрывающие решётки', () => {
  const src = [
    '# H1',
    '  ## H2 ##',
    '### H3',
    '',
    '#### H4',
    '##### H5',
    '###### H6',
    '####### не заголовок',
  ].join('\n');
  assert.deepEqual(extractHeadings(src), [
    { level: 1, text: 'H1', line: 0, contentLine: 1, tokenLevel: 0 },
    { level: 2, text: 'H2', line: 1, contentLine: 2, tokenLevel: 0 },
    { level: 3, text: 'H3', line: 2, contentLine: 3, tokenLevel: 0 },
    { level: 4, text: 'H4', line: 4, contentLine: 5, tokenLevel: 0 },
    { level: 5, text: 'H5', line: 5, contentLine: 6, tokenLevel: 0 },
    { level: 6, text: 'H6', line: 6, contentLine: 7, tokenLevel: 0 },
  ]);
});

test('setext: одиночный h1 и многострочный h2', () => {
  const src = ['Один', '===', 'текст', '', 'Две', 'строки', '---', 'ещё'].join('\n');
  assert.deepEqual(extractHeadings(src), [
    { level: 1, text: 'Один', line: 0, contentLine: 2, tokenLevel: 0 },
    { level: 2, text: 'Две\nстроки', line: 4, contentLine: 7, tokenLevel: 0 },
  ]);
});

test('заголовок внутри списка и цитаты: tokenLevel > 0', () => {
  const src = ['- ## X', '  продолжение', '', '> ## Y', '> текст', '', '## Z'].join('\n');
  assert.deepEqual(extractHeadings(src), [
    { level: 2, text: 'X', line: 0, contentLine: 1, tokenLevel: 2 },
    { level: 2, text: 'Y', line: 3, contentLine: 4, tokenLevel: 1 },
    { level: 2, text: 'Z', line: 6, contentLine: 7, tokenLevel: 0 },
  ]);
});

test('fenced (``` и ~~~) и indented-код заголовков не дают', () => {
  const src = [
    '```',
    '## fake',
    '```',
    '',
    '~~~',
    '## fake2',
    '~~~',
    '',
    '    ## indented',
    '',
    '## real',
  ].join('\n');
  assert.deepEqual(extractHeadings(src), [
    { level: 2, text: 'real', line: 10, contentLine: 11, tokenLevel: 0 },
  ]);
});

test('CRLF и пустой ATX-заголовок `##`', () => {
  assert.deepEqual(extractHeadings('##\r\n\r\n## B\r\n'), [
    { level: 2, text: '', line: 0, contentLine: 1, tokenLevel: 0 },
    { level: 2, text: 'B', line: 2, contentLine: 3, tokenLevel: 0 },
  ]);
});

test('formatHeading: ATX, пустой заголовок, однострочный setext → ATX', () => {
  assert.equal(formatHeading(1, 'Внимание'), '# Внимание');
  assert.equal(formatHeading(2, 'X'), '## X');
  assert.equal(formatHeading(2, ''), '##');
});

test('formatHeading: многострочный setext сохраняется и разбирается обратно', () => {
  const text = 'Внимание\nЭто важно';
  const out = formatHeading(2, text);
  assert.equal(out, 'Внимание\nЭто важно\n---------');
  assert.deepEqual(extractHeadings(out), [
    { level: 2, text, line: 0, contentLine: 3, tokenLevel: 0 },
  ]);
  // Уровень 1 подчёркивается `=`, минимальная длина — 3.
  assert.equal(formatHeading(1, 'A\nB'), 'A\nB\n===');
});

test('formatHeading: уровни вне 1..6 и многострочный текст выше h2 — ошибка', () => {
  assert.throws(() => formatHeading(0, 'A'), /level must be 1\.\.6/);
  assert.throws(() => formatHeading(7, 'A'), /level must be 1\.\.6/);
  assert.throws(() => formatHeading(3, 'A\nB'), /setext \(level 1-2\)/);
});
