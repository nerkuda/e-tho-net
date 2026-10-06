/**
 * Разбор выделенного фрагмента markdown на «единицы» — деревья мыслей для
 * команд ТП3 (задача `1d15f14a`, тех.проект `b16c219c`, ADR `01ec1467`,
 * требование `f5695a1e`).
 *
 * Единица разбора — фрагмент выделения, которому соответствует будущая мысль
 * (создание из раздела/выделенного, «Разделить выделение на мысли»). Функция
 * живёт в едином пакете `@etn/markdown` и разбирает выделение тем же
 * markdown-it-парсером, что и рендер (второй парсер запрещён ADR; сторож
 * `guard-markdown-single-renderer`, правило `own-*-outside-package`). Ни
 * клиент, ни поле комментария собственной нарезки не содержат.
 *
 * Модель ЕДИНИЦЫ (требование `f5695a1e`):
 *
 * - `list` — маркерный/нумерованный список режется иерархически: каждый
 *   элемент списка — единица, вложенный список — её `children` (правило 1).
 *   Единица родителя покрывает собственное содержимое элемента ДО первого
 *   вложенного списка; собственное содержимое ПОСЛЕ него («хвост») — отдельные
 *   единицы-`paragraph` в `children`; пустой элемент единицы не даёт;
 * - `section` — заголовок (любого уровня) и текст до СЛЕДУЮЩЕГО заголовка;
 *   вложенные разделы — `children` по уровням заголовков, тела разделов не
 *   пересекаются (правило 2 + правило 5 «после первого заголовка — по
 *   правилам разделов»); списки внутри тела раздела его не разрезают;
 * - `paragraph` — текст между пустыми строками; блок кода/цитата/таблица,
 *   отделённые от предыдущего не пустой строкой, — его продолжение, отделённые
 *   пустой строкой — новая единица (правило 3);
 * - `line` — одиночная строка простого текста без блочной разметки (правило 4).
 *
 * Начало/конец выделения в середине блока (правила 6 и 7) получаются сами
 * собой: выделение разбирается как самостоятельный документ, поэтому неполная
 * часть становится отдельной единицей-абзацем.
 *
 * Каждая единица несёт `text` — ТОЧНЫЙ срез источника по её полуинтервалу
 * `[start, end)` (`text === source.slice(start, end)`, пустые строки внутри
 * сохраняются) — и вложенные единицы `children`. Диапазоны ВСЕХ единиц попарно
 * не пересекаются: родитель заканчивается раньше первого ребёнка, поэтому на
 * месте каждой единицы можно поставить трансклюзию, а текст между единицами
 * останется нетронутым. Имя мысли («первая значимая строка», обрезка до 250)
 * вычисляет потребитель по требованию `f64f5893` — разбор его не навязывает.
 */

import type Token from 'markdown-it/lib/token.mjs';

import { getRenderer } from './renderer.js';
import { computeLineStarts } from './source-map.js';

/** Вид единицы разбора (список / раздел / абзац / строка). */
export type MarkdownUnitKind = 'list' | 'section' | 'paragraph' | 'line';

/** Единица разбора выделения: будущая мысль и её вложенные единицы. */
export interface MarkdownUnit {
  /** Вид единицы. */
  kind: MarkdownUnitKind;
  /**
   * Точный срез исходного выделения по диапазону `[start, end)`
   * (`text === source.slice(start, end)`) — собственное содержимое единицы без
   * вложенных единиц (`children`), с сохранением разметки (маркер списка, `#`
   * заголовка, ограждение блока кода) и пустых строк внутри. Единицы без
   * собственного содержимого (голый маркер `-`, `- `) не создаются вовсе.
   * Имя мысли потребитель берёт из первой значимой строки.
   */
  text: string;
  /** Начало единицы в переданной строке выделения (включительно). */
  start: number;
  /** Конец единицы в переданной строке выделения (исключительно). */
  end: number;
  /** Вложенные единицы: подчинённые элементы списка и подразделы. */
  children: MarkdownUnit[];
}

