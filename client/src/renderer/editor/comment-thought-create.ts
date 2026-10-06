/**
 * Команды «Создать мысль из раздела», «Создать мысль из выделенного» и
 * «Разделить выделение на мысли» (0.12.1, задачи 5f854e7a и 578c8525, ТП3
 * «Манипуляции с выделением в комментарии»; элемент интерфейса `2a21c27e`).
 *
 * Модуль владеет телами трёх команд поля комментария:
 *  - «из раздела» — каретка (или выделение) стоит в разделе: заголовок
 *    становится названием новой мысли, тело — текстом раздела без заголовка;
 *  - «из выделенного» — любое непустое выделение целиком становится одной
 *    мыслью: название — первая значимая строка, тело — всё выделение (первая
 *    строка остаётся в теле);
 *  - «разделить выделение на мысли» — выделение разбирается на единицы
 *    (`parseSelectionUnits`), по мысли на единицу с учётом вложенности
 *    (вложенные единицы — под-мысли созданной мысли-родителя), на месте каждой
 *    единицы — трансклюзия. Доступна при не менее 2 единицах разбора, диалога
 *    и предпросмотра нет.
 *
 * Общее для всех команд (ТП3): новая мысль — ребёнок текущей мысли
 * (владелец комментария), тип не назначается, позиция — в конец списка детей;
 * на месте исходного фрагмента ставится трансклюзия полного постоянного
 * комментария новой мысли (без `#раздел` — заголовок ушёл в название,
 * требования `23c11231`, `f64f5893`, `fe023652`).
 *
 * Разбор выделения — существующей функцией `parseSelectionUnits`
 * (`@etn/markdown`); второй парсер не создаётся (ADR `01ec1467`, сторож
 * `guard-markdown-single-renderer`). Форма ссылки трансклюзии собирается
 * экспортом `formatTransclusionRef` того же пакета — собственных шаблонов
 * ссылок вне пакета быть не может. Запись — одной клиентской операцией «мысль +
 * постоянный комментарий»: REST `POST /thoughts` с телом `comment { body_md }`
 * (задача `aa79c82d`, ADR `56db189a`), раздельные вызовы не используются.
 *
 * Сеть и запись спрятаны за портом {@link CommentThoughtCreatePort}: юнит-тесты
 * подменяют его и проверяют план/название/тело/родителя без сервера.
 */

import { formatTransclusionRef, parseSelectionUnits, type MarkdownUnit } from '@etn/markdown';

import { requireNetworkId } from '../app.js';
import { errText } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { t } from '../lib/i18n.js';
import { notice } from '../lib/notice.js';
import {
  registerCommentCommand,
  type CommentCommandContext,
  type CommentOwnerRef,
} from './comment-commands.js';
import type { MdEditor, MdEditorSnapshot } from './md-editor.js';

/** Идентификатор команды «Создать мысль из раздела». */
export const CREATE_FROM_SECTION_COMMAND = 'comment.createFromSection';

/** Идентификатор команды «Создать мысль из выделенного». */
export const CREATE_FROM_SELECTION_COMMAND = 'comment.createFromSelection';

/**
 * Идентификатор команды «Разделить выделение на мысли» (задача 578c8525).
 * Идентификатор `comment.split` был заведён ТП1 как точка расширения — здесь
 * регистрируется её тело.
 */
export const SPLIT_SELECTION_COMMAND = 'comment.split';

/** Максимальная длина названия новой мысли (требование `f64f5893`). */
export const TITLE_MAX_LENGTH = 250;

/**
 * Минимальное число единиц разбора, при котором доступна команда «Разделить
 * выделение на мысли» (ТП3, элемент интерфейса `2a21c27e`).
 */
export const SPLIT_MIN_UNITS = 2;

/* ------------------------------------------------------------------ *
 * Порт создания мысли (тестовый шов).
 * ------------------------------------------------------------------ */

/** Запрос создания мысли-ребёнка с постоянным комментарием. */
export interface CommentThoughtCreateRequest {
  parentId: string;
  title: string;
  bodyMd: string;
}

