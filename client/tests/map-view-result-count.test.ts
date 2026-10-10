/**
 * Регресс-тест ошибки 4493811f «Неправильный результат отбора на карте мыслей».
 *
 * Симптом: в нижней зоне карты мыслей в результатах отбора счётчик показывал
 * 100 — длину ЗАГРУЖЕННОЙ страницы, тогда как серверный отбор содержит больше
 * мыслей (тот же отбор на «Структурах мыслей» показывает полное число).
 *
 * Причина: `paintZoneIndicators` в режиме отбора брала
 * `zoneData.get('children')?.length` — число уже подгруженных строк, а не
 * `meta.total` сервера. Плюс нижняя зона не догружала порции отбора.
 *
 * Ожидание карточки: индикатор показывает РЕАЛЬНОЕ количество мыслей отбора,
 * используется динамическая пагинация, одинаковые условия дают одинаковый
 * результат на всех страницах приложения.
 *
 * Проверяется проводка (функциональные правила — в `focus-filter-strip.test.ts`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const read = (rel: string): string =>
  readFileSync(resolve(import.meta.dirname, '..', 'src', 'renderer', rel), 'utf8');

describe('счётчик нижней зоны карты в режиме отбора (4493811f)', () => {
  it('paintZoneIndicators берёт число из meta.total результата отбора, а не длину порции', () => {
    const canvas = read('canvas/canvas.ts');
    assert.match(
      canvas,
      /isChildrenViewResult\(\)\)[\s\S]{0,500}?takeViewResult\(\)\?\.total/,
      'индикатор детей в режиме отбора должен читать total результата отбора',
    );
    assert.doesNotMatch(
      canvas,
      /setZoneIndicator\(\s*'children',\s*zoneCountLabel\(zoneData\.get\('children'\)\?\.length/,
      'нельзя красить счётчик длиной загруженной порции',
    );
  });

  it('нижняя зона в режиме отбора догружает порцию отбора по скроллу (динамическая пагинация)', () => {
    const canvas = read('canvas/canvas.ts');
    assert.match(
      canvas,
      /dir === 'children' && isChildrenViewResult\(\)\)\s*\{\s*await maybeLoadMoreViewResult\(/,
      'скролл нижней зоны в режиме отбора ведёт в догрузку результата отбора',
    );
    assert.match(
      canvas,
      /loadMoreViewResult\(focus\.focused\.id\)/,
      'догрузка вызывает loadMoreViewResult активного отбора',
    );
  });

  it('догрузка шлёт limit/offset и исчерпывается на meta.total', () => {
    const strip = read('canvas/focus-filter-strip.ts');
    assert.match(
      strip,
      /export const VIEW_PAGE_SIZE = 100/,
      'размер порции должен совпадать с дефолтом сервера runViewForThought',
    );
    assert.match(
      strip,
      /limit: VIEW_PAGE_SIZE,\s*offset: result\.nextOffset,/,
      'следующая порция запрашивается с явными limit/offset',
    );
    assert.match(
      strip,
      /result\.exhausted = resp\.data\.length === 0 \|\| result\.items\.length >= result\.total/,
      'исчерпание определяется по meta.total, а не по длине страницы',
    );
  });
});
