/**
 * Structural checks for the thought chip context menu in the diary feed
 * (спецификация «Контекстное меню мысли»).
 *
 * Правило: чип мысли в дневниковой записи — то же облачко мысли, что и везде,
 * поэтому он обязан звать общий конструктор `canvas/context-menu.ts`
 * (`showThoughtContextMenu`) и получать полный набор команд. Рядом с открытием
 * обязателен пункт «В фокус»: поставить мысль в фокус и переключить экран на
 * «Карту мыслей». Без обработчика контекста конструктор этот пункт не строит —
 * и он пропал из меню чипа (ошибка 9c5d2e99).
 *
 * Композиция команд проверяется unit-тестами самого конструктора
 * (`context-menu.test.ts`); здесь — только факт делегирования из «Дневника».
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');
const CHRONICLE = resolve(RENDERER, 'screens', 'chronicle', 'chronicle.ts');

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Вырезает тело функции по её сигнатуре (до закрывающей скобки в 1-й колонке). */
function functionBody(src: string, signature: string, end = '\n}\n'): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `expected ${signature} to be defined`);
  const stop = src.indexOf(end, start);
  assert.ok(stop > start, `expected ${signature} body to be closed with ${JSON.stringify(end)}`);
  return src.slice(start, stop);
}

describe('меню чипа мысли в дневниковой записи — общий конструктор (ошибка 9c5d2e99)', () => {
  it('чип мысли зовёт showThoughtContextMenu и передаёт focusHandler', () => {
    const src = readText(CHRONICLE);
    const chip = functionBody(src, 'function buildChip(');
    assert.ok(
      chip.includes('showThoughtContextMenu('),
      'the diary thought chip must use the shared thought-menu constructor',
    );
    assert.ok(
      chip.includes('focusHandler'),
      '«В фокус» must be requested from the shared builder — without it the row is missing',
    );
    assert.ok(
      chip.includes('focusThoughtOnMap('),
      '«В фокус» uses the single entry point `focusThoughtOnMap` (ошибка 562356a9), not a copy',
    );
    assert.ok(
      chip.includes("await import('../active-view.js')") || chip.includes("import('../active-view.js')"),
      'the view switcher is imported lazily (active-view → chronicle cycle)',
    );
    // Своего списка команд у чипа нет — только блок опций записи.
    assert.ok(
      chip.includes('extraItems'),
      'the record commands («Отвязать»/«Связать с…») are context options, not a second command list',
    );
  });
});
