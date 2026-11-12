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
 *   3. **Цвета — только в файлах и блоках тем.** Прямой цвет (`#hex`, `rgb()`,
 *      `hsl()`, `hwb()`, `oklch()`, именованные цвета) в CSS рендерера
 *      допустим только внутри блока значений темы в файлах каталога
 *      `lib/ui/themes/*.css`; в `styles/**`, в правилах `lib/ui` и в прочих
 *      CSS рендерера — запрещён (требование c244557c: цветовых литералов в
 *      `styles/` не остаётся). Блок с `[data-theme=…]` вне каталога тем не
 *      даёт поблажки — это такая же утечка цвета.
 *   4. **Загрузка.** Каждый файл темы подключён импортом из
 *      `lib/ui/register.ts` (ADR: не `@import` в `styles.css`); забытая тема
 *      не доедет до бандла.
 *   5. **Читаемость акцента.** Пара `--accent`/`--accent-fg` (надпись на
 *      акцентной заливке) в каждой теме и режиме — не ниже 4.5:1 по WCAG 2.1.
 *   6. **Рамки состояний — только токены темы.** Рамки «выделен», «текущий
 *      (курсор)» и «открыт в редакторе» на карте, в структурах и в
 *      публикациях рисуются переменными темы (`--selection`, `--cursor`,
 *      `--focus-ring-contrast`/`--layer-focus-stripe`), а не литералами и не
 *      токенами чужой семантики; состояния различимы внутри темы.
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
  contrastRatio,
  declaredTokens,
  parseThemeColor,
  readTheme,
  stripCssComments,
  themeBlockBody,
  themeFile,
  themeSelector,
  topLevelBlocks,
  type ThemeMode,
} from './theme-css.js';

/**
 * Полный перечень тем версии (ADR de24adef: 6 тем × 2 режима). Этап 1 задачи
 * — ранний срез заказчику (`current`, `blue-topaz`); этап 2 добавил
 * `catppuccin` и `nordic`; этап 3 (0.16.1) — характерные `retronotes` и `wasp`.
 */
const THEME_NAMES = [
  'current',
  'blue-topaz',
  'catppuccin',
  'nordic',
  'retronotes',
  'wasp',
] as const;

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
  '--cursor',
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
  '--shadow-xs-c',
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

/**
 * Признак прямого цвета: hex, функции цвета (`rgb[a]()`, `hsl[a]()`, `hwb()`,
 * `oklch()`, `oklab()`, `lab()`, `lch()`) и именованные цвета CSS.
 * `transparent` и `currentColor` — не цвет темы, а модификатор/наследование,
 * поэтому в список не входят.
 */
const NAMED_COLORS = [
  'aliceblue',
  'antiquewhite',
  'aqua',
  'aquamarine',
  'azure',
  'beige',
  'bisque',
  'black',
  'blanchedalmond',
  'blue',
  'blueviolet',
  'brown',
  'burlywood',
  'cadetblue',
  'chartreuse',
  'chocolate',
  'coral',
  'cornflowerblue',
  'cornsilk',
  'crimson',
  'cyan',
  'darkblue',
  'darkcyan',
  'darkgoldenrod',
  'darkgray',
  'darkgreen',
  'darkgrey',
  'darkkhaki',
  'darkmagenta',
  'darkolivegreen',
  'darkorange',
  'darkorchid',
  'darkred',
  'darksalmon',
  'darkseagreen',
  'darkslateblue',
  'darkslategray',
  'darkslategrey',
  'darkturquoise',
  'darkviolet',
  'deeppink',
  'deepskyblue',
  'dimgray',
  'dimgrey',
  'dodgerblue',
  'firebrick',
  'floralwhite',
  'forestgreen',
  'fuchsia',
  'gainsboro',
  'ghostwhite',
  'gold',
  'goldenrod',
  'gray',
  'green',
  'greenyellow',
  'grey',
  'honeydew',
  'hotpink',
  'indianred',
  'indigo',
  'ivory',
  'khaki',
  'lavender',
  'lavenderblush',
  'lawngreen',
  'lemonchiffon',
  'lightblue',
  'lightcoral',
  'lightcyan',
  'lightgoldenrodyellow',
  'lightgray',
  'lightgreen',
  'lightgrey',
  'lightpink',
  'lightsalmon',
  'lightseagreen',
  'lightskyblue',
  'lightslategray',
  'lightslategrey',
  'lightsteelblue',
  'lightyellow',
  'lime',
  'limegreen',
  'linen',
  'magenta',
  'maroon',
  'mediumaquamarine',
  'mediumblue',
  'mediumorchid',
  'mediumpurple',
  'mediumseagreen',
  'mediumslateblue',
  'mediumspringgreen',
  'mediumturquoise',
  'mediumvioletred',
  'midnightblue',
  'mintcream',
  'mistyrose',
  'moccasin',
  'navajowhite',
  'navy',
  'oldlace',
  'olive',
  'olivedrab',
  'orange',
  'orangered',
  'orchid',
  'palegoldenrod',
  'palegreen',
  'paleturquoise',
  'palevioletred',
  'papayawhip',
  'peachpuff',
  'peru',
  'pink',
  'plum',
  'powderblue',
  'purple',
  'rebeccapurple',
  'red',
  'rosybrown',
  'royalblue',
  'saddlebrown',
  'salmon',
  'sandybrown',
  'seagreen',
  'seashell',
  'sienna',
  'silver',
  'skyblue',
  'slateblue',
  'slategray',
  'slategrey',
  'snow',
  'springgreen',
  'steelblue',
  'tan',
  'teal',
  'thistle',
  'tomato',
  'turquoise',
  'violet',
  'wheat',
  'white',
  'whitesmoke',
  'yellow',
  'yellowgreen',
] as const;

