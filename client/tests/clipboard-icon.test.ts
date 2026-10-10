/**
 * Разбор буфера обмена для диалога иконки (задача 78eaf07a,
 * `client/src/renderer/editor/clipboard-icon.ts`): эвристика «текст буфера —
 * ровно один эмодзи» и сборка `File` из `data:`-URL картинки. Модуль чистый
 * (без DOM) — проверяется в Node напрямую.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  emojiFromClipboardText,
  fileFromImageDataUrl,
} from '../src/renderer/editor/clipboard-icon.js';

describe('emojiFromClipboardText: эмодзи из текста буфера (78eaf07a)', () => {
  it('принимает одиночный эмодзи (в т.ч. с пробелами вокруг)', () => {
    assert.equal(emojiFromClipboardText('😀'), '😀');
    assert.equal(emojiFromClipboardText('  🚀 '), '🚀');
  });

  it('принимает составной эмодзи — один графемный кластер', () => {
    // ZWJ-последовательность семьи — несколько код-поинтов, но один кластер.
    assert.equal(emojiFromClipboardText('👨‍👩‍👧'), '👨‍👩‍👧');
    // Тон кожи — тоже один кластер.
    assert.equal(emojiFromClipboardText('👍🏽'), '👍🏽');
  });

  it('принимает ФЛАГИ — пара Regional_Indicator без Extended_Pictographic (78eaf07a)', () => {
    assert.equal(emojiFromClipboardText('🇷🇺'), '🇷🇺');
    assert.equal(emojiFromClipboardText('🇺🇸'), '🇺🇸');
    assert.equal(emojiFromClipboardText('  🇩🇪 '), '🇩🇪', 'флаг с пробелами вокруг');
    // Одиночный региональный индикатор — не флаг.
    assert.equal(emojiFromClipboardText('\u{1F1F7}'), null);
  });

  it('принимает keycap-последовательности (78eaf07a)', () => {
    assert.equal(emojiFromClipboardText('#️⃣'), '#️⃣');
    assert.equal(emojiFromClipboardText('*️⃣'), '*️⃣');
    assert.equal(emojiFromClipboardText('1️⃣'), '1️⃣');
    // Решётка/звёздочка/цифра БЕЗ U+20E3 — не keycap.
    assert.equal(emojiFromClipboardText('#'), null);
    assert.equal(emojiFromClipboardText('*'), null);
  });

  it('отвергает буквы/цифры и обычный текст', () => {
    assert.equal(emojiFromClipboardText('abc'), null);
    assert.equal(emojiFromClipboardText('a😀'), null, 'буква рядом — не эмодзи-иконка');
    assert.equal(emojiFromClipboardText('1'), null);
    assert.equal(emojiFromClipboardText('12'), null, 'две цифры — не keycap');
    assert.equal(emojiFromClipboardText('тест'), null);
  });

  it('отвергает пустое/несколько кластеров/null', () => {
    assert.equal(emojiFromClipboardText(null), null);
    assert.equal(emojiFromClipboardText(''), null);
    assert.equal(emojiFromClipboardText('   '), null);
    assert.equal(emojiFromClipboardText('😀😀'), null, 'два эмодзи — не один кластер');
  });
});

describe('fileFromImageDataUrl: File из data:-URL картинки (78eaf07a)', () => {
  it('собирает PNG-файл с именем clipboard-<ts>.png и точным размером', () => {
    // 3 байта: 0x01 0x02 0x03.
    const dataUrl = 'data:image/png;base64,AQID';
    const file = fileFromImageDataUrl(dataUrl, 1234);
    assert.ok(file instanceof File, 'вернулся File');
    assert.equal((file as File).name, 'clipboard-1234.png');
    assert.equal((file as File).type, 'image/png');
    assert.equal((file as File).size, 3);
  });

  it('расширение следует mime (jpeg → .jpg)', () => {
    const file = fileFromImageDataUrl('data:image/jpeg;base64,AQID', 7);
    assert.equal((file as File).name, 'clipboard-7.jpg');
    assert.equal((file as File).type, 'image/jpeg');
  });

  it('не картинка / битый URL → null', () => {
    assert.equal(fileFromImageDataUrl('data:text/plain;base64,AQID', 1), null);
    assert.equal(fileFromImageDataUrl('https://example.test/a.png', 1), null);
    assert.equal(fileFromImageDataUrl('data:image/png;base64,!!!!', 1), null, 'битый base64');
  });
});
