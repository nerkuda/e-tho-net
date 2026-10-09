/**
 * Лента «Дневника»: снятие чипса не двигает запись (задача 5a002590).
 *
 * Прежний регресс 368747a6 (снятие последнего чипса «поднимало» запись в
 * HOME-блок, прокрутка сбрасывалась) отменён вместе с классовой сортировкой:
 * порядок — только по дате/времени, позиция записи при снятии привязки НЕ
 * меняется, поэтому прокрутку сбрасывать нечего. Экран в node-тесте не
 * поднимается (тянет `app.js`/редактор), поэтому проводка проверяется
 * структурно по исходнику.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const RENDERER_ROOT = path.resolve(import.meta.dirname, '..', 'src', 'renderer');
const CHRONICLE = fs.readFileSync(
  path.join(RENDERER_ROOT, 'screens', 'chronicle', 'chronicle.ts'),
  'utf8',
);

describe('chronicle detachChip: запись не перемещается, прокрутка не сбрасывается (5a002590)', () => {
  it('снятие чипса обновляет ленту без сброса прокрутки', () => {
    const body = CHRONICLE.slice(CHRONICLE.indexOf('async function detachChip('));
    const fnBody = body.slice(0, body.indexOf('\n}\n'));
    // Подтверждение снятия последней привязки сохранено (требование c81964c7).
    assert.match(fnBody, /const isLast = isLastChip\(meaningful\)/);
    assert.match(fnBody, /invalidateQueries\(queryKeys\.chronicleFeedAll\(\)\);[\s\S]*?await refreshFeedAndCalendar\(\);/);
    // Классовой «перестановки» и сброса прокрутки больше нет.
    assert.ok(!/movesToHome/.test(fnBody), 'прежняя логика перемещения удалена');
    assert.ok(!/feedWrap\.scrollTop = 0/.test(fnBody), 'прокрутка не сбрасывается');
  });
});
