/**
 * Сторож контейнерной адаптивности `lib/ui` (задача ca9f5e70, требование
 * a08c2c4a «Адаптивность компонентов к контейнеру; фиксированные ширины без
 * max запрещены», стандарт «Правило без теста-сторожа не считается введённым»,
 * грабли 36889dd6).
 *
 * Правило: компоненты адаптируются к размеру СВОЕГО контейнера, а не окна.
 * У ключевых компонентов словаря объявлен контейнер (`container-type` +
 * `container-name`) и хотя бы один контейнерный запрос (`@container`),
 * перестраивающий компонент по ширине контейнера. Фиксированная ширина
 * литералом (`width: NNNpx`, `inline-size: NNNpx`) без `max-width`/`clamp`/
 * `min` запрещена — размер берётся токеном или относительной величиной.
 * Ширинные `@media`-перестроения запрещены: адаптивность — контейнерная.
 *
 * **Обоснованный край (allow).** Поля `width: 100%`/`0`/`var(...)` и
 * `inline-size: 100%` — не «жёсткая ширина»: относительная/токенная величина.
 * Правило ловит именно числовой литерал длины.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean, collectViolations, type GuardRule } from './guard-helpers.js';
import { readRendererCss } from './renderer-css.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');
const UI_ROOT = path.join(RENDERER_ROOT, 'lib', 'ui');
// styles.css — манифест: правила собирает readRendererCss (renderer-css.ts).

/** Строка — комментарий? */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** Только CSS-файлы словаря `lib/ui`. */
function inLibUi(rel: string): boolean {
  return rel.startsWith('lib/ui/');
}

/** Жёсткая ширина литералом: `width: 340px` / `inline-size: 6em`.
 *  `max-width`/`min-width` — верхняя/нижняя граница, не «жёсткая ширина»:
 *  отрицательный lookbehind отсекает свойство с префиксом. */
const FIXED_WIDTH = /(?<![\w-])(?:width|inline-size)\s*:\s*\d+(?:\.\d+)?(?:px|rem|em|ch)\b/;

/** Ширинное `@media`-перестроение по окну. */
const WINDOW_MEDIA = /@media[^{]*\b(?:min|max)-width\b/;

function rules(): GuardRule[] {
  return [
    {
      name: 'no-fixed-width-in-lib-ui',
      description:
        'Жёсткая ширина литералом в CSS lib/ui запрещена (требование a08c2c4a): ' +
        '`width`/`inline-size` задаётся токеном или относительной величиной ' +
        '(`100%`, `var(...)`), а не числом без `max-width`/`clamp`/`min`.',
      pattern: FIXED_WIDTH,
      include: inLibUi,
      allow: (_rel, line) => isComment(line),
    },
    {
      name: 'no-window-media-in-lib-ui',
      description:
        'Ширинное `@media`-перестроение по окну в CSS lib/ui запрещено ' +
        '(требование a08c2c4a): адаптивность — по контейнеру (`@container`).',
      pattern: WINDOW_MEDIA,
      include: inLibUi,
      allow: (_rel, line) => isComment(line),
    },
  ];
}

interface ContainerDecl {
  /** Файл относительно `src/renderer` (слеши `/`). */
  file: string;
  /** Селектор-контейнер. */
  selector: string;
  /** Имя контейнера (`container-name`). */
  name: string;
}

/** Ключевые компоненты/узлы, обязанные объявлять контейнер и иметь запрос. */
const CONTAINERS: ContainerDecl[] = [
  { file: 'lib/ui/tabs.css', selector: '.ui-tabs', name: 'ui-tabs' },
  { file: 'lib/ui/field.css', selector: '.ui-field', name: 'ui-field' },
  { file: 'lib/ui/tree.css', selector: '.ui-tree', name: 'ui-tree' },
  { file: 'lib/ui/chip-list.css', selector: '.ui-chip-list', name: 'ui-chip-list' },
  { file: 'lib/ui/table.css', selector: '.ui-table', name: 'ui-table' },
  { file: 'styles.css', selector: '.dialog-box', name: 'dialog' },
  { file: 'styles.css', selector: '.fp-host', name: 'filter-frame' },
  { file: 'styles.css', selector: '.fp-host > .fp-panel', name: 'filter-panel' },
];

const read = (rel: string): string =>
  rel === 'styles.css'
    ? readRendererCss(RENDERER_ROOT)
    : fs.readFileSync(path.join(RENDERER_ROOT, rel), 'utf8');

const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Объявлен ли у селектора контейнер с указанным именем. */
function declaresContainer(css: string, selector: string, name: string): boolean {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = new RegExp(`${escapeRe(selector)}(?![\\w-])[^{}]*\\{[^{}]*container-name\\s*:\\s*${escapeRe(name)}`);
  return re.test(code);
}

describe('guard: контейнерная адаптивность lib/ui (ca9f5e70, требование a08c2c4a)', () => {
  it('жёстких ширин литералом и ширинных @media в lib/ui нет', () => {
    assertGuardClean(RENDERER_ROOT, rules(), { extensions: ['.css'] });
  });

  it('ключевые компоненты объявляют контейнер и имеют контейнерный запрос', () => {
    const problems: string[] = [];
    const queryCache = new Map<string, boolean>();
    for (const decl of CONTAINERS) {
      const css = read(decl.file);
      if (!declaresContainer(css, decl.selector, decl.name)) {
        problems.push(`  • ${decl.file} «${decl.selector}» — нет container-name: ${decl.name}`);
      }
      if (!queryCache.has(decl.file)) {
        queryCache.set(decl.file, new RegExp(`@container\\s+${escapeRe(decl.name)}\\b`).test(css));
      }
      if (queryCache.get(decl.file) !== true) {
        problems.push(`  • ${decl.file} — нет запроса @container ${decl.name}`);
      }
    }
    if (problems.length > 0) {
      throw new Error(
        `Компоненты без контейнерной адаптивности (${problems.length}):\n${problems.join('\n')}\n\n` +
          'Объяви `container-type: inline-size; container-name: <имя>` на корне компонента ' +
          'и хотя бы одно правило `@container <имя> (max-width: …)` с перестроением.',
      );
    }
  });

  it('обёртка таблицы даёт горизонтальную прокрутку (не распирается содержимым)', () => {
    const css = read('lib/ui/table.css');
    assert.match(
      css,
      /\.ui-table\s*\{[^}]*overflow-x\s*:\s*auto/,
      'обёртка .ui-table обязана прокручиваться по X, когда сетка шире контейнера',
    );
  });

  it('правило о жёсткой ширине краснеет на умышленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-container-'));
    try {
      fs.mkdirSync(path.join(dir, 'lib', 'ui'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'lib', 'ui', 'broken.css'),
        ".ui-x {\n  width: 240px;\n}\n@media (max-width: 600px) {\n  .ui-x { display: none; }\n}\n",
        'utf8',
      );
      const violations = collectViolations(dir, rules(), { extensions: ['.css'] });
      assert.ok(
        violations.some((v) => v.rule === 'no-fixed-width-in-lib-ui'),
        'жёсткая ширина обязана попадать в нарушение',
      );
      assert.ok(
        violations.some((v) => v.rule === 'no-window-media-in-lib-ui'),
        'ширинный @media обязан попадать в нарушение',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
