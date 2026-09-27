/**
 * Регресс-тест: контекстное меню доступно в КАЖДОМ отображении облачка мысли
 * (спецификация «Контекстное меню мысли»: холст, панель выделения, дерево
 * «Структур», чипы истории и закреплённых, чипы значений свойств, пилюли
 * локального графа и кнопка «Действия»).
 *
 * Причина появления теста — ошибка b674fc1a «У облачков мыслей пропали
 * контекстные меню»: правка T6 версии 0.10.1 переписала экран «Дневник» и
 * сняла правый клик с чипов ленты (прежний самодельный `showTargetMenu`),
 * а сторож словаря меню этого не заметил — из его перечня просто исчезли
 * функции меню хроники. Набор команд у облачка один на всю программу
 * (`canvas/context-menu.ts` → `showThoughtContextMenu`), поэтому каждое место
 * отображения обязано звать именно его, а не собирать второй список.
 *
 * Композиция команд проверяется unit-тестами конструктора
 * (`context-menu.test.ts`); здесь — только факт делегирования из мест
 * отображения (как в `editor-cloud-menu.test.ts`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const SRC = {
  historyBar: resolve(import.meta.dirname, '..', 'src', 'renderer', 'screens', 'history-bar.ts'),
  pinnedBar: resolve(import.meta.dirname, '..', 'src', 'renderer', 'screens', 'pinned-bar.ts'),
  chronicle: resolve(
    import.meta.dirname,
    '..',
    'src',
    'renderer',
    'screens',
    'chronicle',
    'chronicle.ts',
  ),
};

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

describe('контекстное меню облачка — общий конструктор во всех отображениях (b674fc1a)', () => {
  it('чип панели истории зовёт общее меню мысли (и полоса, и строка дропдауна)', () => {
    const src = readText(SRC.historyBar);
    assert.match(
      src,
      /import\s*\{[^}]*showThoughtContextMenu[^}]*\}\s*from\s*'\.\.\/canvas\/context-menu\.js'/,
      'панель истории обязана импортировать общий конструктор меню мысли',
    );
    const chip = functionBody(src, 'function buildChip(');
    assert.ok(
      chip.includes('onContextMenu') && chip.includes('showThoughtContextMenu('),
      'чип полосы истории обязан вешать общее меню мысли на правый клик',
    );
    // Строки дропдауна строит `showMenuAt` — их меню вешается отдельно.
    const dropdown = functionBody(src, 'function openHistoryMenu(');
    assert.ok(
      dropdown.includes('showThoughtContextMenu(') ||
        dropdown.includes('wireHistoryContextMenu('),
      'строка дропдауна истории обязана получать то же меню мысли',
    );
  });

  it('чип панели закреплённых зовёт общее меню мысли', () => {
    const src = readText(SRC.pinnedBar);
    const chip = functionBody(src, 'function buildChip(');
    assert.ok(
      chip.includes('showThoughtContextMenu('),
      'чип закреплённых обязан вешать общее меню мысли',
    );
  });

  it('чип ленты «Дневника»: облачко мысли — общее меню + команды записи, связь — меню записи', () => {
    const src = readText(SRC.chronicle);
    assert.match(
      src,
      /import\s*\{[^}]*showThoughtContextMenu[^}]*\}\s*from\s*'\.\.\/\.\.\/canvas\/context-menu\.js'/,
      'лента дневника обязана импортировать общий конструктор меню мысли',
    );
    const chip = functionBody(src, 'function buildChip(');
    assert.ok(
      chip.includes('contextmenu'),
      'buildChip дневника обязан перехватывать правый клик',
    );
    assert.ok(
      chip.includes('showThoughtContextMenu('),
      'облачко мысли в ленте дневника обязано открывать общее меню мысли',
    );
    // Операции контекста записи передаются опцией, а не вторым списком команд.
    assert.ok(
      chip.includes('extraItems') &&
        chip.includes("t('chrono.menu.detach')") &&
        chip.includes("t('chrono.menu.attach')"),
      'команды «Отвязать»/«Связать с…» — блоком extraItems общего меню',
    );
    assert.ok(
      src.includes('function showDiaryLinkMenu('),
      'чип связи в ленте обязан иметь своё короткое меню (общее меню мысли к связи неприменимо)',
    );
  });
});
