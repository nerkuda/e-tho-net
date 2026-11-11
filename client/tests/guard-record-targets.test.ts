/**
 * Сторож: видимые привязки дневниковой записи — ОДИН предикат
 * `lib/record-targets.ts` (0.15.4, тех.проект 43329662, задача 33ed043c,
 * стандарт a2488f05 «правило вводится только со сторожем»).
 *
 * Причина. Правило «что из привязок записи видно» нужно трём поверхностям:
 * строке результата поиска, вкладке «Упоминания» (задача ae72e47e) и ленте
 * экрана «Дневник». До выноса оно жило в `screens/chronicle/diary.ts` и
 * фильтровало ТОЛЬКО HOME; вторая копия в строке результата неизбежно разошлась
 * бы с первой — ровно поэтому предикат один.
 *
 * Сужающий контракт (решение пользователя 2026-11-10, K4): настройка
 * `show_trash` действует ТОЛЬКО на привязки-МЫСЛИ; привязка-СВЯЗЬ фильтруется
 * исключительно по `active` — пометки удаления у связи в контракте
 * `chronicle/query` нет и она не добавляется.
 *
 * Что проверяется:
 *  1. объявление `visibleRecordTargets` — только в общем модуле;
 *  2. фильтрация привязок записи (`targets.filter`) — только в общем предикате
 *     (единственное осознанное исключение — снятие чипса в ленте «Дневника»,
 *     оно не про видимость);
 *  3. форма фильтра HOME (`thought.id === homeId`) живёт только в предикате;
 *  4. в поверхностях строки-записи нет собственной логики корзины;
 *  5. K4 закодирован в предикате: мысль проверяет пометку удаления, связь — нет;
 *  6. экранная обёртка `visibleChips` остаётся тонкой (разрешающие флаги).
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

/** Единственный дом предиката видимых привязок. */
const PREDICATE = 'lib/record-targets.ts';

/** Осознанное исключение из правила «фильтрация — только в предикате». */
const CHIP_DETACH = 'screens/chronicle/chronicle.ts';

/** Признак второго объявления предиката. */
const SECOND_PREDICATE =
  /^\s*(?:export\s+)?(?:async\s+)?function\s+visibleRecordTargets\b|^\s*(?:export\s+)?const\s+visibleRecordTargets\b/;

