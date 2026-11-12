/**
 * Чистые функции фоновой картинки карты (0.16.1, задача 80324150; сценарии
 * d9e8dba7 и 3fe62610, ревизия и2).
 *
 * Пороги задачи закреплены здесь числами: 3840 px по длинной стороне, 5 МиБ,
 * подложка по средней светлоте (≥0.5 → белая), тинт от расхождения светлоты
 * картинки и фона темы/слоя. Тесты — сторожа: изменение константы без правки
 * спеки роняет прогон.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  WALLPAPER_ALPHA_LUMINANCE_THRESHOLD,
  WALLPAPER_JPEG_QUALITY,
  WALLPAPER_MAX_BYTES,
  WALLPAPER_MAX_EDGE,
  WALLPAPER_TINT_ALPHA_MAX,
  WALLPAPER_TINT_ALPHA_MIN,
  WALLPAPER_TINT_LAYER_FACTOR,
  alphaBackdropColor,
  flattenPixels,
  hasTransparency,
  measurePixels,
  parseCssColor,
  planWallpaper,
  relativeLuminance,
  wallpaperMeta,
  wallpaperTargetSize,
  wallpaperTintAlpha,
  wallpaperTintColor,
} from '../src/renderer/lib/wallpaper-image.js';

/** RGBA-буфер из перечисленных пикселей `[r, g, b, a]`. */
function pixels(...values: Array<[number, number, number, number]>): Uint8ClampedArray {
  const out = new Uint8ClampedArray(values.length * 4);
  values.forEach(([r, g, b, a], index) => {
    out[index * 4] = r;
    out[index * 4 + 1] = g;
    out[index * 4 + 2] = b;
    out[index * 4 + 3] = a;
  });
  return out;
}

describe('константы задачи (спека 80324150)', () => {
  it('порог даунскейла, качество JPEG и лимит файла', () => {
    assert.equal(WALLPAPER_MAX_EDGE, 3840, 'длинная сторона — 3840 px');
    assert.equal(WALLPAPER_JPEG_QUALITY, 0.85, 'перекодирование — JPEG q0.85');
    assert.equal(WALLPAPER_MAX_BYTES, 5 * 1024 * 1024, 'серверный лимит — 5 МиБ');
    assert.equal(WALLPAPER_ALPHA_LUMINANCE_THRESHOLD, 0.5, 'порог подложки — 0.5');
  });
});

describe('wallpaperTargetSize: уменьшение по длинной стороне', () => {
  it('в пределах порога размер не меняется', () => {
    assert.deepEqual(wallpaperTargetSize(3840, 2160), { width: 3840, height: 2160 });
    assert.deepEqual(wallpaperTargetSize(1200, 800), { width: 1200, height: 800 });
  });

  it('крупнее порога — пропорции сохраняются, длинная сторона = 3840', () => {
    assert.deepEqual(wallpaperTargetSize(7680, 4320), { width: 3840, height: 2160 });
    assert.deepEqual(wallpaperTargetSize(6000, 6000), { width: 3840, height: 3840 });
    // Портретная ориентация: длинной стороной считается высота.
    assert.deepEqual(wallpaperTargetSize(2160, 7680), { width: 1080, height: 3840 });
  });

  it('вырожденный вход не даёт нулевых размеров', () => {
    assert.deepEqual(wallpaperTargetSize(0, 0), { width: 0, height: 0 });
    const tiny = wallpaperTargetSize(10000, 1);
    assert.equal(tiny.width, 3840);
    assert.ok(tiny.height >= 1);
  });
});

describe('planWallpaper: даунскейл и перекодирование', () => {
  const base = { width: 1920, height: 1080, byteLength: 1024 * 1024, hasAlpha: false };

  it('обычный файл в поддерживаемом формате сохраняет тип', () => {
    const plan = planWallpaper({ ...base, mime: 'image/png' });
    assert.equal(plan.downscaled, false);
    assert.equal(plan.encode_mime, 'image/png');
    assert.equal(plan.width, 1920);
  });

  it('длинная сторона > 3840 — даунскейл и JPEG', () => {
    const plan = planWallpaper({ ...base, width: 6000, height: 4000, mime: 'image/png' });
    assert.equal(plan.downscaled, true);
    assert.equal(plan.encode_mime, 'image/jpeg');
    assert.deepEqual({ width: plan.width, height: plan.height }, { width: 3840, height: 2560 });
  });

  it('файл > 5 МиБ — JPEG даже без даунскейла', () => {
    const plan = planWallpaper({ ...base, byteLength: WALLPAPER_MAX_BYTES + 1 });
    assert.equal(plan.downscaled, false);
    assert.equal(plan.encode_mime, 'image/jpeg');
  });

  it('неподдерживаемый сервером формат приводится к PNG', () => {
    const plan = planWallpaper({ ...base, mime: 'image/bmp' });
    assert.equal(plan.encode_mime, 'image/png');
  });

  it('прозрачность включает сведение на подложку', () => {
    assert.equal(planWallpaper({ ...base, hasAlpha: true }).flatten, true);
    assert.equal(planWallpaper(base).flatten, false);
  });
});

