/**
 * Сторож «фокус-потребители — только через цепочку токенов» (требование
 * c19cbb81, ревизия итерации 2; задача 136575c9).
 *
 * Один семантический токен фокуса с тремя ролями:
 *   1. полоса фокуса карты (и рамка открытого в списках публикаций). Рамку
 *      мысли, открытой на карте, с 0.16.1 считает отдельный расчёт
 *      `lib/cloud-frames.ts` (задача c6d74fd4): по решению заказчика она — в
 *      семействе токена курсора (`--cursor`, но ярче), а на слое — производное
 *      от полосы слоя. В CSS она приходит токеном `--frame-open`, чей фолбэк —
 *      та же цепочка фокуса;
 *   2. пара «основа/слой»: на основе — `--focus-accent` файла темы, в
 *      не-основном слое — runtime `--layer-focus-stripe` из `layers.colors`
 *      (пишет `lib/layer-colors.ts`); фон холста — `var(--layer-bg, var(--bg))`;
 *   3. акцент выделения текущего элемента на всех прочих экранах (отбор,
 *      таблицы, дневник, события, публикации, модалки).
 *
 * Правило: цвет фокуса и выделения берётся ТОЛЬКО цепочкой токенов. На карте —
 * `var(--layer-focus-stripe, var(--focus-accent, var(--accent)))` (полоса слоя);
 * на экранах — `var(--layer-focus-ring-screen, var(--focus-accent, var(--accent)))`
 * (кольцо, адаптированное к `--surface`, круг 3 задачи 6e171b39). Прямой
 * литерал или голый токен семейства `--accent*` вне цепочки — красный:
 * выделение перестаёт следовать слою. Мягкий фон выделения — `color-mix` от
 * цепочки полосы.
 *
 * Текстовые роли (`role: 'text'`). Фокус-цвет — цвет ФОНА и КАНТА, но не
 * текста: как текст он даёт 1.9–4.3:1 на подложках части тем (замечание 1
 * вердикта проверки 136575c9, current dark 2.92:1). Цвет текста поэтому берётся
 * контрастным кантом темы `--focus-ring-contrast` — он в каждой теме контрастен
 * к фону (числовой тест ниже требует ≥ 4.5:1 на `--bg`/`--surface`/`--surface-2`
 * во всех темах и режимах).
 *
 * `FOCUS_CONSUMERS` — реестр потребителей: новое правило выделения
 * регистрируется здесь, иначе его цвет никто не стережёт. Сознательные
 * исключения (не выделение текущего элемента): кольца `:focus-visible`
 * контролов, hover-состояния, вкладки-навигация, подсветка совпадений поиска и
 * пунктир курсора (`--cursor`).
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
  THEME_MODES,
  contrastRatio,
  declaredTokens,
  parseThemeColor,
  readTheme,
  stripCssComments,
  themeBlockBody,
} from './theme-css.js';

/** Цепочка фокуса карты — источник цвета полосы слоя. */
const CHAIN =
  /var\(\s*--layer-focus-stripe\s*,\s*var\(\s*--focus-accent\s*,\s*var\(\s*--accent\s*\)\s*\)\s*\)/;

/**
 * Цепочка ЭКРАННЫХ колец (круг 3 задачи 6e171b39): контур 1–2 px на
 * поверхности экрана адаптирован к `--surface`, а не к холсту карты. Тот же
 * фолбэк `--focus-accent`, поэтому семантика темы сохраняется.
 */
const SCREEN_CHAIN =
  /var\(\s*--layer-focus-ring-screen\s*,\s*var\(\s*--focus-accent\s*,\s*var\(\s*--accent\s*\)\s*\)\s*\)/;

/**
 * Рамка открытой на карте: `--frame-open` считает `lib/cloud-frames.ts`
 * (задача c6d74fd4) — на базовом слое от тона курсора темы, на слое от его
 * полосы. Фолбэк в CSS остаётся той же цепочкой фокуса, поэтому потребитель
 * этой формы допустим, но голый токен без фолбэка — нет.
 */
const FRAME_CHAIN =
  /var\(\s*--frame-open\s*,\s*var\(\s*--focus-accent\s*,\s*var\(\s*--accent\s*\)\s*\)\s*\)/;

