/**
 * Сторож токенов дизайн-системы `lib/ui` (задача be2fce4d, требование
 * 0dddd939, стандарт «Правило без теста-сторожа не считается введённым»,
 * грабли 36889dd6).
 *
 * Правило: типографика и геометрия словаря `lib/ui` задаются едиными
 * шкалами-токенами из `styles.css`, а не магическими числами. В правилах
 * компонентных CSS `lib/ui` запрещены:
 *   1. прямые hex-цвета — цвет берётся из токена темы;
 *   2. числовые `px`/`em`/`rem` — размер берётся из токена-шкалы
 *      (`--font-size-*`, `--space-*`, `--radius-*`, `--control-*` и т. п.).
 *
 * **Allow-край (обоснован, минимизирован).** Разрешён единственный литерал
 * `1px` — «волосяная» линия рамки/фокуса; он встречается как `1px` внутри
 * `border`/`outline`/`padding` и не является размером шкалы. Всё остальное
 * (включая `--font-size`, отступы, радиусы, размеры контролов) обязано быть
 * токеном. Строки-комментарии правилами не считаются.
 *
 * **Второй allow — пороги в условиях запросов (задача ca9f5e70).** В строке
 * условия `@container … (max-width: 340px)` / `@media (…)` числовой px —
 * структурная константа раскладки (точка перестроения), а не размер шкалы:
 * CSS не допускает `var()` в условиях контейнерных запросов, поэтому порог
 * задаётся литералом. Разрешены только строки, начинающиеся с `@container`/
 * `@media`; размеры ВНУТРИ запроса по-прежнему обязаны быть токенами.
 *
 * Дополнительно сторож подтверждает, что сами шкалы объявлены в `:root`
 * `styles.css` — иначе запрет на магию нечем заменить.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean, type GuardRule } from './guard-helpers.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');
const STYLES_CSS = path.join(RENDERER_ROOT, 'styles.css');

/** Строка — комментарий? (в пояснениях значения и имена токенов допустимы). */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** Только CSS-файлы словаря `lib/ui`. */
function inLibUi(rel: string): boolean {
  return rel.startsWith('lib/ui/');
}

/** Строка — условие `@container`/`@media`? (порог раскладки, не размер шкалы). */
function isQueryCondition(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('@container') || t.startsWith('@media');
}

function rules(): GuardRule[] {
  return [
    {
      name: 'no-hex-in-lib-ui',
      description:
        'Прямой hex-цвет в CSS lib/ui запрещён: цвет — токен темы из styles.css ' +
        '(требование 0dddd939).',
      pattern: /#[0-9a-fA-F]{3,8}\b/,
      include: inLibUi,
      allow: (_rel, line) => isComment(line),
    },
    {
      name: 'no-magic-px-in-lib-ui',
      description:
        'Числовой px/em/rem в CSS lib/ui запрещён (кроме «волосяного» 1px): ' +
        'размер — токен-шкала из styles.css (требование 0dddd939).',
      // `1px` — единственный разрешённый литерал (волосяная линия).
      pattern: /(?<![\w.-])(?!1px\b)(?:\d*\.)?\d+(?:px|rem|em)\b/,
      include: inLibUi,
      allow: (_rel, line) => isComment(line) || isQueryCondition(line),
    },
  ];
}

describe('guard: токены дизайн-системы lib/ui', () => {
  it('в CSS lib/ui нет hex-цветов и магических px (кроме 1px)', () => {
    assertGuardClean(RENDERER_ROOT, rules(), { extensions: ['.css'] });
  });

  it('шкалы типографики, отступов и радиусов объявлены в :root styles.css', () => {
    const css = fs.readFileSync(STYLES_CSS, 'utf8');
    // Блок :root до селектора тёмной темы (в шапке-комментарии `:root` тоже
    // упоминается `[data-theme='dark']`, поэтому ищем сам селектор).
    const rootEnd = css.indexOf("[data-theme='dark'] {");
    const root = css.slice(0, rootEnd === -1 ? css.length : rootEnd);
    const required = [
      '--font-size-xs',
      '--font-size-s',
      '--font-size-m',
      '--font-size-l',
      '--font-weight-semibold',
      '--line-height-none',
      '--space-1',
      '--space-8',
      '--radius-s',
      '--radius-m',
      '--radius-l',
    ];
    const missing = required.filter((t) => !new RegExp(`${t}\\s*:`).test(root));
    if (missing.length > 0) {
      throw new Error(
        `Шкалы токенов не объявлены в :root styles.css: ${missing.join(', ')}. ` +
          'Магические размеры в lib/ui запрещены — их нечем заменить.',
      );
    }
  });
});
