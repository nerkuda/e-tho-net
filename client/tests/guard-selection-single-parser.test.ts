/**
 * Сторож: разбор выделения на единицы и нарезка markdown-блоков — только
 * в @etn/markdown (ADR `01ec1467`, требование `f5695a1e`, задача `1e6ea5c1`,
 * тех.проект `b16c219c` «Манипуляции с выделением в комментарии», стандарт
 * `a2488f05` «Новая программная сущность — библиотечная…»).
 *
 * Правило. Выделенный markdown разбирается на «единицы» (будущие мысли) ОДНОЙ
 * функцией единого пакета — `parseSelectionUnits` из `@etn/markdown`
 * (`markdown/src/selection.ts`, задача `1d15f14a`). Клиентское поле комментария
 * и команды ТП3 ВЫЗЫВАЮТ её и не содержат собственной логики нарезки: ни
 * второго сегментатора, ни своей модели единиц, ни нарезки блоков регулярным
 * выражением. ADR `01ec1467` прямо запрещает это:
 *
 *   «Второй парсер/сегментатор блоков на клиенте или в поле комментария;
 *    нарезка выделения по регулярным выражениям вне `@etn/markdown`.»
 *
 * Сторож краснеет на:
 *   1. **собственном сегментаторе выделения** — объявление функции/константы с
 *      именем разбора единиц (`parseSelectionUnits`, `parseSelection`,
 *      `segmentSelection`, `selectionUnits`, …) вне пакета;
 *   2. **собственной модели единиц** — объявление типа/интерфейса
 *      `MarkdownUnit` / `MarkdownUnitKind` / `SelectionUnit*` / `ItemPart` вне
 *      пакета (второй сегментатор неизбежно приносит свою модель);
 *   3. **нарезке выделения регулярным выражением** — `.split(...)` /
 *      `.match(...)` / `.matchAll(...)` / `.exec(...)` с регэкспом, распознающим
 *      маркеры markdown-блоков (заголовок `#{1,6}`, ограда кода ``` ```,
 *      маркер списка `[-*+]` / `\d+[.)]`); а также глобальный/многострочный
 *      (`g`/`m`) проход по тем же маркерам через `.replace`/`.test`/`.search`
 *      и `new RegExp(...)` — нарезка на блоки невозможна без обработки ВСЕХ
 *      совпадений. Одиночная правка префикса строки (`body.replace(/^#{1,6} /,
 *      '')`, `.test` без флагов) — не сегментация и под правило не попадает.
 *      Маркерный регэксп, вынесенный в именованную константу и применённый по
 *      имени в нарезке, ловится отдельно — по потоку данных на идентификатор
 *      (см. `filePattern` ниже, ошибка `297b5477`): `const RE = /^#{1,6}\s/m;
 *      src.split(RE)` — та же нарезка, что и литерал в вызове.
 *
 * Санкционированный вызов импортированной `parseSelectionUnits` нарушением не
 * считается: правило 1 смотрит на ОБЪЯВЛЕНИЕ, а не на вызов, а `allow`
 * построчно пропускает импорт/реэкспорт из `@etn/markdown` (тонкая
 * обёртка-делегат — не второй сегментатор). Разрешение именно построчное:
 * файл, который тянет пакет, но рядом объявляет СВОЮ копию сегментатора или
 * модели единиц, остаётся красным.
 *
 * Правила покрывают и серверные исходники (`server/src/**`): единая функция
 * разбора обща у сервера и клиента, поэтому сторож, живущий в клиентском
 * прогоне, следит и за серверной стороной (по образцу
 * `guard-markdown-single-renderer.test.ts`).
 *
 * Поведенческий блок ниже прогоняет единый разбор самих единиц — поддержка не
 * должна пропасть молча.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { parseSelectionUnits } from '@etn/markdown';

import {
  assertGuardClean,
  collectViolations,
  formatViolations,
  type GuardRule,
  type GuardScanOptions,
  type GuardViolation,
} from './guard-helpers.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** Каталоги исходников, к которым применяются правила. */
const SRC_PREFIXES = ['client/src/', 'server/src/', 'shared/src/', 'markdown/src/'];

/** Файл лежит в исходниках одного из пакетов. */
const inSrc = (rel: string): boolean => SRC_PREFIXES.some((p) => rel.startsWith(p));

/**
 * Файл принадлежит пакету единого разбора — здесь запрещённые приёмы
 * разрешены: это и есть дом разбора выделения.
 */
const inMarkdownPackage = (rel: string): boolean => rel.startsWith('markdown/');

