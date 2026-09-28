/**
 * Регресс ошибки 820608e4: сбой точечного додара `etn.comments.get` в ветке
 * вставки записи вне ленты глушился без fallback — перенос даты в видимый
 * период мог не показаться до постороннего обновления.
 *
 * Ожидание: сбой додара уводит окно в полный путь (по образцу `refreshDirections`
 * «Структур»: catch → markFull). Экран в node-тесте не поднимается, поэтому
 * проводка проверяется структурно по исходнику.
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

describe('chronicle realtime: сбой додара вне ленты → полный путь (ошибка 820608e4)', () => {
  it('catch точечного додара в ветке вставки зовёт reloadAndSync', () => {
    const body = CHRONICLE.slice(CHRONICLE.indexOf('async function applyChronicleOps('));
    const ops = body.slice(0, body.indexOf('\n}\n'));
    const insertBranch = ops.slice(ops.indexOf('if (idx < 0) {'));
    assert.match(
      insertBranch,
      /await etn\.comments\.get\(requireNetworkId\(\), op\.id\);[\s\S]*?\} catch \{[\s\S]*?await reloadAndSync\(\);[\s\S]*?return;/,
      'сбой додара не глушится, окно уходит в полный путь',
    );
  });
});
