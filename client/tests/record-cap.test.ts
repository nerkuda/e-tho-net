/**
 * Клиентский потолок рендера строк-записей «Показано N из M» (0.15.4,
 * тех.проект 43329662, задача 33ed043c; уточнение аудита N2).
 *
 * Контракт:
 *  - потолок КЛИЕНТСКИЙ: сервер отдаёт все строки, срез делает `planRecordCap`;
 *  - M > N — показываются первые N строк и подпись «Показано N из M»;
 *  - M ≤ N — строки как есть, БЕЗ подписи (подпись при отсутствии среза была бы
 *    ложным сигналом «часть скрыта»);
 *  - `limit <= 0` — потолок отключён (строки и подписи нет);
 *  - подпись берёт ОТДЕЛЬНЫЙ ключ словаря `records.more`: у ключа
 *    `publications.mentions.more` M — серверный total публикаций, переиспользовать
 *    его нельзя (уточнение аудита P3).
 *
 * В группе поиска «Найдено в хронологии» потолок НЕ применяется (`by_chrono`
 * схлопнут до одного хита на владельца, N2): потребитель — вкладка «Упоминания»
 * (задача ae72e47e).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { en } from '../src/renderer/lib/locales/en.js';
import { ru } from '../src/renderer/lib/locales/ru.js';
import { zh } from '../src/renderer/lib/locales/zh.js';
import { planRecordCap, RECORD_ROWS_LIMIT } from '../src/renderer/lib/chip-overflow.js';

const CHIP_OVERFLOW_TS = resolve(
  import.meta.dirname,
  '..',
  'src',
  'renderer',
  'lib',
  'chip-overflow.ts',
);

/** Строки-заготовки: содержимое срезу не важно, важны количество и порядок. */
function rows(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `row-${index + 1}`);
}

describe('потолок рендера строк-записей (N2, задача 33ed043c)', () => {
  it('M > N: показаны первые N строк и подпись «Показано N из M»', () => {
    const plan = planRecordCap(rows(5), 2);

    assert.deepEqual(plan.shown, ['row-1', 'row-2'], 'срез — первые N строк в порядке ответа');
    assert.equal(plan.total, 5, 'M — число строк в ответе');
    assert.equal(plan.caption, 'Показано 2 из 5', 'подпись называет и N, и M');
  });

  it('M ≤ N: строки как есть, подписи нет', () => {
    const equal = planRecordCap(rows(2), 2);
    const fewer = planRecordCap(rows(1), 2);

    assert.deepEqual(equal.shown, ['row-1', 'row-2'], 'все строки показаны');
    assert.equal(equal.caption, null, 'M = N — скрывать нечего, подписи нет');
    assert.deepEqual(fewer.shown, ['row-1'], 'единственная строка показана');
    assert.equal(fewer.caption, null, 'M < N — подписи нет');
  });

  it('пустой ответ: ни строк, ни подписи', () => {
    const plan = planRecordCap([], 2);

    assert.deepEqual(plan.shown, []);
    assert.equal(plan.total, 0);
    assert.equal(plan.caption, null);
  });

  it('потолок по умолчанию — клиентская константа RECORD_ROWS_LIMIT', () => {
    assert.equal(RECORD_ROWS_LIMIT, 20, 'N — осознанная клиентская константа');

    const plan = planRecordCap(rows(RECORD_ROWS_LIMIT + 1));

    assert.equal(plan.shown.length, RECORD_ROWS_LIMIT, 'срез по умолчанию');
    assert.equal(plan.total, RECORD_ROWS_LIMIT + 1);
    assert.equal(plan.caption, `Показано ${RECORD_ROWS_LIMIT} из ${RECORD_ROWS_LIMIT + 1}`);
  });

  it('`limit <= 0` отключает потолок', () => {
    const plan = planRecordCap(rows(3), 0);

    assert.deepEqual(plan.shown, ['row-1', 'row-2', 'row-3'], 'потолок отключён — все строки');
    assert.equal(plan.caption, null, 'отключённый потолок не подписывается');
  });

  it('подпись — отдельный ключ `records.more`, а не total публикаций', () => {
    const source = readFileSync(CHIP_OVERFLOW_TS, 'utf8');
    // Комментарий шапки объясняет, почему чужой ключ не годится, — проверяется КОД.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    assert.match(code, /t\('records\.more',\s*\[limit, total\]\)/, 'ключ подписи — records.more');
    assert.ok(
      !code.includes('publications.mentions.more'),
      'ключ publications.mentions.more не переиспользуется: у него M — серверный total',
    );
  });

  it('ключ `records.more` есть во всех каталогах с подстановками %1 и %2', () => {
    for (const [code, catalog] of [
      ['ru', ru],
      ['en', en],
      ['zh', zh],
    ] as const) {
      const text = (catalog as Record<string, string>)['records.more'] ?? '';
      assert.ok(text !== '', `${code}: ключ records.more объявлен`);
      assert.match(text, /%1/u, `${code}: подпись называет N (%1)`);
      assert.match(text, /%2/u, `${code}: подпись называет M (%2)`);
    }
  });
});