describe('подложка прозрачного PNG (ревизия и2)', () => {
  it('светлая картинка сводится на белую, тёмная — на чёрную', () => {
    assert.deepEqual(alphaBackdropColor(0.5), [255, 255, 255], 'ровно 0.5 — уже белая');
    assert.deepEqual(alphaBackdropColor(0.9), [255, 255, 255]);
    assert.deepEqual(alphaBackdropColor(0.49), [0, 0, 0]);
    assert.deepEqual(alphaBackdropColor(0), [0, 0, 0]);
  });

  it('hasTransparency видит полупрозрачный и прозрачный пиксель', () => {
    assert.equal(hasTransparency(pixels([255, 0, 0, 255])), false);
    assert.equal(hasTransparency(pixels([255, 0, 0, 255], [0, 255, 0, 128])), true);
    assert.equal(hasTransparency(pixels([0, 0, 0, 0])), true);
  });

  it('flattenPixels смешивает по альфе и делает результат непрозрачным', () => {
    const flattened = flattenPixels(pixels([255, 0, 0, 128]), [255, 255, 255]);
    // a = 128/255 ≈ 0.502: R = 255, G/B = 255·(1−a) ≈ 127
    assert.equal(flattened[3], 255, 'альфа результата — 255');
    assert.equal(flattened[0], 255, 'красный канал полностью перекрыт');
    assert.ok(Math.abs(flattened[1]! - 127) <= 1, 'зелёный — смесь с подложкой');
    assert.ok(Math.abs(flattened[2]! - 127) <= 1, 'синий — смесь с подложкой');
  });

  it('flattenPixels не меняет исходный буфер', () => {
    const source = pixels([10, 20, 30, 100]);
    flattenPixels(source, [0, 0, 0]);
    assert.deepEqual([...source], [10, 20, 30, 100]);
  });
});

describe('метаданные светлоты и тона', () => {
  it('относительная яркость: чёрный 0, белый 1', () => {
    assert.equal(relativeLuminance(0, 0, 0), 0);
    assert.equal(relativeLuminance(255, 255, 255), 1);
    // Зелёный вклад в яркость максимален из каналов.
    assert.ok(relativeLuminance(0, 255, 0) > relativeLuminance(255, 0, 0));
  });

  it('средняя светлота — среднее по пикселям', () => {
    const mixed = pixels([0, 0, 0, 255], [255, 255, 255, 255]);
    const measured = measurePixels(mixed);
    assert.ok(Math.abs(measured.avg_luminance - 0.5) < 1e-6, 'половина чёрного, половина белого');
  });

  it('прозрачные пиксели не влияют на светлоту (вес по альфе)', () => {
    const measured = measurePixels(pixels([0, 0, 0, 255], [255, 255, 255, 0]));
    assert.equal(measured.avg_luminance, 0, 'полностью прозрачный белый не учитывается');
  });

  it('доминирующий тон насыщенной картинки и отсутствие тона у серой', () => {
    const red = measurePixels(pixels([255, 0, 0, 255], [255, 0, 0, 255]));
    assert.equal(red.dominant_hue, 0, 'чистый красный — тон 0°');
    assert.ok(red.dominant_sat !== null && red.dominant_sat > 0.9);

    const gray = measurePixels(pixels([128, 128, 128, 255], [130, 130, 130, 255]));
    assert.equal(gray.dominant_hue, null, 'серая картинка тона не имеет');
    assert.equal(gray.dominant_sat, null);
  });

  it('circular mean: 350° и 10° дают тон около 0°, а не 180°', () => {
    // two hues around zero: magenta-ish (350°) and orange-red (10°)
    const measured = measurePixels(pixels([255, 0, 43, 255], [255, 43, 0, 255]));
    assert.ok(measured.dominant_hue !== null);
    const hue = measured.dominant_hue ?? 0;
    assert.ok(hue < 5 || hue > 355, `тон около 0°, получено ${hue}`);
  });

  it('wallpaperMeta переносит размеры итогового файла', () => {
    const meta = wallpaperMeta(1920, 1080, pixels([0, 0, 0, 255]));
    assert.equal(meta.width, 1920);
    assert.equal(meta.height, 1080);
    assert.equal(meta.avg_luminance, 0);
  });
});