const COLOR_LITERAL = new RegExp(
  [
    '#[0-9a-f]{3,8}\\b',
    '\\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch)\\s*\\(',
    `(?<![-\\w])(?:${NAMED_COLORS.join('|')})(?![-\\w])`,
  ].join('|'),
  'gi',
);

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
 * Связка «рамка состояния → токены темы» (задача 7a652ce8). Один механизм на
 * карту (`.cloud.*`), структуры (переиспользуют те же классы) и публикации:
 * состояние «выделен» — `--selection`, «текущий (курсор)» — `--cursor`,
 * «открыт в редакторе» — полоса `--layer-focus-stripe` (на основе — акцент) и
 * кант `--focus-ring-contrast`.
 */
const STATE_FRAMES = [
  { file: 'styles/canvas.css', selector: '.cloud.selected', tokens: ['--selection'] },
  { file: 'styles/canvas.css', selector: '.cloud.kbd-cursor', tokens: ['--cursor'] },
  {
    file: 'styles/canvas.css',
    selector: '.cloud.halo',
    tokens: ['--layer-focus-stripe', '--focus-ring-contrast'],
  },
  { file: 'styles/screens/publications.css', selector: '.pub-current', tokens: ['--cursor'] },
  { file: 'styles/screens/publications.css', selector: '.pub-doc-current', tokens: ['--cursor'] },
  {
    file: 'styles/screens/publications.css',
    selector: '.pub-open',
    tokens: ['--layer-focus-stripe', '--focus-ring-contrast'],
  },
  {
    file: 'styles/screens/publications.css',
    selector: '.pub-doc-editor',
    tokens: ['--layer-focus-stripe', '--focus-ring-contrast'],
  },
] as const;

/** Тело правила по точному селектору (`null`, если правила нет). */
export function ruleBodyOf(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  return match === null ? null : (match[1] ?? '');
}

/**
 * Рамки состояний берут цвета только из токенов темы. `sources` — CSS
 * рендерера (относительный путь → содержимое). Возвращает список нарушений.
 */
export function stateFrameProblems(sources: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  for (const frame of STATE_FRAMES) {
    const css = sources.get(frame.file);
    if (css === undefined) {
      problems.push(`${frame.file}: файла нет (ожидалась рамка ${frame.selector})`);
      continue;
    }
    const body = ruleBodyOf(stripCssComments(css), frame.selector);
    if (body === null) {
      problems.push(`${frame.file}: нет правила ${frame.selector}`);
      continue;
    }
    for (const token of frame.tokens) {
      // Целый `var(--token)` (или `var(--token, fallback)`): сравнение по
      // префиксу принимало бы `var(--selection-bg)` за `var(--selection)`.
      if (!new RegExp(`var\\(\\s*${token}\\s*[,)]`).test(body)) {
        problems.push(`${frame.selector}: рамка не использует токен темы ${token}`);
      }
    }
    const literal = new RegExp(COLOR_LITERAL.source, 'i').exec(body);
    if (literal !== null) {
      problems.push(`${frame.selector}: прямой цвет «${literal[0]}» вместо токена темы`);
    }
  }
  return problems;
}