/** Вид top-level блока markdown-it, важный для правил разбора. */
type BlockKind =
  | 'heading'
  | 'list'
  | 'paragraph'
  | 'blockquote'
  | 'fence'
  | 'code_block'
  | 'table'
  | 'hr'
  | 'html_block';

/** Top-level блок исходника с его диапазоном и границами в потоке токенов. */
interface Block {
  kind: BlockKind;
  /** Уровень заголовка (1..6) для `heading`, иначе 0. */
  headingLevel: number;
  /** Начало блока в исходнике (строка целиком). */
  start: number;
  /** Конец блока (без хвостовых переводов строк). */
  end: number;
  /** Индекс открывающего токена в потоке. */
  openIndex: number;
}

/** Маркеры блочных конструкций markdown-it по виду. */
const CONTAINER_KINDS: Readonly<Record<string, BlockKind | undefined>> = {
  heading_open: 'heading',
  paragraph_open: 'paragraph',
  bullet_list_open: 'list',
  ordered_list_open: 'list',
  blockquote_open: 'blockquote',
  table_open: 'table',
};

/** Листовые блочные токены markdown-it. */
const LEAF_KINDS: Readonly<Record<string, BlockKind | undefined>> = {
  fence: 'fence',
  code_block: 'code_block',
  hr: 'hr',
  html_block: 'html_block',
};

/** Пробельный символ (для обрезки хвостов и проверки пустых строк). */
function isWs(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
}

/** Конец диапазона без хвостовых пробелов/переводов строк. */
function trimRangeEnd(src: string, start: number, end: number): number {
  let e = end;
  while (e > start && isWs(src[e - 1])) e--;
  return e;
}

/**
 * Разбирает выделенный фрагмент markdown на единицы с вложенностью.
 *
 * Возвращает лес единиц в порядке исходника. Пустое/пробельное выделение даёт
 * пустой массив. Функция чистая (без DOM и БД) и не бросает на произвольном
 * markdown.
 *
 * @throws когда `source` не строка.
 */
export function parseSelectionUnits(source: string): MarkdownUnit[] {
  if (typeof source !== 'string') {
    throw new Error('parseSelectionUnits: source must be a string');
  }
  const lineStarts = computeLineStarts(source);
  const tokens = getRenderer().parse(source, {});
  const blocks = topLevelBlocks(tokens, source, lineStarts);

  const units: MarkdownUnit[] = [];
  /** Единицы, пришедшие из простого абзаца (для вида `line`). */
  const plain = new Map<MarkdownUnit, boolean>();
  let last: MarkdownUnit | null = null;

  // До первого заголовка — правила абзацев и списков (правило 5).
  let i = 0;
  for (; i < blocks.length && blocks[i]!.kind !== 'heading'; i++) {
    const block = blocks[i]!;
    if (block.kind === 'list') {
      units.push(...listUnits(tokens, block.openIndex, source, lineStarts));
      last = null;
      continue;
    }
    const contiguous = last !== null && !hasBlankLine(source, last.end, block.start);
    if (last !== null && contiguous) {
      // Код/цитата/таблица без пустой строки — продолжение предыдущей единицы.
      last.end = block.end;
      plain.set(last, false);
      continue;
    }
    const unit: MarkdownUnit = {
      kind: 'paragraph',
      text: '',
      start: block.start,
      end: block.end,
      children: [],
    };
    units.push(unit);
    plain.set(unit, block.kind === 'paragraph');
    last = unit;
  }

  // С первого заголовка — правила разделов (правило 2).
  if (i < blocks.length) units.push(...sectionUnits(blocks.slice(i), source));

  for (const unit of units) {
    if (unit.kind !== 'paragraph') continue;
    unit.text = source.slice(unit.start, unit.end);
    if (unit.text !== '' && !unit.text.includes('\n') && plain.get(unit) === true) {
      unit.kind = 'line';
    }
  }
  return units;
}

/** Есть ли между `from` и `to` пустая (или пробельная) строка. */
function hasBlankLine(src: string, from: number, to: number): boolean {
  return /\n[ \t]*\r?\n/.test(src.slice(from, to));
}