/** Созданная мысль (нужен только id для трансклюзии). */
export interface CommentThoughtCreated {
  id: string;
}

/**
 * Сеть и запись для команд создания мыслей. Разделено на «определить
 * родителя» и «создать» — так тесты проверяют и разрешение владельца-связи,
 * и саму операцию, не поднимая сервер.
 */
export interface CommentThoughtCreatePort {
  /** Мысль-родитель для владельца комментария; `null` — родитель не найден. */
  resolveParent(owner: CommentOwnerRef): Promise<string | null>;
  /** Создаёт мысль-ребёнка одной операцией «мысль + постоянный комментарий». */
  create(request: CommentThoughtCreateRequest): Promise<CommentThoughtCreated>;
}

let createPort: CommentThoughtCreatePort | null = null;

/** Подменяет порт создания (тестовый шов); `null` — системный REST-порт. */
export function setCommentThoughtCreatePort(port: CommentThoughtCreatePort | null): void {
  createPort = port;
}

/** Действующий порт создания мыслей. */
export function commentThoughtCreatePort(): CommentThoughtCreatePort {
  return createPort ?? restCreatePort();
}

/**
 * Системный порт: родитель — сама мысль-владелец (для комментария связи —
 * её источник, как в `wiki-link-create.ts`); создание — REST `POST /thoughts`
 * с `comment` и связью-родителем `direction: 'parent'` (новая мысль встаёт
 * ПОД текущей).
 */
function restCreatePort(): CommentThoughtCreatePort {
  return {
    async resolveParent(owner) {
      if (owner.ownerType === 'thought') return owner.ownerId;
      const link = await etn.links.get(requireNetworkId(), owner.ownerId);
      return link.source_id;
    },
    async create(request) {
      const created = await etn.thoughts.create(requireNetworkId(), {
        title: request.title,
        comment: { body_md: request.bodyMd },
        // Семантика REST (03-server-api.md §6.3): 'parent' — target становится
        // родителем новой мысли; позиция среди детей — по умолчанию в конец.
        create_link: { direction: 'parent', target_thought_id: request.parentId },
      });
      return { id: created.id };
    },
  };
}

/* ------------------------------------------------------------------ *
 * План: что и на что заменить (чистые функции — основа юнит-тестов).
 * ------------------------------------------------------------------ */

/** Найденная цель команды: диапазон замены и атрибуты новой мысли. */
export interface CommentThoughtPlan {
  /** Начало заменяемого фрагмента в тексте редактора (включительно). */
  start: number;
  /** Конец заменяемого фрагмента в тексте редактора (исключительно). */
  end: number;
  /** Название новой мысли (первая значимая строка, ≤250). */
  title: string;
  /** Тело новой мысли — постоянный комментарий. */
  bodyMd: string;
}

/** Маркер ограждения блока кода (строка целиком — не имя мысли). */
const FENCE_RE = /^(?:```|~~~)/;
/** Цитата (`>`), маркер списка (`-`, `*`, `+`, `1.`, `1)`), чекбокс, заголовок. */
const QUOTE_RE = /^>+/;
const LIST_RE = /^(?:[-*+]|\d{1,9}[.)])(?=\s|$)/;
const TASK_RE = /^\[[ xX]\](?=\s|$)/;
const HEADING_RE = /^#{1,6}(?=\s|$)/;

/** Снимает с начала строки маркеры блочной разметки, оставляя содержимое. */
function stripBlockPrefixes(line: string): string {
  let rest = line.trim();
  for (;;) {
    const before = rest;
    rest = rest
      .replace(QUOTE_RE, '')
      .replace(LIST_RE, '')
      .replace(TASK_RE, '')
      .replace(HEADING_RE, '')
      .trimStart();
    if (rest === before) break;
  }
  return rest;
}

/**
 * Первая значимая строка текста единицы (требование `f64f5893`): первая
 * непустая строка, не состоящая только из маркеров разметки; у заголовка —
 * его текст без `#`; строки-ограждения блока кода пропускаются, берётся первая
 * непустая строка содержимого. Пусто, если значимой строки нет.
 */
