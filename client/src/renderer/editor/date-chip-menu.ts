/**
 * Контекстное меню date-чипа (0.16.1, ТП «Даты, задачи и напоминания»;
 * элемент интерфейса c85ca40d, требования 31fe2cc9 и 236d4472, сценарий P5).
 *
 * Пункты: «Открыть день», «Изменить дату…», «Перенести на завтра / на неделю /
 * на месяц». Перенос строки ЗАДАЧИ — единый сдвиг ВСЕХ её date-ссылок: в
 * просмотре вызывается серверная операция `PATCH /tasks` с `action: 'move'`
 * (грамматика и нормализация 31-го живут в `task-service`,
 * `shiftTaskLineDates`), в правке — тот же сдвиг по локальному документу
 * (`lib/dates.ts`: `addDays`/`addMonths`, нормализация конца месяца та же).
 * Строка без чекбокса — перенос только ОДНОЙ ссылки (правка `body_md`
 * источника через `comments.update`; серверная модель задач её не касается).
 *
 * Меню — общий словарь `lib/menu.ts` (как у карты), диалог даты — общий
 * контрол `lib/date-period-dialog.ts` (сторож `guard-period-editor`), клик по
 * чипу — `editor/wiki-link.ts` (решение DoD). Своего меню/диалога здесь нет.
 *
 * Модуль держит и чистые помощники адресации чипа (юнит-тесты — без DOM):
 * номер строки по смещению/порядковому номеру чипа и сдвиг date-ссылок строки.
 */

import { EditorView } from '@codemirror/view';

import { EtnError, type Comment } from '@etn/shared';
import {
  WIKI_LINK_DATE_ATTR,
  WIKI_LINK_DATE_CLASS,
  MD_SOURCE_START_ATTR,
  computeLineStarts,
  findDateLinkSpans,
  parseTaskLines,
  type DateLinkSpan,
  type TaskLine,
} from '@etn/markdown';

import { requireNetworkId } from '../app.js';
import { addDays, addMonths, isValidLocalDay } from '../lib/dates.js';
import { errText } from '../lib/dom.js';
import { openDatePeriodDialog } from '../lib/date-period-dialog.js';
import { etn } from '../lib/etn.js';
import { t } from '../lib/i18n.js';
import { MENU_SEPARATOR, menuAction, showMenuAt } from '../lib/menu.js';
import { notice } from '../lib/notice.js';
import { TABLE_ROW_KEY_ATTR } from '../lib/ui/table.js';
import { openChronicleDay } from '../screens/chronicle/chronicle.js';
import { COMMENT_FIELD_ATTR, commentSourceForField } from './comment-source.js';

/** Сдвиг дат: ровно один из `days`/`months` (как у серверной операции move). */
export type DateShift = { days: number } | { months: number };

/** Найденная date-ссылка строки и адрес этой строки в `body_md`. */
export interface DateSpanLocation {
  /** Номер строки `body_md` с нуля (адрес `PATCH /tasks`: `line_no`). */
  lineNo: number;
  /** Смещение начала строки в `body_md`. */
  lineStart: number;
  /** Текст строки целиком (без завершающего `\n`). */
  lineText: string;
  /** Позиции date-ссылки внутри строки. */
  span: DateLinkSpan;
}

/** Структурное представление чипа в DOM (минимум для проверок/адресации). */
export interface ChipLike {
  getAttribute(name: string): string | null;
}

/** Смещение видимой даты чипа (source-map просмотра) или `null`. */
export function chipSourceOffset(chip: ChipLike): number | null {
  const raw = chip.getAttribute(MD_SOURCE_START_ATTR);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** Разбить `body_md` на строки, сохраняя завершающий `\r` (CRLF не ломаем). */
function bodyLines(body: string): { start: number; text: string }[] {
  const lines: { start: number; text: string }[] = [];
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\n') continue;
    lines.push({ start, text: body.slice(start, i) });
    start = i + 1;
  }
  lines.push({ start, text: body.slice(start) });
  return lines;
}

/** Ограда блока кода: символ и длина маркера (``` или ~~~). */
function fenceAt(line: string): { char: string; length: number } | null {
  const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (marker === null) return null;
  const fence = marker[1]!;
  return { char: fence[0]!, length: fence.length };
}