/** Голый токен акцента (в т. ч. `--accent-soft`/`--accent-strong`) вне цепочки. */
const ACCENT_VAR = /var\(\s*--accent(?:-[a-z]+)?\s*[,)]/;

/** Прямой цвет: hex или функция цвета. */
const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|oklch|oklab|lab|lch)\(/i;

/** Тема интерфейса, в которой объявлен токен-набор. */
const THEME_NAMES = ['current', 'blue-topaz', 'catppuccin', 'nordic', 'retronotes', 'wasp'];

/** Контрастный кант темы — цвет текста для текстовых ролей фокуса. */
const TEXT_CONTRAST_VAR = '--focus-ring-contrast';

/** Минимальный контраст мелкого текста (WCAG AA). */
const MIN_TEXT_CONTRAST = 4.5;

interface FocusConsumer {
  /** Путь от `client/src/renderer`. */
  file: string;
  /** Селекторы одного правила (группа через запятую — по частям). */
  selectors: string[];
  /** `text` — правило задаёт ЦВЕТ ТЕКСТА текущего элемента (см. шапку). */
  role?: 'text';
}

/**
 * Реестр потребителей фокус-цвета. Файл + селекторы правила; `::part()`
 * селекторы Vaadin тоже допустимы (правило живёт в `lib/ui/table.css`).
 */
export const FOCUS_CONSUMERS: readonly FocusConsumer[] = [
  // (1) полоса фокуса карты и рамка открытой в редакторе мысли
  { file: 'styles/canvas.css', selectors: ['.canvas::before'] },
  { file: 'styles/canvas.css', selectors: ['.cloud.halo'] },
  { file: 'styles/canvas.css', selectors: ['.cloud.focus-cloud.halo'] },
  // (3) публикации
  { file: 'styles/screens/publications.css', selectors: ['.pub-open'] },
  { file: 'styles/screens/publications.css', selectors: ['.pub-doc-editor'] },
  {
    file: 'styles/screens/publications.css',
    selectors: ['.pub-toc-line.pub-toc-current'],
    role: 'text',
  },
  {
    file: 'styles/screens/publications.css',
    selectors: ['.pub-toc-line.pub-toc-selected'],
    role: 'text',
  },
  // (3) отбор: строки выбора в дереве отбора (сохранённые отборы рисует
  // ui-table в shadow DOM Vaadin — их текущая строка в реестре ниже)
  { file: 'styles/filter-tree.css', selectors: ['.ft-choice__item--cursor'] },
  // (3) дневник: календарь и клавиатурная навигация ленты
  { file: 'styles/screens/chronicle.css', selectors: ['.cal-day.is-selected'] },
  {
    file: 'styles/screens/chronicle.css',
    selectors: ['.cal-day.is-selected-from', '.cal-day.is-selected-to'],
  },
  { file: 'styles/screens/chronicle.css', selectors: ['.diary-record-target'] },
  // текущая группа дат: текст — контрастный кант темы, полоса слева — фокус
  {
    file: 'styles/screens/chronicle.css',
    selectors: ['.diary-day-head.diary-nav-current'],
    role: 'text',
  },
  { file: 'styles/screens/chronicle.css', selectors: ['.diary-record.diary-nav-current'] },
  { file: 'styles/screens/chronicle.css', selectors: ['.diary-record .diary-nav-el'] },
  // (3) поиск и события: выбранный результат/строка
  {
    file: 'styles/screens/search.css',
    selectors: ['.search-group-header.selected', '.search-hit.selected'],
  },
  { file: 'styles/screens/search.css', selectors: ['.search-hit.selected'] },
  // (3) модалки: комбобокс типов и списки выбора
  { file: 'styles/type-combobox.css', selectors: ['.type-combo-item.active'] },
  { file: 'styles/type-combobox.css', selectors: ['.row-selected > td'] },
  // (3) выбор сети (онбординг)
  { file: 'styles/screens/onboarding-networks.css', selectors: ['.profile-item.active'] },
  // (3) фасады lib/ui: текущая строка таблицы и дерева (модалки, списки)
  {
    file: 'lib/ui/table.css',
    selectors: ['.ui-table .ui-table-grid::part(row-current)'],
  },
  { file: 'lib/ui/table.css', selectors: ['.ui-table-cell-current'] },
  { file: 'lib/ui/table.css', selectors: ['.ui-table-focusable-current'] },
  { file: 'lib/ui/tree.css', selectors: ['.ui-tree-row--current'] },
  // (3) редактор и модалки: текущие строки/ячейки списков
  { file: 'styles/editor.css', selectors: ['.table-list tr.selected td'] },
  { file: 'styles/editor.css', selectors: ['.table-list tr.current td'] },
  { file: 'styles/editor.css', selectors: ['.attachment-item.selected'] },
  {
    file: 'styles/editor.css',
    selectors: ['.att-search-result-current', '.att-search-result-current:hover'],
  },
  { file: 'styles/editor.css', selectors: ['.att-pick-item-current'] },
  { file: 'styles/editor.css', selectors: ['.att-pick-preview-current'] },
  { file: 'styles/editor.css', selectors: ['.icon-preview-current'] },
  {
    file: 'styles/editor.css',
    selectors: ['.emoji-cell-current', '.icon-library-cell-current'],
  },
];

/** CSS рендерера: относительный путь с `/` → содержимое (без комментариев). */
function rendererCss(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const abs of listSourceFiles(RENDERER_ROOT, { extensions: ['.css'] })) {
    const rel = path.relative(RENDERER_ROOT, abs).split(path.sep).join('/');
    sources.set(rel, stripCssComments(fs.readFileSync(abs, 'utf8')));
  }
  return sources;
}

