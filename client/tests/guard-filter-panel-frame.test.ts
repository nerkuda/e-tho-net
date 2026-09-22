/**
 * Сторож однообразия панелей отбора (задача 2ebe4206, версия 0.8.2).
 *
 * Правило: скрываемость, положение по ширине полотна, размер и строка
 * сохранённых отборов панелей отбора — ОБЩИЕ (модули
 * `lib/filter-panel-frame.ts` и `lib/saved-filter-bar.ts`) и подключаются
 * экранами, а не пишутся заново. Прежде каждая панель («Структуры», «Хроника»,
 * «События») решала это сама и по-разному: две панели имели сплиттер ширины с
 * собственной CSS-переменной, «Хроника» — сплиттер высоты, скрывать панель не
 * умел никто, а сохранённые отборы были только у «Структур».
 *
 * Сторож вводится зелёным — в том же изменении, которое сводит три панели к
 * общему каркасу (мета-стандарт «Правило без теста-сторожа не считается
 * введённым»).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { assertGuardClean, collectViolations } from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(import.meta.dirname, '..', 'src', 'renderer');

/** Экраны с панелью отбора — места применения общего каркаса. */
const SCREENS = (rel: string): boolean =>
  rel === 'screens/structures/structures.ts' ||
  rel === 'screens/chronicle/chronicle.ts' ||
  rel === 'screens/activity/activity.ts';

/** Признак собственного сплиттера панели отбора в экране. */
const OWN_PANEL_SPLITTER = /wirePanelSplitter|--st-filter-w|--act-filter-w/;

/** Признак собственной строки/списка сохранённых отборов в панели экрана. */
const OWN_SAVED_FILTER_UI = /['"]st-f-saved(?:list)?['"]/;

const RULES = [
  {
    name: 'no-own-panel-splitter',
    description:
      'Размер панели отбора меняет общий каркас `lib/filter-panel-frame.ts` ' +
      '(задача 2ebe4206): свой сплиттер и своя CSS-переменная ширины в экране ' +
      'запрещены — прежде панели «Структур» и «Событий» расходились в поведении.',
    pattern: OWN_PANEL_SPLITTER,
    include: SCREENS,
  },
  {
    name: 'no-own-saved-filter-ui',
    description:
      'Строку и список сохранённых отборов строит общий модуль ' +
      '`lib/saved-filter-bar.ts` (задача 2ebe4206): свой список в панели ' +
      'экрана запрещён — «Хроника» обязана работать с отборами как «Структуры».',
    pattern: OWN_SAVED_FILTER_UI,
    include: (rel: string) => rel.startsWith('screens/'),
  },
];

describe('guard: панели отбора строятся общим каркасом', () => {
  it('свой сплиттер панели и своя переменная ширины в экранах запрещены', () => {
    assertGuardClean(RENDERER_ROOT, [RULES[0]!]);
  });

  it('свой список сохранённых отборов в экранах запрещён', () => {
    assertGuardClean(RENDERER_ROOT, [RULES[1]!]);
  });

  it('все три экрана монтируют общий каркас панели', () => {
    for (const rel of [
      'screens/structures/structures.ts',
      'screens/chronicle/chronicle.ts',
      'screens/activity/activity.ts',
    ]) {
      const src = fs.readFileSync(path.join(RENDERER_ROOT, rel), 'utf8');
      assert.match(src, /mountFilterPanelFrame\(\{/, `${rel} обязан монтировать общий каркас панели`);
    }
  });

  it('оба правила краснеют на умышленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-fp-'));
    try {
      // Путь — один из трёх экранов: правило о сплиттере действует только там.
      fs.mkdirSync(path.join(dir, 'screens', 'structures'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'screens', 'structures', 'structures.ts'),
        ['function wirePanelSplitter() {}', "const list = el('button', 'st-f-savedlist');"].join('\n'),
      );
      const violations = collectViolations(dir, RULES);
      assert.ok(
        violations.some((v) => v.rule === 'no-own-panel-splitter'),
        'правило о собственном сплиттере срабатывает',
      );
      assert.ok(
        violations.some((v) => v.rule === 'no-own-saved-filter-ui'),
        'правило о собственном списке отборов срабатывает',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
