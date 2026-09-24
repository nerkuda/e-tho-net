/**
 * Сторож фасадов полей и переключателей `lib/ui` (задача f351b894,
 * требование e64083b5 «Поля и переключатели — фасады lib/ui над Web Awesome»,
 * ADR 03eb2c61, инвентаризация 3fc7c54d — разделы 2.1–2.3).
 *
 * Правило: поля, флажки/радиокнопки и их строки, сегменты, тумблеры и бейджи
 * собираются через фасады `lib/ui`. Самодельные конструкции запрещены —
 * каждый запрет ловится обычным прогоном `npm -w @etn/client test`.
 *
 * Запрещено в разметке рендерера (вне `lib/ui`):
 *   1. базовые классы полей `text-input` / `textarea-input`;
 *   2. прямые `<input>`/`<textarea>` (`el('input' …)`) — поля собирает
 *      `fieldInput`/`fieldTextarea`/`filePathField`/`colorField`;
 *   3. старые классы `checkbox-row` / `radio-row` / `radio-group` и голые
 *      `type = 'checkbox'` / `type = 'radio'` — строку строит `choiceRow`,
 *      контрол без подписи — `choiceControl`;
 *   4. контейнер/подпись поля `'field'` / `'field-label'` — их строит `fieldRow`;
 *   5. `font-toggle(s)` — тумблер строит `toggleButton`, ряд — `ui-toggle-group`;
 *   6. `role-badge` / `group-count` / `st-count` — бейдж строит `badge`;
 *   7. `clearable-field` / `clearable-clear` / `color-input` — обёртку очистки
 *      и поле цвета строят `wrapClearable` / `colorField`.
 *
 * **Allow-края (этап 2).** Общие компоненты отбора и сущностей несут
 * собственную лексику контролов (`st-f-*`) и относятся к под-проекту «единый
 * список» (каталог 3fc7c54d: FilterPanelFrame — «оставить»; EntityCombo/
 * ChipField — не трогать): `lib/filter-form.ts`, `lib/entity-picker.ts`,
 * `lib/saved-filter-bar.ts`. Их контролы переводит профильная задача этапа 2.
 *
 * Строки-комментарии правилом не считаются (в пояснениях имена старых классов
 * допустимы).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { assertGuardClean, type GuardRule } from './guard-helpers.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

/** Allow-края этапа 2: свои контролы `st-f-*`/дерева (см. шапку). */
const ALLOW_EDGE_FILES = new Set([
  'lib/filter-form.ts',
  'lib/entity-picker.ts',
  'lib/saved-filter-bar.ts',
]);

/** Строка — комментарий? (в пояснениях имена старых классов допустимы). */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** Общее для всех правил: не `lib/ui`, не allow-край, не комментарий. */
function outsideFacades(rel: string, line: string): boolean {
  return isComment(line) || ALLOW_EDGE_FILES.has(rel);
}

function rules(): GuardRule[] {
  const include = (rel: string): boolean => !rel.startsWith('lib/ui/');
  return [
    {
      name: 'no-field-base-classes',
      description: 'Базовые классы полей упразднены — поле строит fieldInput/fieldTextarea.',
      pattern: /(?:text-input|textarea-input)/,
      include,
      allow: outsideFacades,
    },
    {
      name: 'no-raw-input',
      description: "Прямые <input>/<textarea> запрещены — поле строит fieldInput/fieldTextarea/colorField/filePathField.",
      pattern: /el\(\s*['"](?:input|textarea)['"]/,
      include,
      allow: outsideFacades,
    },
    {
      name: 'no-legacy-choice-classes',
      description: 'Старые классы строк-переключателей упразднены — строку строит choiceRow.',
      pattern: /(?:checkbox-row|radio-row|radio-group)/,
      include,
      allow: outsideFacades,
    },
    {
      name: 'no-raw-choice-types',
      description: "Голые type='checkbox'/'radio' запрещены — контрол строит choiceRow/choiceControl.",
      pattern: /\.type\s*=\s*['"](?:checkbox|radio)['"]/,
      include,
      allow: outsideFacades,
    },
    {
      name: 'no-legacy-field-container',
      description: 'Контейнер и подпись поля строит fieldRow (классы ui-field/ui-field-label).',
      pattern: /['"]field['"]|['"]field-label['"]/,
      include,
      allow: outsideFacades,
    },
    {
      name: 'no-legacy-font-toggle',
      description: 'Переключатели шрифта строит toggleButton (вид glyph), ряд — ui-toggle-group.',
      pattern: /font-toggle/,
      include,
      allow: outsideFacades,
    },
    {
      name: 'no-legacy-badges',
      description: 'Бейджи (метки и счётчики) строит badge.',
      pattern: /['"](?:role-badge|group-count|st-count)['"]/,
      include,
      allow: outsideFacades,
    },
    {
      name: 'no-legacy-clearable-color',
      description: 'Обёртку очистки и поле цвета строят wrapClearable/colorField.',
      pattern: /(?:clearable-field|clearable-clear|['"]color-input['"])/,
      include,
      allow: outsideFacades,
    },
  ];
}

describe('guard: фасады полей и переключателей lib/ui', () => {
  it('самодельных полей, переключателей, бейджей и полей цвета нет', () => {
    assertGuardClean(RENDERER_ROOT, rules());
  });
});
