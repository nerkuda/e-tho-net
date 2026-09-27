/**
 * Доработка вкладки «Дневник» редактора (0.10.1, задача 8012a9b0).
 *
 * Проверяем пять пунктов чек-листа. Модуль вкладки — модуль рендерера: под
 * Node без Electron-каркаса он не исполняется, поэтому связка вкладки
 * проверяется структурно по исходнику (конвенция `chrono-tab-period.test.ts`),
 * а новый чистый помощник единого отображения периода — поведенчески.
 *
 *  1. Таблица записей: три колонки «Период» / «Заголовок» / «Редактор», период —
 *     единым помощником `formatRecordPeriod` (то же отображение, что в ленте
 *     экрана «Дневник»).
 *  2. Контекстное меню строки: «Открыть в дневнике» и «Удалить».
 *  3. Клавиатурная навигация: таблица строится общим фасадом `lib/ui/table.ts`
 *     (паритет со всеми списками), самодельного `<table>` нет.
 *  4. Нижняя область: явное пустое состояние; «Добавить» открывает новую запись.
 *  5. Шапка записи: одна строка — период (клик — диалог) + заголовок на всю
 *     ширину; флажка «учитывать время» и кнопки удаления в шапке нет.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(rel: string): string {
  return readFileSync(resolve(RENDERER, ...rel.split('/')), 'utf8');
}

/** Локальный инстанс → ISO-строка (без зависимости от пояса машины в ожиданиях). */
function localInstant(y: number, mo: number, d: number, h = 0, mi = 0): string {
  return new Date(y, mo - 1, d, h, mi, 0, 0).toISOString();
}

function shimDom(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (_text: string) => new ShimElement('#text') as any,
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<string, unknown>;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.innerWidth = 1000;
  win.innerHeight = 800;
}

type DialogModule = typeof import('../src/renderer/lib/date-period-dialog.js');

async function loadDialog(): Promise<DialogModule> {
  shimDom();
  return import('../src/renderer/lib/date-period-dialog.js');
}

// ---------------------------------------------------------------------------
// 1. Единое отображение периода
// ---------------------------------------------------------------------------

describe('formatRecordPeriod — единое отображение периода дневниковой записи', () => {
  it('одна дата без времени — только дата', async () => {
    const { formatRecordPeriod } = await loadDialog();
    const day = localInstant(2026, 9, 26);
    assert.equal(formatRecordPeriod(day, day, false), '2026-09-26');
  });

  it('одна дата со временем — дата и время', async () => {
    const { formatRecordPeriod } = await loadDialog();
    const at = localInstant(2026, 9, 26, 10, 0);
    assert.equal(formatRecordPeriod(at, at, true), '2026-09-26 10:00');
  });

  it('один день с разным временем — «дата, ЧЧ:ММ начала - ЧЧ:ММ окончания»', async () => {
    const { formatRecordPeriod } = await loadDialog();
    const from = localInstant(2026, 9, 26, 10, 0);
    const to = localInstant(2026, 9, 26, 10, 15);
    assert.equal(formatRecordPeriod(from, to, true), '2026-09-26, 10:00 - 10:15');
  });

  it('период разными датами — «дата - дата» (с временем при use_time)', async () => {
    const { formatRecordPeriod } = await loadDialog();
    const from = localInstant(2026, 9, 29, 10, 0);
    const to = localInstant(2026, 10, 12, 12, 0);
    assert.equal(formatRecordPeriod(from, to, false), '2026-09-29 - 2026-10-12');
    assert.equal(formatRecordPeriod(from, to, true), '2026-09-29 10:00 - 2026-10-12 12:00');
  });

  it('время скрыто, когда запись не учитывает время (use_time=false)', async () => {
    const { formatRecordPeriod } = await loadDialog();
    const from = localInstant(2026, 9, 26, 10, 0);
    const to = localInstant(2026, 9, 26, 10, 15);
    assert.equal(formatRecordPeriod(from, to, false), '2026-09-26', 'без флага — одна дата');
  });

  it('лента экрана «Дневник» использует тот же помощник', () => {
    const src = read('screens/chronicle/chronicle.ts');
    assert.match(
      src,
      /formatRecordPeriod\(row\.valid_from, row\.valid_to, row\.use_time === true\)/,
      'подпись периода в ленте — общий помощник',
    );
  });
});

// ---------------------------------------------------------------------------
// 2–5. Вкладка: таблица, меню, навигация, нижняя область, шапка
// ---------------------------------------------------------------------------

