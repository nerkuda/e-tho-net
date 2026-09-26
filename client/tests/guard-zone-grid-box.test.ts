/**
 * Сторож ширины коробки сетки сектора (ошибка 1deced69).
 *
 * Правило: `.zone-grid` якорится ПО ВИДИМОМУ КОНТЕНТУ (самый широкий ряд,
 * `zoneContentWidth`), а не по полной колонковой коробке. `gridTemplateColumns`
 * фиксирует все `cols` колонок, поэтому при неполном последнем ряде (в секторе
 * меньше мыслей, чем колонок) коробка шире контента; её `translate` по якорю
 * выносил пустые хвостовые колонки за правый край зоны и рождал горизонтальную
 * полосу прокрутки в секторе с одной мыслью. Проверка дешёвая: пустые колонки
 * не содержат облачков, поэтому ширина коробки обязана быть равна
 * `contentWidth`, вычисленному из `zoneContentWidth`.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANVAS = path.join(CLIENT_ROOT, 'src', 'renderer', 'canvas', 'canvas.ts');

/** Тело функции `renderZoneContent` из canvas.ts. */
function renderZoneContentBody(source: string): string {
  const start = source.indexOf('function renderZoneContent(');
  assert.ok(start >= 0, 'в canvas.ts не найдена renderZoneContent');
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

/** Строка — комментарий? (в пояснениях имена конструкций допустимы). */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

describe('guard: сетка сектора якорится по видимому контенту, не по полной коробке', () => {
  it('renderZoneContent сужает коробку до contentWidth перед якорем', () => {
    const body = renderZoneContentBody(fs.readFileSync(CANVAS, 'utf8'));
    // Ищем по СТРОКАМ КОДА: закомментированная строка не считается фиксом.
    const code = body.split('\n').filter((line) => !isComment(line));
    assert.ok(
      code.some((line) => /const contentWidth = zoneContentWidth\(/.test(line)),
      'ширина видимого контента обязана считаться через zoneContentWidth',
    );
    assert.ok(
      code.some((line) => /grid\.style\.width\s*=\s*`\$\{contentWidth\}px`/.test(line)),
      'коробка .zone-grid обязана сужаться до contentWidth — иначе якорь выносит пустые колонки за край зоны (ошибка 1deced69)',
    );
    assert.ok(
      code.some((line) => /grid\.style\.transform\s*=/.test(line)),
      'якорь сетки пропал из renderZoneContent',
    );
  });

  it('пустой сектор сбрасывает ширину коробки', () => {
    const body = renderZoneContentBody(fs.readFileSync(CANVAS, 'utf8'));
    const emptyBranch = body.indexOf('if (entries.length === 0) {');
    assert.ok(emptyBranch >= 0, 'в renderZoneContent не найдена ветка пустого сектора');
    const branch = body
      .slice(emptyBranch)
      .split('\n')
      .filter((line) => !isComment(line));
    const clearGrid = branch.findIndex((line) => /clear\(grid\);/.test(line));
    const resetWidth = branch.findIndex((line) => /grid\.style\.width = '';/.test(line));
    assert.ok(
      resetWidth >= 0,
      'пустой сектор не сбрасывает ширину коробки — остаточная коробка прокручиваема',
    );
    assert.ok(
      clearGrid >= 0 && resetWidth > clearGrid,
      'ширину коробки надо сбрасывать в ветке пустого сектора',
    );
  });
});
