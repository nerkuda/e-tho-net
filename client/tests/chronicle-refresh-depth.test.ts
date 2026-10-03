/**
 * Регресс ошибки f5809943 (и её продолжения b72e199e): завершение правки,
 * удаление записи и локальная вставка теряли прокрутку ленты «Дневника» —
 * полный перезапрос брал ТОЛЬКО первую страницу и терял дозагруженные «+50»;
 * keyed-сверка снимала лишние узлы, и позицию прокрутки держать становилось
 * нечем (дефект возвращался после 0.10.1 — ошибка 407b1827).
 *
 * Инвариант: refresh ТЕКУЩЕГО вида идёт до уже загруженной глубины, а смена
 * отбора/периода — с первой страницы. Проверка обязана КРАСНЕТЬ, если refresh
 * снова начнёт терять дозагруженные страницы.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { collectRowsToDepth } from '../src/renderer/screens/chronicle/diary.js';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');
const CHRONICLE = readFileSync(resolve(RENDERER, 'screens', 'chronicle', 'chronicle.ts'), 'utf8');

/** Тело функции верхнего уровня по её объявлению (стиль файла: `}` в первой колонке). */
function bodyOf(decl: string): string {
  const start = CHRONICLE.indexOf(decl);
  assert.ok(start >= 0, `не найдена функция: ${decl}`);
  const rest = CHRONICLE.slice(start);
  return rest.slice(0, rest.indexOf('\n}\n'));
}

/** Сервер-заглушка: нумерованные строки + total, как у `POST /chronicle/query`. */
function fakeSource(total: number) {
  const calls: Array<{ offset: number; limit: number }> = [];
  const fetchPage = (offset: number, limit: number) => {
    calls.push({ offset, limit });
    const rows = Array.from(
      { length: Math.max(0, Math.min(limit, total - offset)) },
      (_v, i) => ({ id: `row-${offset + i}` }),
    );
    return Promise.resolve({ rows, total });
  };
  return { calls, fetchPage };
}

describe('лента «Дневника»: refresh сохраняет загруженную глубину (f5809943, b72e199e)', () => {
  it('перезапрос до глубины забирает все страницы, а не первую', async () => {
    const { calls, fetchPage } = fakeSource(76);
    const result = await collectRowsToDepth(76, 50, fetchPage);
    assert.equal(result.rows.length, 76, 'дозагруженные строки не потеряны');
    assert.deepEqual(
      calls,
      [
        { offset: 0, limit: 50 },
        { offset: 50, limit: 50 },
      ],
      'глубина 76 = две страницы по 50',
    );
  });

  it('первая страница (смена отбора) — один запрос', async () => {
    const { calls, fetchPage } = fakeSource(200);
    const result = await collectRowsToDepth(50, 50, fetchPage);
    assert.equal(result.rows.length, 50);
    assert.deepEqual(calls, [{ offset: 0, limit: 50 }], 'сброс глубины = первая страница');
  });

  it('глубина не меньше страницы и не больше total', async () => {
    const shallow = fakeSource(200);
    const none = await collectRowsToDepth(0, 50, shallow.fetchPage);
    assert.equal(none.rows.length, 50, 'минимум — одна страница');
    const short = fakeSource(30);
    const shortResult = await collectRowsToDepth(90, 50, short.fetchPage);
    assert.equal(shortResult.rows.length, 30, 'за total не уходим');
    assert.deepEqual(short.calls, [{ offset: 0, limit: 50 }], 'вторая страница не запрошена');
  });

  it('пустая страница останавливает добор (сервер отдал меньше total)', async () => {
    const calls: number[] = [];
    const result = await collectRowsToDepth(200, 50, (offset, _limit) => {
      calls.push(offset);
      const rows = offset === 0 ? Array.from({ length: 50 }, (_v, i) => ({ id: `row-${i}` })) : [];
      return Promise.resolve({ rows, total: 200 });
    });
    assert.equal(result.rows.length, 50, 'пустая страница не зацикливает');
    assert.deepEqual(calls, [0, 50]);
  });

  it('глубина после удаления/вставки не срезается до первой страницы', async () => {
    const afterDelete = await collectRowsToDepth(76, 50, fakeSource(75).fetchPage);
    assert.equal(afterDelete.rows.length, 75, 'удаление: глубина 76 → 75, а не 50');
    const afterInsert = await collectRowsToDepth(77, 50, fakeSource(77).fetchPage);
    assert.equal(afterInsert.rows.length, 77, 'локальная вставка: глубина сохранена');
  });

  it('все локальные refresh-пути идут через единый помощник глубины', () => {
    const keeper = bodyOf('async function reloadKeepingDepth(');
    assert.match(
      keeper,
      /await reload\(true\)/,
      'помощник сохранения глубины перезапрашивает ленту до rows.length',
    );

    // 1) Отложенный перезапрос по инвалидации слоя (G3) — тот же помощник.
    assert.match(
      bodyOf('async function refreshFeedAndCalendar('),
      /await reloadKeepingDepth\(\)/,
      'refreshFeedAndCalendar сохраняет глубину через помощник',
    );
    // 2) Удаление записи (G6): гасит ключ ленты — отложенный перезапрос идёт
    //    тем же помощником глубины (`refreshFeedAndCalendar`).
    assert.match(
      bodyOf('async function removeRecord('),
      /invalidateQueries\(queryKeys\.chronicleFeedAll\(\)\)/,
      'removeRecord гасит ключ ленты (глубину сохраняет общий refresh)',
    );
    // 3) Локальная вставка: дозагрузка «+50» при pendingReconcile.
    assert.match(
      bodyOf('async function loadMore('),
      /if \(pendingReconcile\) \{\s*await reloadKeepingDepth\(\);/,
      'loadMore при pendingReconcile сохраняет глубину',
    );
  });

  it('refresh-путь считает глубину, сброс — с первой страницы', () => {
    assert.match(
      CHRONICLE,
      /preserveDepth \? rows\.length : CHRONICLE_PAGE_SIZE/,
      'reload считает глубину от уже загруженных строк',
    );
    assert.match(
      CHRONICLE,
      /collectRowsToDepth\(/,
      'страницы собираются до единственной перерисовки',
    );
    const filter = CHRONICLE.slice(CHRONICLE.indexOf('async function applyFilter('));
    const filterBody = filter.slice(0, filter.indexOf('\n}\n'));
    assert.match(filterBody, /await reload\(\);/, 'смена отбора показывает ленту с начала');
    assert.doesNotMatch(
      filterBody,
      /reloadKeepingDepth/,
      'смена отбора/периода не сохраняет глубину',
    );
  });
});
