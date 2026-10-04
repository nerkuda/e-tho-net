/**
 * Сторож замечаний визуальной приёмки 0.11.1, волна 4 (задачи 432ab7ba и
 * bd6609b5) — структурные проверки CSS и разметки там, где поведение уже
 * покрыто DOM/юнит-тестами:
 *
 *  • «книжки» полок: ширина/высота, переносы заголовка/подзаголовка, автор
 *    нижней строкой, дата сборки убрана;
 *  • двухрамочная навигация (ADR e6d48e09): карта, «Структуры», библиотека —
 *    общее правило `shouldDrawCurrentFrame`;
 *  • клик по оглавлению публикации назначает текущий блок документа.
 *
 * Входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');
const read = (...parts: string[]): string => fs.readFileSync(path.join(RENDERER, ...parts), 'utf8');

const CSS = read('styles', 'screens', 'publications.css');
const PUBL = read('screens', 'publications', 'publications.ts');
const LIBNAV = read('screens', 'publications', 'library-nav.ts');
const WS = read('screens', 'publications', 'workspace.ts');
const CANVAS_NAV = read('canvas', 'kbd-nav.ts');
const CANVAS = read('canvas', 'canvas.ts');
const STRUCT_NAV = read('screens', 'structures', 'kbd-nav.ts');
const STRUCTURES = read('screens', 'structures', 'structures.ts');
const NAV_CORE = read('lib', 'ui', 'nav-core.ts');
const LIST = read('lib', 'ui', 'list.ts');

describe('432ab7ba п.1: «книжки» полок — размер, переносы, автор, без даты', () => {
  it('ширина +15% и высота +3 строки (6 строковых зон)', () => {
    assert.match(
      CSS,
      /\.pub-cards\s*\{[^}]*minmax\(calc\(11rem \* 1\.15\),\s*1fr\)/s,
      'ширина книжки +15% против 11rem',
    );
    assert.match(
      CSS,
      /\.pub-card-info\s*\{[^}]*min-height:\s*calc\(6 \* 1\.3 \* var\(--font-size-m\)\)/s,
      'высота текстовой зоны — 6 строк (5 текстовых + автор)',
    );
  });

  it('заголовок до 3 строк (5 без подзаголовка), подзаголовок до 2', () => {
    assert.match(CSS, /\.pub-card-title\s*\{[^}]*-webkit-line-clamp:\s*3/s, 'заголовок — 3 строки');
    assert.match(
      CSS,
      /\.pub-card-info\.pub-card-info-no-subtitle \.pub-card-title\s*\{[^}]*-webkit-line-clamp:\s*5/s,
      'без подзаголовка заголовок — 5 строк',
    );
    assert.match(CSS, /\.pub-card-subtitle\s*\{[^}]*-webkit-line-clamp:\s*2/s, 'подзаголовок — 2 строки');
    assert.ok(PUBL.includes('pub-card-info-no-subtitle'), 'модель помечает карточку без подзаголовка');
  });

  it('автор — нижняя строка с обрезкой; дата сборки убрана', () => {
    assert.match(CSS, /\.pub-card-author\s*\{[^}]*margin-top:\s*auto/s, 'автор прижат к низу');
    assert.match(
      CSS,
      /\.pub-card-author\s*\{[^}]*text-overflow:\s*ellipsis/s,
      'не поместившийся автор обрезается',
    );
    assert.ok(!CSS.includes('.pub-card-date'), 'правила даты сборки в CSS нет');
    assert.ok(!PUBL.includes('pub-card-date'), 'модель карточки больше не строит дату сборки');
    assert.ok(!PUBL.includes('assemblyDateLabel'), 'дата сборки из карточки библиотеки убрана');
  });
});

describe('432ab7ba п.2 / bd6609b5: ядро 2D-навигации и двухрамочность', () => {
  it('nav-core несёт общий пространственный выбор и правило пунктира', () => {
    assert.match(NAV_CORE, /export function pickSpatialTarget/, 'пространственный выбор — в ядре');
    assert.match(NAV_CORE, /export function shouldDrawCurrentFrame/, 'правило «текущий = открытый» — в ядре');
    assert.match(NAV_CORE, /export interface NavBox/, 'общий тип прямоугольника — в ядре');
  });

  it('компонент списка умеет пространственный режим', () => {
    for (const member of ['useSpatialNav', 'boxOf', 'isGroupHead', 'groupOf']) {
      assert.ok(LIST.includes(member), `адаптер списка отдаёт ${member}`);
    }
    assert.match(LIST, /pickSpatialTarget\(/, 'пространственный шаг использует ядро');
  });

  it('ядро карты делегирует выбор тому же pickSpatialTarget', () => {
    assert.match(CANVAS_NAV, /from '\.\.\/lib\/ui\/nav-core\.js'/, 'карта использует общее ядро');
    assert.match(CANVAS_NAV, /pickSpatialTarget/, 'выбор цели карты — из ядра');
  });

  it('карта: пунктир не рисуется на совпавшем с редактором облачке', () => {
    assert.match(CANVAS_NAV, /shouldDrawCurrentFrame\(/, 'карта применяет общее правило');
    assert.match(CANVAS, /paintHalo\(\)[\s\S]*?syncCanvasCursor\(\)/, 'смена цели редактора пересчитывает пунктир');
  });

  it('«Структуры»: пунктир не рисуется на совпавшей с редактором мысли', () => {
    assert.match(STRUCT_NAV, /shouldDrawCurrentFrame\(/, '«Структуры» применяют общее правило');
    assert.match(STRUCTURES, /patchVisualStates\(\)[\s\S]*?syncStructuresCursor\(\)/, 'патч визуала пересчитывает пунктир');
  });

  it('библиотека: текущая — пунктир, открытая в редакторе — сплошная', () => {
    assert.match(CSS, /\.pub-current\s*\{[^}]*outline:\s*2px dashed/s, 'текущая сущность — пунктир');
    assert.match(
      CSS,
      /\.pub-open\s*\{[^}]*outline:\s*2px solid var\(--layer-focus-stripe,\s*var\(--accent\)\)/s,
      'открытая в редакторе — сплошная рамка фокуса',
    );
    assert.ok(LIBNAV.includes('LIB_OPEN_CLASS'), 'контроллер рисует сплошную рамку');
    assert.match(LIBNAV, /shouldDrawCurrentFrame\(/, 'контроллер подавляет пунктир при совпадении');
    assert.ok(PUBL.includes('openedKey'), 'экран прокидывает открытую публикацию');
    assert.match(PUBL, /isShelvesView/, 'геометрия включена только для вида «Полки»');
  });
});

describe('432ab7ba п.3: клик по оглавлению — текущий блок документа', () => {
  it('прокрутка к якорю назначает текущий блок и переводит фокус по клику', () => {
    assert.match(WS, /function makeDocCurrent\(/, 'есть назначение текущего блока документа');
    assert.match(WS, /makeDocCurrent\([\s\S]*?docNav\.setCurrent\(/, 'текущий блок — через компонент навигации');
    assert.match(WS, /node\.addEventListener\('click',\s*\(\)\s*=>\s*scrollToAnchor\(anchor,\s*true\)\)/, 'клик по оглавлению — с фокусом в документ');
    assert.match(WS, /scrollToAnchor\(line\.anchor,\s*true\)/, 'Enter по оглавлению — тоже');
  });
});
