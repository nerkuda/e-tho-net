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
 *   • Z5 (ae76b75e) — списочные экраны: `screens/activity/activity.ts` (лента и
 *     снимок события) и `admin/admin.ts` (участники/сети/аудит) переведены,
 *     записи сняты; `trash.ts` и `lib/saved-filter-bar.ts` — на `<div>`-списках,
 *     сторожем не покрывались, тоже переведены на фасад.
 *
 * `screens/chronicle/chronicle.ts` из Z5 была выведена (клавиатура по
 * колонкам/чипам, DnD чипов, управляемая сортировка). Расширение фасада
 * (задача 20ac6917) дало режим ячеек (`nav: 'cell'`), управляемую сортировку и
 * маркер строки ячейки для DnD — хроника переведена, запись снята.
 *
 * Записи `screens/property-manager.ts` и `screens/type-manager.ts` НЕ снимаются
 * в Z4: в этих файлах ручные таблицы принадлежат частям, которые в объём Z4 не
 * входят — таблицам-привязкам внутри редактора свойства/типа. Деревья типов из
 * этих файлов уже переведены на единый компонент `lib/ui/tree.ts` (Z7,
 * d1c15a2d) — `type-manager` (типы мыслей) и `property-manager` (диалог «Типы
 * связей»); остаются только редакторские таблицы-привязки, поэтому записи
 * файлов сохраняются. Их плоские списки (список «Свойства» и пикер «Добавить
 * свойство») идут через общий `lib/property-list.ts` на фасаде.
 *
 * `selection/dialogs.ts` — форма-грид значений свойств выделения (редакторы в
 * ячейках), а не список данных; на табличный фасад не переводится (решение
 * оркестратора). Остальные файлы (`editor/properties.ts`,
 * `editor/chrono-tab.ts`, `screens/settings-logs.ts`,
 * `screens/workspace-menus.ts`, `screens/thought-type/views-tab.ts`) в объём
 * Z4/Z5 не входят — их таблицы остаются как есть до профильных задач.
 *
 * **Редакция задачи 0a1a2414 (C2, требование 0dddd939).** Хвост этапа 2:
 * редакторные ФОРМЫ-ГРИДЫ приводятся к единому виду по токенам, но на
 * табличный фасад НЕ переводятся (это формы ввода, а не списки данных —
 * граница задачи). Записи `LEGACY_TABLE_FILES` поэтому не снимаются: в каждом
 * из этих файлов `<table>` остаётся формой-гридом. Общий вид форм-гридов задан
 * у класса `.table-list` в `styles.css` (шапка, плотность строк, границы,
 * состояния `:hover`/текущей — по токенам, в семействе `.ui-table`); записи
 * ниже помечены «форма-грид, унифицирован по токенам». Снимать запись можно
 * только когда из файла уйдут ВСЕ самодельные `<table>` (перевод списка на
 * `createTable`).
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

/**
 * Легаси-файлы с ручными таблицами-ФОРМАМИ. Все они унифицированы по токенам
 * (задача 0a1a2414): `<table>` остаётся формой-гридом, на фасад не переведён,
 * поэтому запись сохранена и помечена.
 */
const LEGACY_TABLE_FILES = new Set([
  // Форма-грид, унифицирован по токенам: таблицы-привязки редактора свойства
  // (деревья типов уже на `lib/ui/tree.ts`, Z7 d1c15a2d).
  'screens/property-manager.ts',
  // Форма-грид, унифицирован по токенам: привязки свойств редактора типа.
  'screens/type-manager.ts',
  // Форма-грид, унифицирован по токенам: таблицы вкладок свойств редактора.
  'editor/properties.ts',
  // Форма-грид, унифицирован по токенам: таблица вкладки хроники.
  'editor/chrono-tab.ts',
  // Форма-грид/список, унифицирован по токенам: файлы журнала сервера.
  'screens/settings-logs.ts',
  // Форма-грид/список, унифицирован по токенам: участники сети.
  'screens/workspace-menus.ts',
  // Форма-грид/список, унифицирован по токенам: отборы типа мысли.
  'screens/thought-type/views-tab.ts',
  // Форма-грид значений свойств выделения (редакторы в ячейках), а не список
  // данных; унифицирован по токенам, на табличный фасад не переводится.
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
