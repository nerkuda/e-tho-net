/**
 * Unit tests for `buildContentDisposition` (ошибка 175b2803).
 *
 * Node не принимает не-латиницу в значении заголовка: любое имя файла из
 * пользовательских данных обязано попасть в заголовок в ASCII-виде —
 * RFC 5987 (`filename*`) плюс ASCII-fallback (`filename`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildContentDisposition } from '../src/http/content-disposition.js';

/** Заголовок не должен содержать ничего вне printable ASCII. */
function assertAsciiOnly(value: string): void {
  assert.match(value, /^[\x20-\x7e]+$/, `не-ASCII в заголовке: ${value}`);
}

describe('buildContentDisposition', () => {
  it('кириллическое имя: filename* RFC 5987 + ASCII-fallback', () => {
    const header = buildContentDisposition('attachment', 'etn-Кириллица-краш.etnx');
    assertAsciiOnly(header);
    assert.ok(header.startsWith('attachment; filename="'));
    assert.ok(
      header.includes("filename*=UTF-8''etn-%D0%9A%D0%B8%D1%80%D0%B8%D0%BB%D0%BB%D0%B8%D1%86%D0%B0-%D0%BA%D1%80%D0%B0%D1%88.etnx"),
      header,
    );
    const fallback = /filename="([^"]+)"/.exec(header)?.[1] ?? '';
    assertAsciiOnly(fallback);
    assert.match(fallback, /^etn-.*\.etnx$/);
  });

  it('inline-режим и ASCII-имя сохраняются без искажений', () => {
    const header = buildContentDisposition('inline', 'report.html');
    assert.equal(header, `inline; filename="report.html"; filename*=UTF-8''report.html`);
  });

  it('кавычки, обратные слэши и управляющие символы не ломают заголовок', () => {
    const header = buildContentDisposition('attachment', 'a"b\\c\nd.txt');
    assertAsciiOnly(header);
    const fallback = /filename="([^"]+)"/.exec(header)?.[1] ?? '';
    assert.equal(fallback, 'a_b_c_d.txt');
    // RFC 5987 кодирует кавычку/слэш/перевод строки процентно.
    assert.ok(header.includes("filename*=UTF-8''a%22b%5Cc%0Ad.txt"), header);
  });

  it('RFC 5987 до-кодирует символы, которые encodeURIComponent оставляет как есть', () => {
    const header = buildContentDisposition('attachment', "a'b(c)*d.txt");
    assert.ok(header.includes("UTF-8''a%27b%28c%29%2Ad.txt"), header);
  });

  it('пустое имя превращается в download', () => {
    assert.equal(buildContentDisposition('attachment', ''), `attachment; filename="download"; filename*=UTF-8''download`);
    assert.equal(buildContentDisposition('attachment', null), `attachment; filename="download"; filename*=UTF-8''download`);
  });
});
