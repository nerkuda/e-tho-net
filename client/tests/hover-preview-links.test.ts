/**
 * Unit tests for the pure helpers behind the stage-2 comment-text link
 * previews (task «Предпросмотр содержимого с зажатым Ctrl», stage 2/3):
 * `fileNameFromUrl` (the "full file name" shown in the fallback popup) and
 * `looksLikeText` (the byte-sniff heuristic used when the `etnimg` protocol
 * only reports a generic `application/octet-stream` content type). Pure —
 * no DOM (importing the module itself must stay side-effect-free; it only
 * touches `document`/`window` inside `initHoverPreview()`, never called here).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hoverPreviewInternals } from '../src/renderer/lib/hover-preview.js';

const { fileNameFromUrl, looksLikeText } = hoverPreviewInternals;

test('fileNameFromUrl: базовое имя из пути etnimg://', () => {
  assert.equal(fileNameFromUrl('etnimg://c/reports/report.pdf'), 'report.pdf');
});

test('fileNameFromUrl: декодирует проценты (кириллица/пробелы)', () => {
  assert.equal(
    fileNameFromUrl('etnimg://c/%D0%9E%D1%82%D1%87%D0%B5%D1%82%20%D0%B7%D0%B0%20%D0%B8%D1%8E%D0%BD%D1%8C.docx'),
    'Отчет за июнь.docx',
  );
});

test('fileNameFromUrl: пустой путь → сам href', () => {
  assert.equal(fileNameFromUrl('etnimg://c'), 'etnimg://c');
});

test('fileNameFromUrl: некорректный URL → сам href как fallback', () => {
  assert.equal(fileNameFromUrl('not a url at all'), 'not a url at all');
});

test('fileNameFromUrl: работает и для обычных http(s)-адресов', () => {
  assert.equal(fileNameFromUrl('https://example.com/path/to/file.csv?x=1'), 'file.csv');
});

test('looksLikeText: пустой буфер — считается текстом (нечего проверять)', () => {
  assert.equal(looksLikeText(new ArrayBuffer(0)), true);
});

test('looksLikeText: печатный ASCII-текст — true', () => {
  const bytes = new TextEncoder().encode('function main() {\n  return 42;\n}\n');
  assert.equal(looksLikeText(bytes.buffer), true);
});

test('looksLikeText: UTF-8 с кириллицей — true (байты >= 0x80 считаются частью текста)', () => {
  const bytes = new TextEncoder().encode('Привет, мир! Строка с кириллицей.');
  assert.equal(looksLikeText(bytes.buffer), true);
});

test('looksLikeText: NUL-байт где угодно — сразу false (бинарник)', () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00]);
  assert.equal(looksLikeText(bytes.buffer), false);
});

test('looksLikeText: преимущественно непечатные байты без NUL — false', () => {
  const bytes = new Uint8Array(200).fill(0x01); // control char, not in the whitelist, no NUL
  assert.equal(looksLikeText(bytes.buffer), false);
});
