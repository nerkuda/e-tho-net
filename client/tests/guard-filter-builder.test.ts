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
 *
 * Сторож вводится зелёным — в том же изменении, которое сводит оба
 * конструктора к одному модулю (мета-стандарт «Правило без теста-сторожа
 * не считается введённым»).
 */

import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean } from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

/** Файл единого конструктора — единственное разрешённое место словарей. */
const BUILDER = 'lib/filter-builder.ts';

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
});
