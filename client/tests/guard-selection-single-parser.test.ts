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
 *      `.match(...)` / `.matchAll(...)` с регэкспом, распознающим маркеры
 *      markdown-блоков (заголовок `#{1,6}`, ограда кода ``` ```, маркер списка
 *      `[-*+]` / `\d+[.)]`), вне пакета.
 *
 * Санкционированный вызов импортированной `parseSelectionUnits` нарушением не
 * считается: правило 1 смотрит на ОБЪЯВЛЕНИЕ, а не на вызов, а `allow`
 * дополнительно пропускает файл, который тянет разбор из `@etn/markdown`
 * (тонкая обёртка-делегат — не второй сегментатор). Копия `selection.ts`,
 * перенесённая в клиент/сервер без импорта пакета, остаётся красной.
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
import path from 'node:path';
import { describe, it } from 'node:test';

import { parseSelectionUnits } from '@etn/markdown';

import { assertGuardClean, type GuardRule, type GuardScanOptions } from './guard-helpers.js';

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

/** Единственная функция разбора выделения — экспорт `@etn/markdown`. */
const PACKAGE_PARSER = 'parseSelectionUnits';

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
  allow: (rel) => inMarkdownPackage(rel) || delegatesToSelectionParser(rel),
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
  allow: (rel) => inMarkdownPackage(rel) || delegatesToSelectionParser(rel),
};

/**
 * 3. Нарезка выделения регулярным выражением вне пакета.
 *
 * Регэксп, распознающий маркеры markdown-блоков, применённый через
 * `.split`/`.match`/`.matchAll`/`.exec`: заголовок `#{1,6}`, ограда кода
 * ``` ``` ``` или маркер списка `[-*+]` / `\d+[.)]`. Простое деление по
 * строкам (`split(/\r?\n/)`) и по пробелам (`split(/\s+/)`) — не сегментация
 * блоков и под правило не попадает.
 */
const RULE_OWN_BLOCK_SPLIT_REGEX: GuardRule = {
  name: 'own-selection-block-split-regex',
  description:
    'нарезка выделения на блоки регулярным выражением вне @etn/markdown: .split/.match/.matchAll/.exec по маркерам markdown-блоков (заголовок, ограда кода, маркер списка)',
  pattern:
    /\.(?:split|match|matchAll|exec)\s*\(\s*\/[^/\n]*(?:#\{1,6\}|```|\[-\*\+\]|\\d\+\[\.\)\])/,
  include: inSrc,
  allow: (rel) => inMarkdownPackage(rel),
};

/** Кэш «файл тянет разбор выделения из пакета» — для правил 1 и 2. */
const delegationCache = new Map<string, boolean>();

/**
 * Тонкая обёртка над единым разбором — НЕ второй сегментатор: файл импортирует
 * из `@etn/markdown` и пользуется функцией пакета. Такие файлы правилами 1–2 не
 * краснятся (объявленная рядом оркестровка — вызов пакета, а не своя нарезка);
 * всё, что не тянет пакет, — краснится.
 */
function delegatesToSelectionParser(rel: string): boolean {
  const cached = delegationCache.get(rel);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const content = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    ok =
      /from\s+['"]@etn\/markdown['"]/.test(content) && new RegExp(`\\b${PACKAGE_PARSER}\\b`).test(content);
  } catch {
    ok = false;
  }
  delegationCache.set(rel, ok);
  return ok;
}

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
