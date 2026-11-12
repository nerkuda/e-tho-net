/**
 * Сторож токен-наборов тем интерфейса клиента (задача aaeb6761, тех.проект
 * «Темы интерфейса клиента» 2122be30, ADR de24adef, требование 7cc0cdad,
 * требование c244557c).
 *
 * Правила:
 *   1. **Полнота.** Каждый файл `lib/ui/themes/<тема>.css` объявляет ПОЛНЫЙ
 *      набор токенов темы (цвета, тени, радиусы) в ОБОИХ режимах
 *      (`data-mode='light'`/`'dark'`), включая обязательный `--focus-accent`.
 *      Недостающий или лишний токен — красный сторож: тема обязана задавать
 *      значения всех существующих токенов, а не подмешивать чужие.
 *   2. **Только значения.** Файл темы содержит лишь блоки объявлений
 *      переменных (`:root`/`[data-theme='<тема>'][data-mode='<режим>']`);
 *      ни одного класса или правила оформления — тема не добавляет сущностей
 *      интерфейса (запрет ADR).
 *   3. **Цвета — только в блоках тем.** Прямой цвет (`#hex`, `rgb()`,
 *      `hsl()`) в CSS рендерера допустим только внутри блока темы; в
 *      `styles/**`, в правилах `lib/ui` и в прочих CSS рендерера — запрещён
 *      (требование c244557c: цветовых литералов в `styles/` не остаётся).
 *   4. **Загрузка.** Каждый файл темы подключён импортом из
 *      `lib/ui/register.ts` (ADR: не `@import` в `styles.css`); забытая тема
 *      не доедет до бандла.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { listSourceFiles } from './guard-helpers.js';
import { RENDERER_ROOT } from './renderer-css.js';
import {
  THEMES_DIR,
  THEME_MODES,
  declaredTokens,
  readTheme,
  stripCssComments,
  themeBlockBody,
  themeFile,
  themeSelector,
  topLevelBlocks,
  type ThemeMode,
} from './theme-css.js';

/**
 * Полный перечень тем версии. Этап 1 задачи (ранний срез заказчику) —
 * `current` и `blue-topaz`; этап 2 добавляет `catppuccin` и `nordic`.
 */
const THEME_NAMES = ['current', 'blue-topaz'] as const;

/**
 * Полный набор токенов темы: цвета + тени + радиусы + обязательный
 * `--focus-accent` (ADR de24adef, ревизия итерации 2). НЕ входят группа
 * `--user-*`, runtime-токены слоя (`--layer-*`) и шкалы типографики/отступов
 * (0dddd939 — неизменны во всех темах).
 */
const THEME_TOKENS = [
  '--bg',
  '--surface',
  '--surface-2',
  '--bg-hover',
  '--bg-active',
  '--border',
  '--border-strong',
  '--text',
  '--text-dim',
  '--text-faint',
  '--accent',
  '--accent-strong',
  '--accent-pressed',
  '--accent-soft',
  '--accent-fg',
  '--selection-bg',
  '--selection',
  '--cal-weekend',
  '--danger',
  '--danger-soft',
  '--ok',
  '--ok-soft',
  '--warn',
  '--warn-strong',
  '--warn-soft',
  '--warn-glow',
  '--mark-bg',
  '--link-default',
  '--ft-tone-1',
  '--ft-tone-2',
  '--ft-tone-3',
  '--ft-tone-4',
  '--ellipse-fill',
  '--ellipse-fill-border',
  '--backdrop',
  '--canvas-dot',
  '--focus-band-color',
  '--focus-accent',
  '--focus-ring-contrast',
  '--md-html-comment',
  '--mark-danger',
  '--mark-network',
  '--mark-layer',
  '--mark-warn',
  '--mark-lock-own',
  '--badge-bg',
  '--badge-fg',
  '--overlay-fg',
  '--hljs-comment',
  '--hljs-keyword',
  '--hljs-string',
  '--hljs-number',
  '--hljs-literal',
  '--hljs-title',
  '--hljs-builtin',
  '--hljs-attr',
  '--hljs-type',
  '--hljs-tag',
  '--hljs-meta',
  '--hljs-symbol',
  '--hljs-section',
  '--hljs-addition',
  '--hljs-deletion',
  '--shadow-c',
  '--shadow-sm-c',
  '--shadow',
  '--shadow-sm',
  '--shadow-hover',
  '--shadow-focus',
  '--radius-s',
  '--radius-m',
  '--radius-l',
  '--radius-xl',
  '--radius-pill',
] as const;

