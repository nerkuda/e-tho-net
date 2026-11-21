/**
 * Сторож: `--bg` каждой темы каждого режима разбирается в sRGB-каналы
 * (0.16.1, задача 80324150, требование e6d586d3, вердикт проверки этапа 1).
 *
 * Зачем. Тинт подложки холста карты — цвет фона темы: `canvas/wallpaper.ts`
 * читает `--bg` через `getComputedStyle`, разбирает `parseCssColor` и кладёт
 * `rgba(...)` в `--canvas-wallpaper-tint`. Неразобранное значение молча
 * снимает тинт: картинка показывается БЕЗ вуали, и требование «поверх картинки
 * лёгкий полупрозрачный тинт цвета фона темы» не выполняется.
 *
 * Именно так и случилось: тема blue-topaz (светлый режим) задаёт
 * `--bg: hsla(204, 45%, 97%, 1)`, а `parseCssColor` понимал только
 * `#rgb`/`#rrggbb`/`rgb()`/`rgba()`. Сторож закрывает класс: любая тема,
 * добавившая `hsl()`-значение (или иной непривычный формат), обязана
 * оставаться разбираемой, иначе прогон краснеет.
 *
 * Проверки:
 *  1. у каждой темы в обоих режимах есть токен `--bg`;
 *  2. `parseCssColor(--bg)` даёт каналы, а `wallpaperTintColor` — валидный
 *     `rgba(...)` (то есть значение пригодно как основа тинта);
 *  3. негативная проба: непригодное значение сторож обязан заметить — иначе
 *     он «зелёный всегда» и ничего не защищает.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { parseCssColor, wallpaperTintColor } from '../src/renderer/lib/wallpaper-image.js';
import { THEMES_DIR, THEME_MODES, declaredTokens, readTheme, themeBlockBody } from './theme-css.js';

/** Значение `--bg` одной темы в одном режиме. */
interface ThemeBackground {
  theme: string;
  mode: string;
  value: string;
}

/** Имена тем — по файлам `lib/ui/themes/*.css` (файл = тема). */
function themeNames(): string[] {
  return fs
    .readdirSync(THEMES_DIR)
    .filter((file) => file.endsWith('.css'))
    .map((file) => file.replace(/\.css$/, ''))
    .sort();
}

/** Значения `--bg` всех тем и режимов; отсутствие токена — провал сторожа. */
function themeBackgrounds(): ThemeBackground[] {
  const out: ThemeBackground[] = [];
  for (const theme of themeNames()) {
    const css = readTheme(theme);
    for (const mode of THEME_MODES) {
      const body = themeBlockBody(css, theme, mode);
      assert.ok(body !== null, `тема ${theme}: нет блока режима ${mode}`);
      const value = declaredTokens(body).get('--bg');
      assert.ok(
        value !== undefined && value !== '',
        `тема ${theme} (${mode}): не объявлен токен --bg`,
      );
      out.push({ theme, mode, value });
    }
  }
  return out;
}

/** Записи, чей `--bg` не разбирается в sRGB-каналы. */
function unparsableBackgrounds(entries: ThemeBackground[]): ThemeBackground[] {
  return entries.filter((entry) => parseCssColor(entry.value) === null);
}

describe('сторож: --bg темы пригоден как основа тинта', () => {
  it('все 6 тем объявляют --bg в обоих режимах', () => {
    const themes = themeNames();
    assert.deepEqual(themes, [
      'blue-topaz',
      'catppuccin',
      'current',
      'nordic',
      'retronotes',
      'wasp',
    ]);
    const entries = themeBackgrounds();
    assert.equal(entries.length, themes.length * THEME_MODES.length);
  });

  it('каждый --bg разбирается в sRGB и даёт rgba-тинт', () => {
    const broken = unparsableBackgrounds(themeBackgrounds());
    const readable = broken.map((entry) => `${entry.theme} (${entry.mode}): ${entry.value}`);
    assert.deepEqual(
      readable,
      [],
      `--bg не разбирается в цвет — тинт подложки молча снимется (требование e6d586d3):\n  ` +
        readable.join('\n  '),
    );

    for (const entry of themeBackgrounds()) {
      const rgb = parseCssColor(entry.value);
      assert.ok(rgb !== null, `${entry.theme} (${entry.mode}): parseCssColor вернул null`);
      const tint = wallpaperTintColor(rgb, 0.6);
      assert.match(
        tint,
        /^rgba\(\d+, \d+, \d+, 0\.6\)$/,
        `${entry.theme} (${entry.mode}): из ${entry.value} не собрался rgba-тинт (${tint})`,
      );
    }
  });

  it('случай, из-за которого заведён сторож: hsla в blue-topaz (светлый режим)', () => {
    const entry = themeBackgrounds().find(
      (item) => item.theme === 'blue-topaz' && item.mode === 'light',
    );
    assert.ok(entry !== undefined);
    assert.match(entry.value, /^hsla?\(/i, 'blue-topaz light задаёт --bg в hsl-форме');
    assert.deepEqual(parseCssColor(entry.value), [244, 248, 251]);
  });

  it('негативная проба: сторож замечает непригодное значение', () => {
    const broken = unparsableBackgrounds([
      { theme: 'ok', mode: 'light', value: '#eef0f4' },
      { theme: 'var', mode: 'light', value: 'var(--bg)' },
      { theme: 'short', mode: 'dark', value: '#12' },
      { theme: 'empty', mode: 'dark', value: '' },
    ]);
    assert.deepEqual(
      broken.map((entry) => entry.theme),
      ['var', 'short', 'empty'],
      'сторож обязан видеть неразобранные значения, иначе он ничего не защищает',
    );
  });
});