/** Индекс закрывающего токена контейнера, открытого в `openIndex`. */
function matchingClose(tokens: readonly Token[], openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i++) {
    const nesting = tokens[i]!.nesting;
    if (nesting === 1) depth++;
    else if (nesting === -1) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

/** Диапазон блока `[start, end)` по `token.map` (без хвостовых переводов). */
function blockRange(
  token: Token,
  src: string,
  lineStarts: readonly number[],
): { start: number; end: number } | null {
  const map = token.map;
  if (map === null || map === undefined) return null;
  const start = lineStarts[map[0]!];
  if (start === undefined) return null;
  const rawEnd = lineStarts[map[1]!] ?? src.length;
  return { start, end: trimRangeEnd(src, start, rawEnd) };
}

/** Уровень заголовка (1..6) по токену `heading_open`. */
function headingLevel(token: Token): number {
  const match = /^h([1-6])$/.exec(token.tag);
  return match === null ? 1 : Number(match[1]);
}

/** Собирает top-level (не вложенные в списки) блоки в порядке исходника. */
function topLevelBlocks(
  tokens: readonly Token[],
  src: string,
  lineStarts: readonly number[],
): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token.level !== 0) {
      i++;
      continue;
    }
    const kind =
      token.nesting === 1
        ? CONTAINER_KINDS[token.type]
        : token.nesting === 0
          ? LEAF_KINDS[token.type]
          : undefined;
    if (kind === undefined) {
      i++;
      continue;
    }
    const range = blockRange(token, src, lineStarts);
    if (range !== null) {
      blocks.push({
        kind,
        headingLevel: kind === 'heading' ? headingLevel(token) : 0,
        start: range.start,
        end: range.end,
        openIndex: i,
      });
    }
    i = token.nesting === 1 ? matchingClose(tokens, i) + 1 : i + 1;
  }
  return blocks;
}

/** Единицы элементов списка, открытого в `listOpenIndex` (правило 1). */
function listUnits(
  tokens: readonly Token[],
  listOpenIndex: number,
  src: string,
  lineStarts: readonly number[],
): MarkdownUnit[] {
  const listLevel = tokens[listOpenIndex]!.level;
  const units: MarkdownUnit[] = [];
  let i = listOpenIndex + 1;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token.level <= listLevel) break;
    if (token.type === 'list_item_open' && token.level === listLevel + 1) {
      const close = matchingClose(tokens, i);
      units.push(...listItemUnits(tokens, i, close, src, lineStarts));
      i = close + 1;
      continue;
    }
    i++;
  }
  return units;
}

/** Прямой child элемента списка: собственный блок либо вложенный список. */
interface ItemPart {
  kind: 'own' | 'list';
  start: number;
  end: number;
  /** Единицы вложенного списка (для `kind === 'list'`). */
  units: MarkdownUnit[];
}

/**
 * Единицы одного элемента списка (правило 1). Контракт непересечения диапазонов
 * держится так: единица родителя покрывает собственное содержимое ОТ НАЧАЛА
 * элемента до начала первого вложенного списка (ребёнок внутрь не попадает), а
 * собственное содержимое ПОСЛЕ первого вложенного списка («хвост») становится
 * отдельными единицами-абзацами в `children` — в порядке документа, после
 * вложенных элементов. Элемент без вложенных списков — одна единица на весь
 * свой диапазон (пустые строки между абзацами сохраняются).
 *
 * Возвращает массив, потому что элемент без собственного содержимого («пустой
 * пункт» или пункт, начинающийся сразу с вложенного списка) своей единицы не
 * даёт — остаются только вложенные.
 */
