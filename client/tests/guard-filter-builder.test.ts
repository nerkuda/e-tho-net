/**
 * Сторож стандарта «Клиент: условия отбора — только через общий конструктор»
 * (S4, задача 48b59d00 вехи 5 версии 0.8.2; ADR «условия отбора строит один
 * конструктор с одной моделью состояния»).
 *
 * Правила:
 * 1. Словарь операторов по виду значения объявляется ТОЛЬКО в
 *    `lib/filter-builder.ts` (`const OPS_BY_TYPE … = {`): второй словарь
 *    операторов вне конструктора запрещён.
 * 2. Словарь операторов авторства объявляется ТОЛЬКО там же
 *    (`const AUTHOR_OP_LABELS … = {`): прежде было 4 копии.
 * 3. Набор сортировок отбора объявляется ТОЛЬКО там же: константа
 *    `*SORT*`-массив с литералом `'alpha'`, либо сборка списка `<option>`/
 *    `for (const opt of […)` из литералов сортировок — признак второго
 *    набора, который разойдётся с исполнителем (ошибка 33a3e285).
 * 4. Вторая МОДЕЛЬ состояния отбора в экранах запрещена
 *    (`ChronicleFilterState`, `ActivityFilterState`, `SearchOptions`,
 *    `DialogCriteriaState`): критерии выражаются общей моделью
 *    `FilterCriteriaState`; экранное расширение допустимо только как
 *    `interface X extends FilterCriteriaState`.
 * 5. Второй конвертер/парсер отбора в экранах запрещён (`toDefinition`,
 *    `fromDefinition`, `buildChronicleWire`, `parseChronicleCriteria`,
 *    `buildActivityQueryPlan`, `parseSearchCriteria`, …): и чтение
 *    сохранённого, и запись в wire живут в `lib/filter-builder.ts`.
 *
 * Сторож вводится зелёным — в том же изменении, которое сводит все пять
 * мест применения к одному модулю (мета-стандарт «Правило без теста-сторожа
 * не считается введённым»).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
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

/** Файл единого конструктора — единственное разрешённое место словарей. */
const BUILDER = 'lib/filter-builder.ts';

/** Экраны и строка поиска — места применения конструктора, а не его копии. */
const APPLY_SITES = (rel: string): boolean => rel.startsWith('screens/') || rel.startsWith('search/');

/** Тонкие обёртки-делегаты диалога отбора типа мысли (логики в них нет). */
const DELEGATING_WRAPPERS = new Set(['screens/thought-type/filter-dialog-pure.ts']);