export function firstSignificantLine(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (FENCE_RE.test(line)) continue;
    const content = stripBlockPrefixes(line);
    if (content === '') continue;
    return content;
  }
  return '';
}

/**
 * Обрезает название до `max` символов, не разрывая сущности markdown
 * (закрывающая `]]` wiki-ссылки/трансклюзии остаётся в обрезке; требование
 * `f64f5893`). Хвостовые пробелы снимаются.
 */
export function truncateMarkdownTitle(title: string, max: number = TITLE_MAX_LENGTH): string {
  if (title.length <= max) return title;
  let cut = max;
  const open = title.lastIndexOf('[[', cut);
  if (open !== -1) {
    const close = title.indexOf(']]', open + 2);
    if (close === -1 || close + 2 > cut) cut = open;
  }
  const shortened = title.slice(0, cut).replace(/\s+$/, '');
  return shortened === '' ? title.slice(0, max) : shortened;
}

/** Название новой мысли по правилу `f64f5893` (первая значимая строка, ≤250). */
export function thoughtTitle(text: string): string {
  return truncateMarkdownTitle(firstSignificantLine(text));
}

/**
 * Тело единицы-раздела без строки заголовка (ведущие пустые строки сняты):
 * заголовок уходит в название, тело становится постоянным комментарием.
 */
export function sectionBody(text: string): string {
  const nl = text.indexOf('\n');
  if (nl === -1) return '';
  return text.slice(nl + 1).replace(/^(?:[ \t]*\r?\n)+/, '').replace(/[ \t]+$/, '');
}

/**
 * Единица-раздел, содержащая позицию `pos` (по всему тексту документа):
 * самая глубокая из разделов, в чей диапазон `[start, end]` попадает позиция;
 * `null` — позиция вне разделов (например, до первого заголовка).
 */
export function findSectionUnitAt(text: string, pos: number): MarkdownUnit | null {
  return searchSection(parseSelectionUnits(text), pos);
}

function searchSection(units: readonly MarkdownUnit[], pos: number): MarkdownUnit | null {
  for (const unit of units) {
    if (pos < unit.start || pos > unit.end) continue;
    const nested = searchSection(unit.children, pos);
    if (nested !== null) return nested;
    return unit.kind === 'section' ? unit : null;
  }
  return null;
}

/**
 * План команды «Создать мысль из раздела»: раздел, где стоит каретка, либо
 * раздел, содержащий всё выделение. `null` — позиция вне раздела.
 */
export function planFromSection(snap: MdEditorSnapshot): CommentThoughtPlan | null {
  const unit = findSectionUnitAt(snap.text, snap.from);
  if (unit === null) return null;
  if (snap.from !== snap.to && snap.to > unit.end) return null;
  const title = thoughtTitle(unit.text);
  if (title === '') return null;
  return { start: unit.start, end: unit.end, title, bodyMd: sectionBody(unit.text) };
}

/**
 * План команды «Создать мысль из выделенного»: одна мысль из всего выделения.
 * `null` — выделения нет или оно пустое/без значимой строки.
 */
export function planFromSelection(snap: MdEditorSnapshot): CommentThoughtPlan | null {
  if (snap.from === snap.to) return null;
  const selected = snap.text.slice(snap.from, snap.to);
  if (selected.trim() === '') return null;
  const title = thoughtTitle(selected);
  if (title === '') return null;
  return { start: snap.from, end: snap.to, title, bodyMd: selected };
}

/* ------------------------------------------------------------------ *
 * План команды «Разделить выделение на мысли» (задача 578c8525).
 * ------------------------------------------------------------------ */

/**
 * Узел плана разделения: одна единица разбора → будущая мысль. `start`/`end` —
 * диапазон единицы в тексте редактора `[start, end)`; `children` — вложенные
 * единицы, которые станут под-мыслями созданной мысли-родителя.
 */
