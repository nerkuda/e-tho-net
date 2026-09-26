/**
 * Сторож плавной смены фокуса на карте (спека «FLIP-анимация холста», задача
 * e9f0af94).
 *
 * Правило: длительности и сглаживание фазовой хореографии задаются ТОЛЬКО
 * токенами `--anim-focus-*` (`styles/tokens.css`), а не магическими числами в
 * коде. Оркестратор `canvas/transition.ts` читает их через `getComputedStyle`,
 * поэтому:
 *   1. в модуле перехода нет числовых `…ms` и числовых `duration`;
 *   2. сами токены объявлены в `:root` и обнуляются при
 *      `prefers-reduced-motion: reduce` — иначе reduce-motion пришлось бы
 *      дублировать веткой в коде.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readRendererCss } from './renderer-css.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRANSITION = path.join(CLIENT_ROOT, 'src', 'renderer', 'canvas', 'transition.ts');
const CANVAS = path.join(CLIENT_ROOT, 'src', 'renderer', 'canvas', 'canvas.ts');

/** Токены, которыми живёт фазовая хореография. */
const TOKENS = [
  '--anim-focus-flight',
  '--anim-focus-settle',
  '--anim-focus-fade',
  '--anim-focus-ease',
] as const;

/** Строка — комментарий? (в пояснениях единицы и имена токенов допустимы). */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

describe('guard: плавная смена фокуса — длительности из токенов', () => {
  it('в canvas/transition.ts нет магических ms и числовых duration', () => {
    const source = fs.readFileSync(TRANSITION, 'utf8');
    const offenders: string[] = [];
    source.split('\n').forEach((line, index) => {
      if (isComment(line)) return;
      if (/\b\d+(?:\.\d+)?ms\b/.test(line)) offenders.push(`${index + 1}: ${line.trim()}`);
      if (/\bduration:\s*\d/.test(line)) offenders.push(`${index + 1}: ${line.trim()}`);
    });
    assert.deepEqual(
      offenders,
      [],
      'длительности фаз задаются токенами --anim-focus-*, а не числами в коде',
    );
  });

  it('токены объявлены в :root и обнулены при prefers-reduced-motion', () => {
    const css = readRendererCss();
    const rootEnd = css.indexOf("[data-theme='dark'] {");
    const root = css.slice(0, rootEnd === -1 ? css.length : rootEnd);
    for (const token of TOKENS) {
      assert.match(root, new RegExp(`${token}\\s*:`), `${token} не объявлен в :root styles.css`);
    }
    const reducedEnd = css.indexOf('prefers-reduced-motion: reduce');
    assert.ok(reducedEnd >= 0, 'нет блока prefers-reduced-motion: reduce');
    const reduced = css.slice(reducedEnd);
    for (const token of ['--anim-focus-flight', '--anim-focus-settle', '--anim-focus-fade']) {
      assert.match(
        reduced,
        new RegExp(`${token}\\s*:\\s*0ms`),
        `${token} не обнулён при prefers-reduced-motion — reduce-motion пришлось бы дублировать в коде`,
      );
    }
  });

  // Дефект 1 приёмки e9f0af94: новый фокус мелькал в центре, потому что между
  // пересборкой фокус-облачка и стартом перехода стоял `await` — браузер успевал
  // нарисовать кадр с новым содержимым, пока переход ещё не спрятал его.
  // Инвариант: пересборка и `playFocusTransition` обязаны быть в одной
  // синхронной задаче.
  it('canvas.ts: между пересборкой фокуса и стартом перехода нет await', () => {
    const source = fs.readFileSync(CANVAS, 'utf8');
    const start = source.indexOf('renderFocusRow(focus);');
    const end = source.indexOf('playFocusTransition(host, snapshot');
    assert.ok(start >= 0, 'в canvas.ts не найдена пересборка фокус-облачка');
    assert.ok(end > start, 'в canvas.ts не найден запуск перехода после пересборки');
    const between = source.slice(start, end);
    assert.ok(
      !/\bawait\b/.test(between),
      'между renderFocusRow и playFocusTransition есть await — новый фокус мелькнёт в центре до начала полёта',
    );
  });
});