/** Тело правила по группе точных селекторов (`null`, если правила нет). */
export function ruleBodyOf(css: string, selectors: readonly string[]): string | null {
  const group = selectors
    .map((selector) =>
      selector
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('\\s*,\\s*');
  const match = new RegExp(`(?:^|[}\\s])${group}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  return match === null ? null : (match[1] ?? '');
}

/** Значение объявления `color:` (не `background-color`/`border-color`). */
export function textColorValue(body: string): string | null {
  const match = /(?:^|[;{\s])color\s*:\s*([^;]+);/i.exec(body);
  return match === null ? null : match[1]!.trim();
}

/**
 * Нарушения правила в теле одного потребителя: нет цепочки, голый токен
 * акцента, прямой цвет; для текстовой роли — текст не контрастным кантом.
 * Пустой список — тело соответствует требованию.
 */
export function consumerProblems(body: string, role?: 'text'): string[] {
  const problems: string[] = [];
  if (!CHAIN.test(body) && !FRAME_CHAIN.test(body) && !SCREEN_CHAIN.test(body)) {
    problems.push(
      'цвет взят не цепочкой фокуса (--layer-focus-stripe/--layer-focus-ring-screen → --focus-accent)',
    );
  }
  const rest = body
    .replace(new RegExp(CHAIN.source, 'g'), '')
    .replace(new RegExp(FRAME_CHAIN.source, 'g'), '')
    .replace(new RegExp(SCREEN_CHAIN.source, 'g'), '');
  const accent = ACCENT_VAR.exec(rest);
  if (accent !== null) {
    problems.push(`голый токен акцента вне цепочки: ${accent[0]}`);
  }
  const literal = COLOR_LITERAL.exec(rest);
  if (literal !== null) {
    problems.push(`прямой цвет вместо токена: ${literal[0]}`);
  }
  if (role === 'text') {
    const value = textColorValue(body);
    if (value === null) {
      problems.push('текстовая роль не задаёт цвет текста');
    } else if (!new RegExp(`var\\(\\s*${TEXT_CONTRAST_VAR}\\s*[,)]`).test(value)) {
      problems.push(`цвет текста взят не контрастным кантом темы (${TEXT_CONTRAST_VAR}): ${value}`);
    }
  }
  return problems;
}

/**
 * Нарушения правила по реестру потребителей: нет файла, нет правила или тело
 * не соответствует цепочке. Пустой список — все потребители чисты.
 */
export function focusConsumerProblems(
  sources: ReadonlyMap<string, string>,
  consumers: readonly FocusConsumer[],
): string[] {
  const problems: string[] = [];
  for (const consumer of consumers) {
    const css = sources.get(consumer.file);
    if (css === undefined) {
      problems.push(`${consumer.file}: файла нет`);
      continue;
    }
    const body = ruleBodyOf(css, consumer.selectors);
    if (body === null) {
      problems.push(`${consumer.file}: нет правила ${consumer.selectors.join(', ')}`);
      continue;
    }
    for (const problem of consumerProblems(body, consumer.role)) {
      problems.push(`${consumer.file} ${consumer.selectors.join(', ')}: ${problem}`);
    }
  }
  return problems;
}

/** Значение токена темы; `var(--x)` резолвится на один уровень вложенности. */
function resolveToken(tokens: ReadonlyMap<string, string>, name: string): string | null {
  const seen = new Set<string>();
  let current = name;
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const raw = tokens.get(current);
    if (raw === undefined) return null;
    const ref = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(raw.trim());
    if (ref === null) return raw.trim();
    current = ref[1]!;
  }
}

describe('guard: фокус-цвет — только цепочка токенов (c19cbb81)', () => {
  const sources = rendererCss();

  it('все зарегистрированные потребители берут цвет цепочкой фокуса', () => {
    const problems = focusConsumerProblems(sources, FOCUS_CONSUMERS);
    assert.deepEqual(problems, [], `фокус-потребители:\n${problems.join('\n')}`);
  });

  it('роли токена: полоса карты, гало открытого и публикации — цепочка, холст — --layer-bg', () => {
    const band = ruleBodyOf(sources.get('styles/canvas.css') ?? '', ['.canvas::before']);
    assert.ok(band !== null, 'полоса фокуса карты объявлена');
    assert.match(band!, CHAIN, 'полоса фокуса — цвет фокуса слоя/темы');

    const halo = ruleBodyOf(sources.get('styles/canvas.css') ?? '', ['.cloud.halo']);
    assert.ok(halo !== null, 'гало открытого объявлено');
    // Задача c6d74fd4: рамка открытой на карте — производное семейства курсора
    // (или полосы слоя), фолбэк — та же цепочка фокуса.
    assert.match(halo!, FRAME_CHAIN, 'рамка открытого — --frame-open с фолбэком на цепочку');
    assert.match(halo!, /var\(--focus-ring-contrast\)/, 'второй контур — контрастный кант');

    const pub = ruleBodyOf(sources.get('styles/screens/publications.css') ?? '', ['.pub-open']);
    assert.ok(pub !== null, 'рамка открытой публикации объявлена');
    assert.match(pub!, SCREEN_CHAIN, 'рамка открытой публикации — кольцо поверхностей (круг 3)');

    const canvas = ruleBodyOf(sources.get('styles/canvas.css') ?? '', ['.canvas']);
    assert.match(
      canvas ?? '',
      /var\(--layer-bg,\s*var\(--bg\)\)/,
      'фон холста — пара «основа/слой»',
    );
  });

  it('дублирующего дефолта --focus-band-color в рендерере нет', () => {
    const leftovers = [...sources]
      .filter(([, css]) => css.includes('--focus-band-color'))
      .map(([file]) => file);
    assert.deepEqual(
      leftovers,
      [],
      `--focus-band-color устранён как дубль --focus-accent: ${leftovers.join(', ')}`,
    );
  });

  it('каждая тема и режим объявляет --focus-accent', () => {
    for (const name of THEME_NAMES) {
      const css = readTheme(name);
      for (const mode of THEME_MODES) {
        const tokens = declaredTokens(themeBlockBody(css, name, mode) ?? '');
        assert.ok(
          tokens.has('--focus-accent'),
          `${name}.css [${mode}]: нет фокус-акцента основы (--focus-accent)`,
        );
      }
    }
  });

  it('сторож краснеет на голом акценте, литерале и цепочке с примесью', () => {
    // Мутация 1: голый токен акцента вместо цепочки.
    assert.ok(
      consumerProblems('outline: 2px solid var(--accent);').length > 0,
      'голый var(--accent) обязан краснить',
    );
    // Мутация 2: мягкий фон акцентом темы.
    assert.ok(
      consumerProblems('background: var(--accent-soft);').length > 0,
      'var(--accent-soft) обязан краснить',
    );
    // Мутация 3: прямой цвет.
    assert.ok(
      consumerProblems('border-color: #1e62be;').length > 0,
      'литерал цвета обязан краснить',
    );
    // Мутация 3б: --frame-open без фолбэка-цепочки — источник цвета не прослежен.
    assert.ok(
      consumerProblems('border-color: var(--frame-open);').length > 0,
      'голый --frame-open обязан краснить',
    );
    // Мутация 4: цепочка на месте, но рядом затёк акцент темы.
    assert.ok(
      consumerProblems(
        'background: color-mix(in srgb, var(--layer-focus-stripe, var(--focus-accent, var(--accent))) 18%, transparent);' +
          ' outline: 1px solid var(--accent);',
      ).length > 0,
      'акцент рядом с цепочкой обязан краснить',
    );
    // Контроль: правильные формы чистые.
    assert.deepEqual(
      consumerProblems(
        'outline: 2px solid var(--layer-focus-stripe, var(--focus-accent, var(--accent)));',
      ),
      [],
    );
    assert.deepEqual(
      consumerProblems(
        'background: color-mix(in srgb, var(--layer-focus-stripe, var(--focus-accent, var(--accent))) 18%, transparent);',
      ),
      [],
    );
    assert.deepEqual(
      consumerProblems('border-color: var(--frame-open, var(--focus-accent, var(--accent)));'),
      [],
      'рамка открытой карты через --frame-open — допустимая форма',
    );
    assert.deepEqual(
      consumerProblems(
        'outline: 2px solid var(--layer-focus-ring-screen, var(--focus-accent, var(--accent)));',
      ),
      [],
      'кольцо фокуса экранов — допустимая форма (круг 3)',
    );
  });

  it('контрастный кант читаем как текст во всех темах и режимах (≥ 4.5:1)', () => {
    const BACKDROPS = ['--bg', '--surface', '--surface-2'];
    const problems: string[] = [];
    for (const name of THEME_NAMES) {
      const css = readTheme(name);
      for (const mode of THEME_MODES) {
        const tokens = declaredTokens(themeBlockBody(css, name, mode) ?? '');
        const ink = resolveToken(tokens, TEXT_CONTRAST_VAR);
        const fg = ink === null ? null : parseThemeColor(ink);
        if (ink === null || fg === null) {
          problems.push(`${name}/${mode}: нет ${TEXT_CONTRAST_VAR}`);
          continue;
        }
        for (const token of BACKDROPS) {
          const raw = resolveToken(tokens, token);
          const bg = raw === null ? null : parseThemeColor(raw);
          if (raw === null || bg === null) {
            problems.push(`${name}/${mode}: нет ${token}`);
            continue;
          }
          const ratio = contrastRatio(fg, bg);
          if (ratio < MIN_TEXT_CONTRAST) {
            problems.push(
              `${name}/${mode}: ${TEXT_CONTRAST_VAR} на ${token} — ${ratio.toFixed(2)}:1`,
            );
          }
        }
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  it('сторож краснеет на фокус-цвете и литерале в текстовой роли', () => {
    const chain = 'var(--layer-focus-stripe, var(--focus-accent, var(--accent)))';
    const soft = `background: color-mix(in srgb, ${chain} 18%, transparent);`;
    // Мутация: текст фокус-цветом (низкий контраст).
    assert.ok(
      consumerProblems(`${soft} color: ${chain};`, 'text').length > 0,
      'текст цепочкой фокуса обязан краснить',
    );
    // Мутация: текст литералом.
    assert.ok(
      consumerProblems(`${soft} color: #1e62be;`, 'text').length > 0,
      'литерал в текстовой роли обязан краснить',
    );
    // Мутация: текстовая роль без объявленного цвета.
    assert.ok(
      consumerProblems(soft, 'text').length > 0,
      'текстовая роль без color обязана краснить',
    );
    // Контроль: кант темы — чистая текстовая роль.
    assert.deepEqual(consumerProblems(`${soft} color: var(--focus-ring-contrast);`, 'text'), []);
  });

  it('сторож краснеет на пропавшем правиле потребителя', () => {
    const problems = focusConsumerProblems(sources, [
      { file: 'styles/editor.css', selectors: ['.nothing-current'] },
      { file: 'styles/no-such-file.css', selectors: ['.x'] },
    ]);
    assert.equal(problems.length, 2, problems.join('\n'));
    assert.match(problems[0]!, /нет правила \.nothing-current/);
    assert.match(problems[1]!, /файла нет/);
  });
});