export interface SplitSelectionNode {
  /** Начало заменяемого фрагмента в тексте редактора (включительно). */
  start: number;
  /** Конец заменяемого фрагмента в тексте редактора (исключительно). */
  end: number;
  /** Название новой мысли (первая значимая строка, ≤250). */
  title: string;
  /**
   * Тело новой мысли — постоянный комментарий: полный текст единицы, для
   * единицы-раздела — без строки заголовка (`sectionBody`, требование
   * `23c11231`).
   */
  bodyMd: string;
  /** Вложенные единицы — под-мысли этой мысли. */
  children: SplitSelectionNode[];
}

/**
 * Строит лес узлов плана из дерева единиц разбора, смещая их диапазоны на
 * `offset` (начало выделения в тексте редактора). Единица без значимой строки
 * своей мысли не даёт — её вложенные единицы поднимаются на уровень выше.
 *
 * Тело единицы: для раздела — текст БЕЗ строки заголовка (`sectionBody`):
 * заголовок уходит в название, «раздела с таким заголовком в новой мысли нет»,
 * поэтому в развёртке трансклюзии заголовок не появляется (требование
 * `23c11231`, правило разбора `f5695a1e`; та же механика, что у команды
 * «Создать мысль из раздела» в задаче `5f854e7a`). Для остальных единиц тело —
 * полный текст единицы.
 */
function buildSplitNodes(units: readonly MarkdownUnit[], offset: number): SplitSelectionNode[] {
  const nodes: SplitSelectionNode[] = [];
  for (const unit of units) {
    const children = buildSplitNodes(unit.children, offset);
    const title = thoughtTitle(unit.text);
    if (title === '') {
      nodes.push(...children);
      continue;
    }
    nodes.push({
      start: unit.start + offset,
      end: unit.end + offset,
      title,
      bodyMd: unit.kind === 'section' ? sectionBody(unit.text) : unit.text,
      children,
    });
  }
  return nodes;
}

/** Число единиц разбора в лесе (включая вложенные). */
function countSplitNodes(nodes: readonly SplitSelectionNode[]): number {
  let total = 0;
  for (const node of nodes) total += 1 + countSplitNodes(node.children);
  return total;
}

/**
 * План команды «Разделить выделение на мысли»: лес единиц разбора текущего
 * выделения (вложенность сохраняется). `null` — выделения нет, оно пустое или
 * содержит менее {@link SPLIT_MIN_UNITS} единиц (команда недоступна, ТП3).
 *
 * Разбор — только `parseSelectionUnits` из `@etn/markdown`; собственной нарезки
 * модуль не содержит (ADR `01ec1467`, сторож `guard-selection-single-parser`).
 */
export function planSplitSelection(snap: MdEditorSnapshot): SplitSelectionNode[] | null {
  if (snap.from === snap.to) return null;
  const selected = snap.text.slice(snap.from, snap.to);
  if (selected.trim() === '') return null;
  const nodes = buildSplitNodes(parseSelectionUnits(selected), snap.from);
  if (countSplitNodes(nodes) < SPLIT_MIN_UNITS) return null;
  return nodes;
}

/* ------------------------------------------------------------------ *
 * Тела команд.
 * ------------------------------------------------------------------ */

/** Создаёт мысль по плану и ставит трансклюзию на месте фрагмента. */
async function createAndReplace(
  editor: MdEditor,
  plan: CommentThoughtPlan,
  owner: CommentOwnerRef,
): Promise<void> {
  const port = commentThoughtCreatePort();
  try {
    const parentId = await port.resolveParent(owner);
    if (parentId === null) {
      notice(`${t('comment.create.error')}: ${t('comment.create.noParent')}`, 'error');
      return;
    }
    const created = await port.create({ parentId, title: plan.title, bodyMd: plan.bodyMd });
    const insert = formatTransclusionRef(created.id);
    editor.applyEdit({
      changes: [{ from: plan.start, to: plan.end, insert }],
      selection: { anchor: plan.start + insert.length },
    });
  } catch (err) {
    notice(`${t('comment.create.error')}: ${errText(err)}`, 'error');
  }
}

