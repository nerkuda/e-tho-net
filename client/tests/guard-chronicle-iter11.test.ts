/**
 * Сторож приёмки №11 (0.10.1, задача 45df70ed). Фиксирует структурные
 * инварианты, на которых держатся запреты поведения требования 165323a7
 * («Устойчивость»):
 *
 *  - сворачивание/разворачивание группы дат меняет ленту НА МЕСТЕ
 *    (`findDaySection` + `applyDayCollapsed`), а не полной пересборкой —
 *    иначе теряются фокус клавиатуры и позиция прокрутки (ошибки ab78e7b5,
 *    407b1827);
 *  - перерисовка ленты при правке записи/real-time сохраняет позицию прокрутки
 *    (`preserveScroll`, lib/ui/scroll-anchor.ts — уровень 1 тех.проекта
 *    1d48df6d: якорь по ключу строки вместо простого `scrollTop`);
 *  - фокусируемый узел поля «мысли» — кнопка «+ мысль» (`.diary-chip-add`),
 *    а не пустой контейнер привязок (ошибка 02b4d513).
 *
 * Сторож зелёный на исправленном коде и краснеет, если эти пути откатят.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');
const CHRONICLE = readFileSync(resolve(RENDERER, 'screens', 'chronicle', 'chronicle.ts'), 'utf8');
const FEED_NAV = readFileSync(resolve(RENDERER, 'screens', 'chronicle', 'feed-nav.ts'), 'utf8');

describe('сторож: группы дат переключаются на месте, прокрутка и поле «мысли» (165323a7)', () => {
  it('сворачивание группы меняет её состояние на месте, без полной пересборки', () => {
    assert.match(
      CHRONICLE,
      /findDaySection\(feedList,\s*day\)/,
      'сворачивание ищет секцию дня в текущем DOM',
    );
    assert.match(
      CHRONICLE,
      /applyDayCollapsed\(section,\s*collapsed,\s*dayGroupLabels\(\)\)/,
      'сворачивание применяет состояние к существующей секции (in-place)',
    );
  });

  it('перерисовка ленты сохраняет позицию прокрутки через preserveScroll', () => {
    assert.match(
      CHRONICLE,
      /preserveScroll\(feedWrap,\s*\(\)\s*=>/,
      'renderFeed сохраняет позицию прокрутки при пересборке (правка/real-time)',
    );
  });

  it('поле «мысли» в навигации — сама кнопка «+ мысль»', () => {
    assert.match(
      FEED_NAV,
      /querySelector<HTMLElement>\('\.diary-chip-add'\)/,
      'фокусируемый узел поля «мысли» — кнопка «+ мысль»',
    );
  });
});