/**
 * Все date-ссылки `body_md` в порядке документа с адресами строк.
 * Строки внутри ограды блока кода пропускаются: их `[[…]]` — ТЕКСТ примера,
 * а не чип (в `body_html` он не рендерится). Без этого порядковый номер чипа
 * в просмотре разъехался бы с порядком ссылок в `body_md`.
 */
function bodyDateSpans(body: string): DateSpanLocation[] {
  const out: DateSpanLocation[] = [];
  const lines = bodyLines(body);
  let fence: { char: string; length: number } | null = null;
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo]!;
    const marker = fenceAt(line.text);
    if (fence !== null) {
      if (marker !== null && marker.char === fence.char && marker.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (marker !== null) {
      fence = marker;
      continue;
    }
    for (const span of findDateLinkSpans(line.text)) {
      out.push({ lineNo, lineStart: line.start, lineText: line.text, span });
    }
  }
  return out;
}

/**
 * Date-ссылка по ПОРЯДКОВОМУ номеру чипа в области. Порядок чипов в
 * отрендеренном HTML совпадает с порядком ссылок в `body_md`, поэтому это
 * точная адресация и для серверного `body_html` ленты без source-map.
 */
export function dateSpanByOrdinal(body: string, ordinal: number): DateSpanLocation | null {
  if (ordinal < 0) return null;
  return bodyDateSpans(body)[ordinal] ?? null;
}

/**
 * Date-ссылка по абсолютному смещению (source-map просмотра). Для ссылки с
 * алиасом `data-md-start` указывает на алиас — берём ссылку, в диапазон
 * которой входит смещение.
 */
export function dateSpanByOffset(body: string, offset: number): DateSpanLocation | null {
  if (offset < 0 || offset > body.length) return null;
  const starts = computeLineStarts(body);
  let lineIndex = 0;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i]! <= offset) lineIndex = i;
    else break;
  }
  const lineStart = starts[lineIndex] ?? 0;
  const lineEnd = lineIndex + 1 < starts.length ? starts[lineIndex + 1]! - 1 : body.length;
  const lineText = body.slice(lineStart, lineEnd);
  const local = offset - lineStart;
  const spans = findDateLinkSpans(lineText);
  const span =
    spans.find((item) => item.start <= local && local < item.end) ??
    spans.find((item) => item.targetStart <= local && local < item.targetEnd);
  if (span === undefined) return null;
  return { lineNo: lineIndex, lineStart, lineText, span };
}

/** Сдвиг цели одной date-ссылки (время `HH:MM` сохраняется). */
export function shiftSpanTarget(span: DateLinkSpan, shift: DateShift): string {
  const shifted =
    'months' in shift
      ? addMonths(span.parts.date, shift.months)
      : addDays(span.parts.date, shift.days);
  return span.parts.time === null ? shifted : `${shifted} ${span.parts.time}`;
}

/** Замена цели одной ссылки в строке (алиас автора сохраняется). */
export function replaceSpanTarget(line: string, span: DateLinkSpan, target: string): string {
  return `${line.slice(0, span.targetStart)}${target}${line.slice(span.targetEnd)}`;
}

/**
 * Единый сдвиг ВСЕХ date-ссылок строки; `null` — в строке нет ссылок.
 * Замены идут с конца, чтобы не сдвигать ещё не обработанные позиции.
 */
export function shiftLineDates(line: string, shift: DateShift): string | null {
  const spans = findDateLinkSpans(line);
  if (spans.length === 0) return null;
  let next = line;
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    const span = spans[i]!;
    next = replaceSpanTarget(next, span, shiftSpanTarget(span, shift));
  }
  return next;
}