describe('тинт подложки (сценарий 3fe62610)', () => {
  it('светлая картинка на тёмном фоне — плотнее, чем совпадающая по светлоте', () => {
    const same = wallpaperTintAlpha(0.1, 0.05, false);
    const contrast = wallpaperTintAlpha(0.95, 0.05, false);
    assert.ok(contrast > same, 'расхождение светлот усиливает вуаль');
    assert.ok(same >= WALLPAPER_TINT_ALPHA_MIN - 1e-9);
    assert.ok(contrast <= WALLPAPER_TINT_ALPHA_MAX + 1e-9);
  });

  it('в слое тинт прозрачнее основы', () => {
    const base = wallpaperTintAlpha(0.95, 0.05, false);
    const layer = wallpaperTintAlpha(0.95, 0.05, true);
    assert.ok(Math.abs(layer - base * WALLPAPER_TINT_LAYER_FACTOR) < 1e-9);
    assert.ok(layer < base);
  });

  it('тинт — rgba()-строка цвета фона темы', () => {
    assert.equal(wallpaperTintColor([14, 17, 22], 0.6), 'rgba(14, 17, 22, 0.6)');
    assert.equal(wallpaperTintColor([255, 255, 255], 1), 'rgba(255, 255, 255, 1)');
  });
});

describe('parseCssColor: токены темы', () => {
  it('hex-формы', () => {
    assert.deepEqual(parseCssColor('#0e1116'), [14, 17, 22]);
    assert.deepEqual(parseCssColor('#fff'), [255, 255, 255]);
    assert.deepEqual(parseCssColor('  #191327  '), [25, 19, 39]);
  });

  it('rgb()/rgba()', () => {
    assert.deepEqual(parseCssColor('rgb(1, 2, 3)'), [1, 2, 3]);
    assert.deepEqual(parseCssColor('rgba(10, 20, 30, 0.5)'), [10, 20, 30]);
  });

  it('нераспознанное значение — null (тинт не ставится)', () => {
    assert.equal(parseCssColor(''), null);
    assert.equal(parseCssColor('var(--bg)'), null);
    assert.equal(parseCssColor('#12'), null);
    // Переменная слоя, объявленная, но не разрешённая, не должна ронять тинт.
    assert.deepEqual(parseCssColor('#ABCDEF'), [171, 205, 239]);
  });
});

describe('parseCssColor: hsl-формы тем (вердикт 80324150)', () => {
  it('blue-topaz light: hsla(204, 45%, 97%, 1) — фон темы разбирается', () => {
    // Именно это значение молча снимало тинт: parseCssColor понимал только
    // #hex и rgb(), а тема задаёт фон в hsl-форме.
    assert.deepEqual(parseCssColor('hsla(204, 45%, 97%, 1)'), [244, 248, 251]);
    assert.deepEqual(parseCssColor('hsl(204, 45%, 97%)'), [244, 248, 251]);
  });

  it('основные тона: классический синтаксис с запятыми', () => {
    assert.deepEqual(parseCssColor('hsl(0, 100%, 50%)'), [255, 0, 0]);
    assert.deepEqual(parseCssColor('hsl(120, 100%, 50%)'), [0, 255, 0]);
    assert.deepEqual(parseCssColor('hsl(240, 100%, 50%)'), [0, 0, 255]);
    assert.deepEqual(parseCssColor('hsl(0, 0%, 50%)'), [128, 128, 128], 'серая середина');
  });

  it('современный синтаксис: пробелы, «/» перед альфой, единица deg', () => {
    assert.deepEqual(parseCssColor('hsl(120 100% 50%)'), [0, 255, 0]);
    assert.deepEqual(parseCssColor('hsl(204 45% 97% / 1)'), [244, 248, 251]);
    assert.deepEqual(parseCssColor('hsl(204deg 45% 97%)'), [244, 248, 251]);
    assert.deepEqual(parseCssColor('hsl(240, 100%, 50%, 0.5)'), [0, 0, 255]);
  });

  it('тон нормализуется: 360 и отрицательные значения', () => {
    assert.deepEqual(parseCssColor('hsl(360, 100%, 50%)'), [255, 0, 0]);
    assert.deepEqual(parseCssColor('hsl(-120, 100%, 50%)'), [0, 0, 255]);
  });

  it('неполные/нечисловые аргументы — null (тинт не ставится)', () => {
    assert.equal(parseCssColor('hsl(204, 45%)'), null);
    assert.equal(parseCssColor('hsl(red, 45%, 97%)'), null);
    assert.equal(parseCssColor('hsl()'), null);
    assert.equal(parseCssColor('hsl(none)'), null);
  });
});