function listItemUnits(
  tokens: readonly Token[],
  openIndex: number,
  closeIndex: number,
  src: string,
  lineStarts: readonly number[],
): MarkdownUnit[] {
  const open = tokens[openIndex]!;
  const itemLevel = open.level;
  const itemRange = blockRange(open, src, lineStarts);
  if (itemRange === null) return [];

  // Прямые children элемента в порядке документа: собственные блоки и списки.
  const parts: ItemPart[] = [];
  let i = openIndex + 1;
  while (i < closeIndex) {
    const token = tokens[i]!;
    if (token.level !== itemLevel + 1) {
      i++;
      continue;
    }
    if (token.nesting === 1) {
      const close = matchingClose(tokens, i);
      if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
        const range = blockRange(token, src, lineStarts);
        if (range !== null) {
          parts.push({ kind: 'list', start: range.start, end: range.end, units: listUnits(tokens, i, src, lineStarts) });
        }
      } else {
        const range = blockRange(token, src, lineStarts);
        if (range !== null) {
          parts.push({ kind: 'own', start: range.start, end: range.end, units: [] });
        }
      }
      i = close + 1;
      continue;
    }
    if (token.nesting === 0) {
      const range = blockRange(token, src, lineStarts);
      if (range !== null) {
        parts.push({ kind: 'own', start: range.start, end: range.end, units: [] });
      }
    }
    i++;
  }

  if (parts.length === 0) return [];

  const firstListIndex = parts.findIndex((part) => part.kind === 'list');
  if (firstListIndex === -1) {
    // Элемент без вложенности — одна единица на весь свой диапазон.
    const text = src.slice(itemRange.start, itemRange.end);
    if (text.trim() === '') return [];
    return [{ kind: 'list', text, start: itemRange.start, end: itemRange.end, children: [] }];
  }

  // Собственное содержимое после первого вложенного списка — единицы-абзацы.
  const children: MarkdownUnit[] = [];
  for (let j = firstListIndex; j < parts.length; j++) {
    const part = parts[j]!;
    if (part.kind === 'list') {
      children.push(...part.units);
      continue;
    }
    const text = src.slice(part.start, part.end);
    if (text.trim() === '') continue;
    children.push({ kind: 'paragraph', text, start: part.start, end: part.end, children: [] });
  }

  // Собственного содержимого ДО первого вложенного списка нет — родительская
  // единица была бы «голым» маркером (`-`, `- `): её не создаём, вложенные
  // элементы остаются единицами сами по себе.
  if (firstListIndex === 0) return children;

  // Единица родителя — от начала элемента до первого вложенного списка.
  const parentStart = itemRange.start;
  const parentEnd = trimRangeEnd(src, parentStart, parts[firstListIndex]!.start);
  return [{ kind: 'list', text: src.slice(parentStart, parentEnd), start: parentStart, end: parentEnd, children }];
}

/**
 * Дерево разделов (правило 2): каждый заголовок — единица, её текст — от
 * заголовка до СЛЕДУЮЩЕГО заголовка (любого уровня), вложенные разделы —
 * `children` по уровням. Диапазоны соседних разделов не пересекаются.
 */
function sectionUnits(blocks: readonly Block[], src: string): MarkdownUnit[] {
  const roots: MarkdownUnit[] = [];
  const stack: Array<{ unit: MarkdownUnit; level: number }> = [];
  const ordered: Array<{ unit: MarkdownUnit; level: number }> = [];

  for (const block of blocks) {
    if (block.kind !== 'heading') continue;
    const unit: MarkdownUnit = {
      kind: 'section',
      text: '',
      start: block.start,
      end: block.start,
      children: [],
    };
    while (stack.length > 0 && stack[stack.length - 1]!.level >= block.headingLevel) {
      stack.pop();
    }
    if (stack.length > 0) stack[stack.length - 1]!.unit.children.push(unit);
    else roots.push(unit);
    stack.push({ unit, level: block.headingLevel });
    ordered.push({ unit, level: block.headingLevel });
  }

  let regionEnd = src.length;
  while (regionEnd > 0 && isWs(src[regionEnd - 1])) regionEnd--;

  for (let i = 0; i < ordered.length; i++) {
    const unit = ordered[i]!.unit;
    const boundary = i + 1 < ordered.length ? ordered[i + 1]!.unit.start : regionEnd;
    // Пустые строки между разделами — «текст между единицами»: их не забираем.
    unit.end = trimRangeEnd(src, unit.start, boundary);
    unit.text = src.slice(unit.start, unit.end);
  }
  return roots;
}
