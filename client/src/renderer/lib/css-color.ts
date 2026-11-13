/**
 * Чистый (без DOM) разбор и арифметика CSS-цветов — общий хелпер рендерера.
 *
 * Зачем отдельный модуль. Разбор токенов темы нужен сразу двум потребителям:
 *  • `lib/wallpaper-image.ts` — плотность тинта подложки считается от светлоты
 *    цвета фона темы/слоя (`parseCssColor` + `relativeLuminance`);
 *  • `lib/pure.ts` (`contrastText`) и `canvas/canvas.ts`
 *    (`positionZoneIndicators`) — цвет текста счётчика зоны подбирается к
 *    ФАКТИЧЕСКОМУ цвету плашки под ним.
 * Копия разбора в каждом файле уже приводила к багу: `contrastText` понимал
 * только hex и на `hsla()`-фоне blue-topaz light отдавал белый текст, который на
 * белой плашке давал 1.00 : 1 (вердикт проверки 80324150, круг 2). Поэтому
 * разбор живёт здесь в одном экземпляре, а `wallpaper-image.ts` реэкспортирует
 * его для совместимости существующих импортов.
 */

/** Зажать число в диапазон [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * HSL → sRGB-каналы 0..255. `hue` — градусы (нормализуется, в том числе
 * отрицательные значения), `sat`/`light` — доли 0..1. Формула CSS Color 4
 * (HSL → RGB через хрому и светлоту).
 */
function hslToRgb(hue: number, sat: number, light: number): [number, number, number] {
  const h = ((hue % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - c / 2;
  const sectors: [number, number, number] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [
    Math.round((sectors[0] + m) * 255),
    Math.round((sectors[1] + m) * 255),
    Math.round((sectors[2] + m) * 255),
  ];
}

/**
 * Аргументы `hsl()/hsla()` → тон в градусах, насыщенность и светлота 0..1.
 * Понимает оба синтаксиса: классический через запятую (`hsl(204, 45%, 97%)`)
 * и современный через пробел с `/` перед альфой (`hsl(204 45% 97% / 1)`).
 * Альфа отбрасывается: разбор отдаёт чистый тон, альфа нужна только при
 * композиции — она учитывается вызывающим кодом отдельно.
 * `null` — аргументы не разобраны (не число, меньше трёх компонент).
 */
function parseHslArgs(raw: string): [number, number, number] | null {
  const parts = raw
    .replace(/\//g, ' ')
    .split(/[\s,]+/)
    .filter((part) => part !== '');
  if (parts.length < 3) return null;
  const fraction = (part: string): number => {
    const value = Number.parseFloat(part);
    return part.endsWith('%') ? value / 100 : value;
  };
  const hue = Number.parseFloat(parts[0]!);
  const sat = fraction(parts[1]!);
  const light = fraction(parts[2]!);
  if (!Number.isFinite(hue) || !Number.isFinite(sat) || !Number.isFinite(light)) return null;
  return [hue, clamp(sat, 0, 1), clamp(light, 0, 1)];
}

/**
 * Разобрать CSS-цвет в каналы 0..255. Поддерживает `#rgb`, `#rrggbb`,
 * `rgb()/rgba()` и `hsl()/hsla()`; `null` — цвет не распознан.
 *
 * HSL обязателен: темы оформления задают фон и в hsl-форме (blue-topaz light —
 * `hsla(204, 45%, 97%, 1)`), и без него и тинт подложки, и цвет текста счётчика
 * молча теряли тему (вердикт проверки 80324150; сторожа
 * `guard-theme-bg-color.test.ts` и `guard-canvas-overlay-layers.test.ts`).
 */
export function parseCssColor(value: string): [number, number, number] | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    if (hex.length === 3) {
      const r = Number.parseInt(hex[0]! + hex[0]!, 16);
      const g = Number.parseInt(hex[1]! + hex[1]!, 16);
      const b = Number.parseInt(hex[2]! + hex[2]!, 16);
      return Number.isNaN(r + g + b) ? null : [r, g, b];
    }
    if (hex.length === 6) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      return Number.isNaN(r + g + b) ? null : [r, g, b];
    }
    return null;
  }
  const hsl = /^hsla?\(([^)]+)\)$/i.exec(trimmed);
  if (hsl !== null) {
    const args = parseHslArgs(hsl[1]!);
    return args === null ? null : hslToRgb(args[0], args[1], args[2]);
  }
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(trimmed);
  if (match === null) return null;
  return [
    Math.round(Number(match[1]!)),
    Math.round(Number(match[2]!)),
    Math.round(Number(match[3]!)),
  ];
}

/**
 * Относительная яркость sRGB-канала по WCAG 2.1 (0..1). Та же формула, что в
 * контрастных расчётах темы, поэтому метаданные сопоставимы с токенами.
 */
function linearChannel(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Относительная яркость цвета (каналы 0..255) по WCAG 2.1. */
export function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);
}

/**
 * Композиция полупрозрачного слоя над подложкой (обычная альфа-смесь в sRGB):
 * `top` — цвет слоя с альфой `alpha` (0..1), `bottom` — непрозрачная подложка.
 * Нужна, чтобы цвет текста счётчика зоны считался от ФАКТИЧЕСКОЙ плашки:
 * плашка — `color-mix(--surface 78%, transparent)`, то есть `--surface` с
 * альфой 0.78 над фоном канвы.
 */
export function mixColors(
  top: [number, number, number],
  bottom: [number, number, number],
  alpha: number,
): [number, number, number] {
  const a = clamp(alpha, 0, 1);
  return [
    Math.round(a * top[0] + (1 - a) * bottom[0]),
    Math.round(a * top[1] + (1 - a) * bottom[1]),
    Math.round(a * top[2] + (1 - a) * bottom[2]),
  ];
}
