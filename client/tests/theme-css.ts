/**
 * Чтение файлов тем оформления клиента (`lib/ui/themes/*.css`) в тестах.
 *
 * Тема — файл значений СУЩЕСТВУЮЩИХ токенов (ADR de24adef): каждый файл
 * содержит блок на режим (`data-mode='light'|'dark'`) и ничего, кроме
 * объявлений переменных. Сторожа (`guard-ui-theme-tokens`, а также
 * `guard-focus-ring-contrast`, `guard-chronicle-record-collapse`,
 * `guard-css-token-refs`, `guard-ui-tokens`) читают значения темы отсюда —
 * тематические цвета больше не лежат в `styles/tokens.css`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { RENDERER_ROOT } from './renderer-css.js';

/** Каталог файлов тем. */
export const THEMES_DIR = path.join(RENDERER_ROOT, 'lib', 'ui', 'themes');

/** Режимы темы (атрибут `data-mode`). */
export const THEME_MODES = ['light', 'dark'] as const;

/** Режим темы. */
export type ThemeMode = (typeof THEME_MODES)[number];

/** Блочный комментарий → пробелы (номера строк и смещения сохраняются). */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Блок CSS верхнего уровня: прелюдия-селектор и тело. */
export interface ThemeBlock {
  /** Селектор(ы) блока как есть (пробелы нормализованы). */
  prelude: string;
  /** Тело блока без внешних скобок. */
  body: string;
  /** Смещение начала тела в исходном тексте. */
  bodyStart: number;
  /** Смещение конца тела (за последним символом). */
  bodyEnd: number;
}

/** Блоки верхнего уровня CSS-файла (комментарии не вырезаются из смещений). */
export function topLevelBlocks(css: string): ThemeBlock[] {
  const text = stripCssComments(css);
  const out: ThemeBlock[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const preludeStart = text.lastIndexOf('}', open) + 1;
    const prelude = text.slice(preludeStart, open).replace(/\s+/g, ' ').trim();
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}') depth -= 1;
      j += 1;
    }
    out.push({ prelude, body: text.slice(open + 1, j - 1), bodyStart: open + 1, bodyEnd: j - 1 });
    i = j;
  }
  return out;
}

/** Абсолютный путь файла темы. */
export function themeFile(name: string): string {
  return path.join(THEMES_DIR, `${name}.css`);
}

/** Исходник файла темы. */
export function readTheme(name: string): string {
  return fs.readFileSync(themeFile(name), 'utf8');
}

/** Селектор блока режима темы (без пробелов). */
export function themeSelector(name: string, mode: ThemeMode): string {
  return `[data-theme='${name}'][data-mode='${mode}']`;
}

/**
 * Тело блока режима темы или `null`, если блока нет. Селектор
 * `[data-theme='<name>'][data-mode='<mode>']` ищется среди селекторов блока:
 * прелюдия может содержать дополнительные (`:root` дефолтного светлого
 * режима).
 */
export function themeBlockBody(css: string, name: string, mode: ThemeMode): string | null {
  const marker = themeSelector(name, mode).replace(/\s+/g, '');
  for (const block of topLevelBlocks(css)) {
    const selectors = block.prelude.split(',').map((s) => s.replace(/\s+/g, ''));
    if (selectors.includes(marker)) return block.body;
  }
  return null;
}

/** Объявления кастом-свойств тела блока: токен → значение. */
export function declaredTokens(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const text = stripCssComments(body);
  for (const m of text.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+);/gi)) {
    out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

/** Цвет в sRGB (0–255) для расчёта контраста. */
export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/**
 * Разбор цвета значения токена темы: `#rgb`/`#rrggbb`/`#rrggbbaa`, `rgb[a]()`
 * и `hsl[a]()`. Альфа отбрасывается (сравниваются чистые тона), непонятное
 * значение — `null` (сторож сам скажет, что значение не цвет).
 */
export function parseThemeColor(value: string): RgbColor | null {
  const v = value.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(v);
  if (hex) {
    let digits = hex[1]!;
    if (digits.length === 3 || digits.length === 4) {
      digits = digits
        .slice(0, 3)
        .split('')
        .map((c) => c + c)
        .join('');
    }
    if (digits.length < 6) return null;
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
    };
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (rgb) {
    const parts = rgb[1]!.split(',').map((part) => part.trim());
    if (parts.length < 3) return null;
    const channel = (part: string): number =>
      part.endsWith('%') ? (parseFloat(part) * 255) / 100 : parseFloat(part);
    const [r, g, b] = parts.map(channel) as [number, number, number];
    if ([r, g, b].some((c) => Number.isNaN(c))) return null;
    return { r, g, b };
  }
  const hsl = /^hsla?\(([^)]+)\)$/i.exec(v);
  if (hsl) {
    const parts = hsl[1]!.split(',').map((part) => part.trim());
    if (parts.length < 3) return null;
    const h = parseFloat(parts[0]!);
    const s = parseFloat(parts[1]!) / 100;
    const l = parseFloat(parts[2]!) / 100;
    if ([h, s, l].some((c) => Number.isNaN(c))) return null;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let rgbParts: [number, number, number];
    if (h < 60) rgbParts = [c, x, 0];
    else if (h < 120) rgbParts = [x, c, 0];
    else if (h < 180) rgbParts = [0, c, x];
    else if (h < 240) rgbParts = [0, x, c];
    else if (h < 300) rgbParts = [x, 0, c];
    else rgbParts = [c, 0, x];
    return {
      r: Math.round((rgbParts[0] + m) * 255),
      g: Math.round((rgbParts[1] + m) * 255),
      b: Math.round((rgbParts[2] + m) * 255),
    };
  }
  return null;
}

/** Относительная яркость по WCAG 2.1. */
export function relativeLuminance(color: RgbColor): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** Коэффициент контраста пары цветов по WCAG 2.1 (1–21). */
export function contrastRatio(a: RgbColor, b: RgbColor): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const [hi, lo] = first > second ? [first, second] : [second, first];
  return (hi + 0.05) / (lo + 0.05);
}
