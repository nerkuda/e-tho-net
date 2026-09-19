/**
 * Сторож стандарта «Клиент: ввод значения свойства — только через общий
 * редактор значения» (S2, задача 77e7cafd вехи 4 версии 0.8.2; ADR «значение
 * свойства вводит один компонент, свитч по виду значения — в одном
 * экземпляре»).
 *
 * Правила:
 * 1. `switch` по `value_type` (в любом написании — `value_type`, `valueType`)
 *    для построения поля ввода встречается ТОЛЬКО в `editor/value-editor.ts` —
 *    единственном месте клиента, где поле значения строится свитчем по виду.
 * 2. Цепочка `if`/`else if` по виду значения — тот же диспетчер в другой
 *    форме: два и более `if` по БЕЗЫМЯННОМУ `valueType`/`value_type` (не
 *    `def.value_type` — там вид значения читается как данные) в пределах окна
 *    запрещены вне общего редактора. Новый вид значения добавляется в одном
 *    месте и появляется во всех диалогах сразу.
 * 3. Самодельное чип-поле значения (`st-f-chip`) не пишется вне общих модулей:
 *    чипы значений собирает общий редактор, чипы сущностей — общий чип-лист
 *    пикера (`lib/entity-picker.ts`). Легаси-чипы полей критериев панели
 *    «Структур» (`screens/structures/filter-panel.ts`) — до их перевода
 *    задачей 3742dd59 — единственное исключение.
 *
 * Сторож вводится зелёным — в том же изменении, которое переводит все поля
 * ввода на общий редактор (мета-стандарт «Правило без теста-сторожа
 * не считается введённым»).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean, collectViolations, type GuardRule } from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

/** Один `if`, сравнивающий БЕЗЫМЯННЫЙ идентификатор вида значения
 *  (`value_type`/`valueType`), а не свойство DTO (`def.value_type`). */
const VALUE_TYPE_IF =
  String.raw`\bif\s*\([^\n)]*(?<![.\w])value_?[tT]ype\b[^\n)]*\)`;

/** Цепочка из двух таких `if` в пределах окна — форма диспетчера. */
const IF_DISPATCH_WINDOW = 700;

/** Легаси-исключений нет: панель «Структур» переведена задачей 3742dd59. */
const LEGACY_CHIP_SITES = new Set<string>();

const RULES: GuardRule[] = [
  {
    name: 'no-value-type-switch',
    description:
      '`switch` по виду значения (value_type/valueType) для построения поля ' +
      'ввода разрешён только в editor/value-editor.ts (стандарт S2, ADR ' +
      '«значение свойства вводит один компонент…»).',
    filePattern: /\bswitch\s*\(\s*[^)]*\bvalue_?[tT]ype\s*\)/g,
    allow: (rel) => rel === 'editor/value-editor.ts',
  },
  {
    name: 'no-value-type-if-dispatch',
    description:
      'Цепочка `if` по виду значения (два и более if по безымянному ' +
      'valueType/value_type) — тот же диспетчер, что и switch: строится ' +
      'только в editor/value-editor.ts (стандарт S2).',
    filePattern: new RegExp(
      `${VALUE_TYPE_IF}[\\s\\S]{0,${IF_DISPATCH_WINDOW}}?${VALUE_TYPE_IF}`,
      'g',
    ),
    allow: (rel) => rel === 'editor/value-editor.ts',
  },
  {
    name: 'no-own-value-chip-field',
    description:
      'Самодельное чип-поле значения (класс st-f-chip) вне общих модулей ' +
      'запрещено: чипы значений собирает editor/value-editor.ts, чипы ' +
      'сущностей — lib/entity-picker.ts (инструкция «…унифицированные поля ' +
      'выбора ссылок…», стандарт S2).',
    pattern: /\bst-f-chip\b/,
    allow: (rel) => rel === 'editor/value-editor.ts' || LEGACY_CHIP_SITES.has(rel),
  },
];

describe('guard: ввод значения свойства строится только общим редактором', () => {
  it('диспетчеры по виду значения и самодельные чип-поля вне общего редактора запрещены', () => {
    assertGuardClean(RENDERER_ROOT, RULES);
  });

  it('каждое правило краснеет на умышленно добавленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-value-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'fake-value-editor.ts'),
        [
          "import { div, el } from './lib/dom.js';",
          'function buildField(valueType: string): HTMLElement {',
          "  if (valueType === 'bool') {",
          "    return el('select');",
          '  }',
          "  if (valueType === 'number') {",
          "    return el('input');",
          '  }',
          "  return div('st-f-chip');",
          '}',
          'void buildField;',
        ].join('\n'),
        'utf8',
      );
      const violations = collectViolations(dir, RULES);
      const names = new Set(violations.map((v) => v.rule));
      assert.ok(
        names.has('no-value-type-if-dispatch'),
        'цепочка if по виду значения обязана попадать в нарушение',
      );
      assert.ok(
        names.has('no-own-value-chip-field'),
        'самодельное чип-поле значения обязано попадать в нарушение',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
