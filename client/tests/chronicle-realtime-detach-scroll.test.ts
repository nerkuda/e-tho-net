/**
 * Регресс ошибки 368747a6: снятие последнего чипса поднимает запись в
 * HOME-блок, а лента остаётся прокрученной — перемещённая запись вне вида.
 *
 * Ожидание: перемещение записи в другой блок (смена класса записи на 0) меняет
 * состав верхней части ленты, поэтому прокрутка сбрасывается к началу. Экран в
 * node-тесте не поднимается (тянет `app.js`/редактор), поэтому проводка
 * проверяется структурно по исходнику.
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

describe('chronicle realtime: detachChip сбрасывает прокрутку (ошибка 368747a6)', () => {
  it('снятие последнего чипса показывает ленту с начала', () => {
    const body = CHRONICLE.slice(CHRONICLE.indexOf('async function detachChip('));
    const fnBody = body.slice(0, body.indexOf('\n}\n'));
    // Снятие последнего содержательного чипса меняет класс записи на 0 — сервер
    // поднимает запись в верхний блок HOME.
    assert.match(fnBody, /const movesToHome = isLastChip\(meaningful\)/);
    // keyed-сверка держит позицию прокрутки, поэтому её сбрасываем явно после
    // перезагрузки, чтобы перемещённая запись была видна.
    assert.match(fnBody, /if \(movesToHome && feedWrap !== null\) feedWrap\.scrollTop = 0;/);
    assert.match(fnBody, /await reload\(\);[\s\S]*?feedWrap\.scrollTop = 0;/);
  });
});
