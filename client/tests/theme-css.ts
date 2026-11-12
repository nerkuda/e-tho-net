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
 * режима, переходный `[data-theme='dark']`).
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
