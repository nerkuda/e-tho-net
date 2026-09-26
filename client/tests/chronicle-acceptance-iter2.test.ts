/**
 * Приёмочные регрессы «Дневника» 0.10.1, итерация №2 (задача 7edd1cce,
 * версия 0.10.1). Шесть замечаний приёмки проверяются структурно по исходникам
 * (модуль рендерера под Node без Electron-каркаса не исполняется — конвенция
 * `chronicle-acceptance-0.10.1.test.ts`) и чистыми помощниками:
 *
 *  1) единые поля выбора мыслей/типов в панелях «Структур» и «Дневника» —
 *     общий чип-поле `lib/entity-picker.ts` с угловыми «…»/«✕» и приглашением;
 *  2) показ и правка записей ленты — через единую оболочку комментария;
 *  3) пустая запись даёт область входа в правку (приглашение);
 *  4) группы дат: крупный шрифт, сворачивание, кнопки «Развернуть/Свернуть все»;
 *  5) переключатель «Дата/Дата и время/Диапазон» не сбрасывается перерисовкой;
 *  6) период — «Пресеты»/«Даты», годовые токены, режим в сохранённом отборе.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(rel: string): string {
  return readFileSync(resolve(RENDERER, ...rel.split('/')), 'utf8');
}

const CHRONICLE = read('screens/chronicle/chronicle.ts');
const CHRONICLE_PANEL = read('screens/chronicle/filter-panel.ts');
const STRUCTURES_PANEL = read('screens/structures/filter-panel.ts');
const ENTITY_PICKER = read('lib/entity-picker.ts');
const PERIOD_EDITOR = read('lib/period-editor.ts');
const BUILDER = read('lib/filter-builder.ts');
const DIARY = read('screens/chronicle/diary.ts');
const CSS = read('styles/screens/chronicle.css');

describe('приёмка №2, п.1: единые поля выбора (обе панели)', () => {
  it('чип-поле использует общую обёртку поля значения связи (углы «…»/«✕»)', () => {
    assert.match(ENTITY_PICKER, /link-value-wrap/, 'общая обёртка поля');
    assert.match(ENTITY_PICKER, /link-value-corner-btn/, 'угловые кнопки');
    assert.match(ENTITY_PICKER, /addPlaceholder/, 'приглашение непустого поля');
  });

  it('обе панели задают приглашение «+ ещё один тип/мысль»', () => {
    for (const [name, src] of [
      ['Структуры', STRUCTURES_PANEL],
      ['Дневник', CHRONICLE_PANEL],
    ] as const) {
      assert.ok(src.includes("'+ ещё один тип'"), `${name}: приглашение типа`);
      assert.ok(src.includes("'+ ещё одну мысль'"), `${name}: приглашение мысли`);
    }
  });

  it('кнопок «выбрать…»/«список типов…» в панелях нет', () => {
    for (const [name, src] of [
      ['Структуры', STRUCTURES_PANEL],
      ['Дневник', CHRONICLE_PANEL],
    ] as const) {
      assert.ok(!src.includes('список типов…'), `${name}: кнопка «список типов…» убрана`);
      assert.ok(!src.includes('выбрать…'), `${name}: кнопка «выбрать…» убрана`);
    }
  });
});

describe('приёмка №2, п.2–3: оболочка комментария в ленте', () => {
  it('тело записи строится оболочкой комментария (просмотр и правка)', () => {
    assert.match(CHRONICLE, /function buildBody\(row: ChronicleRow\)[\s\S]*commentShell\(\{ variant: 'plain' \}\)/);
    assert.match(CHRONICLE, /function openBodyEditor\([\s\S]*commentShell/, 'правка — та же оболочка');
    assert.match(CHRONICLE, /shell\.setMode\(editing \? 'edit' : 'view'\)/);
  });

  it('псевдо-запись тоже идёт через оболочку', () => {
    assert.match(CHRONICLE, /slotShell/);
    assert.match(CHRONICLE, /slotShell\.setField\(widget\)/);
  });

  it('пустая запись даёт кликабельную область с приглашением', () => {
    assert.match(CHRONICLE, /diary\.emptyRecordHint/, 'плейсхолдер пустой записи');
    assert.match(CHRONICLE, /diary-snippet-empty/);
    assert.match(CHRONICLE, /diary\.emptyRecordHint'\)\)/);
  });
});

describe('приёмка №2, п.4: группы дат', () => {
  it('шрифт даты вдвое крупнее через токен темы', () => {
    assert.match(CSS, /\.diary-day-head[\s\S]*font-size: calc\(var\(--font-size-s\) \* 2\)/);
  });

  it('группа сворачивается кликом, состояние — в клиентских настройках', () => {
    assert.match(CHRONICLE, /collapsedDays/);
    assert.match(CHRONICLE, /UI_STATE_KEY\.DIARY_COLLAPSED_DAYS/);
    assert.match(CHRONICLE, /function toggleDayCollapsed/);
  });

  it('кнопки «Развернуть все»/«Свернуть все» — компактные иконки рядом с добавлением', () => {
    assert.match(CHRONICLE, /diary-expand-all/);
    assert.match(CHRONICLE, /diary-collapse-all/);
    assert.match(CHRONICLE, /setAllDaysCollapsed/);
    assert.match(CSS, /\.chron-addbar-actions/);
  });
});

describe('приёмка №2, п.5: переключатель даты записи не сбрасывается', () => {
  it('перезапрос ленты отложен, пока открыт редактор даты', () => {
    assert.match(CHRONICLE, /recordDateEditorOpen/);
    assert.match(
      CHRONICLE,
      /scheduleChronicleRefresh\(\): void \{[\s\S]*if \(recordDateEditorOpen\) return/,
      'лента не перерисовывается под открытым контролом',
    );
  });
});

describe('приёмка №2, п.6: период «Пресеты»/«Даты» и годовые токены', () => {
  it('панельный вариант несёт переключатель режимов и пресет-границы', () => {
    assert.match(PERIOD_EDITOR, /PANEL_MODE_ITEMS/);
    assert.match(PERIOD_EDITOR, /panelMode/);
    assert.match(PERIOD_EDITOR, /pe-preset-bound/);
    assert.match(PERIOD_EDITOR, /pe-preset-anchor/);
    assert.match(PERIOD_EDITOR, /pe-preset-num/);
    assert.match(PERIOD_EDITOR, /pe-preset-unit/);
  });

  it('годовые токены и ±Ny в общем языке', () => {
    assert.ok(
      PERIOD_EDITOR.includes('year\\.(?:start|end)'),
      'клиентский шаблон токенов знает год',
    );
    assert.ok(
      DIARY.includes('year\\.start') && DIARY.includes('year\\.end'),
      'раскрытие годовых токенов',
    );
    assert.match(DIARY, /months = n \* 12/, '±Ny = 12 месяцев');
  });

  it('режим периода едет в сохранённый отбор', () => {
    assert.match(BUILDER, /dateMode/);
    assert.match(BUILDER, /out\.date_mode = state\.dateMode/);
    assert.match(CHRONICLE_PANEL, /panelMode: filter\.dateMode/);
    assert.match(CHRONICLE_PANEL, /date_mode|dateMode/, 'режим восстанавливается парсером');
  });

  it('календарь пишет значения по режиму (правило «Пресетов»)', () => {
    assert.match(CHRONICLE, /periodValuesForRange/);
    assert.match(DIARY, /export function periodValuesForRange/);
    assert.match(DIARY, /export function dayOffsetToken/);
  });
});
