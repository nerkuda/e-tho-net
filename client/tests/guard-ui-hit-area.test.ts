/**
 * Сторож тач-зон `lib/ui` (задача e45ca252, требование 5677bc3d «Тач-таргеты
 * не меньше токена --hit-area», стандарт «Правило без теста-сторожа не
 * считается введённым»).
 *
 * Правило: у компактных интерактивных контролов словаря эффективная зона
 * нажатия не меньше токена тач-таргета. Визуальный размер контрола остаётся
 * плотным — зона расширяется невидимым псевдоэлементом (`::after` с
 * `inline-size/block-size: max(100%, var(--hit-area-min))`), который
 * принадлежит самому контролу и потому принимает клик.
 *
 * **Почему отдельный токен `--hit-area-min`, а не рост `--hit-area`.** Значение
 * `--hit-area: 18px` задаёт высоту строки списка, размер флажка и значка дерева
 * — согласованный баланс требования 0086037c (ошибка 6925ffa0). Его рост до
 * 24 раздул бы строки и сместил детали. Тач-зона получает собственный минимум
 * (WCAG 2.5.8), не трогая плотность; `min ≥ --hit-area` — инвариант сторожа.
 *
 * **Ловушка перекрытия (ошибка ec02c553).** Шов каркаса панели отбора
 * (`.fp-splitter`) раскрывает хит-зону псевдоэлементом, но у «Структур мыслей»
 * позиционированный сосед `.st-results { position: relative }` рисуется ПОВЕРХ
 * этого псевдоэлемента и перехватывает его внешнюю половину: замер
 * `elementFromPoint` в Chromium давал у `.st-splitter` зону 11px вместо 18px.
 * Один `z-index` у шва возвращает полные 18px. Поэтому общей строки в
 * `THIN_SEAMS` мало — у швов каркаса проверяется ещё и подъём над соседями.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readRendererCss } from './renderer-css.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

const read = (rel: string): string =>
  rel === 'styles.css'
    ? readRendererCss(RENDERER_ROOT)
    : fs.readFileSync(path.join(RENDERER_ROOT, rel), 'utf8');

const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Значение токена-длины из `:root` styles.css. */
function rootLength(css: string, name: string): number | null {
  const rootEnd = css.indexOf("[data-theme='dark'] {");
  const root = css.slice(0, rootEnd === -1 ? css.length : rootEnd);
  const m = new RegExp(`${escapeRe(name)}\\s*:\\s*(\\d+)px`).exec(root);
  return m === null ? null : Number(m[1]);
}

/** Компактные контролы: визуальный глиф меньше тач-таргета, зона — псевдоэлемент. */
const COMPACT_CONTROLS: Array<{ file: string; selector: string }> = [
  { file: 'lib/ui/chip-list.css', selector: '.ui-chip-remove' },
  { file: 'lib/ui/tree.css', selector: '.ui-tree-caret' },
  { file: 'lib/ui/field.css', selector: '.ui-clearable-btn' },
  { file: 'styles.css', selector: '.tab-close' },
];

/**
 * Тонкие швы разделителей (4–6px, ошибка 4417a2bb). Шов намеренно узкий ради
 * точности перетаскивания, поэтому зона нажатия расширяется невидимым
 * псевдоэлементом поперёк до `--hit-area` (18px — минимум требования 5677bc3d;
 * `--hit-area-min` здесь не нужен: шов не задаёт геометрию строки). Селекторы
 * совпадают с текстом правил в `styles/layout.css` и `styles/filter-panel.css`
 * (сборка модулей через манифест — `read('styles.css')`).
 */
const THIN_SEAMS: Array<{ file: string; selector: string }> = [
  { file: 'styles.css', selector: '.editor-resizer' },
  { file: 'styles.css', selector: '.selection-resizer' },
  { file: 'styles.css', selector: '.event-area-resizer' },
  { file: 'styles.css', selector: '.fp-splitter.fp-side' },
  { file: 'styles.css', selector: '.fp-splitter.fp-top' },
];

/**
 * Швы каркаса панели отбора на экранах (ошибка ec02c553). Класс-имя шва задаёт
 * экран (`.st-splitter`/`.activity-splitter`/`.chron-splitter`), а хит-зону и
 * подъём над соседями — ОБЩЕЕ правило каркаса `.fp-host > .fp-splitter`
 * (каркас вешает на элемент `fp-splitter`, см. `mountFilterPanelFrame`).
 * Список фиксирует, что эти селекторы остаются швами каркаса: если экран
 * перестанет отдавать свой шов каркасу, покрытие молча пропадёт, а строки
 * `THIN_SEAMS` по `.fp-splitter.*` этого не заметят.
 */
const FRAME_SEAMS: Array<{ screen: string; file: string; seamClass: string }> = [
  { screen: 'Структуры мыслей', file: 'screens/structures/structures.ts', seamClass: 'st-splitter' },
  { screen: 'Активность', file: 'screens/activity/activity.ts', seamClass: 'activity-splitter' },
  { screen: 'Хроника', file: 'screens/chronicle/chronicle.ts', seamClass: 'chron-splitter' },
];

/** Тело первого правила `selector { … }` (комментарии сняты). */
function declarationBlock(css: string, selector: string): string | null {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const m = new RegExp(`${escapeRe(selector)}\\s*\\{([^{}]*)\\}`).exec(code);
  return m === null ? null : m[1] ?? null;
}