/** Строка-комментарий (строчного или внутри блочного) — объявления не несёт. */
const isCommentLine = (line: string): boolean => /^\s*(?:\/\/|\/\*|\*)/.test(line);

/**
 * Строка импорта или реэкспорта — санкционированное «тянет разбор из пакета».
 * Объявления (`export function parseSelectionUnits`, `export const …`,
 * `export type MarkdownUnit = …`, `export interface MarkdownUnit`) сюда НЕ
 * попадают: реэкспорт отличает `{`/`*` сразу после `export` (или `type {`).
 * Вызов импортированной функции правилами и так не ловится — они смотрят на
 * объявление.
 */
const isImportOrReexport = (line: string): boolean =>
  /^\s*import\b/.test(line) || /^\s*export\s+(?:\*|\{|type\s*\{)/.test(line);

/** Разрешение для правил 1–2: дом разбора, импорт/реэкспорт, строка-комментарий. */
const allowDelegationOrImport = (rel: string, line: string): boolean =>
  inMarkdownPackage(rel) || isCommentLine(line) || isImportOrReexport(line);

/** Крупные не-исходные каталоги: не читать их содержимое вовсе. */
const SCAN_OPTIONS: GuardScanOptions = {
  exclude: [
    'client/tests',
    'server/tests',
    'markdown/tests',
    'client/scripts',
    'docs',
    '.tmp',
    'tmp',
    '.zcode',
    '.github',
  ],
};

// ---------------------------------------------------------------------------
// Статические запреты: разбор выделения — только в @etn/markdown
// ---------------------------------------------------------------------------

/** Имена, которыми обозначают сегментатор выделения (копия сохраняет имя). */
const SELECTION_PARSER_NAMES = [
  'parseSelectionUnits',
  'parseMarkdownUnits',
  'parseSelectionBlocks',
  'parseMarkdownSelection',
  'parseSelection',
  'segmentSelection',
  'splitSelectionUnits',
  'splitMarkdownSelection',
  'selectionToUnits',
  'selectionUnits',
  'markdownUnitsToTree',
].join('|');

/**
 * 1. Собственный сегментатор выделения вне пакета.
 *
 * Ловятся только ОБЪЯВЛЕНИЯ (`function parseSelectionUnits`, `const
 * parseSelection = …`, `const parseSelection: T = …`) — импорт
 * `import { parseSelectionUnits } from '@etn/markdown'` и вызов
 * `parseSelectionUnits(text)` под правило не попадают.
 */
const RULE_OWN_SELECTION_PARSER: GuardRule = {
  name: 'own-selection-parser-outside-package',
  description:
    'собственный сегментатор выделения (parseSelectionUnits/parseSelection/segmentSelection/selectionUnits/…) вне @etn/markdown — разбор единиц только в единой функции пакета',
  pattern: new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+(?:${SELECTION_PARSER_NAMES})\\b` +
      `|(?:export\\s+)?(?:const|let|var)\\s+(?:${SELECTION_PARSER_NAMES})\\s*[=:]`,
  ),
  include: inSrc,
  allow: allowDelegationOrImport,
};

/** Имена модели единиц разбора — второй сегментатор приносит свою модель. */
const UNIT_MODEL_NAMES = [
  'MarkdownUnit',
  'MarkdownUnitKind',
  'SelectionUnit',
  'SelectionUnitKind',
  'ItemPart',
].join('|');

/**
 * 2. Собственная модель единиц разбора вне пакета.
 *
 * Объявление `interface MarkdownUnit` / `type SelectionUnit = …` вне пакета —
 * нарушение; импорт типа (`import { type MarkdownUnit }` /
 * `export type { MarkdownUnit } from '@etn/markdown'`) — нет.
 */
const RULE_OWN_UNIT_MODEL: GuardRule = {
  name: 'own-unit-model-outside-package',
  description:
    'собственная модель единиц разбора (MarkdownUnit/MarkdownUnitKind/SelectionUnit/ItemPart) вне @etn/markdown — модель единиц живёт в едином пакете',
  pattern: new RegExp(
    `(?:export\\s+)?(?:interface|type|class|enum)\\s+(?:${UNIT_MODEL_NAMES})\\b` +
      `|(?:export\\s+)?(?:const|let|var)\\s+(?:${UNIT_MODEL_NAMES})\\s*[=:]`,
  ),
  include: inSrc,
  allow: allowDelegationOrImport,
};

/**
 * 3. Нарезка выделения регулярным выражением вне пакета.
 *
 * Регэксп, распознающий маркеры markdown-блоков, применённый для разбора ВСЕХ
 * блоков: заголовок `#{1,6}`, ограда кода ``` ``` ``` / `~~~`, маркер списка
 * `[-*+]` / `\d+[.)]` / `\d{1,9}[.)]`. Ловятся:
 *  - прямое `.split`/`.match`/`.matchAll`/`.exec` по маркеру блока;
 *  - `.replace`/`.test`/`.search` по маркеру с флагом `g` или `m` — без флагов
 *    такая обработка не покрывает все блоки и нарезкой не является;
 *  - `new RegExp('…маркер…', '…g|m…')` — конструктор с тем же признаком.
 *
 * Простое деление по строкам (`split(/\r?\n/)`), по пробелам (`split(/\s+/)`),
 * одиночная правка префикса строки (`body.replace(/^#{1,6} /, '')`, `.test`
 * без флагов) — не сегментация блоков и под правило не попадают.
 */
const BLOCK_MARKER_SRC =
  String.raw`#\{1,6\}` +
  '|```|~~~|' +
  String.raw`\[-\*\+\]` +
  '|' +
  String.raw`\\d\+\[\.\)\]` +
  '|' +
  String.raw`\\d\{1,9\}\[\.\)\]`;

/**
 * Объявление маркерного регэкспа-литерала в именованной константе (`const RE =
 * /…маркер…/fl`). Группа 1 — идентификатор: обратная ссылка позже свяжет его с
 * применением по имени. Флаги транспарентны — связывает идентификатор, а не
 * набор флагов (нарезка `.split` свободна от флагов).
 */
const MARKER_REGEX_LITERAL_DECL =
  String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/[^/\n]*(?:` +
  BLOCK_MARKER_SRC +
  String.raw`)[^/\n]*/[dgimsuvy]*`;

/** То же через конструктор: `const RE = new RegExp('…маркер…', 'fl')`. */
const MARKER_REGEX_CTOR_DECL =
  String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+RegExp\s*\(\s*['"\`][^'"\`\n]*(?:` +
  BLOCK_MARKER_SRC +
  String.raw`)[^'"\`\n]*['"\`]`;

/** Приём нарезки/перебора всех блоков, применённый к константе по имени. */
const SPLIT_BY_NAME = String.raw`[\s\S]*?\.(?:split|matchAll)\s*\(\s*`;

const RULE_OWN_BLOCK_SPLIT_REGEX: GuardRule = {
  name: 'own-selection-block-split-regex',
  description:
    'нарезка выделения на блоки регулярным выражением вне @etn/markdown: .split/.match/.matchAll/.exec по маркерам markdown-блоков, а также g/m-проход по ним через .replace/.test/.search и new RegExp; маркерный регэксп, вынесенный в именованную константу и применённый по имени в нарезке',
  pattern: new RegExp(
    // Прямое разбиение/перебор совпадений с маркером блока в теле регэкспа.
    `\\.(?:split|match|matchAll|exec)\\s*\\(\\s*\\/[^/\\n]*(?:${BLOCK_MARKER_SRC})` +
      // Нарезка заменой/проверкой — только с флагом g/m (по всем блокам).
      `|\\.(?:replace|test|search)\\s*\\(\\s*\\/[^/\\n]*(?:${BLOCK_MARKER_SRC})[^/\\n]*\\/[a-z]*[gm]` +
      // То же через конструктор RegExp: строковый шаблон и флаг g/m.
      `|new\\s+RegExp\\s*\\(\\s*['"\`][^'"\`\\n]*(?:${BLOCK_MARKER_SRC})[^'"\`\\n]*['"\`]\\s*,\\s*['"\`][^'"\`\\n]*[gm]`,
  ),
  /*
   * Нарезка выделения невозможна без обработки ВСЕХ блоков — это либо `.split`
   * по маркеру, либо `.matchAll`-перебор. Поток данных по идентификатору ведём
   * именно к этим двум приёмам: одиночный `.exec`/`.match`/`.test`/`.replace`
   * без флагов по строке — законная проверка/классификация одного блока
   * (разбор заголовков трансклюзий, валидация публикации `/m`, правка префикса
   * строки), нарезкой не является и под правило не попадает. Объявление
   * маркерного регэкспа само по себе тоже не нарушение — связка «константа +
   * нарезка по имени» (ошибка `297b5477`). Каждая ветка несёт свою обратную
   * ссылку (`\1` — литерал, `\2` — конструктор).
   */
  filePattern: new RegExp(
    `${MARKER_REGEX_LITERAL_DECL}${SPLIT_BY_NAME}\\1\\b` +
      `|${MARKER_REGEX_CTOR_DECL}${SPLIT_BY_NAME}\\2\\b`,
  ),
  include: inSrc,
  allow: (rel, line) => inMarkdownPackage(rel) || isCommentLine(line),
};

describe('сторож: разбор выделения — только в @etn/markdown (01ec1467, 1e6ea5c1)', () => {
  it('собственного сегментатора выделения нет в клиенте, сервере и shared', () => {
    assertGuardClean(REPO_ROOT, [RULE_OWN_SELECTION_PARSER], SCAN_OPTIONS);
  });

  it('собственной модели единиц разбора нет вне @etn/markdown', () => {
    assertGuardClean(REPO_ROOT, [RULE_OWN_UNIT_MODEL], SCAN_OPTIONS);
  });

  it('нарезки выделения регулярным выражением вне @etn/markdown нет', () => {
    assertGuardClean(REPO_ROOT, [RULE_OWN_BLOCK_SPLIT_REGEX], SCAN_OPTIONS);
  });
});

// ---------------------------------------------------------------------------
// Поведенческая проверка: единый разбор обслуживает единицы выделения
// ---------------------------------------------------------------------------

describe('сторож: единый разбор @etn/markdown покрывает единицы выделения', () => {
  it('список режется на единицы с учётом вложенности', () => {
    const units = parseSelectionUnits('- один\n- два\n  - вложенный');
    assert.equal(units.length, 2, 'два элемента верхнего уровня');
    assert.equal(units[1]!.children.length, 1, 'вложенный элемент — ребёнок второго');
  });

  it('разделы по заголовкам становятся единицами с подчинением', () => {
    const units = parseSelectionUnits('# Раздел\nтекст\n## Подраздел\nещё текст');
    assert.equal(units.length, 1, 'раздел верхнего уровня один');
    assert.equal(units[0]!.kind, 'section');
    assert.equal(units[0]!.children.length, 1, 'подраздел — ребёнок раздела');
  });
});

// ---------------------------------------------------------------------------
// Регресс правила: построчный allow ловит копию-сегментатор, но щадит делегата
// ---------------------------------------------------------------------------

describe('сторож: разрешение построчное, а не на файл (e7545827)', () => {
  /** Прогоняет три правила по временному дереву с путями относительно репозитория. */
  const scanFixture = (files: Record<string, string>): GuardViolation[] => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-selection-'));
    try {
      for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      }
      return collectViolations(
        root,
        [RULE_OWN_SELECTION_PARSER, RULE_OWN_UNIT_MODEL, RULE_OWN_BLOCK_SPLIT_REGEX],
        SCAN_OPTIONS,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  it('своя копия сегментатора в файле с ЛЮБЫМ импортом @etn/markdown краснеет', () => {
    const violations = scanFixture({
      'client/src/renderer/editor/evil.ts':
        "import { renderMarkdown } from '@etn/markdown';\n" +
        'export function parseSelectionUnits(src: string): string[] {\n' +
        '  return src.split(/\\n/);\n' +
        '}\n',
    });
    assert.ok(
      violations.some((v) => v.rule === 'own-selection-parser-outside-package'),
      `ожидалось нарушение правила 1:\n${formatViolations(violations)}`,
    );
  });

  it('легитимный делегат (импорт + вызов parseSelectionUnits) зелёный', () => {
    const violations = scanFixture({
      'client/src/renderer/editor/delegate.ts':
        "import { parseSelectionUnits, type MarkdownUnit } from '@etn/markdown';\n" +
        'export function splitAll(text: string): MarkdownUnit[] {\n' +
        '  return parseSelectionUnits(text);\n' +
        '}\n',
    });
    assert.deepEqual(violations, [], formatViolations(violations));
  });

  it('своя модель единиц краснеет, импорт типа и комментарий — нет', () => {
    const own = scanFixture({
      'client/src/renderer/editor/model.ts': 'export interface MarkdownUnit { kind: string }\n',
    });
    assert.ok(
      own.some((v) => v.rule === 'own-unit-model-outside-package'),
      `ожидалось нарушение правила 2:\n${formatViolations(own)}`,
    );

    const imported = scanFixture({
      'client/src/renderer/editor/model.ts':
        "import { type MarkdownUnit } from '@etn/markdown';\n" +
        '// type MarkdownUnit — модель единиц живёт в пакете\n' +
        'export const all: MarkdownUnit[] = [];\n',
    });
    assert.deepEqual(imported, [], formatViolations(imported));
  });

  it('g/m-проход по маркерам блока краснеет, одиночная правка префикса — нет', () => {
    const split = scanFixture({
      'client/src/renderer/editor/split.ts':
        'export const f = (s: string): string[] => s.split(/^#{1,6}\\s/m);\n',
    });
    assert.ok(
      split.some((v) => v.rule === 'own-selection-block-split-regex'),
      `ожидалось нарушение правила 3 (.split):\n${formatViolations(split)}`,
    );

    const replace = scanFixture({
      'client/src/renderer/editor/split2.ts':
        "export const f = (s: string): string => s.replace(/^#{1,6}\\s/gm, '');\n",
    });
    assert.ok(
      replace.some((v) => v.rule === 'own-selection-block-split-regex'),
      `ожидалось нарушение правила 3 (.replace + g/m):\n${formatViolations(replace)}`,
    );

    const ctor = scanFixture({
      'client/src/renderer/editor/split3.ts':
        "export const f = (s: string): string[] => s.split(new RegExp('(?:#{1,6} )', 'gm'));\n",
    });
    assert.ok(
      ctor.some((v) => v.rule === 'own-selection-block-split-regex'),
      `ожидалось нарушение правила 3 (new RegExp + g/m):\n${formatViolations(ctor)}`,
    );

    const prefix = scanFixture({
      'client/src/renderer/editor/prefix.ts':
        "export const f = (s: string): string => s.replace(/^#{1,6} /, '');\n",
    });
    assert.deepEqual(prefix, [], formatViolations(prefix));
  });

  it('маркерный регэксп в именованной константе, применённый в нарезке, краснеет (297b5477)', () => {
    const literalFlagged = scanFixture({
      'client/src/renderer/editor/named.ts':
        'const HEADING_RE = /^#{1,6}\\s/m;\n' +
        'export function cut(src: string): string[] {\n' +
        '  return src.split(HEADING_RE);\n' +
        '}\n',
    });
    assert.ok(
      literalFlagged.some((v) => v.rule === 'own-selection-block-split-regex'),
      `ожидалось нарушение правила 3 (константа-литерал + split):\n${formatViolations(literalFlagged)}`,
    );

    const literalNoFlags = scanFixture({
      'client/src/renderer/editor/named2.ts':
        'const HEADING_RE = /^#{1,6}\\s/;\n' +
        'export const cut = (src: string): string[] => src.split(HEADING_RE);\n',
    });
    assert.ok(
      literalNoFlags.some((v) => v.rule === 'own-selection-block-split-regex'),
      `ожидалась нарезка константой без флагов (split обрабатывает все блоки):\n${formatViolations(literalNoFlags)}`,
    );

    const ctor = scanFixture({
      'client/src/renderer/editor/named3.ts':
        "const HEADING_RE = new RegExp('^#{1,6}\\\\s', 'm');\n" +
        'export const cut = (src: string): string[] => src.split(HEADING_RE);\n',
    });
    assert.ok(
      ctor.some((v) => v.rule === 'own-selection-block-split-regex'),
      `ожидалась нарезка константой-конструктором:\n${formatViolations(ctor)}`,
    );
  });

  it('маркерный регэксп в константе, но не в нарезке, зелёный (297b5477)', () => {
    const testOnly = scanFixture({
      'server/src/domain/validate.ts':
        'const MARKDOWN_ATX_HEADING = /^\\s{0,3}#{1,6}\\s+\\S/m;\n' +
        'export const hasHeading = (t: string): boolean => MARKDOWN_ATX_HEADING.test(t);\n',
    });
    assert.deepEqual(testOnly, [], formatViolations(testOnly));

    const execLine = scanFixture({
      'client/src/renderer/editor/parse-ref.ts':
        'const HEADING_RE = /^(#{1,6})\\s+(.+)$/;\n' +
        'export const h = (line: string) => HEADING_RE.exec(line);\n',
    });
    assert.deepEqual(execLine, [], formatViolations(execLine));

    const replacePrefix = scanFixture({
      'client/src/renderer/lib/title.ts':
        'const LEADING_MD_MARKER_RE = /^(#{1,6}\\s+|[-*+]\\s+)/;\n' +
        "export const f = (t: string): string => t.replace(LEADING_MD_MARKER_RE, '').trim();\n",
    });
    assert.deepEqual(replacePrefix, [], formatViolations(replacePrefix));
  });
});

