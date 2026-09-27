/**
 * Экран «Дневник»: даты хроно-записи — полные UTC-инстансы (ошибка f45fac74,
 * 0.10.1, задача T6 64ca2b48; ADR времени 994d076a; требование d58aa1a4
 * «полные UTC-инстансы и непустой valid_to»; требование-элемент 2f14de06
 * «Поле периода»).
 *
 * Дефект: экран отправлял в `valid_from`/`valid_to` «сырое» значение контрола
 * периода — в режиме «дата» это «голая дата», и сервер обнулял время суток.
 * Проверяем, что путь экрана переводит значение общим помощником
 * `resolvePeriodInstants` (как вкладка редактора T8), и что голых дат и
 * пустого `valid_to` в записи больше нет.
 *
 * Часть тестов — чистая (сам помощник), часть — структурная по исходнику
 * экрана (модуль рендерера недоступен под Node без Electron-каркаса —
 * конвенция `chronicle-calendar.test.ts` / `chrono-tab-period.test.ts`).
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
const CHRONICLE_TS = resolve(RENDERER, 'screens', 'chronicle', 'chronicle.ts');

function source(): string {
  return readFileSync(CHRONICLE_TS, 'utf8');
}

describe('«Дневник»: смена только даты сохраняет время суток (f45fac74)', () => {
  it('правка периода записи: «голая дата» меняет дату, время и мс — нет', () => {
    // Исходная запись без флага времени: полный инстанс, время скрыто.
    const recordFrom = '2026-09-26T10:30:45.123Z';
    const recordTo = '2026-09-26T10:30:45.123Z';
    const next = resolvePeriodInstants(
      { from: '2026-10-01', to: '2026-10-01', hasTime: false },
      { from: recordFrom, to: recordTo },
    );
    assert.equal(instantToLocalDate(next.from), '2026-10-01', 'дата применена');
    assert.equal(
      instantToLocalTime(next.from),
      instantToLocalTime(recordFrom),
      'время суток исходной записи сохранено',
    );
    assert.match(next.from, /:45\.123Z$/, 'секунды и миллисекунды сохранены');
    assert.equal(next.to, next.from, 'одна дата заполняет обе границы');
  });

  it('создание псевдо-записи: дата из псевдо-дня, время — текущее, valid_to непуст', () => {
    const now = '2026-09-26T10:30:45.123Z';
    const next = resolvePeriodInstants(
      { from: '2026-09-01', to: '2026-09-01' },
      { from: now, to: now },
    );
    assert.equal(instantToLocalDate(next.from), '2026-09-01', 'псевдо-день применён');
    assert.equal(instantToLocalTime(next.from), instantToLocalTime(now), 'время создания сохранено');
    assert.notEqual(next.to, '', 'valid_to непуст (d58aa1a4)');
    assert.equal(next.to, next.from);
  });

  it('копирование («Действия…»): даты = сегодня + текущее время, valid_to непуст', () => {
    const now = '2026-09-26T10:30:45.123Z';
    const today = instantToLocalDate(now);
    const next = resolvePeriodInstants({ from: today, to: today }, { from: now, to: now });
    assert.equal(instantToLocalDate(next.from), today, 'дата копии — сегодня');
    assert.notEqual(next.to, '', 'valid_to непуст (d58aa1a4)');
    assert.equal(next.to, next.from);
  });
});

describe('«Дневник»: запись дат идёт через resolvePeriodInstants, не «сырым» значением', () => {
  it('экран импортирует общий помощник', () => {
    assert.match(source(), /resolvePeriodInstants/, 'resolvePeriodInstants подключён');
  });

  it('правка даты записи переводит значение и передаёт прежние инстансы', () => {
    const src = source();
    assert.match(
      src,
      /saveRecordDates\(\s*row\.id,\s*result,\s*previous\)/,
      'предыдущие инстансы записи передаются в saveRecordDates',
    );
    assert.match(
      src,
      /resolvePeriodInstants\(period,\s*previous\)/,
      'saveRecordDates переводит даты диалога в инстансы общим помощником',
    );
    assert.match(
      src,
      /setInstantTime\(base\.from,\s*value\.fromTime\)/,
      'время суток диалога выставляется с сохранением секунд (ADR 994d076a)',
    );
  });

  it('создание псевдо-записи и копия тоже переводят даты', () => {
    const src = source();
    assert.match(
      src,
      /resolvePeriodInstants\(\s*\{\s*from:\s*state\.from,\s*to:\s*state\.from\s*\}/,
      'создание псевдо-записи — через помощник',
    );
    assert.match(
      src,
      /resolvePeriodInstants\(\s*\{\s*from:\s*today,\s*to:\s*today\s*\}/,
      'копирование («Действия…») — через помощник',
    );
  });

  it('голых дат и пустого valid_to в записи экрана нет', () => {
    const src = source();
    for (const bare of [
      'valid_from: state.from',
      'valid_to: state.from',
      'valid_from: today,',
      'valid_to: today,',
    ]) {
      assert.ok(!src.includes(bare), `голая дата не уходит в запись: ${bare}`);
    }
    assert.ok(
      !/valid_to:\s*(?:null|['"]['"])/.test(src),
      'valid_to хронологической записи не бывает пустым (d58aa1a4)',
    );
  });
});
