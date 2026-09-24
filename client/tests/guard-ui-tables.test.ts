/**
 * Сторож единого табличного компонента `lib/ui` (задача dad2b029, требование
 * 93115633 «Единый табличный компонент списков», техпроект 78398ec5,
 * ADR 03eb2c61).
 *
 * Правило: любой список в клиенте — таблица единого фасада `lib/ui/table.ts`
 * (`createTable`). Самодельная сборка таблиц (`<table>`/`thead`/`tbody`/`tr`/
 * `th`/`td` через `el(...)`/`createElement(...)`, сырой HTML `<table>` или
 * собственный хелпер `createTable`) в рендерере вне `lib/ui` запрещена.
 *
 * **Allow-края (инвентарь 3fc7c54d, 12 файлов ручных таблиц).** Это
 * существующие списки на самодельных таблицах. Перевод по задачам этапа 2:
 *   • Z4 (ada14160) — общий список свойств `lib/property-list.ts` переведён
 *     (запись снята) — им пользуются и менеджер свойств, и пикер типа;
 *   • Z5 (ae76b75e) — списочные экраны: `screens/chronicle/chronicle.ts`,
 *     `screens/activity/activity.ts`.
 *
 * Оставшиеся записи `screens/property-manager.ts` и `screens/type-manager.ts`
 * НЕ снимаются в Z4: в этих файлах ручные таблицы принадлежат частям, которые
 * в объём Z4 не входят — таблицам-привязкам внутри редактора свойства/типа и
 * деревьям типов (деревья переводит Z7, `d1c15a2d`). Их плоские списки
 * (список «Свойства» и пикер «Добавить свойство») уже идут через общий
 * `lib/property-list.ts` на фасаде. Снять записи целиком можно будет после
 * перевода редакторских таблиц и деревьев.
 *
 * Остальные 7 файлов в объём Z4/Z5 не входят (`admin/admin.ts`,
 * `editor/properties.ts`, `editor/chrono-tab.ts`, `screens/settings-logs.ts`,
 * `screens/workspace-menus.ts`, `screens/thought-type/views-tab.ts`,
 * `selection/dialogs.ts`) — их таблицы остаются как есть до профильных задач.
 *
 * Сторож подключается зелёным: записи Z5 и редакторов/деревьев не удалены до
 * их перевода (иначе сторож краснел бы на текущем коде — правило «сторож
 * только зелёным», AGENTS.md §2.5).
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assertGuardClean, collectViolations, type GuardRule } from './guard-helpers.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

/** Легаси-файлы с ручными таблицами: переводятся в Z5/Z7 либо вне объёма. */
const LEGACY_TABLE_FILES = new Set([
  // Редакторские таблицы-привязки и деревья типов — вне объёма Z4
  // (деревья — Z7, d1c15a2d; редакторы в Z4 не переписываются).
  'screens/property-manager.ts',
  'screens/type-manager.ts',
  // Z5 — списочные экраны.
  'screens/chronicle/chronicle.ts',
  'screens/activity/activity.ts',
  // Вне объёма Z4/Z5 (перевод — профильными задачами позже).
  'admin/admin.ts',
  'editor/properties.ts',
  'editor/chrono-tab.ts',
  'screens/settings-logs.ts',
  'screens/workspace-menus.ts',
  'screens/thought-type/views-tab.ts',
  'selection/dialogs.ts',
]);

/** Строка — комментарий? (имена тегов в пояснениях допустимы). */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function rules(): GuardRule[] {
  const include = (rel: string): boolean => !rel.startsWith('lib/ui/');
  const allow = (rel: string, line: string): boolean => isComment(line) || LEGACY_TABLE_FILES.has(rel);
  return [
    {
      name: 'no-manual-table-elements',
      description:
        'Таблицы (`table`/`thead`/`tbody`/`tr`/`th`/`td`) собирает единый ' +
        'фасад lib/ui/table.ts (`createTable`), а не разметка вручную.',
      pattern: /el\(\s*['"](?:table|thead|tbody|tr|th|td)['"]/,
      include,
      allow,
    },
    {
      name: 'no-raw-create-element-table',
      description:
        'Табличные элементы создаются не через createElement в обход ' +
        'фасада lib/ui/table.ts.',
      pattern: /createElement\(\s*['"](?:table|thead|tbody|tr|th|td)['"]/,
      include,
      allow,
    },
    {
      name: 'no-raw-html-table',
      description: 'Сырой HTML `<table>` запрещён — список собирает lib/ui/table.ts.',
      pattern: /<table[\s>]/,
      include,
      allow,
    },
    {
      name: 'no-competing-create-table',
      description:
        'Собственный хелпер `createTable` запрещён — единый сборщик ' +
        'существует в lib/ui/table.ts.',
      pattern: /(?:export\s+)?function\s+createTable\b/,
      include,
      allow,
    },
  ];
}

describe('guard: единый табличный компонент lib/ui (dad2b029)', () => {
  it('самодельных таблиц вне lib/ui нет', () => {
    assertGuardClean(RENDERER_ROOT, rules());
  });

  it('правило краснеет на умышленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-table-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'screen.ts'),
        "const t = el('table', 'x');\nconst tr = el('tr');\nexport function createTable() {}\n",
        'utf8',
      );
      const violations = collectViolations(dir, rules(), { extensions: ['.ts'] });
      assert.ok(
        violations.some((v) => v.rule === 'no-manual-table-elements'),
        'ручная сборка table/tr обязана попадать в нарушение',
      );
      assert.ok(
        violations.some((v) => v.rule === 'no-competing-create-table'),
        'свой createTable обязан попадать в нарушение',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