/**
 * Различимость состояний внутри темы: акцент (гало), рамка выделения и
 * пунктир курсора — разные значения (решение пользователя 2026-11-12).
 */
export function stateDistinctnessProblems(css: string, name: string, mode: ThemeMode): string[] {
  const tokens = declaredTokens(themeBlockBody(css, name, mode) ?? '');
  const roles: Array<[string, string]> = [
    ['--accent', 'акцент/гало'],
    ['--selection', 'рамка выделения'],
    ['--cursor', 'курсор'],
  ];
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const [token, role] of roles) {
    const value = tokens.get(token)?.replace(/\s+/g, '').toLowerCase();
    if (value === undefined) {
      problems.push(`нет ${token}`);
      continue;
    }
    const twin = seen.get(value);
    if (twin !== undefined) problems.push(`${role} (${token}) совпала с ${twin}`);
    else seen.set(value, `${role} (${token})`);
  }
  return problems;
}

/**
 * Прямые цвета вне блоков тем. Возвращает список `файл:строка — фрагмент`.
 *
 * Маска: значения разрешены ТОЛЬКО в файлах каталога `lib/ui/themes/*.css` —
 * там тела блоков значений заменяются пробелами. Блоки с `[data-theme=…]` в
 * любом другом файле (`styles/**`, правила `lib/ui`) не маскируются: тёмное
 * переопределение экрана прямо в модуле стилей — такая же утечка цвета, как
 * hex в правиле.
 */