/** Признак прямого цвета: hex, rgb()/rgba(), hsl()/hsla(). */
const COLOR_LITERAL = /(#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\s*\()/g;

/** Полнота блока режима: недостающие и лишние токены. */
export function completenessProblems(css: string, name: string, mode: ThemeMode): string[] {
  const body = themeBlockBody(css, name, mode);
  if (body === null) return [`нет блока ${themeSelector(name, mode)}`];
  const declared = declaredTokens(body);
  const expected = new Set<string>(THEME_TOKENS);
  const problems: string[] = [];
  const missing = [...expected].filter((token) => !declared.has(token));
  if (missing.length > 0) problems.push(`не объявлено ${missing.length}: ${missing.join(', ')}`);
  const unknown = [...declared.keys()].filter((token) => !expected.has(token));
  if (unknown.length > 0) {
    problems.push(`лишние (нет в наборе темы): ${unknown.join(', ')}`);
  }
  const empty = [...declared].filter(([, value]) => value === '').map(([token]) => token);
  if (empty.length > 0) problems.push(`пустые значения: ${empty.join(', ')}`);
  if (!/color-scheme\s*:\s*(light|dark)\s*;/.exec(body)) {
    problems.push('нет `color-scheme` (режим не объявлен)');
  } else {
    const scheme = /color-scheme\s*:\s*(light|dark)\s*;/.exec(body)![1];
    if (scheme !== mode) problems.push(`color-scheme='${scheme}' не совпадает с режимом '${mode}'`);
  }
  return problems;
}

/** Форма файла темы: только блоки объявления переменных своей темы. */
export function shapeProblems(css: string, name: string): string[] {
  const problems: string[] = [];
  for (const block of topLevelBlocks(css)) {
    if (block.prelude === '') {
      problems.push('блок без селектора');
      continue;
    }
    for (const rawSelector of block.prelude.split(',')) {
      const selector = rawSelector.replace(/\s+/g, '');
      const own = THEME_MODES.some((mode) => selector === themeSelector(name, mode));
      const rootDefault = selector === ':root';
      // Переходный селектор текущего клиента (data-theme хранит РЕЖИМ) — только
      // в теме `current` и только до задачи механизма применения (0e4a52cd).
      const legacyMode = name === 'current' && /^\[data-theme='(light|dark)'\]$/.test(selector);
      if (!own && !rootDefault && !legacyMode) {
        problems.push(`посторонний селектор «${rawSelector.trim()}»`);
      }
    }
  }
  return problems;
}

/**
 * Прямые цвета вне блоков тем. Возвращает список `файл:строка — фрагмент`.
 * Маска: тела блоков с `[data-theme=…]` заменяются пробелами, поэтому
 * находка = цвет вне блока темы.
 */
export function colorLiteralsOutsideThemes(
  files: ReadonlyArray<{ rel: string; css: string }>,
): string[] {
  const out: string[] = [];
  for (const { rel, css } of files) {
    // Комментарии вырезаются до маски: hex в пояснении — не цвет правила.
    const stripped = stripCssComments(css);
    const chars = stripped.split('');
    for (const block of topLevelBlocks(stripped)) {
      const isThemeBlock = block.prelude.includes('[data-theme=');
      if (!isThemeBlock) continue;
      for (let i = block.bodyStart; i < block.bodyEnd; i += 1) {
        if (chars[i] !== '\n') chars[i] = ' ';
      }
    }
    const masked = chars.join('');
    for (const m of masked.matchAll(COLOR_LITERAL)) {
      const index = m.index ?? 0;
      const line = masked.slice(0, index).split('\n').length;
      out.push(`${rel}:${line} — ${m[0]}`);
    }
  }
  return out;
}

/** CSS рендерера (относительный путь с `/` + содержимое). */
function rendererCssFiles(): Array<{ rel: string; css: string }> {
  return listSourceFiles(RENDERER_ROOT, { extensions: ['.css'] })
    .map((abs) => ({
      rel: path.relative(RENDERER_ROOT, abs).split(path.sep).join('/'),
      css: fs.readFileSync(abs, 'utf8'),
    }))
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

describe('guard: токен-наборы тем интерфейса (aaeb6761)', () => {
  it('все темы версии заведены файлами и подключены импортом в register.ts', () => {
    const register = fs.readFileSync(path.join(RENDERER_ROOT, 'lib', 'ui', 'register.ts'), 'utf8');
    const problems: string[] = [];
    for (const name of THEME_NAMES) {
      if (!fs.existsSync(themeFile(name))) problems.push(`нет файла lib/ui/themes/${name}.css`);
      if (!register.includes(`import './themes/${name}.css';`)) {
        problems.push(`нет импорта './themes/${name}.css' в lib/ui/register.ts`);
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
    const onDisk = fs
      .readdirSync(THEMES_DIR)
      .filter((file) => file.endsWith('.css'))
      .map((file) => file.replace(/\.css$/, ''))
      .sort();
    assert.deepEqual(
      onDisk,
      [...THEME_NAMES].sort(),
      'каталог тем и перечень THEME_NAMES разошлись: незарегистрированный файл темы',
    );
  });

  it('каждый файл темы задаёт полный набор токенов в обоих режимах', () => {
    const problems: string[] = [];
    for (const name of THEME_NAMES) {
      const css = readTheme(name);
      for (const mode of THEME_MODES) {
        for (const problem of completenessProblems(css, name, mode)) {
          problems.push(`${name}.css [${mode}]: ${problem}`);
        }
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  it('файлы тем содержат только блоки значений своей темы (ни классов, ни правил)', () => {
    const problems: string[] = [];
    for (const name of THEME_NAMES) {
      for (const problem of shapeProblems(readTheme(name), name)) {
        problems.push(`${name}.css: ${problem}`);
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  it('прямые цвета есть только в блоках тем, в styles/ их нет вовсе', () => {
    const violations = colorLiteralsOutsideThemes(rendererCssFiles());
    assert.deepEqual(
      violations,
      [],
      `прямой цвет вне блока темы (требование c244557c, ADR de24adef):\n${violations.join('\n')}`,
    );
  });

  it('сторож краснеет на неполном блоке, постороннем селекторе и цвете вне темы', () => {
    const incomplete = `
      /* Тема без половины токенов и без color-scheme */
      [data-theme='demo'][data-mode='light'] {
        --bg: #ffffff;
      }
    `;
    const problems = completenessProblems(incomplete, 'demo', 'light');
    assert.ok(
      problems.some((p) => p.includes('не объявлено')),
      'неполный блок обязан обнаруживаться',
    );
    assert.ok(
      problems.some((p) => p.includes('color-scheme')),
      'color-scheme без режима обязан обнаруживаться',
    );

    const withClass = `
      [data-theme='demo'][data-mode='light'] { color-scheme: light; }
      .demo-card { color: var(--text); }
    `;
    const shape = shapeProblems(withClass, 'demo');
    assert.ok(
      shape.some((p) => p.includes('.demo-card')),
      'класс в файле темы обязан обнаруживаться',
    );

    const leaks = colorLiteralsOutsideThemes([
      { rel: 'styles/demo.css', css: '.demo { color: #ff0000; background: rgba(0, 0, 0, 0.5); }' },
      {
        rel: 'lib/ui/themes/demo.css',
        css: "[data-theme='demo'][data-mode='dark'] { color-scheme: dark; --bg: #000000; }",
      },
    ]);
    assert.equal(leaks.length, 2, `ожидались два литерала вне темы, найдено: ${leaks.join(' | ')}`);
  });
});