/** Разница дней между двумя календарными датами `YYYY-MM-DD`. */
export function dayDelta(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** Строка задачи проекции по номеру строки с нуля; `null` — не задача. */
export function taskLineAt(body: string, lineNo: number): TaskLine | null {
  const row = parseTaskLines(body).find((item) => item.lineNo === lineNo + 1);
  return row !== undefined && row.isTask ? row : null;
}

/** Заменить строку `lineNo` (с нуля) в `body_md`, сохраняя остальные. */
function replaceBodyLine(body: string, lineNo: number, next: string): string {
  const lines = body.split('\n');
  if (lineNo < 0 || lineNo >= lines.length) return body;
  lines[lineNo] = next;
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Адрес чипа: правка или просмотр
// ---------------------------------------------------------------------------

/** Чип в live-preview редактора: документ доступен напрямую. */
interface EditorChip {
  kind: 'editor';
  view: EditorView;
  /** Начало узла `[[…]]` в документе (data-md-from виджета). */
  linkFrom: number;
}

/** Чип в просмотре: источник — комментарий (id/версия/body_md дочитываются). */
interface ViewChip {
  kind: 'view';
  commentId: string | null;
  /** Абсолютное смещение видимой даты в `body_md` (source-map), либо null. */
  offset: number | null;
  /** Порядковый номер чипа в области, либо null. */
  ordinal: number | null;
}

type ChipContext = EditorChip | ViewChip;

/** Первый редактор CodeMirror, содержащий узел, или `null`. */
function editorViewAt(node: HTMLElement): EditorView | null {
  const dom = node.closest('.cm-editor');
  if (dom === null) return null;
  try {
    return EditorView.findFromDOM(dom as HTMLElement);
  } catch {
    return null;
  }
}

/** Позиция чипа в контейнере: область — поле markdown либо карточка записи. */
function chipOrdinal(chip: HTMLElement, scope: HTMLElement): number | null {
  const chips = Array.from(scope.querySelectorAll(`.${WIKI_LINK_DATE_CLASS}`));
  const index = chips.indexOf(chip);
  return index === -1 ? null : index;
}

/** Определить адрес чипа по DOM (до открытия меню — DOM ещё стабилен). */
function chipContext(chip: HTMLElement): ChipContext {
  const view = editorViewAt(chip);
  if (view !== null) {
    const from = Number(chip.dataset.mdFrom);
    return { kind: 'editor', view, linkFrom: Number.isFinite(from) ? from : 0 };
  }

  const field = chip.closest(`[${COMMENT_FIELD_ATTR}]`);
  if (field instanceof HTMLElement) {
    const commentId = commentSourceForField(field)?.getCommentId() ?? null;
    return {
      kind: 'view',
      commentId,
      offset: chipSourceOffset(chip),
      ordinal: chipOrdinal(chip, field),
    };
  }

  const card = chip.closest(`[${TABLE_ROW_KEY_ATTR}]`);
  if (card instanceof HTMLElement) {
    return {
      kind: 'view',
      commentId: card.getAttribute(TABLE_ROW_KEY_ATTR),
      offset: chipSourceOffset(chip),
      ordinal: chipOrdinal(chip, card),
    };
  }

  return { kind: 'view', commentId: null, offset: chipSourceOffset(chip), ordinal: null };
}

// ---------------------------------------------------------------------------
// Локальный сдвиг (режим правки)
// ---------------------------------------------------------------------------

/** Найти в строке ссылку, на которую указывает виджет, — по позиции начала узла. */
function clickedSpan(lineText: string, localFrom: number): DateLinkSpan | null {
  const spans = findDateLinkSpans(lineText);
  return (
    spans.find((span) => span.start === localFrom) ??
    spans.find((span) => span.start <= localFrom && localFrom < span.end) ??
    null
  );
}

/**
 * Правка date-ссылок в ЛОКАЛЬНОМ документе редактора. Строка задачи — все
 * ссылки строки, иначе — только кликнутая. Возвращает `false`, если ссылка не
 * найдена (документ успел измениться).
 */
function applyLocalShift(
  ctx: EditorChip,
  mode: 'all' | 'single',
  shift: DateShift,
  setTo?: string,
): boolean {
  const { view, linkFrom } = ctx;
  const line = view.state.doc.lineAt(linkFrom);
  const localFrom = linkFrom - line.from;
  const spans = findDateLinkSpans(line.text);
  const clicked = clickedSpan(line.text, localFrom);
  if (clicked === null) return false;

  const targets = mode === 'all' ? spans : [clicked];
  const changes = targets.map((span) => {
    const target =
      setTo !== undefined && span === clicked
        ? span.parts.time === null
          ? setTo
          : `${setTo} ${span.parts.time}`
        : shiftSpanTarget(span, shift);
    return { from: line.from + span.targetStart, to: line.from + span.targetEnd, insert: target };
  });
  // С конца: позиции ещё не обработанных ссылок не смещаются.
  changes.sort((a, b) => b.from - a.from);
  view.dispatch({ changes });
  return true;
}

// ---------------------------------------------------------------------------
// Серверный сдвиг (режим просмотра)
// ---------------------------------------------------------------------------

/** Разрешённый источник и адрес ссылки в просмотре. */
interface ResolvedView {
  comment: Comment;
  location: DateSpanLocation;
}

/** Дочитать комментарий и найти в нём кликнутую date-ссылку. */
async function resolveViewChip(ctx: ViewChip): Promise<ResolvedView | null> {
  if (ctx.commentId === null) return null;
  let comment: Comment;
  try {
    comment = await etn.comments.get(requireNetworkId(), ctx.commentId);
  } catch (err) {
    notice(t('wikiLink.dateMenu.failed', errText(err)), 'error');
    return null;
  }
  const location =
    ctx.offset !== null
      ? dateSpanByOffset(comment.body_md, ctx.offset)
      : ctx.ordinal !== null
        ? dateSpanByOrdinal(comment.body_md, ctx.ordinal)
        : null;
  if (location === null) {
    notice(t('wikiLink.dateMenu.noSource'), 'error');
    return null;
  }
  return { comment, location };
}

/** Ошибка записи: конфликт ревизии — честная подсказка «обновите». */
function reportWriteError(err: unknown): void {
  if (err instanceof EtnError && err.code === 'VERSION_CONFLICT') {
    notice(t('wikiLink.dateMenu.stale'), 'error');
    return;
  }
  notice(t('wikiLink.dateMenu.failed', errText(err)), 'error');
}

/** Человеческий текст отказа операции строки задачи. */
function taskErrorText(code: string | undefined): string {
  switch (code) {
    case 'undated':
      return t('wikiLink.dateMenu.undated');
    case 'not_a_task':
      return t('wikiLink.dateMenu.notTask');
    case 'line_not_found':
      return t('wikiLink.dateMenu.noSource');
    default:
      return t('wikiLink.dateMenu.failed', code ?? '');
  }
}

/** Строка чипа в разрешённом просмотре — задача (единый сдвиг строки)? */
function resolvedIsTask(resolved: ResolvedView): boolean {
  return taskLineAt(resolved.comment.body_md, resolved.location.lineNo) !== null;
}

/** Применить сдвиг/установку даты в ПРОСМОТРЕ (задача → PATCH /tasks). */
async function applyViewShift(
  resolved: ResolvedView,
  mode: 'all' | 'single',
  shift: DateShift,
  setTo?: string,
): Promise<void> {
  const { comment, location } = resolved;
  const networkId = requireNetworkId();
  const task = mode === 'all' ? taskLineAt(comment.body_md, location.lineNo) : null;

  try {
    if (task !== null) {
      // Строка задачи — единый сдвиг всех ссылок серверным механизмом.
      const shiftBody =
        setTo !== undefined ? { days: dayDelta(location.span.parts.date, setTo) } : shift;
      const result = await etn.tasks.patch(networkId, {
        ops: [
          {
            comment_id: comment.id,
            line_no: location.lineNo,
            action: 'move',
            ...shiftBody,
            expected_revision: comment.version,
          },
        ],
      });
      const first = result.results[0];
      if (first !== undefined && !first.ok) {
        notice(taskErrorText(first.error), 'error');
      }
      return;
    }

    // Не задача — правим ссылку в body_md источника. Одиночный перенос
    // (режим `single`) меняет только кликнутую ссылку, «Изменить дату» —
    // только её; единый сдвиг строки — отдельный режим `all`.
    const nextLine =
      setTo !== undefined
        ? replaceSpanTarget(
            location.lineText,
            location.span,
            location.span.parts.time === null ? setTo : `${setTo} ${location.span.parts.time}`,
          )
        : mode === 'all'
          ? shiftLineDates(location.lineText, shift)
          : replaceSpanTarget(
              location.lineText,
              location.span,
              shiftSpanTarget(location.span, shift),
            );
    if (nextLine === null) {
      notice(t('wikiLink.dateMenu.undated'), 'error');
      return;
    }
    await etn.comments.update(
      networkId,
      comment.id,
      { body_md: replaceBodyLine(comment.body_md, location.lineNo, nextLine) },
      comment.version,
    );
  } catch (err) {
    reportWriteError(err);
  }
}

// ---------------------------------------------------------------------------
// Пункты меню
// ---------------------------------------------------------------------------

/** Действие «Перенести на …» для контекста чипа. */
async function moveChip(ctx: ChipContext, shift: DateShift): Promise<void> {
  if (ctx.kind === 'editor') {
    const line = ctx.view.state.doc.lineAt(ctx.linkFrom);
    const isTask = taskLineAt(ctx.view.state.doc.toString(), line.number - 1) !== null;
    if (!applyLocalShift(ctx, isTask ? 'all' : 'single', shift)) {
      notice(t('wikiLink.dateMenu.noSource'), 'error');
    }
    return;
  }
  const resolved = await resolveViewChip(ctx);
  if (resolved === null) return;
  await applyViewShift(resolved, resolvedIsTask(resolved) ? 'all' : 'single', shift);
}

/** «Изменить дату…»: диалог одной даты, затем единый сдвиг/замена. */
async function changeChipDate(ctx: ChipContext, date: string): Promise<void> {
  const picked = await openDatePeriodDialog({
    allowPeriod: false,
    allowTime: false,
    initial: {
      mode: 'date',
      from: date,
      to: date,
      hasTime: false,
      fromTime: '00:00',
      toTime: '00:00',
    },
    title: t('wikiLink.dateMenu.changeDate'),
  });
  if (picked === null) return;
  const target = picked.from;
  if (!isValidLocalDay(target) || target === date) return;
  const delta = dayDelta(date, target);
  if (delta === 0) return;

  if (ctx.kind === 'editor') {
    const line = ctx.view.state.doc.lineAt(ctx.linkFrom);
    const isTask = taskLineAt(ctx.view.state.doc.toString(), line.number - 1) !== null;
    // Задача — единый сдвиг (период сохраняется); иначе меняем только чип.
    if (!applyLocalShift(ctx, isTask ? 'all' : 'single', { days: delta }, target)) {
      notice(t('wikiLink.dateMenu.noSource'), 'error');
    }
    return;
  }
  const resolved = await resolveViewChip(ctx);
  if (resolved === null) return;
  await applyViewShift(
    resolved,
    resolvedIsTask(resolved) ? 'all' : 'single',
    { days: delta },
    target,
  );
}

/** Открыть меню у чипа. */
function showDateChipMenu(chip: HTMLElement, date: string, x: number, y: number): void {
  const ctx = chipContext(chip);
  const items = [
    menuAction(t('wikiLink.dateMenu.openDay'), () => void openChronicleDay(date)),
    MENU_SEPARATOR,
    menuAction(t('wikiLink.dateMenu.changeDate'), () => void changeChipDate(ctx, date)),
    menuAction(t('wikiLink.dateMenu.moveTomorrow'), () => void moveChip(ctx, { days: 1 })),
    menuAction(t('wikiLink.dateMenu.moveWeek'), () => void moveChip(ctx, { days: 7 })),
    menuAction(t('wikiLink.dateMenu.moveMonth'), () => void moveChip(ctx, { months: 1 })),
  ];
  showMenuAt(x, y, items);
}

let wired = false;

/**
 * Подключить контекстное меню date-чипов (один раз из `main.ts`). Перехват в
 * capture-фазе документа: меню чипа должно открыться ВМЕСТО меню поля
 * редактирования/карточки, а не поверх него.
 */
export function initDateChipMenu(): void {
  if (wired) return;
  wired = true;
  document.addEventListener(
    'contextmenu',
    (event) => {
      const target = event.target as Element | null;
      const chip = target?.closest?.(`.${WIKI_LINK_DATE_CLASS}`);
      if (!(chip instanceof HTMLElement)) return;
      const date = chip.getAttribute(WIKI_LINK_DATE_ATTR);
      if (date === null || date === '') return;
      event.preventDefault();
      event.stopPropagation();
      showDateChipMenu(chip, date, event.clientX, event.clientY);
    },
    true,
  );
}
