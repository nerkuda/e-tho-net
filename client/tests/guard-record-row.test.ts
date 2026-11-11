/**
 * Сторож: общая строка дневниковой записи — ОДНА компонента в ОДНОМ месте
 * интеграции на эту версию (0.15.4, тех.проект 43329662, задача 33ed043c,
 * элемент 554e3129, ADR 8f0e9412).
 *
 * Почему сторож. Пока строку-запись собирал сам экран, форма разъезжалась:
 * группа «Найдено в хронологии» показывала только период и сниппет — без
 * привязок и без перехода. Компонента живёт в `lib/` и собирается ОДНИМ
 * вызовом на каждое место интеграции. С версии 0.15.4 таких мест ДВА — группа
 * поиска «Найдено в хронологии» (`search/search.ts`) и вкладка «Упоминания»
 * (`editor/links-tab.ts` через подблок `lib/record-rows-block.ts`, задача
 * ae72e47e); сторож держит оба места на общей компоненте.
 *
 * Дополнительно фиксируются правила состава строки:
 *  * сниппет проходит ТОТ ЖЕ конвейер `[[#id]]` → имя мысли, что у прочих
 *    результатов (ошибка 2a8181f4) — регресс недопустим;
 *  * Ctrl+hover-предпросмотр в строке результата не включается (уточнение N5:
 *    предпросмотр — фича ленты «Дневника»);
 *  * перетаскивание с чипа не начинается (P3): чип — цель клика;
 *  * кнопка «+N» — из словаря кнопок и выглядит чипом (guard-ui-buttons);
 *  * обвязка переполнения снимается во ВСЕХ ветках замены результатов — общим
 *    хелпером `clearResults` (замечание приёмки 1, круг 2): иначе
 *    `ResizeObserver` держал бы отцепленные полосы до полного рендера.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean, collectViolations } from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

/** Дом общей компоненты строки-записи. */
const ROW = 'lib/record-row.ts';

/** Место интеграции общей строки — группа поиска «Найдено в хронологии». */
const SEARCH = 'search/search.ts';

/** Место интеграции общей строки — вкладка «Упоминания» (задача ae72e47e). */
const TAB = 'editor/links-tab.ts';

/** Подблок строк-записей вкладки — единственная сборка строки для неё. */
const BLOCK = 'lib/record-rows-block.ts';

/** Разрешённые сборщики строки: сама компонента, подблок вкладки и поиск. */
const BUILDERS = [ROW, BLOCK, SEARCH];

/** Признак сборки строки дневниковой записи. */
const ROW_BUILD = /\bcreateRecordRow\s*\(/;

/** Признак импорта экранного модуля из библиотеки (`lib` → `screens` запрещён). */
const SCREENS_IMPORT = /from\s+'[^']*screens\//;

/** Исходник модуля рендерера. */
function read(...parts: string[]): string {
  return readFileSync(path.join(RENDERER_ROOT, ...parts), 'utf8');
}

/** Исходник строки-записи. */
const ROW_SOURCE = read('lib', 'record-row.ts');

/**
 * Проблемы подключения общей строки в ОБОИХ местах интеграции. Пустой массив —
 * всё на месте: поиск зовёт компоненту сам, вкладка «Упоминания» — через подблок,
 * а собственной разметки строки у вкладки нет. Функция вынесена из теста, чтобы
 * откат проверялся на синтетическом дереве (правило обязано краснеть).
 */