describe('вкладка «Дневник» редактора: таблица и нижняя область', () => {
  const tab = read('editor/chrono-tab.ts');

  it('п.1: три колонки на общем фасаде списков', () => {
    assert.match(tab, /import \{ createTable, type TableHandle \} from '\.\.\/lib\/ui\/table\.js'/, 'фасад таблицы подключён');
    assert.match(tab, /createTable<Comment>\(\{/, 'таблица строится фасадом');
    assert.ok(!/el\('table'/.test(tab), 'самодельного <table> нет');
    assert.match(tab, /key: 'period'/);
    assert.match(tab, /key: 'title'/);
    assert.match(tab, /key: 'editor'/);
    assert.match(tab, /header: t\('chrono\.col\.period'\)/);
    assert.match(tab, /header: t\('chrono\.col\.title'\)/);
    assert.match(tab, /header: t\('chrono\.col\.editor'\)/);
  });

  it('п.1: «Заголовок» — title, иначе первая непустая строка заметки', () => {
    assert.match(tab, /function recordTitle\(comment: Comment\): string/, 'помощник заголовка');
    assert.match(tab, /const title = \(comment\.title \?\? ''\)\.trim\(\)/, 'сначала title');
    assert.match(tab, /comment\.body_md\.split\(\/\\r\?\\n\/\)/, 'иначе — строки заметки');
    assert.match(tab, /TITLE_FROM_BODY_MAX = 250/, 'не более 250 символов');
  });

  it('п.1: «Редактор» — последний изменивший (updated_by), через кэш пользователей', () => {
    assert.match(tab, /render: \(c\) => userLabel\(c\.updated_by\)/, 'ячейка — updated_by');
    assert.match(tab, /function userLabel\(userId: string \| null\): string/, 'помощник имени');
  });

  it('п.2: контекстное меню — «Открыть в дневнике» и «Удалить»', () => {
    assert.match(tab, /rowMenu: \(row\) => recordMenuItems\(row\)/, 'меню строки — через фасад');
    assert.match(tab, /menuAction\(t\('chrono\.menu\.openInDiary'\)/, 'пункт «Открыть в дневнике»');
    assert.match(tab, /t\('actions\.delete'\)/, 'пункт «Удалить»');
    assert.match(tab, /openChronicleRecord\(\{/, 'открытие записи на экране «Дневник»');
    assert.match(tab, /await import\('\.\.\/screens\/chronicle\/chronicle\.js'\)/, 'ленивый импорт экрана (без цикла)');
  });

  it('п.2: переход на экран «Дневник» есть в компоненте экрана', () => {
    const chronicle = read('screens/chronicle/chronicle.ts');
    assert.match(chronicle, /export async function openChronicleRecord\(/, 'публичный вход перехода');
    assert.match(chronicle, /setActiveView\('chronicle'\)/, 'переключает вид');
    assert.match(chronicle, /await jumpToRecord\(record\)/, 'переиспользует переход поиска (T7)');
  });

  it('п.3: клавиатурная навигация фасада (Enter = войти в правку)', () => {
    assert.match(tab, /onCurrentChange:/, 'текущая строка → просмотр');
    assert.match(tab, /onActivate:/, 'Enter/двойной клик — действие строки');
    assert.match(tab, /sortMode: 'toggle'/, 'сортировка — режим фасада');
    assert.match(tab, /defaultSort: \{ key: 'period', dir: 'desc' \}/, 'начальная сортировка по периоду');
  });

  it('п.4: пустое состояние нижней области и «Добавить»', () => {
    assert.match(tab, /state: \{ kind: 'empty', text: t\('chrono\.emptyEditor'\) \}/, 'надпись пустого состояния');
    assert.match(tab, /onClick: \(\) => startNew\(\)/, 'кнопка «Добавить»');
    assert.match(tab, /buildEditor\(null, true\)/, 'новая запись сразу в правке');
  });

  it('п.5: шапка — период + заголовок одной строкой, без флажка и кнопки удаления', () => {
    assert.match(tab, /metaRow\.append\(dateBtn, titleInput\)/, 'период слева, заголовок следом');
    assert.ok(!tab.includes('учитывать время'), 'флажка «учитывать время» нет');
    assert.ok(!/checkboxRow\(/.test(tab), 'переключатель не подключается');
    assert.ok(!/label: t\('actions\.delete'\)/.test(tab), 'в шапке кнопки удаления нет');
  });

  it('п.5: клик по периоду открывает диалог «Дата/период»', () => {
    assert.match(tab, /onClick: \(\) => void openPeriodDialog\(\)/, 'клик по периоду — диалог');
    assert.match(tab, /allowPeriod: true/, 'период разрешён');
    assert.match(tab, /allowTime: true/, 'время разрешено');
  });
});