/** Общий ход команды: план → владелец → асинхронное создание. */
function runCreate(
  ctx: CommentCommandContext,
  plan: CommentThoughtPlan | null,
): boolean {
  if (plan === null) return false;
  const owner = ctx.getCommentOwner();
  if (owner === null) return false;
  void createAndReplace(ctx.editor, plan, owner);
  return true;
}

/* ------------------------------------------------------------------ *
 * Тело команды «Разделить выделение на мысли» (задача 578c8525).
 * ------------------------------------------------------------------ */

/**
 * Создаёт по мысли на каждую единицу плана и заменяет каждую единицу её
 * трансклюзией. Обход — в порядке документа, родитель создаётся прежде
 * ребёнка: под-мысль вложенной единицы получает родителем id мысли-родителя,
 * а не текущую мысль контейнера (элемент интерфейса `2a21c27e`). Правки
 * диапазонов не пересекаются (`parseSelectionUnits`), поэтому уезжают одной
 * транзакцией редактора; текст вне единиц остаётся на месте.
 */
async function splitAndReplace(
  editor: MdEditor,
  nodes: readonly SplitSelectionNode[],
  owner: CommentOwnerRef,
): Promise<void> {
  const port = commentThoughtCreatePort();
  try {
    const parentId = await port.resolveParent(owner);
    if (parentId === null) {
      notice(`${t('comment.create.error')}: ${t('comment.create.noParent')}`, 'error');
      return;
    }
    const changes: Array<{ from: number; to: number; insert: string }> = [];
    let caret: number | null = null;
    const walk = async (
      list: readonly SplitSelectionNode[],
      parent: string,
    ): Promise<void> => {
      for (const node of list) {
        const created = await port.create({
          parentId: parent,
          title: node.title,
          bodyMd: node.bodyMd,
        });
        const insert = formatTransclusionRef(created.id);
        changes.push({ from: node.start, to: node.end, insert });
        if (caret === null) caret = node.start + insert.length;
        await walk(node.children, created.id);
      }
    };
    await walk(nodes, parentId);
    editor.applyEdit({ changes, selection: { anchor: caret ?? 0 } });
  } catch (err) {
    notice(`${t('comment.create.error')}: ${errText(err)}`, 'error');
  }
}

/** Ход команды «Разделить выделение на мысли»: план → владелец → создание. */
function runSplit(ctx: CommentCommandContext): boolean {
  const nodes = planSplitSelection(ctx.editor.snapshot());
  if (nodes === null) return false;
  const owner = ctx.getCommentOwner();
  if (owner === null) return false;
  void splitAndReplace(ctx.editor, nodes, owner);
  return true;
}

/**
 * Регистрирует тела обеих команд (идемпотентно — повторный вызов заменяет
 * записи реестра). Вызывается при установке набора команд поля. Идентификаторы
 * заданы литералами, а не экспортированными константами: модуль может быть
 * установлен из циклически импортируемого `comment-format.ts` до инициализации
 * своих констант.
 */
export function installCommentThoughtCreateCommands(): void {
  registerCommentCommand('comment.createFromSection', {
    run: (ctx) => runCreate(ctx, planFromSection(ctx.editor.snapshot())),
    state: (snap) => ({ disabled: planFromSection(snap) === null }),
  });
  registerCommentCommand('comment.createFromSelection', {
    run: (ctx) => runCreate(ctx, planFromSelection(ctx.editor.snapshot())),
    state: (snap) => ({ disabled: planFromSelection(snap) === null }),
  });
  registerCommentCommand('comment.split', {
    run: (ctx) => runSplit(ctx),
    state: (snap) => ({ disabled: planSplitSelection(snap) === null }),
  });
}

// Самоустановка при загрузке модуля: команды доступны полю без явного вызова
// со стороны ТП1 (модуль подключается боковым импортом из `comment-format.ts`).
installCommentThoughtCreateCommands();