export function colorLiteralsOutsideThemes(
  files: ReadonlyArray<{ rel: string; css: string }>,
): string[] {
  const out: string[] = [];
  for (const { rel, css } of files) {
    // Значения тем живут только в файлах каталога тем (ADR de24adef).
    const isThemeFile = /^lib\/ui\/themes\/[^/]+\.css$/.test(rel);
    // Комментарии вырезаются до маски: hex в пояснении — не цвет правила.
    const stripped = stripCssComments(css);
    const chars = stripped.split('');
    if (isThemeFile) {
      for (const block of topLevelBlocks(stripped)) {
        const selector = block.prelude.replace(/\s+/g, '');
        const isValueBlock = selector.includes('[data-theme=') || selector === ':root';
        if (!isValueBlock) continue;
        for (let i = block.bodyStart; i < block.bodyEnd; i += 1) {
          if (chars[i] !== '\n') chars[i] = ' ';
        }
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

  it('пара --accent/--accent-fg читается во всех темах и режимах (WCAG ≥ 4.5:1)', () => {
    const problems: string[] = [];
    for (const name of THEME_NAMES) {
      const css = readTheme(name);
      for (const mode of THEME_MODES) {
        const tokens = declaredTokens(themeBlockBody(css, name, mode) ?? '');
        const accent = parseThemeColor(tokens.get('--accent') ?? '');
        const foreground = parseThemeColor(tokens.get('--accent-fg') ?? '');
        if (accent === null || foreground === null) {
          problems.push(`${name}.css [${mode}]: --accent/--accent-fg не цвета`);
          continue;
        }
        const ratio = contrastRatio(accent, foreground);
        if (ratio < 4.5) {
          problems.push(
            `${name}.css [${mode}]: --accent/--accent-fg = ${ratio.toFixed(2)}:1 (< 4.5:1)`,
          );
        }
      }
    }
    assert.deepEqual(
      problems,
      [],
      `контраст надписи на акцентной заливке:\n${problems.join('\n')}`,
    );
  });

  it('рамки состояний на карте и в публикациях берут только токены темы', () => {
    const sources = new Map(rendererCssFiles().map((file) => [file.rel, file.css] as const));
    const problems = stateFrameProblems(sources);
    assert.deepEqual(problems, [], `рамки состояний:\n${problems.join('\n')}`);
  });

  it('состояния различимы внутри темы: акцент, рамка выделения, курсор', () => {
    const problems: string[] = [];
    for (const name of THEME_NAMES) {
      const css = readTheme(name);
      for (const mode of THEME_MODES) {
        for (const problem of stateDistinctnessProblems(css, name, mode)) {
          problems.push(`${name}.css [${mode}]: ${problem}`);
        }
      }
    }
    assert.deepEqual(problems, [], `состояния не различены:\n${problems.join('\n')}`);
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

    // Тёмное переопределение экрана прямо в модуле стилей — утечка цвета:
    // маскируются только блоки значений в файлах каталога тем.
    const styleOverride = colorLiteralsOutsideThemes([
      {
        rel: 'styles/layout.css',
        css: "[data-theme='dark'] .demo-theme-leak { color: #abcdef; }",
      },
    ]);
    assert.equal(
      styleOverride.length,
      1,
      `переопределение с hex в styles/ обязано краснить: ${styleOverride.join(' | ')}`,
    );

    // Именованный цвет — тоже литерал (требование c244557c).
    const named = colorLiteralsOutsideThemes([
      { rel: 'styles/layout.css', css: '.demo-named-leak{color:red}' },
    ]);
    assert.deepEqual(named, ['styles/layout.css:1 — red'], 'именованный цвет обязан краснить');

    // Функции современного синтаксиса цвета — тоже литералы.
    const modern = colorLiteralsOutsideThemes([
      {
        rel: 'styles/layout.css',
        css: '.demo-modern-leak{color:oklch(0.7 0.1 200);background:hwb(0 0% 0%)}',
      },
    ]);
    assert.equal(modern.length, 2, `oklch()/hwb() обязаны краснить: ${modern.join(' | ')}`);

    // `white-space` и `transparent` — не цвет: ложных срабатываний нет.
    const clean = colorLiteralsOutsideThemes([
      {
        rel: 'styles/layout.css',
        css: '.demo-clean{white-space:nowrap;background:transparent;}',
      },
    ]);
    assert.deepEqual(
      clean,
      [],
      `ложное срабатывание на white-space/transparent: ${clean.join(' | ')}`,
    );

    // Рамки состояний: подмена токена литералом и потеря токена — красные.
    const canvas = rendererCssFiles().find((file) => file.rel === 'styles/canvas.css');
    assert.ok(canvas !== undefined, 'canvas.css должен читаться');
    const literalFrame = stateFrameProblems(
      new Map([
        [
          'styles/canvas.css',
          canvas.css.replace('outline: 2px dashed var(--cursor);', 'outline: 2px dashed #ff00ff;'),
        ],
        ...rendererCssFiles()
          .filter((file) => file.rel !== 'styles/canvas.css')
          .map((file) => [file.rel, file.css] as const),
      ]),
    );
    assert.ok(
      literalFrame.some((p) => p.includes('--cursor')),
      `подмена var(--cursor) литералом обязана краснить: ${literalFrame.join(' | ')}`,
    );

    const lostFrame = stateFrameProblems(
      new Map([
        [
          'styles/canvas.css',
          canvas.css.replace(
            'outline: 2px solid var(--selection);',
            'outline: 2px solid var(--accent);',
          ),
        ],
        ...rendererCssFiles()
          .filter((file) => file.rel !== 'styles/canvas.css')
          .map((file) => [file.rel, file.css] as const),
      ]),
    );
    assert.ok(
      lostFrame.some((p) => p.includes('--selection')),
      `рамка выделения без --selection обязана краснить: ${lostFrame.join(' | ')}`,
    );

    // Соседний токен с тем же префиксом (`--selection-bg`) не считается
    // рамкой выделения: сравнение идёт по целому `var(--selection)`.
    const prefixTwin = stateFrameProblems(
      new Map([
        [
          'styles/canvas.css',
          canvas.css.replace(
            'outline: 2px solid var(--selection);',
            'outline: 2px solid var(--selection-bg);',
          ),
        ],
        ...rendererCssFiles()
          .filter((file) => file.rel !== 'styles/canvas.css')
          .map((file) => [file.rel, file.css] as const),
      ]),
    );
    assert.ok(
      prefixTwin.some((p) => p.includes('--selection')),
      `var(--selection-bg) вместо var(--selection) обязана краснить: ${prefixTwin.join(' | ')}`,
    );

    // Совпадение состояний внутри темы — красное.
    const demoTheme =
      "[data-theme='demo'][data-mode='light'] { --accent: #112233; --selection: #112233; --cursor: #445566; }";
    const same = stateDistinctnessProblems(demoTheme, 'demo', 'light');
    assert.ok(
      same.some((p) => p.includes('--selection')),
      `рамка выделения, равная акценту, обязана краснить: ${same.join(' | ')}`,
    );
  });
});
