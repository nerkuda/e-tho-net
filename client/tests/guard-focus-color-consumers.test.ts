/**
 * Сторож «фокус-потребители — только через цепочку токенов» (требование
 * c19cbb81, ревизия итерации 2; задача 136575c9).
 *
 * Один семантический токен фокуса с тремя ролями:
 *   1. полоса фокуса карты и рамка мысли, открытой в редакторе;
 *   2. пара «основа/слой»: на основе — `--focus-accent` файла темы, в
 *      не-основном слое — runtime `--layer-focus-stripe` из `layers.colors`
 *      (пишет `lib/layer-colors.ts`); фон холста — `var(--layer-bg, var(--bg))`;
 *   3. акцент выделения текущего элемента на всех прочих экранах (отбор,
 *      таблицы, дневник, события, публикации, модалки).
 *
 * Правило: цвет фокуса и выделения берётся ТОЛЬКО цепочкой
 * `var(--layer-focus-stripe, var(--focus-accent, var(--accent)))`. Прямой
 * литерал или голый токен семейства `--accent*` вне цепочки — красный:
 * выделение перестаёт следовать слою. Мягкий фон выделения — `color-mix` от
 * той же цепочки.
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
  declaredTokens,
  readTheme,
  stripCssComments,
  themeBlockBody,
} from './theme-css.js';

/** Цепочка фокуса — единственный допустимый источник цвета потребителя. */
const CHAIN =
  /var\(\s*--layer-focus-stripe\s*,\s*var\(\s*--focus-accent\s*,\s*var\(\s*--accent\s*\)\s*\)\s*\)/;

/** Голый токен акцента (в т. ч. `--accent-soft`/`--accent-strong`) вне цепочки. */
const ACCENT_VAR = /var\(\s*--accent(?:-[a-z]+)?\s*[,)]/;

/** Прямой цвет: hex или функция цвета. */
const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|oklch|oklab|lab|lch)\(/i;

interface FocusConsumer {
  /** Путь от `client/src/renderer`. */
  file: string;
  /** Селекторы одного правила (группа через запятую — по частям). */
  selectors: string[];
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
  { file: 'styles/screens/publications.css', selectors: ['.pub-toc-line.pub-toc-current'] },
  { file: 'styles/screens/publications.css', selectors: ['.pub-toc-line.pub-toc-selected'] },
  // (3) отбор: сохранённые отборы и строки выбора
  { file: 'styles/filter-panel.css', selectors: ['.sfd-row.cursor'] },
  { file: 'styles/filter-panel.css', selectors: ['.sfd-row.active'] },
  { file: 'styles/filter-tree.css', selectors: ['.ft-choice__item--cursor'] },
  // (3) дневник: календарь и клавиатурная навигация ленты
  { file: 'styles/screens/chronicle.css', selectors: ['.cal-day.is-selected'] },
  {
    file: 'styles/screens/chronicle.css',
    selectors: ['.cal-day.is-selected-from', '.cal-day.is-selected-to'],
  },
  { file: 'styles/screens/chronicle.css', selectors: ['.diary-record-target'] },
  { file: 'styles/screens/chronicle.css', selectors: ['.diary-day-head.diary-nav-current'] },
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

/**
 * Нарушения правила в теле одного потребителя: нет цепочки, голый токен
 * акцента, прямой цвет. Пустой список — тело соответствует требованию.
 */
export function consumerProblems(body: string): string[] {
  const problems: string[] = [];
  if (!CHAIN.test(body)) {
    problems.push('цвет взят не цепочкой фокуса (--layer-focus-stripe → --focus-accent)');
  }
  const rest = body.replace(new RegExp(CHAIN.source, 'g'), '');
  const accent = ACCENT_VAR.exec(rest);
  if (accent !== null) {
    problems.push(`голый токен акцента вне цепочки: ${accent[0]}`);
  }
  const literal = COLOR_LITERAL.exec(rest);
  if (literal !== null) {
    problems.push(`прямой цвет вместо токена: ${literal[0]}`);
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
    for (const problem of consumerProblems(body)) {
      problems.push(`${consumer.file} ${consumer.selectors.join(', ')}: ${problem}`);
    }
  }
  return problems;
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
    assert.match(halo!, CHAIN, 'рамка открытого — цвет фокуса слоя/темы');
    assert.match(halo!, /var\(--focus-ring-contrast\)/, 'второй контур — контрастный кант');

    const pub = ruleBodyOf(sources.get('styles/screens/publications.css') ?? '', ['.pub-open']);
    assert.ok(pub !== null, 'рамка открытой публикации объявлена');
    assert.match(pub!, CHAIN, 'рамка открытой публикации — цвет фокуса слоя/темы');

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
    for (const name of ['current', 'blue-topaz', 'catppuccin', 'nordic', 'retronotes', 'wasp']) {
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
