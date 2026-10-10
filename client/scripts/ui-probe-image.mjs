/**
 * Программные ассерты растровых проверок стенда UI (`ui-probe.mjs`, задача
 * 38ef87cc).
 *
 * Модуль чистый: декодирует PNG-снимок `Page.captureScreenshot` в массив RGBA
 * и прогоняет по нему набор проверок, возвращая ТЕКСТОВЫЕ факты. Модель
 * получает результат текстом («кроп непустой», «пиксель #1b1b1b»), а не
 * картинку, — это требование задачи (PNG до модели не доходят; картинка
 * остаётся только доказательством ошибки).
 *
 * Зависимостей нет: PNG разбирается встроенным `node:zlib` (inflate) и ручным
 * реверсом фильтров строк. Поддержаны 8-битные неиндексированные PNG
 * (`grayscale`/`rgb`/`rgb+alpha`/`grayscale+alpha`) — именно в таком виде
 * Chromium отдаёт `Page.captureScreenshot`. 16-битные, индексированные и
 * интерлейсные PNG отвергаются понятной ошибкой: стенду они не нужны.
 *
 * Проверки (регион адресуется как `clip` у шага `shot`):
 *   - `notBlank`      — доля пикселей, отличных от фонового (пиксель [0,0]);
 *                       утверждает `>= minRatio` (по умолчанию 0.02);
 *   - `colorAt`       — цвет пикселя региона по смещению `at: [dx, dy]`;
 *                       утверждает совпадение с `color` в допуске `tolerance`;
 *   - `hasColor`      — число пикселей в допуске от `color`; утверждает
 *                       `>= minPixels` (по умолчанию 1);
 *   - `distinct`      — число различимых (квантованных) цветов региона;
 *                       утверждает `>= minColors` (по умолчанию 2).
 *
 * Каждая проверка возвращает `{ name, ok, fact, expect }`: `fact` — что
 * получилось (текстом), `expect` — что ожидалось. Раннер печатает пару
 * «факт/ожидание» в отчёт и валит шаг, если `ok === false`.
 */

import { inflateSync } from 'node:zlib';

/** Ошибка разбора/проверки изображения (отличается от провала шага). */
export class ImageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImageError';
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Число каналов на пиксель по типу цвета PNG. */
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Декодировать PNG в `{ width, height, data }` (`data` — RGBA, 4 байта/пиксель).
 *
 * @param {Buffer} buffer — байты PNG.
 */
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new ImageError('это не PNG: сигнатура не совпала');
  }
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) throw new ImageError('PNG обрезан: чанк выходит за границу файла');
    if (type === 'IHDR') {
      header = {
        width: buffer.readUInt32BE(start),
        height: buffer.readUInt32BE(start + 4),
        depth: buffer[start + 8],
        colorType: buffer[start + 9],
        compression: buffer[start + 10],
        filter: buffer[start + 11],
        interlace: buffer[start + 12],
      };
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4; // + CRC
  }
  if (header === null) throw new ImageError('PNG без чанка IHDR');
  if (header.depth !== 8) throw new ImageError(`поддержан только 8-битный PNG (получено ${header.depth})`);
  if (!(header.colorType in CHANNELS)) {
    throw new ImageError(`неподдержанный тип цвета PNG: ${header.colorType}`);
  }
  if (header.interlace !== 0) throw new ImageError('интерлейсный PNG не поддержан');
  if (header.compression !== 0 || header.filter !== 0) {
    throw new ImageError('PNG с нестандартной компрессией/фильтрацией');
  }
  if (idat.length === 0) throw new ImageError('PNG без данных изображения (IDAT)');

  const channels = CHANNELS[header.colorType];
  const { width, height } = header;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const expected = (stride + 1) * height;
  if (raw.length < expected) {
    throw new ImageError(`распакованных данных меньше ожидаемого (${raw.length} < ${expected})`);
  }

  const pixels = unfilter(raw, width, height, channels, stride);
  return { width, height, data: toRgba(pixels, header.colorType, width, height) };
}

/** Реверс фильтров PNG (типы 0–4) в буфер без байтов фильтра. */
function unfilter(raw, width, height, channels, stride) {
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const outStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[rowStart + x];
      const left = x >= channels ? out[outStart + x - channels] : 0;
      const up = y > 0 ? out[prevStart + x] : 0;
      const upLeft = y > 0 && x >= channels ? out[prevStart + x - channels] : 0;
      let restored;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + ((left + up) >> 1);
          break;
        case 4:
          restored = value + paeth(left, up, upLeft);
          break;
        default:
          throw new ImageError(`неизвестный тип фильтра PNG: ${filter}`);
      }
      out[outStart + x] = restored & 0xff;
    }
  }
  return out;
}

