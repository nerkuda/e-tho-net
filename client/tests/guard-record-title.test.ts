/**
 * Сторож единого разбора производного заголовка записи (0.10.2, задача 8e4a965f).
 *
 * Правило: разбор производного заголовка дневниковой записи (снятие ведущих
 * markdown-маркеров, разэкранирование HTML-сущностей, снятие чужого хвостового
 * «…», обрезка по максимальной длине) живёт РОВНО в одном месте —
 * `lib/record-title.ts`. Лента «Дневника» и вкладка «Дневник» редактора
 * используют его; второй реализации нет, и редактор не тянет разбор из экранов
 * (`editor/` ← `screens/` запрещено — иначе верхний слой зависит от нижнего).
 *
 * Сторож зелёный на исправленном коде и краснеет, если разбор снова раздвоится
 * или вкладка вернёт собственную реализацию.
 *
 * Входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(...parts: string[]): string {
  return readFileSync(resolve(RENDERER, ...parts), 'utf8');
}

const LIB = read('lib', 'record-title.ts');
const DIARY = read('screens', 'chronicle', 'diary.ts');
const CHRONO_TAB = read('editor', 'chrono-tab.ts');

describe('сторож: единый разбор производного заголовка записи (8e4a965f)', () => {
  it('разбор и пределы длины живут в lib/record-title.ts', () => {
    assert.match(LIB, /LEADING_MD_MARKER_RE/, 'снятие ведущих markdown-маркеров');
    assert.match(LIB, /function recordTitleFromBody\(/, 'первая непустая строка тела');
    assert.match(LIB, /function recordDisplayTitle\(/, 'отображаемый заголовок');
    assert.match(LIB, /RECORD_DISPLAY_TITLE_MAX = 150/, 'лимит ленты — 150');
    assert.match(LIB, /EDITOR_RECORD_TITLE_MAX = 250/, 'лимит вкладки редактора — 250');
  });

  it('лента не держит вторую реализацию разбора', () => {
    assert.ok(
      !/LEADING_MD_MARKER_RE/.test(DIARY) && !/recordTitleFromBody/.test(DIARY),
      'screens/chronicle/diary.ts делегирует разбор общему модулю',
    );
  });

  it('вкладка редактора использует общий модуль, а не свои строки заметки', () => {
    assert.match(
      CHRONO_TAB,
      /import \{[^}]*recordDisplayTitle[^}]*\} from '\.\.\/lib\/record-title\.js'/,
      'импорт общего разбора',
    );
    assert.match(
      CHRONO_TAB,
      /recordDisplayTitle\(comment\.title, comment\.body_md, EDITOR_RECORD_TITLE_MAX\)/,
      'ячейка «Заголовок» — общий помощник с лимитом вкладки',
    );
    assert.ok(
      !/body_md\.split\(/.test(CHRONO_TAB),
      'собственного разбора первой непустой строки во вкладке нет',
    );
  });

  it('редактор не тянет разбор заголовка из экранов', () => {
    assert.ok(
      !/from '\.\.\/screens\/chronicle\//.test(CHRONO_TAB),
      'нет зависимости editor/ ← screens/chronicle',
    );
  });
});
