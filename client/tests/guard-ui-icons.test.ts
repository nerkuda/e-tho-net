/**
 * Сторож единства значков интерфейса (задача 728740fd, требование e52d249e,
 * ADR bd224643, компонент lib/ui f3979068).
 *
 * Требование «Значки интерфейса клиента — из единой библиотеки через фасад
 * lib/ui»: все значки обвязки клиента (кнопки-иконки, каретки, тулбары, меню,
 * диалоги, индикаторы) рисуются из Lucide через фасад `lib/ui/icon.ts`.
 * Собственные inline-SVG-значки, прямой импорт иконочной библиотеки и внешние
 * иконочные шрифты/спрайты вне фасада запрещены.
 *
 * Три запрета:
 *   1. **Импорт `lucide` — только внутри `lib/ui/`.** Единственная точка
 *      доступа к иконочной библиотеке — фасад; иначе обходится tree-shaking,
 *      единый вид и учёт лицензии.
 *   2. **Иконочный шрифт/спрайт — только внутри `lib/ui/`** (маркеры
 *      иконочных шрифтов, `@font-face`-подключение семейства иконок, ссылки на
 *      svg-спрайт вида `href="#icon-…"`).
 *   3. **Собственный inline-SVG значка — только внутри `lib/ui/`**: литерал
 *      пространства имён `http://www.w3.org/2000/svg` и строковая разметка
 *      `<svg>`/`<path>`/… вне фасада — нарушение.
 *
 * **Легитимные исключения (не значки обвязки, сторож их не краснит).**
 * Запрет про SVG распространяется только на значки интерфейса; из него явно
 * исключены модули, рисующие SVG как диаграммный элемент или контент:
 *   • `lib/property-list.ts` — `buildLinkEndIcon`: собственный значок КОНЦА
 *     СВЯЗИ (линия со стрелкой, направление/стиль/цвет связи) — диаграммный
 *     элемент свойства-связи, а не значок интерфейса; аналога в Lucide нет
 *     (решение оркестратора по задаче 728740fd);
 *   • `canvas/links.ts` — рёбра графа мыслей (кривые, градиенты, счётчики);
 *   • `editor/mini-graph.ts` — мини-граф (контент редактора);
 *   • `screens/structures/structures.ts` — диаграмма структур связей.
 * Исключения — закрытый список конкретных модулей с обоснованием; глушения
 * сторожа целиком нет, новый inline-SVG значка в любом другом файле краснит.
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

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

/** Каталог фасада — значки там разрешены. */
const FACADE_PREFIX = 'lib/ui/';

