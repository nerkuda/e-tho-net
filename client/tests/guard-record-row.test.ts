/**
 * Сторож: общая строка дневниковой записи — ОДНА компонента в ОДНОМ месте
 * интеграции на эту версию (0.15.4, тех.проект 43329662, задача 33ed043c,
 * элемент 554e3129, ADR 8f0e9412).
 *
 * Почему сторож. Пока строку-запись собирал сам экран, форма разъезжалась:
 * группа «Найдено в хронологии» показывала только период и сниппет — без
 * привязок и без перехода. Компонента живёт в `lib/` и собирается ОДНИМ
 * вызовом в поиске; второй потребитель («Упоминания», задача ae72e47e) придёт
 * отдельной работой — тогда этот сторож осознанно расширится, а не «просто
 * позеленеет».
 *
 * Дополнительно фиксируются правила состава строки:
 *  * сниппет проходит ТОТ ЖЕ конвейер `[[#id]]` → имя мысли, что у прочих
 *    результатов (ошибка 2a8181f4) — регресс недопустим;
 *  * Ctrl+hover-предпросмотр в строке результата не включается (уточнение N5:
 *    предпросмотр — фича ленты «Дневника»);
 *  * перетаскивание с чипа не начинается (P3): чип — цель клика;
 *  * кнопка «+N» — из словаря кнопок и выглядит чипом (guard-ui-buttons).
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

/** Единственное место интеграции этой версии. */
const SEARCH = 'search/search.ts';

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

describe('guard: общая строка-запись — одна компонента, одно место интеграции', () => {
  it('строку собирает только lib/record-row.ts, интеграция — одна (поиск)', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'single-record-row-integration',
        description:
          'Строку дневниковой записи собирает общая компонента lib/record-row.ts; ' +
          'место интеграции этой версии — search/search.ts. Второй сборщик в экране ' +
          'вернёт расхождение формы (период без привязок и перехода).',
        filePattern: ROW_BUILD,
        allow: (rel) => rel === ROW || rel === SEARCH,
      },
    ]);
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
          allow: (rel) => rel === ROW || rel === SEARCH,
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
