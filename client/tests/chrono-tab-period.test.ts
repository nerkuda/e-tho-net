/**
 * Вкладка «Дневник» редактора: поле периода и флаг «учитывать время»
 * (0.10.1, задача T8 a657bf3b; элемент 7310d077 «Вкладка «Дневник» редактора»,
 * элемент 2f14de06 «Поле периода»; ADR времени 994d076a; требования d58aa1a4
 * «формат дат/valid_to», 91ba5b3f «флаг use_time», 80b31f7a «переименование»).
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

describe('вкладка «Дневник»: диалог даты/периода и флаг «учитывать время»', () => {
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

  it('флаг «учитывать время» — переключатель строки метаданных', () => {
    const src = read(SRC.tab);
    assert.ok(src.includes("label: 'учитывать время'"), 'подпись переключателя');
    assert.match(src, /checkboxRow\(\{/, 'переключатель — фасад lib/ui');
    assert.match(src, /useTimeInput\.input\.checked/, 'флаг читается из переключателя');
    assert.ok(src.includes('use_time: useTimeInput.input.checked'), 'флаг уходит в create/update');
  });

  it('время показывается по флагу, подпись — общий рендерер значения', () => {
    const src = read(SRC.tab);
    // Подпись значения строится общим рендерером диалога; время — по флагу.
    assert.match(src, /formatDatePeriodValue\(/, 'подпись — общий рендерер значения');
    assert.match(
      src,
      /datePeriodValueFromInstants\(\s*fromInstant,\s*toInstant,\s*useTimeInput\.input\.checked/,
      'hasTime диалога берётся из флага',
    );
    // Явная правка времени в диалоге включает флаг (требование 91ba5b3f).
    assert.match(
      src,
      /useTimeInput\.input\.checked !== result\.hasTime/,
      'правка времени синхронизирует флаг',
    );
  });

  it('правка дат — полные UTC-инстансы, время суток сохраняет общий помощник', () => {
    const src = read(SRC.tab);
    assert.match(src, /resolveDatePeriodInstants\(/, 'значение диалога переводится в инстансы');
    const create = src.slice(src.indexOf('etn.comments.create('), src.indexOf('invalidateIndicators(ctx.ownerId);', src.indexOf('etn.comments.create(')));
    assert.ok(create.includes('valid_from: fromInstant'), 'create: полный инстанс начала');
    assert.ok(create.includes('valid_to: toInstant'), 'create: полный инстанс конца');
    assert.ok(!/valid_to:\s*(?:null|['"]['"])/.test(src), 'valid_to не бывает пустым');
  });

  it('таблица показывает время только при включённом флаге', () => {
    const src = read(SRC.tab);
    assert.match(src, /comment\.use_time === true \? formatDateTime\(/, 'время в колонках С/По — по флагу');
  });
});
