/**
 * Юнит-тесты чистого модуля программных растровых ассертов
 * (`client/scripts/ui-probe-image.mjs`, задача 38ef87cc).
 *
 * PNG собирается прямо в тесте (zlib + ручной CRC): так проверяется и декодер,
 * и все виды проверок региона — без запуска клиента.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

import {
  ImageError,
  decodePng,
  hexColor,
  parseColor,
  runRegionChecks,
} from '../scripts/ui-probe-image.mjs';

/** CRC32 (IEEE) для чанков PNG. */
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** Собрать PNG 8-бит из строк пикселей (без фильтрации). */
function pngFromRows(width: number, height: number, colorType: number, rows: Buffer[]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const raw = Buffer.concat(rows.map((row) => Buffer.concat([Buffer.from([0]), row])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** PNG RGBA из массива пикселей. */
function rgbaPng(width: number, height: number, pixels: ReadonlyArray<[number, number, number, number]>): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(width * 4);
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixels[y * width + x] ?? [0, 0, 0, 0];
      row.writeUInt8(r, x * 4);
      row.writeUInt8(g, x * 4 + 1);
      row.writeUInt8(b, x * 4 + 2);
      row.writeUInt8(a, x * 4 + 3);
    }
    rows.push(row);
  }
  return pngFromRows(width, height, 6, rows);
}

test('decodePng: RGBA 8-бит → пиксели 1:1', () => {
  const png = rgbaPng(2, 1, [
    [255, 0, 0, 255],
    [0, 0, 255, 255],
  ]);
  const image = decodePng(png);
  assert.equal(image.width, 2);
  assert.equal(image.height, 1);
  assert.deepEqual(Array.from(image.data), [255, 0, 0, 255, 0, 0, 255, 255]);
});

test('decodePng: RGB 8-бит разворачивается в RGBA с alpha=255', () => {
  const rows = [Buffer.from([10, 20, 30, 40, 50, 60])];
  const png = pngFromRows(2, 1, 2, rows);
  const image = decodePng(png);
  assert.deepEqual(Array.from(image.data), [10, 20, 30, 255, 40, 50, 60, 255]);
});

test('decodePng: не-PNG и обрезанный буфер — ImageError', () => {
  assert.throws(() => decodePng(Buffer.from('not a png')), ImageError);
  assert.throws(() => decodePng(Buffer.alloc(4)), ImageError);
});

test('parseColor/hexColor: #rgb, #rrggbb и обратно', () => {
  assert.deepEqual(parseColor('#ff0000'), [255, 0, 0]);
  assert.deepEqual(parseColor('00ff00'), [0, 255, 0]);
  assert.deepEqual(parseColor('#0f0'), [0, 255, 0]);
  assert.equal(hexColor([255, 0, 0]), '#ff0000');
  assert.equal(hexColor([0, 255, 0]), '#00ff00');
  assert.throws(() => parseColor('rgb(1,2,3)'), ImageError);
});

test('runRegionChecks: notBlank сравнивает с фоном [0,0]', () => {
  const png = rgbaPng(2, 2, [
    [0, 0, 0, 255],
    [255, 255, 255, 255],
    [0, 0, 0, 255],
    [0, 0, 0, 255],
  ]);
  const image = decodePng(png);
  const ok = runRegionChecks(image, [{ kind: 'notBlank', name: 'a', minRatio: 0.2 }]);
  assert.equal(ok[0]?.ok, true);
  assert.match(ok[0]?.fact ?? '', /0\.25/);
  const fail = runRegionChecks(image, [{ kind: 'notBlank', name: 'b', minRatio: 0.3 }]);
  assert.equal(fail[0]?.ok, false);
});

test('runRegionChecks: colorAt, hasColor и distinct', () => {
  const png = rgbaPng(2, 1, [
    [255, 255, 255, 255],
    [0, 0, 0, 255],
  ]);
  const image = decodePng(png);
  const [colorAt] = runRegionChecks(image, [
    { kind: 'colorAt', name: 'p', at: [0, 0], color: '#ffffff', tolerance: 0 },
  ]);
  assert.equal(colorAt?.ok, true);
  assert.match(colorAt?.fact ?? '', /#ffffff/);
  const [bad] = runRegionChecks(image, [
    { kind: 'colorAt', name: 'p2', at: [1, 0], color: '#ffffff', tolerance: 4 },
  ]);
  assert.equal(bad?.ok, false);
  const [hasColor] = runRegionChecks(image, [
    { kind: 'hasColor', name: 'h', color: '#000000', tolerance: 0, minPixels: 1 },
  ]);
  assert.equal(hasColor?.ok, true);
  const [distinct] = runRegionChecks(image, [{ kind: 'distinct', name: 'd', minColors: 2 }]);
  assert.equal(distinct?.ok, true);
  const [tooMany] = runRegionChecks(image, [{ kind: 'distinct', name: 'd2', minColors: 5 }]);
  assert.equal(tooMany?.ok, false);
});

test('runRegionChecks: colorAt вне кропа — провал с текстом, без исключения', () => {
  const png = rgbaPng(1, 1, [[1, 2, 3, 255]]);
  const image = decodePng(png);
  const [result] = runRegionChecks(image, [
    { kind: 'colorAt', name: 'oob', at: [5, 5], color: '#000000', tolerance: 0 },
  ]);
  assert.equal(result?.ok, false);
  assert.match(result?.fact ?? '', /вне кропа/);
});