/** Комментарий (JS/CSS) — упоминание в пояснении не является использованием. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('#')
  );
}

/** Импорт (или ленивый/Requir-импорт) иконочной библиотеки `lucide`. */
const LUCIDE_IMPORT =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]lucide(?:['"/])/;

/** Маркер иконочного шрифта (семейства/классы известных иконочных наборов). */
const ICON_FONT_MARKER =
  /(?:icon-?font|icofont|material-icons|material-symbols|font-?awesome|glyphicon|bootstrap-icons)/i;

/** Ссылка на svg-спрайт иконок: `href="#icon-…"`, `xlink:href="#ico-…"`. */
const SVG_SPRITE_REF = /(?:xlink:href|href)\s*=\s*['"]#(?:icon|ico|sprite)/i;

/** Литерал пространства имён SVG — признак собственной отрисовки `<svg>`. */
const SVG_NS_LITERAL = /['"]http:\/\/www\.w3\.org\/2000\/svg['"]/;

/** Строковая разметка собственного inline-SVG (`<svg>`, `<path>`, …). */
const RAW_SVG_MARKUP =
  /['"`][^'"`\n]*<\s*(?:svg|path|circle|rect|line|polyline|polygon)[\s/>]/i;

/**
 * Модули, где SVG — диаграммный элемент/контент, а не значок обвязки.
 * Закрытый список; каждый пункт обоснован в шапке файла.
 */
const DIAGRAM_SVG_MODULES = new Set<string>([
  'lib/property-list.ts',
  'canvas/links.ts',
  'editor/mini-graph.ts',
  'screens/structures/structures.ts',
]);

/** Разрешён ли собственный SVG этому модулю (фасад или диаграммное исключение). */
function isSvgAllowed(rel: string): boolean {
  return rel.startsWith(FACADE_PREFIX) || DIAGRAM_SVG_MODULES.has(rel);
}

/** Правила сторожа — используются и на реальном дереве, и на фикстуре. */
const RULES: GuardRule[] = [
  {
    name: 'no-lucide-outside-facade',
    description:
      'Иконочная библиотека `lucide` импортируется только фасадом ' +
      '`lib/ui/icon.ts` (требование e52d249e, ADR bd224643): потребители ' +
      'берут значки через фасад, а не из библиотеки напрямую.',
    filePattern: LUCIDE_IMPORT,
    allow: (rel) => rel.startsWith(FACADE_PREFIX),
  },
  {
    name: 'no-icon-font-outside-facade',
    description:
      'Иконочные шрифты вне фасада `lib/ui` запрещены (требование e52d249e): ' +
      'значки берутся из Lucide через фасад, а не из внешнего шрифта/набора.',
    pattern: ICON_FONT_MARKER,
    allow: (rel, line) => rel.startsWith(FACADE_PREFIX) || isCommentLine(line),
  },
  {
    name: 'no-svg-sprite-outside-facade',
    description:
      'Ссылки на svg-спрайт иконок вне фасада `lib/ui` запрещены (требование ' +
      'e52d249e): вместо спрайта — значок из Lucide через фасад.',
    pattern: SVG_SPRITE_REF,
    allow: (rel, line) => rel.startsWith(FACADE_PREFIX) || isCommentLine(line),
  },
  {
    name: 'no-own-svg-outside-facade',
    description:
      'Собственный inline-SVG значка вне фасада `lib/ui` запрещён (требование ' +
      'e52d249e): значок обвязки рисует только `lib/ui/icon.ts`. Исключения — ' +
      'диаграммные/контентные модули (см. шапку сторожа), а не значки.',
    pattern: SVG_NS_LITERAL,
    allow: (rel) => isSvgAllowed(rel),
  },
  {
    name: 'no-own-svg-markup-outside-facade',
    description:
      'Строковая разметка собственного inline-SVG (`<svg>`/`<path>`/…) вне ' +
      'фасада `lib/ui` запрещена (требование e52d249e): значок обвязки ' +
      'рисует только `lib/ui/icon.ts`.',
    pattern: RAW_SVG_MARKUP,
    allow: (rel, line) => isSvgAllowed(rel) || isCommentLine(line),
  },
];

/** Расширения для сканирования: исходники, стили и разметка. */
const SCAN_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.css', '.html'];

describe('guard: значки только через фасад lib/ui (728740fd, требование e52d249e)', () => {
  it('на текущем дереве рендерера нарушений нет', () => {
    assertGuardClean(RENDERER_ROOT, RULES, { extensions: SCAN_EXTENSIONS });
  });

  it('собственный SVG значка вне фасада краснит', () => {
    withTempTree(
      {
        'screen.ts':
          "const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');\n",
      },
      (dir) => {
        const v = collectViolations(dir, RULES, { extensions: SCAN_EXTENSIONS });
        assert.ok(
          v.some((x) => x.rule === 'no-own-svg-outside-facade'),
          'inline-SVG значка вне lib/ui обязан краснить',
        );
      },
    );
  });

  it('строковая разметка inline-SVG вне фасада краснит', () => {
    withTempTree(
      {
        'screen.ts': "el.innerHTML = '<svg viewBox=\"0 0 24 24\"><path d=\"M0 0h24v24H0z\"/></svg>';\n",
      },
      (dir) => {
        const v = collectViolations(dir, RULES, { extensions: SCAN_EXTENSIONS });
        assert.ok(
          v.some((x) => x.rule === 'no-own-svg-markup-outside-facade'),
          'строковая SVG-разметка значка вне lib/ui обязана краснить',
        );
      },
    );
  });

  it('прямой импорт lucide вне фасада краснит', () => {
    withTempTree(
      { 'screen.ts': "import { Search } from 'lucide';\n" },
      (dir) => {
        const v = collectViolations(dir, RULES, { extensions: SCAN_EXTENSIONS });
        assert.ok(
          v.some((x) => x.rule === 'no-lucide-outside-facade'),
          'импорт lucide вне lib/ui обязан краснить',
        );
      },
    );
  });

  it('иконочный шрифт и svg-спрайт вне фасада краснят', () => {
    withTempTree(
      {
        'styles.css': "@import url('https://fonts.example/material-icons');\n",
        'screen.ts': "const use = '<use xlink:href=\"#icon-search\"/>';\n",
      },
      (dir) => {
        const v = collectViolations(dir, RULES, { extensions: SCAN_EXTENSIONS });
        assert.ok(
          v.some((x) => x.rule === 'no-icon-font-outside-facade'),
          'иконочный шрифт вне lib/ui обязан краснить',
        );
        assert.ok(
          v.some((x) => x.rule === 'no-svg-sprite-outside-facade'),
          'ссылка на svg-спрайт иконок вне lib/ui обязана краснить',
        );
      },
    );
  });

  it('исключения сторожа не глушат значки: SVG в диаграммном модуле — ок, в новом экране — нет', () => {
    withTempTree(
      {
        'lib/property-list.ts': "const ns = 'http://www.w3.org/2000/svg';\n",
        'screens/new-screen.ts': "const ns = 'http://www.w3.org/2000/svg';\n",
      },
      (dir) => {
        const v = collectViolations(dir, RULES, { extensions: SCAN_EXTENSIONS });
        const files = v.filter((x) => x.rule === 'no-own-svg-outside-facade').map((x) => x.file);
        assert.deepEqual(files, ['screens/new-screen.ts'], 'карта исключений — закрытый список');
      },
    );
  });
});

/** Пишет временное дерево, гоняет колбэк и убирает его за собой. */
function withTempTree(files: Record<string, string>, run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-icons-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
    }
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