/**
 * Объявлено ли у контрола расширение зоны нажатия: псевдоэлемент
 * (`::after`/`::before`) с размером от токена тач-таргета.
 */
function hasHitAreaExpansion(css: string, selector: string): boolean {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = new RegExp(
    `${escapeRe(selector)}::(?:after|before)\\s*\\{[^{}]*(?:inline-size|block-size|width|height)\\s*:[^{}]*var\\(--hit-area`,
  );
  return re.test(code);
}

describe('guard: тач-зоны lib/ui (e45ca252, требование 5677bc3d)', () => {
  it('токен тач-таргета объявлен и не меньше токена геометрии строки', () => {
    const css = read('styles.css');
    const area = rootLength(css, '--hit-area');
    const min = rootLength(css, '--hit-area-min');
    assert.ok(area !== null, '--hit-area объявлен в :root styles.css');
    assert.ok(min !== null, '--hit-area-min объявлен в :root styles.css');
    assert.ok(
      min! >= area!,
      `тач-таргет --hit-area-min (${min}px) не меньше геометрии строки --hit-area (${area}px)`,
    );
  });

  it('компактные контролы расширяют зону нажатия псевдоэлементом', () => {
    const problems: string[] = [];
    for (const { file, selector } of COMPACT_CONTROLS) {
      if (!hasHitAreaExpansion(read(file), selector)) {
        problems.push(`  • ${file} «${selector}» — нет псевдоэлемента с var(--hit-area)`);
      }
    }
    if (problems.length > 0) {
      throw new Error(
        `Компактные контролы без расширенной зоны нажатия (${problems.length}):\n` +
          `${problems.join('\n')}\n\n` +
          'Добавь `::after` с `inline-size/block-size: max(100%, var(--hit-area-min))` ' +
          '(требование 5677bc3d) либо обоснуй исключение в COMPACT_CONTROLS/шапке сторожа.',
      );
    }
  });

  it('тонкие швы разделителей расширяют зону нажатия псевдоэлементом (4417a2bb)', () => {
    const problems: string[] = [];
    for (const { file, selector } of THIN_SEAMS) {
      if (!hasHitAreaExpansion(read(file), selector)) {
        problems.push(`  • ${file} «${selector}» — нет псевдоэлемента с var(--hit-area)`);
      }
    }
    if (problems.length > 0) {
      throw new Error(
        `Тонкие швы без расширенной зоны нажатия (${problems.length}):\n` +
          `${problems.join('\n')}\n\n` +
          'Добавь `::after` с `inline-size/block-size: max(100%, var(--hit-area))` ' +
          'поперёк шва (требование 5677bc3d, ошибка 4417a2bb).',
      );
    }
  });

  it('швы каркаса панели отбора подняты над соседними панелями (ec02c553)', () => {
    const css = read('styles.css');
    const block = declarationBlock(css, '.fp-host > .fp-splitter');
    assert.ok(block !== null, 'правило `.fp-host > .fp-splitter` найдено в CSS каркаса');
    assert.match(
      block!,
      /\bposition\s*:\s*relative/,
      'шов каркаса позиционирован (position: relative) — без этого псевдоэлемент хит-зоны не привязан к шву',
    );
    assert.match(
      block!,
      /\bz-index\s*:\s*\d+/,
      'шов каркаса обязан быть поднят над соседними панелями (z-index): иначе ' +
        'позиционированный сосед (`.st-results { position: relative }`) перекрывает ' +
        'внешнюю половину хит-зоны — у `.st-splitter` эффективная зона падала до 11px (ошибка ec02c553)',
    );

    const problems: string[] = [];
    for (const { screen, file, seamClass } of FRAME_SEAMS) {
      const src = read(file);
      if (!new RegExp(`splitterElement\\('${escapeRe(seamClass)}'\\)`).test(src)) {
        problems.push(`  • ${screen}: нет splitterElement('${seamClass}') в ${file}`);
      }
      if (!/mountFilterPanelFrame\(/.test(src)) {
        problems.push(
          `  • ${screen}: шов «${seamClass}» не отдан каркасу (mountFilterPanelFrame) — ` +
            'общее правило хит-зоны к нему не применится',
        );
      }
    }
    if (problems.length > 0) {
      throw new Error(
        `Швы каркаса панели отбора без покрытия (${problems.length}):\n` +
          `${problems.join('\n')}\n\n` +
          'Экранные швы (`.st-splitter`/`.activity-splitter`/`.chron-splitter`) получают хит-зону ' +
          'и z-index от общего правила `.fp-host > .fp-splitter`; отдай шов каркасу ' +
          '`mountFilterPanelFrame` (ошибка ec02c553).',
      );
    }
  });

  it('проверка краснеет на контроле без расширения', () => {
    assert.equal(
      hasHitAreaExpansion('.ui-x { padding: 0; }', '.ui-x'),
      false,
      'контрол без псевдоэлемента не должен считаться расширенным',
    );
    assert.equal(
      hasHitAreaExpansion(
        '.ui-x::after { content: ""; inline-size: max(100%, var(--hit-area-min)); }',
        '.ui-x',
      ),
      true,
      'корректное расширение обязано распознаваться',
    );
  });
});