/** Признак собственной фильтрации привязок записи. */
const TARGETS_FILTER = /\btargets\s*\.\s*filter\s*\(/;

/** Признак собственного фильтра HOME по привязке-мысли (старая форма). */
const HOME_FILTER = /\.thought\.id\s*[!=]==\s*homeId\b/;

/**
 * Поверхности, которым запрещено заводить свою логику корзины привязок.
 * Место интеграции поиска входит в правило: строка-запись строится там, значит
 * и собственная проверка пометки удаления там не появляется (замечание приёмки 1,
 * круг 2).
 */
const TARGET_SURFACES =
  /^(?:lib\/record-row|lib\/record-targets|search\/search|screens\/chronicle\/diary|screens\/chronicle\/record-head)\.ts$/;

/** Признак собственной проверки пометки удаления. */
const TRASH_MARK = /\bmarked_for_deletion\b/;

/** Исходник модуля рендерера. */
function read(...parts: string[]): string {
  return readFileSync(path.join(RENDERER_ROOT, ...parts), 'utf8');
}

describe('guard: один предикат видимых привязок записи (задача 33ed043c)', () => {
  it('второе объявление `visibleRecordTargets` запрещено', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'single-visible-record-targets',
        description:
          'Видимые привязки записи считает только lib/record-targets.ts: ' +
          'копия правила в экране/поиске разойдётся с оригиналом (стандарт a2488f05).',
        pattern: SECOND_PREDICATE,
        allow: (rel) => rel === PREDICATE,
      },
    ]);
  });

  it('фильтрация привязок записи — только в общем предикате', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'single-targets-filter',
        description:
          'Фильтр привязок записи (`targets.filter`) живёт в lib/record-targets.ts. ' +
          'Новое место — осознанное исключение сторожа: оно проверяет инвариант ' +
          '«видимость считается одним предикатом», а не переписывает его.',
        pattern: TARGETS_FILTER,
        allow: (rel) => rel === PREDICATE || rel === CHIP_DETACH,
      },
    ]);
  });

  it('фильтр HOME по привязке-мысли живёт только в предикате', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'single-home-filter',
        description:
          'HOME скрывается общим предикатом: локальная форма ' +
          '`target.thought.id === homeId` — вторая копия правила (требование c81964c7).',
        pattern: HOME_FILTER,
        allow: (rel) => rel === PREDICATE,
      },
    ]);
  });

  it('поверхности строки-записи не заводят своей логики корзины', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-local-trash-filter',
        description:
          'Пометка удаления привязки проверяется только в lib/record-targets.ts ' +
          '(K4): в строке-записи, экранной обёртке и заголовке записи своей проверки нет.',
        pattern: TRASH_MARK,
        include: (rel) => TARGET_SURFACES.test(rel),
        allow: (rel) => rel === PREDICATE,
      },
    ]);
  });

  it('K4 закодирован в предикате: мысль — по пометке, связь — только по active', () => {
    const source = read('lib', 'record-targets.ts');
    const body = /export function visibleRecordTargets\([\s\S]*?\n\}/.exec(source)?.[0] ?? '';
    assert.ok(body !== '', 'тело предиката найдено');
    const code = body.replace(/\/\/[^\n]*/g, '');

    assert.match(
      code,
      /if \(!showTrash && thought\.marked_for_deletion\) return false;/,
      'K4: у привязки-мысли пометка удаления учитывается настройкой «корзина»',
    );
    assert.match(
      code,
      /return showInactive \|\| target\.link\.active;/,
      'K4: у привязки-связи остаётся только актуальность',
    );
    // Ветка связи не читает пометку удаления ни в каком виде: у `ChronicleTargetLink`
    // её нет, и добавление поля в контракт — отдельное решение, а не побочный эффект.
    const linkBranch = /\/\/ K4: чип-связь[\s\S]*?target\.link\.active;/.exec(body)?.[0] ?? '';
    assert.ok(linkBranch !== '', 'ветка чипа-связи найдена');
    assert.ok(
      !linkBranch.includes('marked_for_deletion'),
      'чип-связь не фильтруется по корзине (K4)',
    );
  });

  it('экранная обёртка `visibleChips` остаётся тонкой (граница версии)', () => {
    const diary = read('screens', 'chronicle', 'diary.ts');
    const body = /export function visibleChips\([\s\S]*?\n\}/.exec(diary)?.[0] ?? '';
    assert.ok(body !== '', 'тело visibleChips найдено');
    const code = body.replace(/\/\/[^\n]*/g, '');

    assert.match(
      code,
      /return visibleRecordTargets\(targets, \{ homeId, showInactive: true, showTrash: true \}\);/,
      'лента «Дневника» делегирует общему предикату с РАЗРЕШАЮЩИМИ флагами ' +
        '(видимый результат экрана прежний — фильтруется только HOME)',
    );
    assert.ok(
      !/\.filter\(/.test(code),
      'собственной фильтрации в обёртке нет — иначе правило снова раздвоится',
    );
  });

  it('правила краснеют на умышленном нарушении', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-record-targets-'));
    try {
      const file = path.join(dir, 'screens', 'fake.ts');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        [
          'export function visibleRecordTargets(targets: ChronicleTarget[]) {',
          '  const marked = target.thought.marked_for_deletion;',
          '  return targets.filter((target) => !(target.thought.id === homeId));',
          '}',
        ].join('\n'),
        'utf8',
      );
      const names = new Set(
        collectViolations(dir, [
          { name: 'single-visible-record-targets', description: '', pattern: SECOND_PREDICATE },
          { name: 'single-home-filter', description: '', pattern: HOME_FILTER },
          { name: 'single-targets-filter', description: '', pattern: TARGETS_FILTER },
        ]).map((violation) => violation.rule),
      );
      assert.ok(names.has('single-visible-record-targets'), 'копия предиката — нарушение');
      assert.ok(names.has('single-home-filter'), 'локальный фильтр HOME — нарушение');
      assert.ok(names.has('single-targets-filter'), 'локальная фильтрация привязок — нарушение');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
