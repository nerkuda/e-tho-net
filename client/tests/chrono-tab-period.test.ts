/**
 * Вкладка «Дневник» редактора: период записи, таблица и шапка
 * (0.10.1, задача T8 a657bf3b; элемент 7310d077 «Вкладка «Дневник» редактора»,
 * элемент 2f14de06 «Поле периода»; ADR времени 994d076a; требования d58aa1a4
 * «формат дат/valid_to», 91ba5b3f «флаг use_time», 80b31f7a «переименование»).
 * Доработка вкладки — задача 8012a9b0 (три колонки, единый помощник периода,
 * шапка записи без флажка времени, переход в экран «Дневник»).
 *
 * Чистый помощник `resolvePeriodInstants` (значение контрола → полные
 * UTC-инстансы записи) проверяется напрямую; связка вкладки — структурно по
 * исходнику (модуль рендерера недоступен под Node без Electron-каркаса —
 * конвенция `chronicle-calendar.test.ts`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  instantToLocalDate,
  instantToLocalTime,
  resolvePeriodInstants,
} from '../src/renderer/lib/period-editor.js';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(rel: string): string {
  return readFileSync(resolve(RENDERER, ...rel.split('/')), 'utf8');
}

const SRC = {
  tab: 'editor/chrono-tab.ts',
  editor: 'editor/editor.ts',
};

describe('resolvePeriodInstants: время по ADR и непустой valid_to', () => {
  it('«голая дата» меняет только дату, время суток и мс сохраняются', () => {
    const source = '2026-09-26T10:30:45.123Z';
    const next = resolvePeriodInstants(
      { from: '2026-10-01', to: '2026-10-01', hasTime: false },
      { from: source, to: source },
    );
    assert.equal(instantToLocalDate(next.from), '2026-10-01', 'дата применена');
    assert.equal(instantToLocalTime(next.from), instantToLocalTime(source), 'время суток сохранено');
    assert.match(next.from, /:45\.123Z$/, 'секунды и мс сохранены');
    assert.equal(next.to, next.from, 'одна дата заполняет обе границы');
  });

  it('полный UTC-инстанс применяется как есть', () => {
    const next = resolvePeriodInstants(
      { from: '2026-10-05T08:00:00.000Z', to: '2026-10-06T09:15:00.000Z', hasTime: true },
      { from: '2026-09-26T10:30:45.123Z', to: '2026-09-26T10:30:45.123Z' },
    );
    assert.equal(next.from, '2026-10-05T08:00:00.000Z');
    assert.equal(next.to, '2026-10-06T09:15:00.000Z');
  });

  it('незаданный конец равен началу — valid_to непуст (требование d58aa1a4)', () => {
    const next = resolvePeriodInstants(
      { from: '2026-10-01' },
      { from: '2026-09-26T10:30:00.000Z', to: '2026-09-26T10:30:00.000Z' },
    );
    assert.notEqual(next.to, '', 'конец периода никогда не пуст');
    assert.equal(next.to, next.from);
  });

  it('пустое значение сохраняет прежние инстансы', () => {
    const source = '2026-09-26T10:30:45.123Z';
    const next = resolvePeriodInstants({}, { from: source, to: source });
    assert.equal(next.from, source);
    assert.equal(next.to, source);
  });
});

describe('вкладка «Дневник»: диалог даты/периода и шапка записи', () => {
  it('вкладка переименована в «Дневник» (требование 80b31f7a)', () => {
    const editorSrc = read(SRC.editor);
    assert.ok(editorSrc.includes("title: 'Дневник'"), 'вкладка подписана «Дневник»');
    assert.ok(!editorSrc.includes("title: 'Хроника'"), 'прежняя подпись «Хроника» убрана');
  });

  it('даты правятся диалогом даты/периода, а не своими полями', () => {
    const src = read(SRC.tab);
    assert.match(src, /from '\.\.\/lib\/date-period-dialog\.js'/, 'импорт компонента диалога');
    assert.match(src, /openDatePeriodDialog\(\{/, 'диалог открывается');
    // Заголовок диалога не подменяется — дефолт «Дата/период» (ошибка 214ab5da).
    const dialogCall = src.slice(
      src.indexOf('openDatePeriodDialog({'),
      src.indexOf('});', src.indexOf('openDatePeriodDialog({')),
    );
    assert.ok(!/\btitle:/.test(dialogCall), 'заголовок диалога — дефолтный «Дата/период»');
    assert.match(src, /resolveDatePeriodInstants\(/, 'значение диалога переводится в инстансы');
    assert.ok(!/\.type\s*=\s*['"](?:date|datetime-local|time)['"]/.test(src), 'своих полей дат периода нет');
  });

  it('в шапке нет флажка «учитывать время» — показ времени задаёт ответ диалога', () => {
    const src = read(SRC.tab);
    assert.ok(!src.includes('учитывать время'), 'флажка «учитывать время» в шапке нет');
    assert.ok(!/checkboxRow\(/.test(src), 'фасад переключателя больше не подключается');
    assert.match(src, /useTime = result\.hasTime === true/, 'показ времени — из ответа диалога (hasTime)');
    assert.match(src, /use_time: useTime/, 'флаг уходит в create/update');
  });

  it('подпись периода — единый помощник `formatRecordPeriod` (лента, таблица, шапка)', () => {
    const src = read(SRC.tab);
    // И «ячейка таблицы», и подпись шапки строятся одним помощником — своим
    // вызовом на каждый случай, без дублирования логики формата.
    const matches = src.match(/formatRecordPeriod\(/g) ?? [];
    assert.ok(matches.length >= 2, 'период строится помощником и в таблице, и в шапке');
    assert.ok(!/formatDatePeriodValue\(/.test(src), 'локального рендерера значения на вкладке нет');
  });

  it('правка дат — полные UTC-инстансы, время суток сохраняет общий помощник', () => {
    const src = read(SRC.tab);
    assert.match(src, /resolveDatePeriodInstants\(/, 'значение диалога переводится в инстансы');
    const create = src.slice(
      src.indexOf('etn.comments.create('),
      src.indexOf('invalidateQueries(queryKeys.indicators(ctx.ownerId));', src.indexOf('etn.comments.create(')),
    );
    assert.ok(create.includes('valid_from: now'), 'create: полный инстанс начала');
    assert.ok(create.includes('valid_to: now'), 'create: полный инстанс конца');
    assert.ok(!/valid_to:\s*(?:null|['"]['"])/.test(src), 'valid_to не бывает пустым');
  });
});
