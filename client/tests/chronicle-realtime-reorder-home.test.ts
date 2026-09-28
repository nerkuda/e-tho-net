/**
 * Регресс ошибки 89409d57: локальная перестановка строки при правке даты
 * передавала модульный `homeId` вместо разрешённого `home` — при недоступном
 * HOME (`homeId === null`) `recordClass` даёт 1 всем строкам, и позиция могла
 * разойтись с серверной.
 *
 * Ожидание: перестановка сверяется с разрешённым HOME; недоступный HOME уводит
 * в полный путь. Экран в node-тесте не поднимается, проводка проверяется
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

describe('chronicle realtime: перестановка по разрешённому HOME (ошибка 89409d57)', () => {
  it('перестановка использует homeForOrder, недоступный HOME → полный путь', () => {
    const body = CHRONICLE.slice(CHRONICLE.indexOf('async function applyChronicleOps('));
    const ops = body.slice(0, body.indexOf('\n}\n'));
    const reorder = ops.slice(ops.lastIndexOf('// Переставить на место'));
    assert.match(reorder, /const homeForOrder = homeId \?\? \(await getHome\(\)\.catch\(\(\) => null\)\);/);
    assert.match(reorder, /if \(homeForOrder === null\) \{[\s\S]*?await reloadAndSync\(\);[\s\S]*?return;/);
    assert.match(reorder, /insertRowByDay\([\s\S]*?homeForOrder,/);
    assert.ok(
      !/,\s*homeId,\s*\)/.test(reorder),
      'перестановка не передаёт модульный homeId напрямую',
    );
  });
});
