/**
 * Сторож правила «даты периода в интерфейсе задаются только редактором
 * периода» (0.10.1, задача T5 740b8045; ADR d4d53fe6 «редактор периода —
 * новый библиотечный модуль lib/period-editor.ts»; элемент интерфейса
 * «Поле периода» 2f14de06; стандарт библиотечности a2488f05).
 *
 * Правило: поля дат периода (лента «Дневника», панель отбора, вкладка
 * «Дневник» редактора) строит общий контрол `lib/period-editor.ts`. Свои
 * `<input type="date">`/`<input type="datetime-local">`/`<input type="time">`
 * для периода в экранах и панелях запрещены — иначе три места снова разойдутся
 * по поведению (режимы, токены, сохранение времени по ADR 994d076a).
 *
 * **Согласование с кодовой базой.** Контрол введён задачей T5; потребители
 * (лента/панель — T6, вкладка редактора — T8) перешли на него. Поэтому правило
 * допускает ровно перечисленные ниже места: сам контрол, общий редактор
 * значения (`editor/value-editor.ts` — свойства-даты, не период), сборщик
 * условий отбора (`lib/filter-form.ts` — строки дат панелей) и вне области
 * «Дневника» (`admin/`, `screens/activity/`). Перечень закрыт тестом-снимком:
 * расширять его можно только осознанно.
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

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

/** Единственное разрешённое место определения контрола. */
const PERIOD_EDITOR = 'lib/period-editor.ts';

/**
 * Файлы, которым поле даты/времени разрешено не через «редактор периода»
 * (см. докблок). Ключ — путь относительно `src/renderer`, слеши `/`.
 */
const ALLOWED_DATE_INPUT_FILES = new Set([
  PERIOD_EDITOR,
  // Диалог даты/периода (0.10.1, приёмка №5): поля времени `HH:MM` — часть
  // того же контрола даты/периода, вынесенного в библиотечный компонент.
  'lib/date-period-dialog.ts',
  // Общий редактор значения — свойства-даты (сюда же попадает тикет-ветка
  // редактора свойств), не период «Дневника».
  'editor/value-editor.ts',
  // Строки условий дат панелей отбора («Создано»/«Изменено») — не период ленты.
  'lib/filter-form.ts',
  // Вне области «Дневника»: фильтр дат журнала активности и даты в админке.
  'admin/admin.ts',
  'screens/activity/activity.ts',
]);

/** Точка входа контрола — не должна объявляться нигде, кроме модуля. */
const NO_SECOND_PERIOD_EDITOR: GuardRule = {
  name: 'no-second-period-editor',
  description:
    'Контрол периода объявляется только в lib/period-editor.ts: вторая ' +
    'реализация (buildPeriodEditor/periodEditor вне модуля) разойдётся с ' +
    'оригиналом по режимам и сохранению времени (ADR d4d53fe6).',
  pattern: /\b(?:function|const)\s+(?:buildPeriodEditor|periodEditor)\b/,
  allow: (rel) => rel === PERIOD_EDITOR,
};

/** Императивное присваивание нативного типа поля даты/времени. */
const NO_RAW_PERIOD_DATE_ASSIGN: GuardRule = {
  name: 'no-raw-period-date-input',
  description:
    'Свои поля `input[type=date|datetime-local|time]` для периода в интерфейсе ' +
    'запрещены — даты периода задаёт общий контрол lib/period-editor.ts ' +
    '(ADR d4d53fe6; иначе лента, панель и вкладка редактора расходятся).',
  pattern: /\.type\s*=\s*['"](?:date|datetime-local|time)['"]/,
  allow: (rel) => ALLOWED_DATE_INPUT_FILES.has(rel),
};

/** Нативный тип поля даты/времени, заданный опцией фасада `fieldInput`. */
const NO_RAW_PERIOD_DATE_FIELD: GuardRule = {
  name: 'no-raw-period-date-field',
  description:
    'Поле даты/времени периода через `fieldInput({ type: ... })` вне общего ' +
    'контрола lib/period-editor.ts запрещено (ADR d4d53fe6).',
  filePattern: /fieldInput\(\{[^)]*?type:\s*['"](?:date|datetime-local|time)['"]/g,
  allow: (rel) => ALLOWED_DATE_INPUT_FILES.has(rel),
};

const RULES: GuardRule[] = [
  NO_SECOND_PERIOD_EDITOR,
  NO_RAW_PERIOD_DATE_ASSIGN,
  NO_RAW_PERIOD_DATE_FIELD,
];

describe('guard: даты периода задаёт только редактор периода', () => {
  it('полей дат периода мимо общего контрола нет', () => {
    assertGuardClean(RENDERER_ROOT, RULES);
  });

  it('точка входа контрола объявлена ровно в lib/period-editor.ts', () => {
    const src = fs.readFileSync(path.join(RENDERER_ROOT, PERIOD_EDITOR), 'utf8');
    assert.match(
      src,
      /export function buildPeriodEditor\s*\(/,
      'общий контрол обязан экспортировать buildPeriodEditor',
    );
  });

  it('перечень разрешённых мест закрыт (осознанное расширение)', () => {
    const allowed = [...ALLOWED_DATE_INPUT_FILES].sort();
    assert.deepEqual(allowed, [
      'admin/admin.ts',
      'editor/value-editor.ts',
      'lib/date-period-dialog.ts',
      'lib/filter-form.ts',
      'lib/period-editor.ts',
      'screens/activity/activity.ts',
    ]);
  });

  it('правила краснеют на умышленных нарушениях', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-period-'));
    try {
      fs.mkdirSync(path.join(dir, 'screens', 'fake'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'screens', 'fake', 'diary.ts'),
        [
          "import { fieldInput } from '../../lib/ui/field.js';",
          'const fromInput = fieldInput({ type: \'date\' });',
          "const toInput = document.createElement('input');",
          "toInput.type = 'datetime-local';",
          'export function buildPeriodEditor(): void {}',
          'void fromInput; void toInput;',
        ].join('\n'),
        'utf8',
      );
      const names = new Set(collectViolations(dir, RULES).map((v) => v.rule));
      assert.ok(names.has('no-second-period-editor'), 'вторая реализация обязана краснеть');
      assert.ok(names.has('no-raw-period-date-input'), 'сырой input[type=datetime-local] обязан краснеть');
      assert.ok(names.has('no-raw-period-date-field'), 'fieldInput({type:\'date\'}) обязан краснеть');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
