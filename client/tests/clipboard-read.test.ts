/**
 * Чтение системного буфера обмена главным процессом (задача 78eaf07a,
 * `client/src/main/ipc/clipboard.ts`).
 *
 * Обработчик IPC тонок (ленивый `import('electron')` + вызов), а вся логика
 * чтения вынесена в {@link readClipboard} с инъектируемым `ClipboardReader` —
 * её и проверяем без Electron-runtime (паттерн main-тестов, `client-log.ts`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readClipboard, type ClipboardReader } from '../src/main/ipc/clipboard.js';

/** Заглушка Electron-`clipboard` с настраиваемым содержимым. */
function reader(opts: {
  text?: string;
  image?: string | null;
  throwOnText?: boolean;
}): ClipboardReader {
  return {
    readText: () => {
      if (opts.throwOnText === true) throw new Error('clipboard unavailable');
      return opts.text ?? '';
    },
    readImage: () => ({
      isEmpty: () => (opts.image ?? null) === null,
      toDataURL: () => opts.image ?? '',
    }),
  };
}

describe('readClipboard: содержимое буфера обмена (78eaf07a)', () => {
  it('текст + картинка возвращаются оба', () => {
    const result = readClipboard(reader({ text: '😀', image: 'data:image/png;base64,AAAA' }));
    assert.deepEqual(result, { text: '😀', imagePngDataUrl: 'data:image/png;base64,AAAA' });
  });

  it('пустой текст → null; пустая картинка → null', () => {
    assert.deepEqual(readClipboard(reader({ text: '' })), { text: null, imagePngDataUrl: null });
    assert.deepEqual(readClipboard(reader({ text: 'x', image: null })), {
      text: 'x',
      imagePngDataUrl: null,
    });
  });

  it('сбой чтения → пустой результат (без исключения)', () => {
    assert.deepEqual(readClipboard(reader({ throwOnText: true })), {
      text: null,
      imagePngDataUrl: null,
    });
  });
});