function integrationProblems(root: string): string[] {
  const readRel = (rel: string): string => {
    try {
      return readFileSync(path.join(root, ...rel.split('/')), 'utf8');
    } catch {
      return '';
    }
  };
  const problems: string[] = [];
  const search = readRel(SEARCH);
  if (
    !/import\s*\{[^}]*\bcreateRecordRow\b[^}]*\}\s*from\s*'\.\.\/lib\/record-row\.js'/.test(search)
  ) {
    problems.push('search/search.ts не импортирует общую компоненту строки-записи');
  }
  if (!ROW_BUILD.test(search)) problems.push('search/search.ts не строит строку-запись');
  const block = readRel(BLOCK);
  if (!/import\s*\{[^}]*\bcreateRecordRow\b[^}]*\}\s*from\s*'\.\/record-row\.js'/.test(block)) {
    problems.push('lib/record-rows-block.ts не использует общую компоненту строки-записи');
  }
  const tab = readRel(TAB);
  if (
    !/import\s*\{[\s\S]*?\bmountRecordRowsBlock\b[\s\S]*?\}\s*from\s*'\.\.\/lib\/record-rows-block\.js'/.test(
      tab,
    )
  ) {
    problems.push('editor/links-tab.ts не импортирует подблок строк-записей (откат ae72e47e)');
  }
  // Импорта мало (замечание приёмки, круг 1): мутация «оставить импорт, убрать
  // монтирование» выглядела подключённой, хотя строк-записей на вкладке не было.
  // Проверяется ВЫЗОВ внутри сборки тела группы, а не факт импорта.
  const tabBody = /function buildHitListBody\([\s\S]*?\n\}/.exec(tab)?.[0] ?? '';
  if (!/\bmountRecordRowsBlock\s*\(\s*\{/.test(tabBody)) {
    problems.push(
      'editor/links-tab.ts не монтирует подблок строк-записей: в buildHitListBody нет вызова',
    );
  }
  if (ROW_BUILD.test(tab)) problems.push('editor/links-tab.ts строит строку-запись мимо подблока');
  if (/record-row-(?:head|chips|snippet)/.test(tab)) {
    problems.push('editor/links-tab.ts повторяет разметку общей строки-записи');
  }
  return problems;
}

/** Запись файла синтетического дерева (каталоги создаются). */
function writeTree(root: string, rel: string, content: string): void {
  const file = path.join(root, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

describe('guard: общая строка-запись — одна компонента, места интеграции', () => {
  it('строку собирает только lib/record-row.ts и её подблок вкладки', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'single-record-row-integration',
        description:
          'Строку дневниковой записи собирает общая компонента lib/record-row.ts. ' +
          'Места интеграции — search/search.ts и подблок editor/links-tab.ts ' +
          '(lib/record-rows-block.ts). Свой сборщик в экране вернёт расхождение ' +
          'формы (период без привязок и перехода).',
        filePattern: ROW_BUILD,
        allow: (rel) => BUILDERS.includes(rel),
      },
    ]);
  });

  it('общая строка подключена в ОБОИХ местах интеграции: поиск и вкладка «Упоминания»', () => {
    const problems = integrationProblems(RENDERER_ROOT);
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  it('правило краснеет на откате вкладки к собственной строке-записи', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-record-integrations-'));
    try {
      writeTree(
        dir,
        SEARCH,
        [
          "import { createRecordRow } from '../lib/record-row.js';",
          'export const row = (model: unknown, options: unknown) => createRecordRow(model, options);',
        ].join('\n'),
      );
      writeTree(
        dir,
        BLOCK,
        [
          "import { createRecordRow } from './record-row.js';",
          'export const rows = (model: unknown, options: unknown) => createRecordRow(model, options);',
        ].join('\n'),
      );
      // Откат: вкладка потеряла подблок строк-записей.
      writeTree(dir, TAB, 'export function buildBody(): unknown { return null; }\n');
      assert.ok(
        integrationProblems(dir).some((problem) => problem.includes('не монтирует подблок')),
        'вкладка без подблока строк-записей — нарушение',
      );
      // Регресс: вкладка собирает строку сама, мимо подблока.
      writeTree(
        dir,
        TAB,
        [
          "import { createRecordRow } from '../lib/record-row.js';",
          'export const row = (model: unknown, options: unknown) => createRecordRow(model, options);',
        ].join('\n'),
      );
      const problems = integrationProblems(dir);
      assert.ok(
        problems.some((problem) => problem.includes('мимо подблока')),
        'своя сборка строки-записи на вкладке — нарушение',
      );
      assert.ok(
        problems.some((problem) => problem.includes('не монтирует подблок')),
        'подблок при этом так и не подключён',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('правило краснеет на ИМПОРТЕ подблока без монтирования (замечание приёмки, круг 1)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-record-mount-call-'));
    try {
      writeTree(
        dir,
        SEARCH,
        [
          "import { createRecordRow } from '../lib/record-row.js';",
          'export const row = (model: unknown, options: unknown) => createRecordRow(model, options);',
        ].join('\n'),
      );
      writeTree(
        dir,
        BLOCK,
        [
          "import { createRecordRow } from './record-row.js';",
          'export const rows = (model: unknown, options: unknown) => createRecordRow(model, options);',
        ].join('\n'),
      );
      // Мутация «импорт остался, вызов убран»: подблок в сборке группы не монтируется.
      writeTree(
        dir,
        TAB,
        [
          'import {',
          '  mountRecordRowsBlock,',
          '  type RecordRowsBlock,',
          "} from '../lib/record-rows-block.js';",
          '',
          'export function buildHitListBody(): RecordRowsBlock | null {',
          '  return null;',
          '}',
        ].join('\n'),
      );
      assert.ok(
        integrationProblems(dir).some((problem) => problem.includes('нет вызова')),
        'импорт без вызова монтирования — нарушение (иначе сторож зеленеет на пустом подблоке)',
      );

      // Обратный контроль: вызов внутри сборки группы — нарушений нет.
      writeTree(
        dir,
        TAB,
        [
          'import {',
          '  mountRecordRowsBlock,',
          '  type RecordRowsBlock,',
          "} from '../lib/record-rows-block.js';",
          '',
          'export function buildHitListBody(): RecordRowsBlock {',
          '  return mountRecordRowsBlock({ networkId: "", hits: [], homeId: null, showInactive: false, showTrash: false, onOpen: () => undefined });',
          '}',
        ].join('\n'),
      );
      assert.deepEqual(integrationProblems(dir), [], 'импорт + вызов — правило довольно');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('компонента строки не импортирует экранные модули', () => {
    assert.ok(
      !SCREENS_IMPORT.test(ROW_SOURCE),
      'lib/record-row.ts не импортирует screens/** (ADR 8f0e9412): иначе общая ' +
        'компонента потянет экранный каркас и цикл импортов',
    );
  });

  it('сниппет проходит общий конвейер `[[#id]]` → имя мысли', () => {
    assert.match(
      ROW_SOURCE,
      /import\s*\{[^}]*paintWikiIdsInSnippet[^}]*\}\s*from\s*'\.\.\/editor\/wiki-link-resolver\.js'/,
      'резолвер сниппета подключён из общего модуля, а не переписан локально',
    );
    assert.match(
      ROW_SOURCE,
      /renderHtml\(snippet, paintWikiIdsInSnippet\(model\.snippet, options\.networkId\)\);/,
      'синхронный резолв из кеша — id не мелькает на экране',
    );
    assert.match(
      ROW_SOURCE,
      /resolveWikiIdsInSnippet\(model\.snippet, options\.networkId\)/,
      'батч-дорезолв того же сниппета',
    );
  });

  it('Ctrl+hover-предпросмотр в строке результата не включается (N5)', () => {
    assert.ok(
      !/hover-preview/.test(ROW_SOURCE),
      'строка — навигационный элемент; предпросмотр остаётся фичей ленты «Дневника»',
    );
    assert.ok(
      !/markThoughtCommentPreview|markCommentPreview/.test(ROW_SOURCE),
      'декорации предпросмотра в строке результата не навешиваются',
    );
  });

  it('перетаскивание с чипа не начинается (P3)', () => {
    // Комментарии шапки объясняют жест — проверяется КОД модуля.
    const code = ROW_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(
      !/pointerdown/.test(code),
      'чип — цель клика: жест перетаскивания на чипе не заводится',
    );
    assert.ok(
      !/drag-cloud|drag-list|dragId/.test(code),
      'канал перетаскивания строки-результата не подключается',
    );
  });

  it('кнопка «+N» — из словаря кнопок и несёт вид чипа', () => {
    assert.match(
      ROW_SOURCE,
      /return uiButton\(\{\s*label: `\+\$\{count\}`,/,
      'кнопка строится словарём `lib/ui/button.ts` (guard-ui-buttons)',
    );
    assert.match(
      ROW_SOURCE,
      /class: 'record-row-more chron-chip',/,
      'вид кнопки — чип строки записи (модификатор прикладного слоя)',
    );
    assert.match(
      ROW_SOURCE,
      /const strip: ChipOverflowStrip = mountChipOverflow\(\{/,
      'переполнение чипов — общая измерительная обвязка',
    );
  });

  it('у строки одно действие: клик по строке и Enter ведут одним путём', () => {
    assert.match(
      ROW_SOURCE,
      /row\.addEventListener\('click', \(event\) => \{[\s\S]*?activate\(\);\s*\}\);/,
      'клик по строке — то же действие `activate`, что отдаёт рукоятка (Enter)',
    );
    assert.match(
      ROW_SOURCE,
      /activate: \(\) => activate\(\),/,
      'рукоятка отдаёт активацию наружу для Enter в списке результатов',
    );
  });

  it('адаптеры обоих форматов записи объявлены (следующий потребитель — ae72e47e)', () => {
    assert.match(ROW_SOURCE, /export function recordRowFromChronoHit\(/);
    assert.match(ROW_SOURCE, /export function recordRowFromRecordHit\(/);
  });

  it('обвязка строк-записей снимается во ВСЕХ ветках замены результатов', () => {
    const source = read('search', 'search.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    assert.deepEqual(
      source.match(/\bresultsBox\s*\.\s*replaceChildren\s*\(/g) ?? [],
      [],
      'коробку результатов очищает только общий хелпер: прямой replaceChildren ' +
        'оставляет ResizeObserver на отцепленных строках-записях',
    );
    assert.match(
      source,
      /function clearResults\(box: Element \| null\): void \{[\s\S]*?mountedRecordRows\) handle\.destroy\(\);[\s\S]*?mountedRecordRows\.clear\(\);[\s\S]*?box\?\.replaceChildren\(\);/,
      'хелпер снимает обвязку ДО очистки DOM (инвариант renderResults)',
    );
    const uses = (source.match(/\bclearResults\(/g) ?? []).length;
    assert.ok(
      uses >= 6,
      `хелпер зовётся во всех ветках замены результатов (объявление + 5 мест), найдено: ${uses}`,
    );
  });

  it('правило краснеет на втором сборщике строки в экране', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-record-row-'));
    try {
      const file = path.join(dir, 'screens', 'fake', 'panel.ts');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        'export function buildRow(model: unknown) { return createRecordRow(model, {}); }\n',
        'utf8',
      );
      const violations = collectViolations(dir, [
        {
          name: 'single-record-row-integration',
          description: '',
          filePattern: ROW_BUILD,
          allow: (rel) => BUILDERS.includes(rel),
        },
      ]);
      assert.deepEqual(
        violations.map((violation) => `${violation.rule}:${violation.file}`),
        ['single-record-row-integration:screens/fake/panel.ts'],
        'своя сборка строки-записи в экране — нарушение',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