/** Предиктор Paeth для фильтра 4. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Привести распакованные пиксели любого типа цвета к RGBA. */
function toRgba(pixels, colorType, width, height) {
  const count = width * height;
  const out = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i += 1) {
    let r;
    let g;
    let b;
    let a = 255;
    if (colorType === 0) {
      r = g = b = pixels[i];
    } else if (colorType === 2) {
      r = pixels[i * 3];
      g = pixels[i * 3 + 1];
      b = pixels[i * 3 + 2];
    } else if (colorType === 4) {
      r = g = b = pixels[i * 2];
      a = pixels[i * 2 + 1];
    } else {
      r = pixels[i * 4];
      g = pixels[i * 4 + 1];
      b = pixels[i * 4 + 2];
      a = pixels[i * 4 + 3];
    }
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = a;
  }
  return out;
}

/** RGBA-пиксель по координатам. */
function pixelAt(image, x, y) {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
}

/** Цвет пикселя в `#rrggbb` (альфа игнорируется). */
export function hexColor([r, g, b]) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Разобрать `#rgb`/`#rrggbb` в `[r, g, b]`. */
export function parseColor(text) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(text));
  if (m === null) throw new ImageError(`цвет «${text}» не разобран (ожидается #rgb или #rrggbb)`);
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Евклидово расстояние между цветами (0 — совпадают). */
function distance(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/**
 * Прогнать проверки по изображению.
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray}} image
 * @param {ReadonlyArray<object>} checks — нормализованные проверки шага `assert`.
 * @returns {Array<{name:string,ok:boolean,fact:string,expect:string}>}
 */
export function runRegionChecks(image, checks) {
  const results = [];
  for (const check of checks) {
    switch (check.kind) {
      case 'notBlank':
        results.push(checkNotBlank(image, check));
        break;
      case 'colorAt':
        results.push(checkColorAt(image, check));
        break;
      case 'hasColor':
        results.push(checkHasColor(image, check));
        break;
      case 'distinct':
        results.push(checkDistinct(image, check));
        break;
      default:
        throw new ImageError(`неизвестная проверка региона: ${check.kind}`);
    }
  }
  return results;
}

function checkNotBlank(image, check) {
  const tolerance = check.tolerance ?? 16;
  const minRatio = check.minRatio ?? 0.02;
  const bg = pixelAt(image, 0, 0);
  let differing = 0;
  const total = image.width * image.height;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (distance(pixelAt(image, x, y), bg) > tolerance) differing += 1;
    }
  }
  const ratio = total === 0 ? 0 : differing / total;
  return {
    name: check.name,
    ok: ratio >= minRatio,
    fact: `доля непустых пикселей ${ratio.toFixed(4)}`,
    expect: `>= ${minRatio}`,
  };
}

function checkColorAt(image, check) {
  const [dx, dy] = check.at;
  const tolerance = check.tolerance ?? 8;
  if (dx >= image.width || dy >= image.height) {
    return {
      name: check.name,
      ok: false,
      fact: `точка [${dx}, ${dy}] вне кропа ${image.width}×${image.height}`,
      expect: `пиксель ${check.color} ± ${tolerance}`,
    };
  }
  const actual = pixelAt(image, dx, dy);
  const wanted = parseColor(check.color);
  const delta = distance(actual, wanted);
  return {
    name: check.name,
    ok: delta <= tolerance,
    fact: `пиксель ${hexColor(actual)} (Δ ${delta.toFixed(1)})`,
    expect: `${check.color} ± ${tolerance}`,
  };
}

function checkHasColor(image, check) {
  const tolerance = check.tolerance ?? 8;
  const minPixels = check.minPixels ?? 1;
  const wanted = parseColor(check.color);
  let count = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (distance(pixelAt(image, x, y), wanted) <= tolerance) count += 1;
    }
  }
  return {
    name: check.name,
    ok: count >= minPixels,
    fact: `пикселей ${check.color} ± ${tolerance}: ${count}`,
    expect: `>= ${minPixels}`,
  };
}

function checkDistinct(image, check) {
  const minColors = check.minColors ?? 2;
  const seen = new Set();
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const [r, g, b] = pixelAt(image, x, y);
      // Квантование 16 уровней на канал — устойчиво к сглаживанию/шумам.
      seen.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    }
  }
  return {
    name: check.name,
    ok: seen.size >= minColors,
    fact: `различимых цветов: ${seen.size}`,
    expect: `>= ${minColors}`,
  };
}