/** Признак собственной модели критериев отбора. */
const OWN_MODEL_NAMES =
  /^(?:export\s+)?interface\s+(?:ChronicleFilterState|ActivityFilterState|SearchOptions|DialogCriteriaState|FilterCriteriaState|FilterState)\s*(?:extends\b|\{)/;

/** Признак собственного конвертера/парсера отбора. */
const OWN_CONVERTER =
  /^(?:export\s+)?(?:function|const)\s+(?:toDefinition|fromDefinition|buildWireFilter|buildChronicleWire|parseChronicleCriteria|parseFilterDefinition|buildActivityQueryPlan|parseActivityCriteria|parseSearchCriteria|buildWireDefinition|parseViewDefinition)\b/;

describe('guard: условия отбора строятся только общим конструктором', () => {
  it('второй словарь операторов (OPS_BY_TYPE) вне lib/filter-builder.ts запрещён', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-second-ops',
        description:
          'Словарь операторов по виду значения объявляется только в ' +
          'lib/filter-builder.ts (стандарт S4, ADR «условия отбора строит один ' +
          'конструктор…»); вторая копия разойдётся с сервером и второй панелью.',
        pattern: /^(?:export\s+)?const\s+OPS_BY_TYPE\s*[:=]/,
        allow: (rel) => rel === BUILDER,
      },
    ]);
  });

  it('второй словарь операторов авторства (AUTHOR_OP_LABELS) вне lib/filter-builder.ts запрещён', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-second-author-labels',
        description:
          'Словарь подписей операторов авторства объявляется только в ' +
          'lib/filter-builder.ts (стандарт S4); прежде копий было четыре.',
        pattern: /^(?:export\s+)?const\s+AUTHOR_OP_LABELS\s*[:=]/,
        allow: (rel) => rel === BUILDER,
      },
    ]);
  });

  it('второй набор сортировок отбора вне lib/filter-builder.ts запрещён', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-second-sort-set',
        description:
          'Набор сортировок отбора объявляется только в lib/filter-builder.ts: ' +
          'константа-массив с *SORT* в имени, содержащая литерал сортировки, ' +
          'или сборка списка опций `for (const opt of […)` из литералов ' +
          'сортировок — второй набор разойдётся с исполнителем (ошибка 33a3e285).',
        filePattern: /const\s+[A-Za-z_]*SORT[A-Za-z_]*\s*(?::[^=]+)?=\s*\[[\s\S]{0,400}?['"]alpha['"]/g,
        allow: (rel) => rel === BUILDER,
      },
      {
        name: 'no-second-sort-options',
        description:
          'Сборка списка опций сортировки из литералов (`for (const opt of [` с ' +
          '`\'alpha\'`/`\'created\'`/…) разрешена только в lib/filter-builder.ts — ' +
          'списки `<option>` обоих отборов собираются из единого FILTER_SORTS.',
        filePattern: /for\s*\(\s*const\s+opt\s+of\s+\[[\s\S]{0,400}?['"]alpha['"]/g,
        allow: (rel) => rel === BUILDER,
      },
    ]);
  });

  it('вторая модель состояния отбора в экранах запрещена', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-second-criteria-model',
        description:
          'Своя модель критериев отбора в экране (`ChronicleFilterState`, ' +
          '`ActivityFilterState`, `SearchOptions`, …) запрещена: критерии ' +
          'выражаются общей `FilterCriteriaState`; экранное расширение — только ' +
          '`interface X extends FilterCriteriaState` (задача 3742dd59).',
        pattern: OWN_MODEL_NAMES,
        include: APPLY_SITES,
        // Экранное расширение общей модели (панель «Структур») — не вторая
        // модель: у него нет своих критериев, только панельные дополнения.
        allow: (rel, line) => DELEGATING_WRAPPERS.has(rel) || line.includes('extends FilterCriteriaState'),
      },
    ]);
  });

  it('второй конвертер/парсер отбора в экранах запрещён', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-second-wire-converter',
        description:
          'Свой конвертер состояния отбора в wire или свой парсер сохранённого ' +
          'определения в экране запрещён (`toDefinition`/`fromDefinition`/' +
          '`buildChronicleWire`/`parseChronicleCriteria`/`buildActivityQueryPlan`/' +
          '`parseSearchCriteria`): и запись, и чтение живут в ' +
          'lib/filter-builder.ts (задача 3742dd59).',
        pattern: OWN_CONVERTER,
        include: APPLY_SITES,
        allow: (rel) => DELEGATING_WRAPPERS.has(rel),
      },
    ]);
  });

  it('оба новых правила краснеют на умышленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-filter-'));
    try {
      fs.mkdirSync(path.join(dir, 'screens', 'fake'), { recursive: true });
      const rules = [
        {
          name: 'no-second-criteria-model',
          description: '',
          pattern: OWN_MODEL_NAMES,
          include: APPLY_SITES,
          allow: (rel: string, line: string) =>
            DELEGATING_WRAPPERS.has(rel) || line.includes('extends FilterCriteriaState'),
        },
        {
          name: 'no-second-wire-converter',
          description: '',
          pattern: OWN_CONVERTER,
          include: APPLY_SITES,
          allow: (rel: string) => DELEGATING_WRAPPERS.has(rel),
        },
      ];
      fs.writeFileSync(
        path.join(dir, 'screens', 'fake', 'panel.ts'),
        [
          'export interface ChronicleFilterState {',
          '  keywords: string;',
          '}',
          'export function toDefinition(state: ChronicleFilterState): unknown {',
          '  return state;',
          '}',
        ].join('\n'),
        'utf8',
      );
      const names = new Set(collectViolations(dir, rules).map((v) => v.rule));
      assert.ok(names.has('no-second-criteria-model'), 'своя модель обязана попадать в нарушение');
      assert.ok(names.has('no-second-wire-converter'), 'свой конвертер обязана попадать в нарушение');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
