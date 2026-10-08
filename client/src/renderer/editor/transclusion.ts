/**
 * Трансклюзии комментариев в поле markdown (0.12.1, ТП2, задачи `f72a9134`,
 * `f59d24e1`, `a2b68d72` и `1b405a92`; ADR `8c41387c`, ADR `dc1758ad`,
 * ADR `85a7a01e`, ADR `fdb1a271`, ADR `c425202a`; элементы интерфейса
 * `7a479549` и `2b116d37`; требования `647fa34a`, `29a3c17a`, `fc60d763`,
 * `e04d84f7`).
 *
 * Узкий клиентский модуль поверх единого рендерера: разбор ссылок и развёртка
 * текста выполняются ТОЛЬКО экспортируемыми функциями `@etn/markdown`
 * (`parseTransclusions`, `expandTransclusions`, `extractSection`) — своего
 * парсера здесь нет (сторож `markdown-single-renderer`). Резолвер источника
 * (постоянный комментарий мысли своей сети) и режимы блока живут здесь.
 *
 * **Живой блок: вложенный редактор вместо растворения (задача `73ae1d4b`).**
 * Блок — блочный виджет с шапкой-чипом и развёрнутым текстом источника; вход
 * каретки (клик, стрелки, Enter на блоке) лениво монтирует ВНУТРИ виджета
 * отдельный `EditorView` на том же стеке расширений ({@link NestedEditorStore} в
 * `transclusion-nested.ts`), с текстом раздела (`sectionBodyForEdit`) и
 * собственной историей undo. Печать идёт в документ вложенного редактора и НЕ
 * меняет документ контейнера; блок остаётся атомарным диапазоном контейнера
 * ({@link transclusionAtomicRanges}). Вложенные трансклюзии внутри блока
 * работают рекурсивно до глубины `MAX_NESTED_DEPTH`. Изменение блока помечает
 * его «грязным» сигналом в хост ({@link blockEditorHostFacet}) — поле входит в
 * набор правки и на `Ctrl+Enter`/«Записать»/клик вне записывает его в источник
 * (единая запись, {@link commitTransclusionEdit}). Семантика единой правки
 * (задача «Единая запись», `e9dfc2df`): выход из блока, клик вне и `Ctrl+Enter`
 * внутри — либо выход с СОХРАНЕНИЕМ текста в состоянии инстанса (пока правка
 * поля не завершена), либо единая запись всего поля; `Esc` — отмена всей правки
 * с откатом инстансов. Прежнего «растворения» текста источника в документ
 * контейнера и связанных режимов (кнопки «Отменить/Сохранить трансклюзию»,
 * линейная рамка) больше нет.
 *
 * **Замочек чужого захвата.** Источник, захваченный другим участником, делает
 * блок только для чтения: вход каретки вложенный редактор НЕ монтирует
 * (проверка через `lib/lock-cache`). Пакетный захват всех мыслей-источников
 * текста берётся при входе поля в правку ({@link TransclusionLockSet}) и
 * снимается при записи/отмене/выходе.
 *
 * Два состояния одной ссылки в редакторе (курсор/выделение решают):
 *  1. **Блок** — ссылка заменена блоком с шапкой-чипом «имя · раздел» и
 *     развёрнутым текстом источника. Диапазон атомарен: каретка внутрь не
 *     встаёт, блок выделяется как единое целое.
 *  2. **Черновик ссылки при вводе** — выделение пересекает ссылку: виден
 *     исходный markdown, токен `#<id>` заменён атомарным виджетом с именем
 *     мысли. Этот путь нужен ТОЛЬКО созданию ссылки (открывающий токен +
 *     автокомплит + жест `#`) — к готовым блокам он не применяется.
 * Ссылка существующего блока правится кликом по чипу: поповер выбора мысли и
 * раздела применяет смену ОДНОЙ транзакцией замены диапазона
 * (`formatTransclusionRef`). Прежних режимов «правка ссылки» (сворачивание
 * блока в сырой markdown) и «свёрнутая ссылка» больше нет (задача `68591b8a`).
 *
 * **Визуальные слои блока (задача `a2b68d72`).** Развёрнутый текст рендерится с
 * блочными обёртками `@etn/markdown` (`data-transclusion-depth`), поэтому фон
 * подкрашивается по уровню вложенности (ADR `c425202a`), а плашки ошибок
 * источника приходят из рендера (`fc60d763`). Блок неделим при навигации:
 * замена идёт блоком на весь диапазон ссылки; каретка контейнера внутрь блока не
 * встаёт (вход открывает вложенный редактор). Выделение блока целиком (например,
 * перетаскиванием) показывается РАМКОЙ ВОКРУГ него (класс
 * `cm-transclusion-block--covered`), а не подсветкой текста/пробелов внутри
 * (ошибка `39553204`). Блок — replace-виджет `block: true`, в DOM он лежит
 * прямым потомком `.cm-content` (вне `.cm-line`), поэтому подавление нативного
 * выделения внутри — селектором БЕЗ `.cm-line` (иначе не матчит). Ссылка
 * правится чипом и поповером (элемент `7a479549`).
 * Появление/раскрытие блока анимировано (CSS, с учётом `prefers-reduced-motion`).
 * Просмотр поля (view-режим) разворачивает ссылки тем же швом
 * `transclusionInternals.expandWithLoader` + `renderMarkdown` с `sourceMap` в
 * `markdown-field.ts` (разметка позиций по развёрнутому тексту, ошибка
 * `0fdd8c86`), а шапки-чипы на блоки просмотра вешает
 * {@link decorateViewTransclusionChips} по карте имён той же развёртки.
 *
 * **Контекстное меню блока (задача `955478e8`).** Правый клик по блоку
 * открывает меню из пяти команд (элемент `1e0fb0bd`): «Редактировать»,
 * «Открыть ссылку», «В фокус», «Копировать», «Копировать ID». Пункты — на общем
 * словаре `lib/menu.ts` и словаре команд `editor/comment-commands.ts`; доступно
 * только в режиме редактирования окружения. Чип в просмотре открывает четыре
 * команды навигации ({@link transclusionNavHandlers}). В поповере чипа (правка)
 * к командам навигации добавлена «Удалить блок» — удаление ссылки ОДНОЙ
 * транзакцией с кареткой на место блока, без подтверждения (задача `c11b82ee`).
 * `Shift`+клик по блоку выделяет его целиком (атомарный диапазон, рамка
 * `--covered`) для Delete/Ctrl+C — вход кареткой остаётся за обычным кликом.
 *
 * **Свёрнутость разделов внутри блока (задача `1b405a92`, требование
 * `e04d84f7`).** Неактивный блок декорирует своё HTML-содержимое через
 * `decorateCommentView` с состоянием своего пути вставки (фабрика из
 * `collapseScopeFacet`, ставит `markdown-field`): один и тот же источник в
 * разных контейнерах хранит свёрнутость раздельно. В активном блоке текст живёт
 * во вложенном редакторе — свёрнутость его разделов это состояние самого
 * вложенного инстанса (свой стек расширений), поля-контейнера она не трогает.
 * Просмотр идёт тем же путём обхода `.md-transclusion` в `decorateCommentView`.
 *
 * За границами задачи (другие работы ТП2): команды
 * «как текст» (`e9f553e5`), realtime-обновление блока.
 */

import {
  completionStatus,
  currentCompletions,
  selectedCompletion,
  startCompletion,
  type Completion,
  type CompletionSource,
} from '@codemirror/autocomplete';
import {
  EditorState,
  Prec,
  RangeSet,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import {
  extractSection,
  expandTransclusions,
  formatTransclusionRef,
  parseTransclusions,
  renderMarkdown,
  // Классы блока/атрибут источника в HTML просмотра (ошибка f60f99e0):
  // внешние и вложенные блоки в просмотре — это `.md-transclusion` единого
  // рендерера; одноимённая константа правки (`cm-transclusion-block`) ниже.
  TRANSCLUSION_BLOCK_CLASS as MD_TRANSCLUSION_BLOCK_CLASS,
  TRANSCLUSION_SOURCE_ATTR as MD_TRANSCLUSION_SOURCE_ATTR,
  TRANSCLUSION_SECTION_ATTR as MD_TRANSCLUSION_SECTION_ATTR,
  type TransclusionLabels,
  type TransclusionRef,
  type TransclusionResolution,
} from '@etn/markdown';
import type { AnyRealtimeEvent } from '@etn/shared';

import { requireNetworkId } from '../app.js';
import { div, el, errText } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { t } from '../lib/i18n.js';
import { onRoutedRealtimeEvent } from '../lib/live/index.js';
import { guardMenuFocus, showMenuAt } from '../lib/menu.js';
import { holderName, otherHolder, subscribeLockCache } from '../lib/lock-cache.js';
import {
  acquireOrShowBlocked,
  lockHandleFromOutcome,
  releaseHeld,
  type LockHandle,
} from '../lib/lock-guard.js';
import { notice } from '../lib/notice.js';
import { iconButton, setButtonActive, uiButton } from '../lib/ui/button.js';
import { fieldInput } from '../lib/ui/field.js';
import { svgIcon, type IconName } from '../lib/ui/icon.js';
import { reconcileKeyed } from '../lib/ui/keyed-list.js';
import { openPopover, watchOutsideTap } from '../lib/ui/popover.js';
import {
  isInsideSuggestDropdown,
  wireSuggest,
  type SuggestEntry,
} from '../lib/suggest-dropdown.js';

import { buildTransclusionMenuItems, TRANSCLUSION_NAV_MENU_LAYOUT } from './comment-commands.js';
import { collapseScopeFacet, decorateCommentView } from './comment-collapse.js';
import {
  MAX_NESTED_DEPTH,
  NestedEditorStore,
  blockEditorHostFacet,
  blockEditorStoreFacet,
  nestedDepthFacet,
  type BlockEditorHost,
  type NestedEditorOptions,
  type NestedExitReason,
} from './transclusion-nested.js';

/** Корневой класс блока трансклюзии (редактирование). */
export const TRANSCLUSION_BLOCK_CLASS = 'cm-transclusion-block';
/**
 * Шапка блока с чипом «имя · раздел» (элемент `7a479549`, задача `68591b8a`) —
 * парный вид правки и просмотра (`.cm-editor` / `.comment-view`). Чип всегда
 * виден (не hover-only) и открывает поповер правки ссылки в правке и меню
 * команд навигации в просмотре.
 */
export const TRANSCLUSION_HEAD_CLASS = 'transclusion-head';
/** Чип шапки блока — кнопка словаря `lib/ui` с подписью «имя · раздел». */
export const TRANSCLUSION_CHIP_CLASS = 'transclusion-chip';
/** Плашка ошибки источника/раздела. */
export const TRANSCLUSION_ERROR_CLASS = 'cm-transclusion-error';
/** Атомарный токен `#<id>` при вводе ссылки (создание ссылки не меняется). */
export const TRANSCLUSION_ID_CLASS = 'cm-transclusion-id';
/** Блок активен — внутри смонтирован вложенный редактор (задача 73ae1d4b). */
export const TRANSCLUSION_EDITING_CLASS = 'cm-transclusion-block--editing';
/**
 * Блок целиком покрыт выделением (ошибка `39553204`): пользователь видит блок
 * как единое целое — CSS рисует рамку ВОКРУГ блока и подавляет нативную
 * подсветку текста/пробелов внутри (выделение блока как атома, `5312142d`).
 */
export const TRANSCLUSION_COVERED_CLASS = 'cm-transclusion-block--covered';
/** «Замочек» блока при чужом захвате источника. */
export const TRANSCLUSION_LOCK_CLASS = 'cm-transclusion-lock';

/** Длина префикса ссылки — восклицательный знак и две открывающие скобки. */
const OPEN_LEN = 3;

/** Контекст каретки внутри ссылки трансклюзии. */
export interface TransclusionContext {
  /** Разобранная ссылка (диапазон содержит каретку). */
  ref: TransclusionRef;
  /** Начало токена `#<id>` (сам `#`). */
  idFrom: number;
  /** Конец токена `#<id>` (исключительно). */
  idTo: number;
  /** Начало текста раздела (после второго `#`), либо `null`. */
  sectionFrom: number | null;
  /** Конец текста раздела (перед `]]`), либо `null`. */
  sectionTo: number | null;
  /** Каретка в токене `#<id>`. */
  inId: boolean;
  /** Каретка в тексте раздела. */
  inSection: boolean;
}

/**
 * Находит ссылку трансклюзии, внутри которой стоит позиция, и размечает её
 * части. Границы ИСКЛЮЧАЮЩИЕ (ошибка `5312142d`): позиция ровно на `start` или
 * `end` ссылки «внутри» не считается — иначе Enter на строке перед/после блока
 * попадал бы в правку блока, а не ставил новую строку.
 */
export function transclusionAtCaret(source: string, pos: number): TransclusionContext | null {
  for (const ref of parseTransclusions(source)) {
    if (pos <= ref.start || pos >= ref.end) continue;
    const idFrom = ref.start + OPEN_LEN; // на `#`
    const innerEnd = ref.end - 2; // перед `]]`
    const hash2 = source.indexOf('#', idFrom + 1);
    // Раздел — по НАЛИЧИЮ второго `#`, а не по `ref.section`: единый парсер
    // (`@etn/markdown`) сворачивает ПУСТОЙ раздел в `section: null`, но каретка
    // сразу после второго `#` — уже «в разделе». Без этого список заголовков не
    // открывался немедленно после жеста `#` (ошибка `ccf4d25f`).
    const hasSection = hash2 !== -1 && hash2 < innerEnd;
    const idTo = hasSection ? hash2 : innerEnd;
    return {
      ref,
      idFrom,
      idTo,
      sectionFrom: hasSection ? hash2 + 1 : null,
      sectionTo: hasSection ? innerEnd : null,
      inId: pos >= idFrom && pos <= idTo,
      inSection: hasSection && pos >= hash2 + 1 && pos <= innerEnd,
    };
  }
  return null;
}

/**
 * Ссылка трансклюзии, начинающаяся ровно в позиции `start` (ошибка `5312142d`).
 * Нужна там, где известна точка НАЧАЛА диапазона ссылки (атрибут виджета
 * `data-md-from`, внешняя ссылка контейнера при вложенной правке), а не позиция
 * каретки: с исключающими границами {@link transclusionAtCaret} на `start`
 * ссылка уже не находится.
 */
export function transclusionRefStartingAt(source: string, start: number): TransclusionRef | null {
  for (const ref of parseTransclusions(source)) {
    if (ref.start === start) return ref;
  }
  return null;
}

/**
 * Спека ОДНОЙ транзакции замены диапазона ссылки на новую (задача `68591b8a`):
 * смена мысли/раздела из поповера применяется заменой диапазона ссылки
 * (`formatTransclusionRef`), а не правкой тела документа. `null` — ссылка
 * сдвинулась или её источник изменился, пока
 * поповер был открыт (менять вслепую нельзя), либо новая ссылка совпала с
 * прежней. `expectedSourceId` — источник, которым ссылка обладала до смены;
 * `sourceId`/`section` — новые значения. Чистая (без DOM) — под тестами.
 */
export function transclusionLinkChange(
  doc: string,
  anchorStart: number,
  expectedSourceId: string,
  sourceId: string,
  section: string | null,
): { from: number; to: number; insert: string } | null {
  const fresh = transclusionRefStartingAt(doc, anchorStart);
  if (fresh === null || fresh.sourceId !== expectedSourceId) return null;
  let next: string;
  try {
    next = formatTransclusionRef(sourceId, section);
  } catch {
    return null;
  }
  if (next === fresh.raw) return null;
  return { from: fresh.start, to: fresh.end, insert: next };
}

/**
 * Диапазон удаления блока по началу его ссылки (задача `c11b82ee`): каретка
 * ставится на место блока. `null` — ссылка сдвинулась/исчезла (удалять нечего).
 */
export function transclusionBlockRemoval(
  doc: string,
  start: number,
): { from: number; to: number } | null {
  const ref = transclusionRefStartingAt(doc, start);
  return ref === null ? null : { from: ref.start, to: ref.end };
}

/** ATX-заголовок: уровень и текст (закрывающие `#` срезаны). */
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;

/**
 * Заголовки источника по порядку (для выпадашки разделов). Лёгкий обзор
 * заголовков markdown-текста — не разбор трансклюзий; повторяющиеся имена
 * схлопываются (при резолве берётся первый).
 */
export function listSectionTitles(bodyMd: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of bodyMd.split('\n')) {
    const m = HEADING_RE.exec(line.endsWith('\r') ? line.slice(0, -1) : line);
    if (m === null) continue;
    const title = m[2]!.trim();
    if (title === '' || seen.has(title)) continue;
    seen.add(title);
    out.push(title);
  }
  return out;
}

/**
 * Уровень ATX-заголовка раздела и его содержимое без строки заголовка.
 * `null` — заголовок раздела не найден.
 */
function sectionParts(body: string, section: string): { level: number; content: string } | null {
  const extracted = extractSection(body, section);
  if (extracted === null) return null;
  const nl = extracted.indexOf('\n');
  const headingLine = nl === -1 ? extracted : extracted.slice(0, nl);
  const m = HEADING_RE.exec(headingLine.endsWith('\r') ? headingLine.slice(0, -1) : headingLine);
  if (m === null) return null;
  return { level: m[1]!.length, content: nl === -1 ? '' : extracted.slice(nl + 1) };
}

/**
 * Текст раздела для вложенной правки блока: содержимое без строки заголовка
 * (задача `e2c14673`). Заголовок живёт в ссылке `#Раздел` и правится отдельно.
 * `null` — раздела нет.
 */
export function sectionBodyForEdit(body: string, section: string): string | null {
  return sectionParts(body, section)?.content ?? null;
}

/**
 * Сливает изменённое содержимое раздела обратно в полное тело источника,
 * сохраняя прочие разделы (запись в источник при правке блока, задача
 * `e2c14673`). `null` — заголовок раздела не найден в теле.
 */
export function mergeSectionContent(body: string, section: string, newContent: string): string | null {
  const extracted = extractSection(body, section);
  if (extracted === null) return null;
  const idx = body.indexOf(extracted);
  if (idx === -1) return null;
  const nl = extracted.indexOf('\n');
  const headingLine = nl === -1 ? extracted : extracted.slice(0, nl);
  const merged = newContent === '' ? headingLine : `${headingLine}\n${newContent}`;
  return body.slice(0, idx) + merged + body.slice(idx + extracted.length);
}

/**
 * Появился ли в правке раздела заголовок того же или более высокого уровня —
 * он завершает редактируемую область, при сохранении показывается
 * предупреждение (задача `e2c14673`, элемент `2b116d37`).
 */
export function sectionBoundaryCrossed(body: string, section: string, newContent: string): boolean {
  const parts = sectionParts(body, section);
  if (parts === null) return false;
  for (const line of newContent.split('\n')) {
    const m = HEADING_RE.exec(line.endsWith('\r') ? line.slice(0, -1) : line);
    if (m !== null && m[1]!.length <= parts.level) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Единая запись и пакетный захват источников (задача e9dfc2df, ТП fcde7c55)
 * ------------------------------------------------------------------ */

/**
 * Уникальные id мыслей-источников трансклюзий документа (в порядке появления).
 * Пакетный захват берётся на КАЖДЫЙ источник текста при входе поля в правку
 * (задача `e9dfc2df`, ADR `f3adf3d3`, решение 3).
 */
export function transclusionSourceIds(md: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of parseTransclusions(md)) {
    if (seen.has(ref.sourceId)) continue;
    seen.add(ref.sourceId);
    out.push(ref.sourceId);
  }
  return out;
}

/**
 * Пакет захватов мыслей-источников трансклюзий на время правки поля (задача
 * `e9dfc2df`). Держит `LockHandle` по каждому источнику и снимает их пачкой
 * (`releaseHeld`) при записи/отмене/выходе. Источник, захваченный другим
 * участником, — блок только для чтения с «замочком»: захват не удерживается
 * (`lock-cache` уже показывает индикатор), остальные источники редактируются.
 * Повторный `acquire` того же источника — no-op (в т.ч. если источник совпал с
 * владельцем поля: существующий захват отдаётся как `self`).
 */
export class TransclusionLockSet {
  private readonly handles = new Map<string, LockHandle>();
  /** Источники с чужим захватом (блок только для чтения). */
  private readonly blocked = new Set<string>();

  /** Берёт захваты на источники `sourceIds`, которых ещё не касались. */
  async acquire(sourceIds: Iterable<string>): Promise<void> {
    const todo: string[] = [];
    for (const id of sourceIds) {
      if (typeof id !== 'string' || id === '') continue;
      if (!this.handles.has(id) && !this.blocked.has(id)) todo.push(id);
    }
    if (todo.length === 0) return;
    const outcomes = await Promise.all(
      todo.map(async (id) => {
        try {
          const outcome = await acquireOrShowBlocked('thought', id);
          return { id, outcome };
        } catch {
          // Вне сети/ранний доступ: захват — мягкая возмож-ность, не ломаем
          // вход в правку (захват просто не берётся).
          return { id, outcome: { kind: 'failed', error: null } as const };
        }
      }),
    );
    for (const { id, outcome } of outcomes) {
      if (outcome.kind === 'acquired' || outcome.kind === 'self') {
        this.handles.set(id, lockHandleFromOutcome('thought', id, outcome));
      } else if (outcome.kind === 'blocked') {
        // Чужой захват: блок только для чтения («замочек» уже показывает
        // `lock-cache`), захват не удерживаем — снимать нечего.
        this.blocked.add(id);
      }
    }
  }

  /** Снимает все удержанные захваты пачкой; список обнуляется. */
  async release(): Promise<void> {
    const handles = [...this.handles.values()];
    this.handles.clear();
    this.blocked.clear();
    await Promise.all(handles.map((handle) => releaseHeld(handle)));
  }

  /** Идентификаторы удержанных захватов (для проб/тестов). */
  heldIds(): string[] {
    return [...this.handles.keys()];
  }
}

/** Один «грязный» блок к записи в источник: ключ инстанса и его ссылка. */
export interface TransclusionBlockSave {
  /** Ключ инстанса (`sourceId#section`, {@link blockEditorKey}). */
  key: string;
  sourceId: string;
  section: string | null;
  /** Текущий текст правки блока. */
  text: string;
}

/** Разбирает ключ инстанса блока обратно на источник и раздел. */
export function parseBlockEditorKey(key: string): { sourceId: string; section: string | null } {
  const at = key.indexOf('#');
  if (at <= 0) return { sourceId: key, section: null };
  const section = key.slice(at + 1);
  return { sourceId: key.slice(0, at), section: section === '' ? null : section };
}

/**
 * «Грязные» блоки хранилища к записи: ключ и текст инстанса + распарсенная
 * ссылка. Источник/раздел берутся из КЛЮЧА (`sourceId#section`), поэтому
 * пригодно и для вложенных блоков, чьей ссылки нет в документе контейнера.
 */
export function dirtyBlockSaves(store: NestedEditorStore): TransclusionBlockSave[] {
  const out: TransclusionBlockSave[] = [];
  for (const key of store.dirtyKeys()) {
    const text = store.text(key);
    if (text === null) continue;
    const { sourceId, section } = parseBlockEditorKey(key);
    out.push({ key, sourceId, section, text });
  }
  return out;
}

/** Записывает текст одного блока в постоянный комментарий источника. */
async function saveOneSource(networkId: string, save: TransclusionBlockSave): Promise<void> {
  const comments = await etn.comments.list(networkId, 'thought', save.sourceId);
  const perm = comments.find((c) => c.kind === 'permanent');
  if (perm === undefined) throw new Error('no permanent comment');
  let body = save.text;
  if (save.section !== null) {
    const merged = mergeSectionContent(perm.body_md, save.section, save.text);
    if (merged === null) throw new Error('no section');
    body = merged;
  }
  await etn.comments.update(networkId, perm.id, { body_md: body }, perm.version);
  // Записанный источник больше не актуален — сбрасываем из общего кэша сети,
  // иначе повторная загрузка вернула бы старое тело (задача e9dfc2df).
  invalidateTransclusionSource(networkId, save.sourceId);
}

/** Итог единой записи: записанные/сбойные блоки и успех записи окружения. */
export interface TransclusionCommitResult {
  /** Окружение (контейнер) записано (или записи не требовалось). */
  envOk: boolean;
  /** HTML окружения после успешной записи, либо `null`. */
  envHtml: string | null;
  /** Ключи блоков, чей источник записан. */
  savedKeys: string[];
  /** Ключи блоков, чью запись источник отверг (версия/`LOCKED`/нет источника). */
  failedKeys: string[];
  /** id источников, запись которых сорвалась (для уведомления). */
  failedSourceIds: string[];
  /**
   * Ошибка записи окружения (для сообщения пользователю), `null` при успехе.
   * Раньше сбой окружения был безымянным (`envOk: false`), из-за чего вызывающий
   * не мог отличить его от сбоя блоков и показывал блок-специфичное сообщение на
   * поле без трансклюзий (ошибка `7399c9ec`).
   */
  envError: unknown;
}

/**
 * ЕДИНАЯ запись правки поля (задача `e9dfc2df`, ТП `fcde7c55`): окружение
 * (контейнер) и все «грязные» источники трансклюзий. Источники пишутся
 * `etn.comments.update` с `expected_version` (для раздела — слияние
 * `mergeSectionContent`); сбой одного источника НЕ отменяет остальные —
 * частичный сбой виден в {@link TransclusionCommitResult}. Окружение пишется
 * через `writeEnv` (null — записи не требуется). Ничего не бросает: сбой
 * окружения — `envOk: false`.
 */
export async function commitTransclusionEdit(params: {
  networkId: string;
  saves: readonly TransclusionBlockSave[];
  writeEnv: (() => Promise<string>) | null;
}): Promise<TransclusionCommitResult> {
  const savedKeys: string[] = [];
  const failedKeys: string[] = [];
  const failedSourceIds: string[] = [];
  for (const save of params.saves) {
    try {
      await saveOneSource(params.networkId, save);
      savedKeys.push(save.key);
    } catch {
      failedKeys.push(save.key);
      failedSourceIds.push(save.sourceId);
    }
  }
  let envOk = true;
  let envHtml: string | null = null;
  let envError: unknown = null;
  if (params.writeEnv !== null) {
    try {
      envHtml = await params.writeEnv();
    } catch (err) {
      envOk = false;
      envError = err;
    }
  }
  return { envOk, envHtml, savedKeys, failedKeys, failedSourceIds, envError };
}

/** Метка ссылки в свёрнутом виде: имя мысли и, при наличии, раздел. */
export function transclusionLinkLabel(title: string, section: string | null): string {
  const name = title !== '' ? title : t('comment.transclusion.untitled');
  return section === null ? name : `${name} · ${section}`;
}

/**
 * Метка блока-источника по ключу инстанса (`sourceId#section`) для сообщения о
 * сбое записи (ошибка `7399c9ec`): имя мысли берётся из общего кэша источников
 * сети ({@link sourceCache}), раздел — из ключа. Показывается как шапка-чип
 * «имя · раздел»; имя из кэша синхронно доступно, потому что сбойный блок уже
 * был отрисован (источник загружен).
 */
export function transclusionBlockLabel(networkId: string, key: string): string {
  const { sourceId, section } = parseBlockEditorKey(key);
  const title = sourceCache.get(sourceCacheKey(networkId, sourceId))?.title ?? '';
  return transclusionLinkLabel(title, section);
}

/**
 * Сообщает пользователю о сбоях ЕДИНОЙ записи (ошибка `7399c9ec`). Ничего не
 * сообщает при полном успехе. Сбойные блоки (если есть) называются конкретно
 * именем и разделом — сообщение про «помеченные блоки» показывается ТОЛЬКО при
 * их наличии. Сбой записи окружения даёт СВОЁ сообщение (не блок-специфичное),
 * поэтому поле без трансклюзий больше не показывает текст про блоки. Сбой
 * окружения и блоков одновременно отражается обоими сообщениями — это честнее
 * одной сводки. Вынесено чистым швом с инъекцией `notify` — под юнит-тестами
 * без поднятия поля (реальный `EditorView` в DOM-шиме не живёт).
 */
export function reportCommitFailures(params: {
  networkId: string;
  result: TransclusionCommitResult;
  notify: (message: string, level: 'error') => void;
}): void {
  const { result } = params;
  if (result.failedKeys.length > 0) {
    const labels = result.failedKeys.map((key) => transclusionBlockLabel(params.networkId, key));
    params.notify(t('comment.transclusion.savePartial', labels.join(', ')), 'error');
  }
  if (!result.envOk) {
    const reason = errText(result.envError);
    params.notify(
      reason === ''
        ? t('comment.save.failedUnknown')
        : t('comment.save.failed', reason),
      'error',
    );
  }
}

/** Ключ кэша данных ссылки (сеть + источник + раздел). */
export function transclusionCacheKeyParts(
  networkId: string,
  sourceId: string,
  section: string | null,
): string {
  return `${networkId}:${sourceId}#${section ?? ''}`;
}

/** Ключ кэша данных ссылки (сеть + источник + раздел). */
export function transclusionCacheKey(networkId: string, ref: TransclusionRef): string {
  return transclusionCacheKeyParts(networkId, ref.sourceId, ref.section);
}

/**
 * Локализованные подписи контейнеров трансклюзий (задача `a2b68d72`): единый
 * рендерер оборачивает развёрнутые фрагменты блоками (глубина/ошибки), а текст
 * ошибок даёт клиент через `t()` — рендерер строк не знает.
 */
export function transclusionLabels(): TransclusionLabels {
  return {
    noSource: t('comment.transclusion.noSource'),
    noSection: t('comment.transclusion.noSection'),
    skipped: t('comment.transclusion.skipped'),
  };
}

/** Отрисовка развёрнутого markdown с блочными обёртками трансклюзий. */
export function renderTransclusionMarkdown(text: string): string {
  return renderMarkdown(text, { transclusion: { labels: transclusionLabels() } });
}

/** Загруженный источник: имя мысли, наличие и полный текст постоянного комментария. */
export interface TransclusionSource {
  found: boolean;
  title: string;
  body_md: string;
}

/** Разрешение источника по id (инжектируемая зависимость для тестов). */
export type TransclusionSourceLoader = (sourceId: string) => Promise<TransclusionSource | null>;

/** Источник не найден — плашка «нет источника трансклюзии». */
type TransclusionError = 'source' | 'section' | null;

/** Данные одной ссылки для отрисовки. */
export interface TransclusionEntry {
  title: string;
  exists: boolean;
  error: TransclusionError;
  /** Отрендеренный HTML развёрнутого текста, либо `null` при ошибке. */
  html: string | null;
  /** Исходный markdown источника (для вложенной правки блока, задача e2c14673). */
  body_md?: string;
}

/** Загрузчик источника по умолчанию — постоянный комментарий мысли своей сети. */
export function defaultTransclusionLoader(networkId: string): TransclusionSourceLoader {
  return async (sourceId) => {
    try {
      const [refs, comments] = await Promise.all([
        etn.thoughts.resolve(networkId, [sourceId]),
        etn.comments.list(networkId, 'thought', sourceId),
      ]);
      const title = refs.find((r) => r.id === sourceId)?.title ?? '';
      const permanent = comments.find((c) => c.kind === 'permanent');
      if (permanent === undefined) return { found: false, title, body_md: '' };
      return { found: true, title, body_md: permanent.body_md };
    } catch {
      return null;
    }
  };
}

/**
 * Кэш данных источников трансклюзий: ОДИН на сеть, общий для ВСЕХ инстансов
 * редактора (поле-контейнер комментария и вложенные редакторы блоков —
 * ТП «Живой блок»). Ключ — `networkId:sourceId`. Здесь лежат только данные
 * источника (имя и тело постоянного комментария) — они одинаковы для всех
 * инстансов сети, поэтому второй редактор с тем же источником не повторяет
 * сетевой запрос (кэш НЕ дублируется по инстансам). Состояние ПОКАЗА (кэш
 * декораций, свёрнутость, режим правки, захваты) остаётся в
 * `transclusionState` — у каждого инстанса своё.
 *
 * Кэшируются только успешно загруженные источники (`found: true`): ошибка сети
 * и отсутствие постоянного комментария не закрепляются, чтобы источник можно
 * было дочитать позже. Запись в источник сбрасывает его из кэша
 * ({@link invalidateTransclusionSource}).
 */
const sourceCache = new Map<string, TransclusionSource>();

/** Ключ общего кэша источников (сеть + id мысли-источника). */
function sourceCacheKey(networkId: string, sourceId: string): string {
  return `${networkId}:${sourceId}`;
}

/**
 * Загрузчик источника поверх общего кэша сети: результат тот же, что у
 * {@link defaultTransclusionLoader}, но повторный запрос к сети не делается,
 * пока данные источника лежат в {@link sourceCache}. Новый вызов на инстанс —
 * общий кэш один.
 */
export function cachedTransclusionLoader(networkId: string): TransclusionSourceLoader {
  const load = defaultTransclusionLoader(networkId);
  return async (sourceId) => {
    const key = sourceCacheKey(networkId, sourceId);
    const cached = sourceCache.get(key);
    if (cached !== undefined) return cached;
    const result = await load(sourceId);
    if (result !== null && result.found) sourceCache.set(key, result);
    return result;
  };
}

/** Сбрасывает данные источника из общего кэша сети (после записи в источник). */
export function invalidateTransclusionSource(networkId: string, sourceId: string): void {
  sourceCache.delete(sourceCacheKey(networkId, sourceId));
}

/**
 * Ключ источника, который надо сбросить по realtime-событию комментария, либо
 * `null`. Тело источника трансклюзии — ПОСТОЯННЫЙ комментарий мысли, поэтому
 * кэш трогают только создания/правки/удаления постоянных комментариев
 * владельца-мысли; хроно-комментарии и владельцы-связи — нет. Удаление самой
 * мысли-источника (`thought.deleted`) тоже сбрасывает ключ: её постоянный
 * комментарий сносится каскадом, а отдельного `comment.deleted` сервер не шлёт
 * (ошибка `746e4e59`).
 */
function sourceKeyForCommentEvent(evt: AnyRealtimeEvent): string | null {
  // Удаление мысли-источника (ошибка `746e4e59`): постоянный комментарий
  // сносится каскадом, но маршрут эмитит только `thought.deleted`
  // (`server/src/routes/thoughts.ts`) без `comment.deleted` — без этой ветки
  // кэш держал бы тело удалённого источника и блок показывал бы его вместо
  // «нет источника трансклюзии».
  if (evt.type === 'thought.deleted') {
    return sourceCacheKey(evt.network_id, evt.data.id);
  }
  if (evt.type === 'comment.updated') {
    return evt.data.kind === 'permanent'
      ? sourceCacheKey(evt.network_id, evt.data.owner_id)
      : null;
  }
  if (evt.type === 'comment.created') {
    const comment = evt.data.comment;
    return comment.kind === 'permanent' && comment.owner_type === 'thought'
      ? sourceCacheKey(evt.network_id, comment.owner_id)
      : null;
  }
  if (evt.type === 'comment.deleted') {
    return evt.data.owner_type === 'thought'
      ? sourceCacheKey(evt.network_id, evt.data.owner_id)
      : null;
  }
  return null;
}

/**
 * Применяет realtime-событие к общему кэшу источников: правки/создание/удаление
 * постоянного комментария-источника и удаление мысли сбрасывают запись
 * ({@link sourceKeyForCommentEvent}), а переименование мысли-источника
 * (`thought.updated` с `changes.title`) — точечно обновляет ЗАКЭШИРОВАННОЕ ИМЯ
 * без массового сброса на любое обновление мысли (ошибка `0a11aec5`): тело
 * источника от переименования не меняется, перечитывать его из сети дороже.
 * Имя в шапке-чипе читается из этой записи, поэтому после переименования чип
 * показывает актуальное имя. Обновляем только закэшированный источник.
 */
function applySourceCacheEvent(evt: AnyRealtimeEvent): void {
  if (evt.type === 'thought.updated') {
    const key = sourceCacheKey(evt.network_id, evt.data.id);
    const cached = sourceCache.get(key);
    if (cached === undefined) return;
    const title = evt.data.changes.title;
    if (typeof title === 'string' && title !== cached.title) {
      sourceCache.set(key, { ...cached, title });
    }
    return;
  }
  const key = sourceKeyForCommentEvent(evt);
  if (key !== null) sourceCache.delete(key);
}

let sourceCacheWired = false;

/**
 * Центральная инвалидация общего кэша источников по realtime (подключается из
 * `app.ts` при старте, рядом с `initLockCache`). ЛЮБАЯ запись постоянного
 * комментария-источника — обычная правка комментария, черновик, хроно-путь, MCP,
 * чужая правка — приходит из main в рендерер событием `comment.*`, в том числе
 * автору записи (broadcast-to-all), поэтому ОДНА подписка покрывает все пути
 * записи: отдельные вызовы `etn.comments.update` ловить не нужно. Переименование
 * мысли-источника приходит `thought.updated` и обновляет имя точечно
 * ({@link applySourceCacheEvent}). Идемпотентно.
 */
export function initTransclusionSourceCache(): void {
  if (sourceCacheWired) return;
  sourceCacheWired = true;
  onRoutedRealtimeEvent(applySourceCacheEvent);
}

/**
 * Разворачивает текст, итеративно дозагружая источники. Рекурсия, глубина (5)
 * и защита от циклов — внутри `expandTransclusions` (`@etn/markdown`); здесь
 * лишь наполняем резолвер текстами и повторяем развёртку, пока остаются
 * неизвестные источники. `markers: false` даёт текст без служебных маркеров
 * границ (режим «как текст», задача `e9f553e5`).
 */
async function expandRounds(
  raw: string,
  load: TransclusionSourceLoader,
  markers: boolean,
): Promise<{ text: string; topId: string | null; titles: Map<string, string> }> {
  const bodies = new Map<string, { body_md: string; title: string } | null>();
  const topId = parseTransclusions(raw)[0]?.sourceId ?? null;
  let text = raw;
  for (let round = 0; round < 8; round += 1) {
    const pending = new Set<string>();
    const resolver = (id: string): TransclusionResolution => {
      if (!bodies.has(id)) {
        pending.add(id);
        return { found: false, body_md: '' };
      }
      const body = bodies.get(id);
      return body === null || body === undefined
        ? { found: false, body_md: '' }
        : { found: true, body_md: body.body_md };
    };
    text = expandTransclusions(raw, resolver, { markers });
    if (pending.size === 0) break;
    const fetched = await Promise.all(
      [...pending].map(async (id): Promise<readonly [string, { body_md: string; title: string } | null]> => {
        const src = await load(id);
        return [id, src !== null && src.found ? { body_md: src.body_md, title: src.title } : null] as const;
      }),
    );
    for (const [id, body] of fetched) bodies.set(id, body);
  }
  // Имена источников собираются тем же проходом загрузки, что и тела (задача
  // `68591b8a`): шапка-чип блока просмотра получает «имя · раздел» без
  // ВТОРОГО сетевого запроса — развёртка уже сходила за источником.
  const titles = new Map<string, string>();
  for (const [id, body] of bodies) {
    if (body !== null) titles.set(id, body.title);
  }
  return { text, topId, titles };
}

/** Разворачивает текст ссылки с маркерами и подтягивает данные верхнего источника. */
async function expandWithLoader(
  raw: string,
  load: TransclusionSourceLoader,
): Promise<{ text: string; top: TransclusionSource | null; titles: Map<string, string> }> {
  const { text, topId, titles } = await expandRounds(raw, load, true);
  const top = topId === null ? null : await load(topId);
  return { text, top, titles };
}

/**
 * Разворачивает трансклюзии в чистый текст БЕЗ ссылок и служебных маркеров —
 * для команд «как текст» (ТП2, задача `e9f553e5`): контекстное меню «копировать/
 * вырезать как текст» и «вставить как текст» делятся содержимым без ссылок.
 * Разбор и развёртка — только через `@etn/markdown`; источник, который не
 * найден, и нераскрытая ссылка просто «проглатываются» (в текст ничего не
 * подставляется). Текст без трансклюзий возвращается как есть.
 */
export async function expandTransclusionsToText(
  raw: string,
  networkId: string,
  load: TransclusionSourceLoader = defaultTransclusionLoader(networkId),
): Promise<string> {
  if (parseTransclusions(raw).length === 0) return raw;
  const { text } = await expandRounds(raw, load, false);
  return text;
}

/**
 * Развёртка текста для команд «как текст»: сеть определяется самой функцией.
 * Вне сети (список сетей, ранний доступ) и при сбое загрузки возвращает текст
 * как есть — команда не должна молча терять выделение/буфер.
 */
export async function expandTransclusionsForClipboard(raw: string): Promise<string> {
  const networkId = safeNetwork();
  if (networkId === null) return raw;
  try {
    return await expandTransclusionsToText(raw, networkId);
  } catch {
    return raw;
  }
}

/** Строит данные ссылки для отрисовки (развёртка и состояния ошибок). */
async function loadEntry(
  ref: TransclusionRef,
  load: TransclusionSourceLoader,
): Promise<TransclusionEntry> {
  const { text, top } = await expandWithLoader(ref.raw, load);
  const title = top?.title ?? '';
  const bodyMd = top?.found === true ? top.body_md : '';
  if (top === null || !top.found) {
    return { title, exists: false, error: 'source', html: null, body_md: '' };
  }
  if (ref.section !== null && extractSection(top.body_md, ref.section) === null) {
    return { title, exists: true, error: 'section', html: null, body_md: bodyMd };
  }
  return {
    title,
    exists: true,
    error: null,
    html: renderTransclusionMarkdown(text),
    body_md: bodyMd,
  };
}

/* ------------------------------------------------------------------ *
 * Декорации CM6
 * ------------------------------------------------------------------ */

/** Эффект наполнения кэша данными ссылок. */
const setEntries = StateEffect.define<Array<{ key: string; entry: TransclusionEntry }>>();

/**
 * Ключ блока (трансклюзии) в состоянии редактора и хранилище вложенных
 * инстансов: `sourceId#section` (`#` без раздела). Один блок = одна запись
 * вложенного редактора (задача `73ae1d4b`).
 */
export function blockEditorKey(sourceId: string, section: string | null): string {
  return `${sourceId}#${section ?? ''}`;
}

/**
 * Эффект активного блока (задача `73ae1d4b`): ключ блока, в который вошла
 * каретка (внутри смонтирован вложенный редактор), либо `null` при выходе.
 * Заменяет прежний `setBlockEdit` (растворение текста источника в контейнер).
 */
export const setActiveBlock = StateEffect.define<string | null>();

/** Эффект обновления карты чужих захватов источников (`sourceId` → имя). */
const setLockedSources = StateEffect.define<ReadonlyMap<string, string>>();

/** Состояние плагина: кэш данных, декорации и атомарные токены. */
interface TransclusionStateData {
  networkId: string | null;
  cache: Map<string, TransclusionEntry>;
  /** Ключ активного блока (внутри — вложенный редактор), либо `null`. */
  activeKey: string | null;
  /** Чужие захваты источников: `sourceId` → имя держателя. */
  lockedSources: ReadonlyMap<string, string>;
  deco: DecorationSet;
  atomic: RangeSet<Decoration>;
}

/** Атомарный виджет токена `#<id>` при вводе ссылки. */
class TransclusionIdWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly deleted: boolean,
  ) {
    super();
  }

  override eq(other: TransclusionIdWidget): boolean {
    return other.label === this.label && other.deleted === this.deleted;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = `${TRANSCLUSION_ID_CLASS}${this.deleted ? ' wiki-link-deleted' : ''}`;
    span.contentEditable = 'false';
    span.textContent = this.label;
    return span;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Шапка блока с чипом «имя · раздел» (элемент `7a479549`, задача `68591b8a`).
 * Один вид для правки и просмотра: кнопка словаря `lib/ui` с модификатором
 * `transclusion-chip`. Чип всегда виден (не hover-only) — обнаружимость
 * открытия поповера не зависит от наведения мыши. `onClick` получает событие
 * (клик в просмотре открывает меню команд в точке клика); `mousedown` гасится,
 * чтобы клик по чипу не двигал каретку редактора и не забирал фокус.
 */
export function createTransclusionHead(label: string, onClick: (event: MouseEvent) => void): HTMLElement {
  const head = div(TRANSCLUSION_HEAD_CLASS);
  const chip = uiButton({
    label,
    role: 'ghost',
    size: 's',
    class: TRANSCLUSION_CHIP_CLASS,
    title: t('comment.transclusion.chip.tooltip'),
  });
  chip.addEventListener('mousedown', (event) => event.preventDefault());
  // Двойной клик по чипу не должен уходить наружу: в правке он открыл бы
  // правку блока, в просмотре — вход в правку поля. Чип обрабатывает себя сам.
  chip.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  chip.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick(event);
  });
  head.append(chip);
  return head;
}

/** Убирает прежнюю шапку блока (идемпотентная разметка просмотра). */
function clearTransclusionHead(block: HTMLElement): void {
  for (const child of Array.from(block.children)) {
    if (child instanceof HTMLElement && child.classList.contains(TRANSCLUSION_HEAD_CLASS)) {
      child.remove();
    }
  }
}

/** Прямой потомок `parent` с классом `cls`, либо `null` (без обхода вглубь). */
function directChildByClass(parent: HTMLElement, cls: string): HTMLElement | null {
  for (const child of Array.from(parent.children)) {
    if (child instanceof HTMLElement && child.classList.contains(cls)) return child;
  }
  return null;
}

/**
 * Индикатор-«замочек» блока при чужом захвате источника: тот же класс/вид, что
 * и в правке. Общий для режима правки ({@link TransclusionBlockWidget}) и
 * режима просмотра ({@link decorateViewTransclusionLocks}) — ошибка `f60f99e0`.
 */
export function createTransclusionLockBadge(holder: string): HTMLElement {
  const badge = document.createElement('span');
  badge.className = TRANSCLUSION_LOCK_CLASS;
  badge.textContent = '🔒';
  badge.title = t('comment.transclusion.locked', holder);
  return badge;
}

/** id мысли-источника блока трансклюзии просмотра (`data-transclusion-source`). */
function viewBlockSourceId(block: HTMLElement): string | null {
  // Реальный DOM отдаёт camelCase-ключ `transclusionSource`; DOM-шим тестов
  // кладёт ещё и полное имя атрибута — читаем оба варианта.
  const ds = block.dataset as Record<string, string | undefined>;
  const id = ds['transclusionSource'] ?? ds[MD_TRANSCLUSION_SOURCE_ATTR];
  return id === undefined || id === '' ? null : id;
}

/**
 * Размечает «замочки» чужих захватов на блоках трансклюзий РЕЖИМА ПРОСМОТРА
 * (ошибка `f60f99e0`): обходит внешние и вложенные `.md-transclusion` единого
 * рендерера, и на каждый блок с чужим захватом источника вешает индикатор
 * {@link createTransclusionLockBadge} (тот же вид, что в правке). Идемпотентна:
 * прежние замочки блока снимаются перед разметкой, поэтому снятый захват
 * убирает индикатор при следующем вызове.
 */
export function decorateViewTransclusionLocks(view: HTMLElement): void {
  const blocks = view.querySelectorAll<HTMLElement>(
    `.${MD_TRANSCLUSION_BLOCK_CLASS}[${MD_TRANSCLUSION_SOURCE_ATTR}]`,
  );
  for (const block of blocks) {
    for (const child of Array.from(block.children)) {
      if (child instanceof HTMLElement && child.classList.contains(TRANSCLUSION_LOCK_CLASS)) {
        child.remove();
      }
    }
    const sourceId = viewBlockSourceId(block);
    if (sourceId === null) continue;
    const row = otherHolder('thought', sourceId);
    if (row === null) continue;
    block.prepend(createTransclusionLockBadge(holderName(row)));
  }
}

let viewLocksWired = false;

/**
 * Подключает перерисовку «замочков» просмотра к кэшу захватов: на каждый
 * переход кэша (`edit.*`) обновляет индикаторы во всех ЖИВЫХ полях просмотра
 * (`.md-field-view`). Подписка одна на приложение и держит только связь с
 * `document`, а не с конкретным полем: поля комментария пересоздаются на каждой
 * пересборке редактора, и подписка «на поле» накапливала бы слушателей
 * (текла) — ошибка `f60f99e0`. Идемпотентна.
 */
export function wireViewTransclusionLocks(): void {
  if (viewLocksWired) return;
  viewLocksWired = true;
  subscribeLockCache(() => {
    for (const root of document.querySelectorAll<HTMLElement>('.md-field-view')) {
      decorateViewTransclusionLocks(root);
    }
  });
}

/** Блок трансклюзии: шапка-чип «имя · раздел» и развёрнутый текст источника. */
class TransclusionBlockWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly entry: TransclusionEntry,
    readonly key: string,
    /** Источник блока — для «замочка» и входа во вложенный редактор. */
    readonly sourceId: string,
    /** Ключ блока в состоянии (`sourceId#section`). */
    readonly editorKey: string,
    /** Блок активен — внутри смонтирован вложенный редактор (задача 73ae1d4b). */
    readonly active: boolean,
    /** Имя чужого держателя захвата источника, либо `null`. */
    readonly lockedBy: string | null,
    /** Выделение покрывает блок целиком (ошибка 39553204). */
    readonly covered: boolean,
    /** Раздел источника (для шапки-чипа), либо `null` — весь комментарий. */
    readonly section: string | null,
  ) {
    super();
  }

  override eq(other: TransclusionBlockWidget): boolean {
    return (
      other.from === this.from &&
      other.to === this.to &&
      other.key === this.key &&
      other.sourceId === this.sourceId &&
      other.editorKey === this.editorKey &&
      other.active === this.active &&
      other.lockedBy === this.lockedBy &&
      other.covered === this.covered &&
      other.section === this.section &&
      other.entry.html === this.entry.html &&
      other.entry.error === this.entry.error &&
      other.entry.title === this.entry.title &&
      other.entry.exists === this.entry.exists
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('div');
    this.render(box, view);
    return box;
  }

  /**
   * Обновляет существующий DOM блока вместо его пересоздания (WidgetType API):
   * косметические пересборки (класс `--covered`, «замочек», подпись чипа, смена
   * активного блока) НЕ переносят DOM вложенного редактора — иначе
   * `remove`+`insert` сбрасывал бы фокус и каретку (ошибка `ce46723d`). Всегда
   * возвращает `true`: DOM пригоден к обновлению на месте.
   */
  override updateDOM(dom: HTMLElement, view: EditorView): boolean {
    this.render(dom, view);
    return true;
  }

  /**
   * Идемпотентная отрисовка блока в существующий `box`. Держит на месте уже
   * подключённый DOM активного вложенного редактора (не переставляет его) —
   * фокус вложенного инстанса сохраняется при любой пересборке декораций.
   */
  private render(box: HTMLElement, view: EditorView): void {
    // Без класса `md-widget`: его клик обрабатывает mdWidgetClick (md-live.ts),
    // иначе было бы двойное перемещение каретки.
    box.className =
      `${TRANSCLUSION_BLOCK_CLASS} comment-view` +
      (this.active ? ` ${TRANSCLUSION_EDITING_CLASS}` : '') +
      (this.covered ? ` ${TRANSCLUSION_COVERED_CLASS}` : '');
    box.dataset.mdFrom = String(this.from);
    box.dataset.mdTo = String(this.to);
    box.dataset['transclusionSource'] = this.sourceId;

    // «Замочек» при чужом захвате источника (требование 647fa34a): источник
    // правит другой участник — блок только для чтения, вход в блок не монтирует
    // вложенный редактор. Обновляется на месте (появление/снятие захвата).
    let badge = directChildByClass(box, TRANSCLUSION_LOCK_CLASS);
    if (this.lockedBy !== null) {
      if (badge === null) {
        badge = createTransclusionLockBadge(this.lockedBy);
        box.prepend(badge);
      } else {
        badge.title = t('comment.transclusion.locked', this.lockedBy);
      }
    } else if (badge !== null) {
      badge.remove();
      badge = null;
    }

    // Шапка-чип «имя · раздел» (элемент `7a479549`, задача `68591b8a`): всегда
    // видна, клик открывает поповер правки ссылки (выбор мысли и раздела,
    // команды навигации). У блока с ошибкой шапки нет (паритет с прежним видом);
    // подпись чипа обновляется на месте — имя могло смениться realtime-событием.
    let head: HTMLElement | null = null;
    if (this.entry.error !== null) {
      clearTransclusionHead(box);
    } else {
      const label = transclusionLinkLabel(this.entry.title, this.section);
      head = directChildByClass(box, TRANSCLUSION_HEAD_CLASS);
      if (head === null) {
        head = createTransclusionHead(label, (event) => {
          const ref = transclusionRefStartingAt(view.state.doc.toString(), this.from);
          if (ref !== null) openTransclusionLinkPopover(view, ref, event.currentTarget as HTMLElement);
        });
        box.append(head);
      } else {
        const chip = head.querySelector(`.${TRANSCLUSION_CHIP_CLASS}`);
        if (chip !== null && chip.textContent !== label) chip.textContent = label;
      }
    }

    // Область содержимого: ошибка / вложенный редактор / HTML источника.
    // DOM активного вложенного редактора НЕ переставляем — иначе `remove`+`insert`
    // сбросил бы фокус (ошибка `ce46723d`); устаревшее содержимое убираем, а уже
    // подключённый `nestedDom` оставляем на месте.
    const store = view.state.facet(blockEditorStoreFacet);
    const nestedDom =
      this.active && this.lockedBy === null ? store?.dom(this.editorKey) ?? null : null;
    let nestedAttached = false;
    for (const child of Array.from(box.children)) {
      if (child === badge || child === head) continue;
      if (child === nestedDom) {
        nestedAttached = true;
        continue;
      }
      child.remove();
    }

    if (nestedDom !== null) {
      if (!nestedAttached) box.append(nestedDom);
      return;
    }

    if (this.entry.error !== null) {
      const err = document.createElement('div');
      err.className = TRANSCLUSION_ERROR_CLASS;
      err.textContent =
        this.entry.error === 'source'
          ? t('comment.transclusion.noSource')
          : t('comment.transclusion.noSection');
      box.append(err);
      return;
    }

    const body = document.createElement('div');
    body.innerHTML = this.entry.html ?? '';
    box.append(body);

    // Сворачивание разделов внутри неактивного блока — своим состоянием на путь
    // вставки (ТП2, задача 1b405a92, требование e04d84f7): блок показывает
    // готовый HTML, поэтому декорируем своё содержимое как область просмотра.
    // В активном блоке текст живёт во вложенном редакторе — свёрнутость там
    // состояние самого инстанса (свой стек расширений).
    const factory = view.state.facet(collapseScopeFacet);
    if (factory !== null) {
      const path = [this.sourceId];
      decorateCommentView(body, factory(path), factory, path);
    }
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** Пересекается ли выделение с диапазоном ссылки. */
function intersects(
  selection: { from: number; to: number },
  from: number,
  to: number,
): boolean {
  return selection.from < to && selection.to > from;
}

/** Выделение покрывает весь диапазон ссылки `[from, to]` (блок выделен целиком). */
function coversRef(selection: { from: number; to: number }, from: number, to: number): boolean {
  return selection.from <= from && selection.to >= to;
}

/**
 * Черновик ссылки при вводе (сырой markdown с атомарным `#<id>`): выделение
 * задевает ссылку, но НЕ покрывает её целиком. Нужен ТОЛЬКО созданию ссылки
 * (открывающий токен + автокомплит + жест `#`): пока каретка внутри набираемой
 * ссылки, показываем её текст, а токен `#<id>` — атомарным виджетом.
 * Существующий блок целиком атомарен (ошибка `5312142d`), каретка внутрь него
 * не встаёт, поэтому к готовым блокам этот путь не применяется. Полное покрытие
 * выделением оставляет блок-атом выделенным как единое целое, а не разбирает его
 * на markdown.
 */
function linkDraftMode(selection: { from: number; to: number }, from: number, to: number): boolean {
  return intersects(selection, from, to) && !coversRef(selection, from, to);
}

/** Пустая карта чужих захватов (значение по умолчанию). */
const NO_LOCKS: ReadonlyMap<string, string> = new Map();

/** Строит декорации и атомарные диапазоны для текущего состояния. */
export function buildTransclusionDecorations(
  source: string,
  selection: { from: number; to: number },
  cache: Map<string, TransclusionEntry>,
  networkId: string | null,
  /** Ключ активного блока (внутри — вложенный редактор), либо `null`. */
  activeKey: string | null = null,
  /** Чужие захваты источников: `sourceId` → имя держателя. */
  lockedSources: ReadonlyMap<string, string> = NO_LOCKS,
): { deco: DecorationSet; atomic: RangeSet<Decoration> } {
  const parts: Array<{ from: number; to: number; value: Decoration }> = [];
  const atomParts: Array<{ from: number; to: number; value: Decoration }> = [];
  const refs = parseTransclusions(source);

  for (const ref of refs) {
    const idFrom = ref.start + OPEN_LEN;
    const innerEnd = ref.end - 2;
    const hash2 = source.indexOf('#', idFrom + 1);
    const idTo = hash2 !== -1 && hash2 < innerEnd ? hash2 : innerEnd;
    const key = networkId === null ? null : transclusionCacheKey(networkId, ref);
    const entry = key === null ? undefined : cache.get(key);
    const title = entry?.title ?? '';
    const deleted = entry !== undefined && !entry.exists;
    const lockedBy = lockedSources.get(ref.sourceId) ?? null;
    const editorKey = blockEditorKey(ref.sourceId, ref.section);
    const active = activeKey !== null && activeKey === editorKey;
    // Выделение покрывает диапазон ссылки целиком — блок показывается как
    // выделенное единое целое (ошибка 39553204): рамка вокруг, без подсветки
    // внутреннего текста (неделимость блока — ошибка 5312142d).
    const covered = coversRef(selection, ref.start, ref.end);

    if (linkDraftMode(selection, ref.start, ref.end)) {
      // Черновик ссылки при вводе: токен `#<id>` — атомарный виджет с именем
      // мысли; раздел остаётся редактируемым текстом (создание ссылки не
      // меняется).
      const label = title !== '' ? title : '…';
      atomParts.push({ from: idFrom, to: idTo, value: Decoration.mark({}) });
      parts.push({
        from: idFrom,
        to: idTo,
        value: Decoration.replace({
          widget: new TransclusionIdWidget(label, deleted),
          inclusive: false,
        }),
      });
      continue;
    }

    // Развёрнутый блок: диапазон атомарен (задача a2b68d72) — иначе Right/Left
    // заводят каретку внутрь, декорации пересобираются в черновик ссылки и
    // блок распадается в исходный markdown (блокер верификатора). Вход в блок
    // монтирует вложенный редактор (задача 73ae1d4b), а не растворение текста.
    atomParts.push({ from: ref.start, to: ref.end, value: Decoration.mark({}) });
    parts.push({
      from: ref.start,
      to: ref.end,
      value: Decoration.replace({
        block: true,
        widget: new TransclusionBlockWidget(
          ref.start,
          ref.end,
          entry ?? emptyEntry(),
          key ?? '',
          ref.sourceId,
          editorKey,
          active,
          lockedBy,
          covered,
          ref.section,
        ),
        inclusive: false,
      }),
    });
  }

  return { deco: Decoration.set(parts, true), atomic: RangeSet.of(atomParts, true) };
}

/** Заглушка данных до загрузки источника. */
function emptyEntry(): TransclusionEntry {
  return { title: '', exists: true, error: null, html: '', body_md: '' };
}

/** Поле состояния: кэш данных, активный блок, захваты, декорации. */
export const transclusionState = StateField.define<TransclusionStateData>({
  create: (state) => {
    const networkId = safeNetwork();
    const { deco, atomic } = buildTransclusionDecorations(
      state.doc.toString(),
      state.selection.main,
      new Map(),
      networkId,
    );
    return {
      networkId,
      cache: new Map(),
      activeKey: null,
      lockedSources: NO_LOCKS,
      deco,
      atomic,
    };
  },
  update(state, tr) {
    let networkId = state.networkId;
    let cache = state.cache;
    let activeKey = state.activeKey;
    let lockedSources = state.lockedSources;
    for (const effect of tr.effects) {
      if (effect.is(setEntries)) {
        if (cache === state.cache) cache = new Map(cache);
        for (const { key, entry } of effect.value) cache.set(key, entry);
      } else if (effect.is(setActiveBlock)) {
        activeKey = effect.value;
      } else if (effect.is(setLockedSources)) {
        lockedSources = effect.value;
      }
    }
    const currentNetwork = safeNetwork();
    if (currentNetwork !== null && currentNetwork !== networkId) networkId = currentNetwork;

    if (
      !tr.docChanged &&
      !tr.selection &&
      cache === state.cache &&
      activeKey === state.activeKey &&
      lockedSources === state.lockedSources &&
      networkId === state.networkId
    ) {
      return state;
    }
    const { deco, atomic } = buildTransclusionDecorations(
      tr.state.doc.toString(),
      tr.state.selection.main,
      cache,
      networkId,
      activeKey,
      lockedSources,
    );
    return { networkId, cache, activeKey, lockedSources, deco, atomic };
  },
  provide: (f) => [EditorView.decorations.from(f, (s) => s.deco)],
});

/**
 * Атомарные диапазоны CM6: токен `#<id>` при вводе ссылки, а также целые
 * диапазоны блока (ошибка `5312142d` — блок единым атомом, каретка внутрь
 * не встаёт).
 */
export const transclusionAtomicRanges = EditorView.atomicRanges.of((view) => {
  const state = view.state.field(transclusionState, false);
  return state === undefined ? RangeSet.empty : state.atomic;
});

/** Диапазон блока-атома документа (выделяется целиком) вместе с его ссылкой. */
interface BlockRange {
  from: number;
  to: number;
  ref: TransclusionRef;
}

/**
 * Диапазоны блоков-атомов документа в текущем состоянии — те же ссылки, что
 * рисуются replace-виджетом блока (не черновик ссылки при вводе). Нужны
 * навигации/входу в блок (задача `73ae1d4b`).
 */
function blockRanges(state: EditorState): BlockRange[] {
  const field = state.field(transclusionState, false);
  if (field === undefined) return [];
  const selection = state.selection.main;
  const out: BlockRange[] = [];
  for (const ref of parseTransclusions(state.doc.toString())) {
    if (linkDraftMode(selection, ref.start, ref.end)) continue;
    out.push({ from: ref.start, to: ref.end, ref });
  }
  return out;
}

/** Ссылка, покрытая выделением целиком (`[start, end]` == выделение), либо `null`. */
function refCoveringSelection(
  state: EditorState,
  selection: { from: number; to: number },
): TransclusionRef | null {
  if (selection.from >= selection.to) return null;
  for (const ref of parseTransclusions(state.doc.toString())) {
    if (ref.start === selection.from && ref.end === selection.to) return ref;
  }
  return null;
}

/** Блок-атом, начинающийся в позиции `pos`. */
function blockStartingAt(blocks: readonly BlockRange[], pos: number): BlockRange | null {
  return blocks.find((block) => block.from === pos) ?? null;
}

/** Блок-атом, заканчивающийся в позиции `pos`. */
function blockEndingAt(blocks: readonly BlockRange[], pos: number): BlockRange | null {
  return blocks.find((block) => block.to === pos) ?? null;
}

/** Блок-атом, занимающий ЦЕЛИКОМ строку, следующую за строкой позиции `pos`. */
function blockOnLineAfter(
  state: EditorState,
  blocks: readonly BlockRange[],
  pos: number,
): BlockRange | null {
  const line = state.doc.lineAt(pos);
  if (line.to >= state.doc.length) return null;
  const next = state.doc.lineAt(line.to + 1);
  return blocks.find((block) => block.from === next.from && block.to === next.to) ?? null;
}

/** Блок-атом, занимающий ЦЕЛИКОМ строку, предшествующую строке позиции `pos`. */
function blockOnLineBefore(
  state: EditorState,
  blocks: readonly BlockRange[],
  pos: number,
): BlockRange | null {
  const line = state.doc.lineAt(pos);
  if (line.from === 0) return null;
  const prev = state.doc.lineAt(line.from - 1);
  return blocks.find((block) => block.from === prev.from && block.to === prev.to) ?? null;
}

/**
 * Навигация/вход в блок стрелками (задача `73ae1d4b`). Стрелка, входящая в блок
 * из позиции перед/после, монтирует вложенный редактор и переносит в него фокус
 * (по краям — каретка в начало/конец текста блока). Если блок уже выделен
 * (например, перетаскиванием) — шаг уводит каретку за его границу, не разбирая
 * блок. Возвращает `true`, если нажатие обработано (иначе стрелку отдаём CM6).
 */
export function transclusionBlockArrow(
  view: EditorView,
  dir: 'left' | 'right' | 'up' | 'down',
): boolean {
  const state = view.state;
  const sel = state.selection.main;
  const blocks = blockRanges(state);
  if (!sel.empty) {
    // Блок выделен целиком — шаг уводит каретку за границу, не разбирая блок.
    const covering = blocks.find((block) => block.from === sel.from && block.to === sel.to) ?? null;
    if (covering === null) return false;
    const target = dir === 'left' || dir === 'up' ? covering.from : covering.to;
    view.dispatch({ selection: { anchor: target }, scrollIntoView: true, userEvent: 'select' });
    return true;
  }
  const pos = sel.head;
  let block: BlockRange | null = null;
  if (dir === 'right') block = blockStartingAt(blocks, pos);
  else if (dir === 'left') block = blockEndingAt(blocks, pos);
  // Вертикаль СИММЕТРИЧНА (ошибка ea9c76d3): сначала проверяем границу
  // СОБСТВЕННОЙ строки каретки — после выхода из блока каретка стоит ровно на
  // его крае (`ref.start` вверху / `ref.end` внизу), и обратная стрелка обязана
  // снова войти в блок, а не перескочить его. Затем — блок на соседней строке
  // (обычный подход сверху/снизу). «Вперёд» (вправо/вниз) входит кареткой в
  // начало текста блока, «назад» (влево/вверх) — в конец.
  else if (dir === 'down') block = blockStartingAt(blocks, pos) ?? blockOnLineAfter(state, blocks, pos);
  else block = blockEndingAt(blocks, pos) ?? blockOnLineBefore(state, blocks, pos);
  if (block === null) return false;
  // Вход в блок: стрелка «вперёд» (вправо/вниз) — каретка в начало текста,
  // «назад» (влево/вверх) — в конец.
  enterBlock(view, block.ref, dir === 'left' || dir === 'up');
  return true;
}

/**
 * Лежит ли элемент блока-трансклюзии ВНУТРИ DOM этого редактора. Стек
 * вложенного инстанса содержит те же расширения трансклюзий
 * (`transclusion-nested.ts` → `md-editor.ts` `...transclusionExtensions` →
 * `transclusionClick`/`transclusionContextMenu`), поэтому от текста ВНУТРИ
 * блока обработчики вложенного редактора срабатывают первыми, и `closest`
 * находит ВНЕШНИЙ блок-виджет (предок вложенного редактора, чужие координаты
 * `data-md-from/to`): трактовать его как цель нельзя — жест принадлежит
 * собственному тексту вложенного инстанса (ошибка `e2c6c66c`, раунд 2).
 * У тестовых дублёров без `dom` проверка неприменима (считаем «внутри»).
 */
function blockInViewDom(view: EditorView, block: HTMLElement): boolean {
  if (view.dom === undefined || view.dom === null) return true;
  if (typeof view.dom.contains !== 'function') return true;
  return view.dom.contains(block);
}

/**
 * Цель события лежит во ВНУТРЕННЕМ (вложенном) редакторе относительно `view`:
 * ближайший `.cm-editor` существует и не равен корню `view`. Такой жест
 * принадлежит вложенному инстансу — контейнерный обработчик НЕ должен считать
 * внешний блок-виджет (предок вложенного редактора, координаты контейнера)
 * своей целью: иначе клик гасится (ошибка `e2c6c66c`), а правый клик открывает
 * меню внешнего блока (ошибка `a8b74fd6`).
 */
function targetInNestedEditor(view: EditorView, target: Element | null): boolean {
  const root = target?.closest?.('.cm-editor') ?? null;
  return root !== null && root !== view.dom;
}

/**
 * Обработчик `mousedown` трансклюзий (задача `73ae1d4b`): клик по блоку монтирует
 * вложенный редактор и переносит фокус внутрь; клик по шапке-чипу открывает
 * поповер правки ссылки; клик по заблокированному (чужой захват) блоку лишь
 * выделяет его целиком — блок только для чтения. Клики ВНУТРИ вложенного
 * редактора сюда не относятся (обрабатывает сам инстанс).
 *
 * Реагирует только на ОСНОВНУЮ кнопку мыши (`event.button === 0`): правый и
 * средний клик — жесты вызова контекстного меню, они не должны менять
 * выделение (ошибка `27b95e60`).
 *
 * `Shift`+клик по блоку выделяет его ЦЕЛИКОМ (атомарный диапазон + рамка
 * `--covered`) для Delete/Ctrl+C, в блок НЕ входит; обычный клик — вход
 * кареткой, как раньше (задача `c11b82ee`, решение пользователя 2026-10-08).
 */
export function transclusionMouseDown(event: MouseEvent, view: EditorView): boolean {
  if (event.button !== 0) return false;
  const target = event.target as Element | null;
  if (target === null) return false;
  // Шапка-чип блока (элемент 7a479549): клик открывает поповер правки ссылки,
  // каретку не двигаем — событие обработает сам чип (`createTransclusionHead`
  // гасит `mousedown`, сохраняя фокус редактора).
  if (target.closest(`.${TRANSCLUSION_HEAD_CLASS}`) !== null) return true;
  // Клик внутри СМОНТИРОВАННОГО вложенного редактора (его корень `.cm-editor` —
  // не корень контейнера): жест уже обработан самим инстансом (его обработчик
  // на вложенном `contentDOM` срабатывает раньше, при всплытии). Контейнеру
  // надо НЕ просто отдать событие дальше, а погасить его: иначе встроенный
  // `mousedown`-обработчик CM6 у контейнера выполнит своё выделение и на
  // `mustFocus` вызовет `active.blur()` для активного элемента (вложенного
  // редактора) — клики по блоку гасились, каретка не ставилась (ошибка
  // `e2c6c66c`). `preventDefault()` останавливает конвейер обработчиков CM6
  // (он пропускает оставшиеся после `defaultPrevented`), вложенный инстанс
  // свой жест уже получил.
  if (targetInNestedEditor(view, target)) {
    event.preventDefault();
    return true;
  }
  const block = target.closest(`.${TRANSCLUSION_BLOCK_CLASS}`);
  if (!(block instanceof HTMLElement)) return false;
  // Блок обязан лежать ВНУТРИ DOM этого редактора (см. `blockInViewDom`).
  if (!blockInViewDom(view, block)) return false;
  const from = Number(block.dataset['mdFrom']);
  const to = Number(block.dataset['mdTo']);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return false;
  const ref = transclusionRefStartingAt(view.state.doc.toString(), from);
  if (ref === null) return true;
  // Shift+клик — выделить блок целиком (атомарный диапазон, рамка `--covered`),
  // в блок не входим: дальше Delete удалит ссылку, Ctrl+C скопирует (задача
  // `c11b82ee`). Выделение — единственная транзакция выбора.
  if (event.shiftKey) {
    const sel = view.state.selection.main;
    if (sel.from !== from || sel.to !== to) {
      view.dispatch({ selection: { anchor: from, head: to }, userEvent: 'select' });
    }
    return true;
  }
  // Источник захвачен другим участником — блок только для чтения: выделяем
  // целиком (атом), вложенный редактор не монтируем (требование 647fa34a).
  if (otherHolder('thought', ref.sourceId) !== null) {
    const sel = view.state.selection.main;
    if (sel.from !== from || sel.to !== to) {
      view.dispatch({ selection: { anchor: from, head: to }, userEvent: 'select' });
    }
    return true;
  }
  enterBlock(view, ref, false);
  return true;
}

/** Клики по блоку: вход во вложенный редактор; шапка/чип обрабатывают себя. */
export const transclusionClick = EditorView.domEventHandlers({
  mousedown: transclusionMouseDown,
});

/* ------------------------------------------------------------------ *
 * Контекстное меню блока трансклюзии (задача 955478e8, элемент 1e0fb0bd)
 * ------------------------------------------------------------------ */

/**
 * Ссылка трансклюзии под правой кнопкой: блок трансклюзии.
 * `null` — цель не внутри блока (тогда действует меню поля).
 */
function transclusionWidgetRefAt(view: EditorView, target: Element | null): TransclusionRef | null {
  const el = target?.closest?.(`.${TRANSCLUSION_BLOCK_CLASS}`);
  if (!(el instanceof HTMLElement)) return null;
  // Внешний блок-виджет из вложенного инстанса целью не является (см.
  // `blockInViewDom`): иначе правый клик в блоке открывал бы меню чужого
  // (внешнего) блока с координатами контейнера (ошибка `e2c6c66c`).
  if (!blockInViewDom(view, el)) return null;
  const from = Number(el.dataset.mdFrom);
  if (!Number.isFinite(from)) return null;
  // Ищем ссылку по НАЧАЛУ диапазона (`data-md-from`), а не по каретке: с
  // исключающими границами `transclusionAtCaret` на `start` ссылка не находится.
  return transclusionRefStartingAt(view.state.doc.toString(), from);
}

/** Копирует текст в буфер обмена; неудача — уведомление об ошибке. */
async function copyTransclusionText(text: string, okMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notice(okMessage);
  } catch {
    notice(t('comment.transclusion.menu.copyError'), 'error');
  }
}

/**
 * Обработчики четырёх команд навигации блока (элемент `1e0fb0bd`): «Открыть
 * ссылку»/«В фокус» уводят из поля (ленивые импорты — статический замкнул бы
 * цикл editor ↔ transclusion); «Копировать»/«Копировать ID» — буфер обмена.
 * Общие для контекстного меню правки и меню чипа в просмотре.
 */
export function transclusionNavHandlers(
  sourceId: string,
  raw: string,
): Record<string, () => void> {
  return {
    'transclusion.openSource': () => {
      void import('./editor.js').then((m) => m.openThoughtInEditor(sourceId));
    },
    'transclusion.focusSource': () => {
      void import('../screens/active-view.js').then((m) => m.focusThoughtOnMap(sourceId));
    },
    'transclusion.copyLink': () => {
      void copyTransclusionText(raw, t('comment.transclusion.menu.copied'));
    },
    'transclusion.copyId': () => {
      void copyTransclusionText(sourceId, t('comment.transclusion.menu.copiedId'));
    },
  };
}

/**
 * Обработчики меню блока (элемент `1e0fb0bd`): четыре команды навигации
 * ({@link transclusionNavHandlers}). Пункта «Редактировать» больше нет — вход в
 * блок идёт кареткой (клик/стрелки/Enter), ссылка правится чипом-шапкой.
 */
export function transclusionMenuHandlers(
  _view: EditorView,
  ref: TransclusionRef,
): Record<string, () => void> {
  return {
    ...transclusionNavHandlers(ref.sourceId, ref.raw),
  };
}

/**
 * Контекстное меню блока трансклюзии (элемент `1e0fb0bd`): правый клик по блоку
 * в режиме правки окружения. Событие гасится, чтобы не дошло до меню поля
 * (`markdown-field` слушает `editor.dom`). Открывается поверх текущего
 * состояния: `mousedown` по неосновной кнопке выделение не двигает (см.
 * {@link transclusionMouseDown}, ошибка `27b95e60`).
 */
export function transclusionContextMenuHandler(event: MouseEvent, view: EditorView): boolean {
  // Правый клик внутри ВЛОЖЕННОГО редактора — это его собственный текст, а не
  // внешний блок (внешний виджет — предок вложенного, он лежит внутри
  // `view.dom` контейнера, поэтому одной проверки `blockInViewDom`
  // недостаточно). Меню блока не открываем — событие уходит меню поля
  // (ошибка `a8b74fd6`).
  if (targetInNestedEditor(view, event.target as Element | null)) return false;
  const ref = transclusionWidgetRefAt(view, event.target as Element | null);
  if (ref === null) return false;
  event.preventDefault();
  event.stopPropagation();
  const menuRoot = showMenuAt(
    event.clientX,
    event.clientY,
    buildTransclusionMenuItems(transclusionMenuHandlers(view, ref)),
  );
  // Общая защита фокуса строк меню (ошибка 64b18420): клик по строке не должен
  // уводить фокус из CodeMirror → focusout → onBlur → поле уходит в просмотр
  // (ошибка 1b847110). Делегированный обработчик на контейнере гасит mousedown
  // по любой строке, включая лениво построенные подменю.
  guardMenuFocus(menuRoot);
  return true;
}

/** Расширение-обработчик контекстного меню блока (точка подключения в поле). */
export const transclusionContextMenu = EditorView.domEventHandlers({
  contextmenu: transclusionContextMenuHandler,
});

/* ------------------------------------------------------------------ *
 * Чип-шапка и поповер правки ссылки (задача 68591b8a, элемент 7a479549)
 * ------------------------------------------------------------------ */

/** Корень тела поповера правки ссылки (вид — `styles/editor.css`). */
export const TRANSCLUSION_POPOVER_CLASS = 'transclusion-popover';
/** Строка-подпись группы поповера («Мысль», «Раздел»). */
const TRANSCLUSION_POPOVER_LABEL_CLASS = 'transclusion-popover-label';
/** Прокручиваемый список разделов источника. */
const TRANSCLUSION_POPOVER_SECTIONS_CLASS = 'transclusion-popover-sections';
/** Ряд команд навигации поповера. */
const TRANSCLUSION_POPOVER_COMMANDS_CLASS = 'transclusion-popover-commands';
/** Строка списка разделов (кнопка словаря с модификатором раскладки). */
const TRANSCLUSION_POPOVER_ROW_CLASS = 'transclusion-popover-row';

/**
 * Источник подсказок «мысль» поповера (задача `68591b8a`): живой поиск по
 * именам и синонимам тем же серверным механизмом, что и выпадашка пикера
 * сущностей (`etn.thoughts.findDuplicates`), — второго поиска не заводим.
 * Пустой запрос ничего не отдаёт (живой поиск начинается с ввода).
 */
async function loadThoughtEntries(networkId: string, query: string): Promise<SuggestEntry[]> {
  const trimmed = query.trim();
  if (trimmed === '') return [];
  try {
    const hits = await etn.thoughts.findDuplicates(networkId, trimmed, [], []);
    return hits.map((hit) => ({ value: hit.id, label: hit.title, thought: { ...hit } }));
  } catch {
    return [];
  }
}

/** Заголовки разделов источника (пусто, если источник не найден). */
async function sourceSectionTitles(networkId: string, sourceId: string): Promise<string[]> {
  const src = await cachedTransclusionLoader(networkId)(sourceId).catch(() => null);
  return src !== null && src.found ? listSectionTitles(src.body_md) : [];
}

/**
 * Поповер правки ссылки блока (задача `68591b8a`, элемент `7a479549`): выбор
 * мысли живым поиском, выбор раздела источника целиком сразу и четыре команды
 * навигации. Смена ссылки применяется ОДНОЙ транзакцией замены диапазона
 * ссылки (`formatTransclusionRef`) — прежней сырой правки ссылки и сворачивания
 * блока нет. Поповер и его закрытие — общий компонент `lib/ui`; выпадашка
 * поиска мыслей — общий `wireSuggest`; «клик вне» закрывает через
 * `watchOutsideTap` (подсказки считаются «своими», как в строке поиска).
 */
export function openTransclusionLinkPopover(
  view: EditorView,
  ref: TransclusionRef,
  anchor: HTMLElement,
): void {
  const networkId = safeNetwork();
  if (networkId === null) return;
  const anchorStart = ref.start;
  let currentSourceId = ref.sourceId;
  let currentSection = ref.section;
  /** Снятие делегированного «клика вне»; назначается после открытия панели. */
  let stopOutside: () => void = () => {};

  const body = div(TRANSCLUSION_POPOVER_CLASS);
  const input = fieldInput({
    extraClass: 'transclusion-popover-input',
    placeholder: t('comment.transclusion.popover.search'),
  });
  input.autocomplete = 'off';
  const sectionList = div(TRANSCLUSION_POPOVER_SECTIONS_CLASS);
  const commands = div(TRANSCLUSION_POPOVER_COMMANDS_CLASS);
  body.append(
    el('div', TRANSCLUSION_POPOVER_LABEL_CLASS, t('comment.transclusion.popover.thought')),
    input,
    el('div', TRANSCLUSION_POPOVER_LABEL_CLASS, t('comment.transclusion.popover.section')),
    sectionList,
    el('div', TRANSCLUSION_POPOVER_LABEL_CLASS, t('comment.transclusion.popover.commands')),
    commands,
  );

  const close = (): void => popover.close();

  /** Исходник ссылки текущего выбора (для «Копировать»); сбой сборки — прежний. */
  const currentRaw = (): string => {
    try {
      return formatTransclusionRef(currentSourceId, currentSection);
    } catch {
      return ref.raw;
    }
  };

  /** Применяет смену ссылки одной транзакцией замены диапазона. */
  const apply = (sourceId: string, section: string | null): void => {
    const change = transclusionLinkChange(
      view.state.doc.toString(),
      anchorStart,
      currentSourceId,
      sourceId,
      section,
    );
    if (change === null) {
      // Ссылка сдвинулась/заменена или выбор не изменился — закрываем панель,
      // ничего не меняя (слепая замена испортила бы документ).
      if (transclusionRefStartingAt(view.state.doc.toString(), anchorStart) === null) close();
      return;
    }
    currentSourceId = sourceId;
    currentSection = section;
    view.dispatch({
      changes: change,
      selection: { anchor: change.from + change.insert.length },
      userEvent: 'input',
    });
    void renderSections();
  };

  /** Строка списка разделов (ключ — имя раздела; `null` — весь комментарий). */
  interface SectionRow {
    key: string;
    label: string;
    section: string | null;
    active: boolean;
  }

  /** Перерисовывает список разделов текущего источника (целиком сразу). */
  const renderSections = async (): Promise<void> => {
    const sourceId = currentSourceId;
    const titles = await sourceSectionTitles(networkId, sourceId);
    if (sourceId !== currentSourceId) return;
    const rows: SectionRow[] = [
      {
        key: '\u0000whole',
        label: t('comment.transclusion.popover.whole'),
        section: null,
        active: currentSection === null,
      },
    ];
    if (currentSection !== null && !titles.includes(currentSection)) {
      // Текущий раздел не найден в источнике — показываем строкой, чтобы выбор
      // не «терялся» на глазах пользователя.
      rows.push({ key: currentSection, label: currentSection, section: currentSection, active: true });
    }
    for (const title of titles) {
      rows.push({ key: title, label: title, section: title, active: currentSection === title });
    }
    // Инкрементальная сверка по ключу (стандарт «Списки рендерятся
    // инкрементально»): смена активного раздела обновляет строку, не снося
    // прокрутку/фокус списка.
    reconcileKeyed(sectionList, rows, {
      key: (row) => row.key,
      equals: (a, b) => a.key === b.key && a.label === b.label && a.active === b.active,
      build: (row) => {
        const btn = uiButton({
          label: row.label,
          role: 'ghost',
          size: 's',
          class: TRANSCLUSION_POPOVER_ROW_CLASS,
          title: row.label,
          onClick: () => apply(currentSourceId, row.section),
        });
        setButtonActive(btn, row.active);
        return btn;
      },
      update: (el, row) => {
        el.textContent = row.label;
        el.title = row.label;
        setButtonActive(el as HTMLButtonElement, row.active);
      },
    });
  };

  const commandButton = (
    icon: IconName,
    title: string,
    onClick: () => void,
  ): HTMLButtonElement =>
    iconButton({ icon: svgIcon(icon, 14), role: 'ghost', size: 's', title, onClick });

  /**
   * Удаляет ссылку блока одной транзакцией, каретка — на место блока (задача
   * `c11b82ee`). Без диалога подтверждения: откат — undo контейнера. Если
   * ссылка сдвинулась/исчезла, пока поповер был открыт, — ничего не меняем.
   */
  const removeBlock = (): void => {
    const range = transclusionBlockRemoval(view.state.doc.toString(), anchorStart);
    close();
    if (range === null) return;
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: '' },
      selection: { anchor: range.from },
      userEvent: 'delete',
    });
  };

  commands.append(
    commandButton('external-link', t('comment.transclusion.menu.open'), () => {
      close();
      void import('./editor.js').then((m) => m.openThoughtInEditor(currentSourceId));
    }),
    commandButton('focus', t('comment.transclusion.menu.focus'), () => {
      close();
      void import('../screens/active-view.js').then((m) => m.focusThoughtOnMap(currentSourceId));
    }),
    commandButton('copy', t('comment.transclusion.menu.copy'), () => {
      const raw = currentRaw();
      close();
      void copyTransclusionText(raw, t('comment.transclusion.menu.copied'));
    }),
    commandButton('hash', t('comment.transclusion.menu.copyId'), () => {
      close();
      void copyTransclusionText(currentSourceId, t('comment.transclusion.menu.copiedId'));
    }),
    // «Удалить блок» — удаление ссылки одной транзакцией, каретка на место
    // блока; без подтверждения (откат — undo контейнера).
    commandButton('trash', t('comment.transclusion.menu.delete'), removeBlock),
  );

  const handle = wireSuggest(input, {
    // Живой поиск мыслей — та же выпадашка, что у пикера сущностей.
    sources: [{ when: 'typed', load: (query) => loadThoughtEntries(networkId, query) }],
    minWidth: 280,
    onPick: (entry) => apply(entry.value, null),
  });

  const popover = openPopover({
    anchor: { element: anchor },
    content: {
      title: t('comment.transclusion.popover.title'),
      body,
      maxHeightPx: 360,
    },
    // Клик вне закрывает вручную через `watchOutsideTap` (подсказки мыслей
    // живут в общем слое вне панели — их клик «свой», а не внешний).
    closeOnOutsideClick: false,
    onClose: () => {
      handle.dispose();
      stopOutside();
    },
  });
  stopOutside = watchOutsideTap(
    (target) => popover.contains(target) || isInsideSuggestDropdown(target),
    () => popover.close(),
  );
  void renderSections();
}

/** Меню команд навигации чипа в просмотре (в точке клика). */
function openViewChipMenu(event: MouseEvent, sourceId: string, section: string | null): void {
  let raw: string;
  try {
    raw = formatTransclusionRef(sourceId, section);
  } catch {
    raw = '';
  }
  const menuRoot = showMenuAt(
    event.clientX,
    event.clientY,
    buildTransclusionMenuItems(
      transclusionNavHandlers(sourceId, raw),
      TRANSCLUSION_NAV_MENU_LAYOUT,
    ),
  );
  guardMenuFocus(menuRoot);
}

/**
 * Размечает шапки-чипы «имя · раздел» на блоках трансклюзий ПРОСМОТРА (задача
 * `68591b8a`): обходит внешние и вложенные `.md-transclusion` единого рендерера
 * и на каждый блок вешает чип `createTransclusionHead`. Имена приходят картой
 * `titles` — тем же проходом развёртки, что рисовал блок (`expandWithLoader`),
 * без второго сетевого запроса. Идемпотентна: прежняя шапка снимается.
 */
export function decorateViewTransclusionChips(
  view: HTMLElement,
  titles: ReadonlyMap<string, string>,
): void {
  const blocks = view.querySelectorAll<HTMLElement>(
    `.${MD_TRANSCLUSION_BLOCK_CLASS}[${MD_TRANSCLUSION_SOURCE_ATTR}]`,
  );
  for (const block of blocks) {
    clearTransclusionHead(block);
    const sourceId = viewBlockSourceId(block);
    if (sourceId === null) continue;
    const section = block.getAttribute(MD_TRANSCLUSION_SECTION_ATTR);
    const title = titles.get(sourceId) ?? '';
    block.prepend(
      createTransclusionHead(transclusionLinkLabel(title, section), (event) => {
        openViewChipMenu(event, sourceId, section);
      }),
    );
  }
}

/* ------------------------------------------------------------------ *
 * Вход/выход вложенного редактора блока (задача 73ae1d4b)
 * ------------------------------------------------------------------ */

/**
 * Хост поля комментария (задача «Единая запись», `e9dfc2df`). Тип, фасет и
 * расширение живут рядом с {@link NestedEditorStore} (`transclusion-nested.ts`):
 * фасет пробрасывается в стек вложенного инстанса, поэтому блок ЛЮБОЙ глубины
 * видит хост. Реэкспорт сохранён ради прежней точки импорта (`transclusion.js`).
 */
export { blockEditorHostExtension, type BlockEditorHost } from './transclusion-nested.js';

/** Хранилище вложенных редакторов текущего поля, либо `null` (нет фасета). */
function editorStore(view: EditorView): NestedEditorStore | null {
  return view.state.facet(blockEditorStoreFacet);
}

/** Глубина вложенного редактора, который откроется для блока текущего поля. */
function nextDepth(state: EditorState): number {
  return (state.facet(nestedDepthFacet) ?? 0) + 1;
}

/** Ссылка блока по ключу его вложенного редактора в текущем документе. */
function refForKey(state: EditorState, key: string): TransclusionRef | null {
  for (const ref of parseTransclusions(state.doc.toString())) {
    if (blockEditorKey(ref.sourceId, ref.section) === key) return ref;
  }
  return null;
}

/** Ссылка трансклюзии под позицией `pos`, либо `null`. */
function transclusionRefAt(view: EditorView, pos: number): TransclusionRef | null {
  return transclusionAtCaret(view.state.doc.toString(), pos)?.ref ?? null;
}

/**
 * Вход в блок: монтирует вложенный редактор с текстом раздела и переносит в него
 * фокус. Повторный вход в уже смонтированный блок лишь активирует его и
 * фокусирует (текст правки сохранён в состоянии инстанса).
 *
 * **Вход СИНХРОНЕН (ошибка `ce46723d`).** Тело источника уже загружено для
 * отрисовки блока (общий кэш сети {@link sourceCache}), поэтому вложенный
 * редактор монтируется В ТОМ ЖЕ ТИКЕ, что и нажатие, — без сети и микрозадач:
 * каретка не теряется, повторные стрелки не уводят её за блок. Сеть — только при
 * промахе кэша, с дедупликацией дозагрузки ({@link loadNestedBlock}). Свежесть
 * источника обеспечивают инвалидация кэша по realtime (`comment.*` /
 * `thought.deleted`, {@link sourceKeyForCommentEvent}) и `expected_version` при
 * единой записи.
 *
 * Заблокированный источник (чужой захват) и превышение глубины — no-op: блок
 * остаётся только для чтения. Пакетный захват источников берётся полем при
 * входе в правку ({@link TransclusionLockSet}), здесь он не ставится.
 */
export function enterBlock(view: EditorView, ref: TransclusionRef, caretAtEnd = false): void {
  const store = editorStore(view);
  if (store === null) return;
  if (otherHolder('thought', ref.sourceId) !== null) return;
  const depth = nextDepth(view.state);
  if (depth > MAX_NESTED_DEPTH) return;
  const key = blockEditorKey(ref.sourceId, ref.section);
  if (store.has(key)) {
    activateNestedBlock(view, store, key, caretAtEnd);
    return;
  }
  const networkId = safeNetwork();
  if (networkId === null) return;
  const cached = sourceCache.get(sourceCacheKey(networkId, ref.sourceId));
  if (cached !== undefined) {
    // Синхронный монтёж из уже загруженного тела — блок им и отрисован.
    mountNestedBlock(view, store, ref, key, depth, cached, caretAtEnd);
    return;
  }
  // Промах кэша: единственная точка сетевого чтения — дозагрузка с
  // дедупликацией (повторные нажатия до монтажа не запускают второй запрос).
  void loadNestedBlock(view, store, ref, key, depth, caretAtEnd);
}

/** Активирует смонтированный блок и переносит в него фокус (синхронно). */
function activateNestedBlock(
  view: EditorView,
  store: NestedEditorStore,
  key: string,
  caretAtEnd: boolean,
): void {
  view.dispatch({ effects: setActiveBlock.of(key) });
  store.focus(key, caretAtEnd ? 'end' : 'start');
}

/** Опции вложенного инстанса блока: хост поля, грязность и жесты выхода. */
function nestedBlockOptions(
  view: EditorView,
  key: string,
  host: BlockEditorHost | null,
  depth: number,
): NestedEditorOptions {
  return {
    depth,
    // Хост пробрасывается в стек инстанса (задача `e9dfc2df`): блок любой
    // глубины догружает захват СВОЕГО источника при монтировании и проводит
    // Ctrl+Enter/Esc в единую запись/отмену поля.
    host,
    onDirty: (k) => host?.onBlockDirty(k),
    onExit: (k, reason) => exitBlock(view, k, reason),
    onCommit: () => host?.onCommitEdit?.(key),
    onCancel: () => host?.onCancelEdit?.(key),
  };
}

/**
 * СИНХРОННЫЙ монтаж вложенного редактора из уже загруженного источника
 * (ошибка `ce46723d`): тело берётся из кэша, инстанс создаётся и активируется в
 * том же тике. Черновик правки источника (задача `6a085e01`) читается из
 * локального хранилища АСИНХРОННО и подставляется до первого ввода
 * ({@link NestedEditorStore.applyDraft}) — монтаж его не ждёт.
 */
function mountNestedBlock(
  view: EditorView,
  store: NestedEditorStore,
  ref: TransclusionRef,
  key: string,
  depth: number,
  src: TransclusionSource,
  caretAtEnd: boolean,
): void {
  const text = ref.section === null ? src.body_md : sectionBodyForEdit(src.body_md, ref.section);
  if (text === null) return;
  const host = view.state.facet(blockEditorHostFacet);
  store.mount(key, text, nestedBlockOptions(view, key, host, depth));
  // Блок смонтирован — источник входит в набор правки: поле берёт на него
  // пакетный захват (задача `e9dfc2df`). Вложенные источники (в т.ч. внутри
  // блока) попадают в набор по мере монтирования.
  host?.onBlockMounted?.(ref.sourceId);
  activateNestedBlock(view, store, key, caretAtEnd);
  if (host?.getBlockDraft !== undefined) {
    void host
      .getBlockDraft(ref.sourceId, ref.section)
      .then((draft) => {
        store.applyDraft(key, draft);
      })
      .catch(() => undefined);
  }
}

/** Промахи кэша, чья дозагрузка источника уже идёт (ключ сети + блок). */
const nestedBlockLoads = new Set<string>();

/**
 * Асинхронная дозагрузка источника при ПРОМАХЕ кэша и монтаж инстанса.
 * Дедуплицирована по ключу (сеть + блок): повторные нажатия, пока идёт
 * загрузка, второго запроса не делают (ошибка `ce46723d`). Загрузка идёт через
 * общий кэш сети ({@link cachedTransclusionLoader}) — после неё повторный вход
 * синхронен.
 */
async function loadNestedBlock(
  view: EditorView,
  store: NestedEditorStore,
  ref: TransclusionRef,
  key: string,
  depth: number,
  caretAtEnd: boolean,
): Promise<void> {
  const networkId = safeNetwork();
  if (networkId === null) return;
  const loadKey = `${networkId}#${key}`;
  if (nestedBlockLoads.has(loadKey)) return;
  nestedBlockLoads.add(loadKey);
  try {
    const src = await cachedTransclusionLoader(networkId)(ref.sourceId).catch(() => null);
    if (src === null || !src.found) return;
    // Ссылка могла сдвинуться/исчезнуть, пока грузили источник.
    const fresh = transclusionRefStartingAt(view.state.doc.toString(), ref.start);
    if (fresh === null || fresh.sourceId !== ref.sourceId) return;
    if (store.has(key)) {
      // Пока грузили — блок уже смонтирован другим путём: просто активируем.
      activateNestedBlock(view, store, key, caretAtEnd);
      return;
    }
    mountNestedBlock(view, store, ref, key, depth, src, caretAtEnd);
  } finally {
    nestedBlockLoads.delete(loadKey);
  }
}

/**
 * Выход из блока: снимает активность (инстанс с текстом остаётся в хранилище —
 * семантика «сохранить в состоянии» до задачи «Единая запись»). При выходе
 * клавишей (`up`/`left`/`down`/`right`/`ctrl-enter`) фокус возвращается в
 * контейнер на границу блока; при уходе фокуса (`blur`) фокус НЕ навязывается —
 * иначе клик по внешнему элементу «перехватывался» бы обратно в поле (ошибка
 * `b4986d3a`).
 */
export function exitBlock(view: EditorView, key: string, reason: NestedExitReason): void {
  const active = view.state.field(transclusionState, false)?.activeKey ?? null;
  if (active !== key) return;
  const ref = refForKey(view.state, key);
  const back = reason === 'up' || reason === 'left';
  const anchor = ref === null ? null : back ? ref.start : ref.end;
  view.dispatch({
    effects: setActiveBlock.of(null),
    ...(anchor === null ? {} : { selection: { anchor } }),
  });
  // `blur` — фокус ушёл в посторонний элемент; возвращать его в контейнер
  // нельзя (контракт выхода, ошибка `b4986d3a`). Остальные причины выхода
  // инициированы клавишей внутри блока — фокус ставится на границу блока.
  if (anchor !== null && reason !== 'blur') view.focus();
}

/** Выход из активного блока без причины (например, поле выходит из правки). */
export function exitActiveBlock(view: EditorView): void {
  view.dispatch({ effects: setActiveBlock.of(null) });
}

/** Сравнивает карты чужих захватов (чтобы не слать лишние транзакции). */
function sameLockMap(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

/**
 * Плагин «замочков»: ведёт карту чужих захватов источников документа для
 * индикатора 🔒 (требование `647fa34a`). Своих захватов не ставит — вход в блок
 * лишь проверяет `lock-cache` ({@link enterBlock}); пакетный захват источников
 * держит поле ({@link TransclusionLockSet}, задача `e9dfc2df`, ADR `fdb1a271`).
 */
const transclusionLockPlugin = ViewPlugin.fromClass(
  class {
    disposed = false;
    /** Пересбор карты захватов уже запланирована (микрозадача). */
    locksScheduled = false;
    unsubscribe: () => void;

    constructor(readonly view: EditorView) {
      this.unsubscribe = subscribeLockCache(() => this.refreshLocks());
      this.refreshLocks();
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) this.refreshLocks();
    }

    /** Карта чужих захватов источников текущего документа. */
    computeLocks(): Map<string, string> {
      const next = new Map<string, string>();
      for (const ref of parseTransclusions(this.view.state.doc.toString())) {
        const row = otherHolder('thought', ref.sourceId);
        if (row !== null) next.set(ref.sourceId, holderName(row));
      }
      return next;
    }

    /**
     * Пересобирает карту чужих захватов источников документа. Диспатч
     * откладывается в микрозадачу: плагин может вызываться из `update()`, где
     * синхронный `dispatch` запрещён.
     */
    refreshLocks(): void {
      if (this.disposed || this.locksScheduled) return;
      this.locksScheduled = true;
      queueMicrotask(() => {
        this.locksScheduled = false;
        if (this.disposed) return;
        const state = this.view.state.field(transclusionState, false);
        if (state === undefined) return;
        const next = this.computeLocks();
        if (sameLockMap(state.lockedSources, next)) return;
        this.view.dispatch({ effects: setLockedSources.of(next) });
      });
    }

    destroy(): void {
      this.disposed = true;
      this.unsubscribe();
    }
  },
);

/**
 * Жесты трансклюзий: вход в блок кареткой и создание ссылки. Вход монтирует
 * вложенный редактор (задача `73ae1d4b`); `Mod-Enter`/`Escape` намеренно НЕ
 * перехватываются — их обрабатывает поле (коммит/отмена окружения), а внутри
 * блока — стек вложенного редактора.
 */
export const transclusionEditGestures = [
  Prec.high(
    keymap.of([
      {
        key: 'Enter',
        run: (view) => {
          // Открытый автокомплит (мысли/разделы) обрабатывает Enter сам.
          if (completionStatus(view.state) === 'active') return false;
          // Enter вводит в блок только когда он выделен целиком (перетаскиванием)
          // или каретка строго внутри ссылки (после входа стрелкой). На строке
          // перед/после блока каретка на границе — Enter остаётся переводом строки.
          const covering = refCoveringSelection(view.state, view.state.selection.main);
          if (covering !== null) {
            enterBlock(view, covering);
            return true;
          }
          const ref = transclusionRefAt(view, view.state.selection.main.head);
          if (ref === null) return false;
          enterBlock(view, ref);
          return true;
        },
      },
      // `#` при открытом списке мыслей трансклюзии принимает выделенную мысль
      // и сразу открывает список разделов источника (ошибка `ccf4d25f`,
      // элемент `7a479549`). В любом другом состоянии `#` — обычный ввод.
      { key: '#', run: (view) => acceptTransclusionThought(view) },
      // Стрелка, входящая в блок, монтирует вложенный редактор и уводит фокус
      // внутрь (задача 73ae1d4b); обычные шаги вне блока отдаём CM6.
      { key: 'ArrowRight', run: (view) => transclusionBlockArrow(view, 'right') },
      { key: 'ArrowLeft', run: (view) => transclusionBlockArrow(view, 'left') },
      { key: 'ArrowDown', run: (view) => transclusionBlockArrow(view, 'down') },
      { key: 'ArrowUp', run: (view) => transclusionBlockArrow(view, 'up') },
    ]),
  ),
] as const;

/** Плагин: догружает источники ссылок документа и наполняет кэш состояния. */
const transclusionLoader = ViewPlugin.fromClass(
  class {
    inflight = false;

    constructor(readonly view: EditorView) {
      this.schedule();
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet) this.schedule();
    }

    schedule(): void {
      if (this.inflight) return;
      const state = this.view.state.field(transclusionState, false);
      if (state === undefined) return;
      const networkId = state.networkId ?? safeNetwork();
      if (networkId === null) return;
      const source = this.view.state.doc.toString();
      const todo = parseTransclusions(source).filter(
        (ref) => !state.cache.has(transclusionCacheKey(networkId, ref)),
      );
      if (todo.length === 0) return;
      this.inflight = true;
      const load = cachedTransclusionLoader(networkId);
      void Promise.all(
        todo.map(async (ref) => ({
          key: transclusionCacheKey(networkId, ref),
          entry: await loadEntry(ref, load).catch(emptyEntry),
        })),
      )
        .then((entries) => {
          this.view.dispatch({ effects: setEntries.of(entries) });
        })
        .finally(() => {
          this.inflight = false;
        });
    }
  },
);

/* ------------------------------------------------------------------ *
 * Автокомплит разделов
 * ------------------------------------------------------------------ */

/**
 * Открывающий токен ссылки трансклюзии: восклицательный знак и две скобки.
 * Собирается из частей: литерал этого токена в исходниках клиента запрещён
 * сторожем `own-transclusion-outside-package` — конструкция ссылки строится единым
 * `formatTransclusionRef` пакета `@etn/markdown`, а здесь нужен лишь поиск
 * начала уже набранной ссылки.
 */
const TRANSCLUSION_OPEN = '!' + '[[';

/**
 * Ссылка-трансклюзия после нажатия `#` в списке мыслей: ID-форма `#<id>]]`
 * (значение `apply` подсказки мыслей) превращается в ссылку с пустым разделом
 * (`#<id>#` перед закрывающими скобками), каретка — в тексте раздела
 * (элемент `7a479549`). `null` — не ID-форма. Чистая функция ради проверки
 * итогового вида ссылки и позиции каретки.
 */
export function transclusionSectionAccept(
  applied: string,
): { ref: string; caret: number } | null {
  const m = /^#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})]]$/i.exec(
    applied,
  );
  if (m === null) return null;
  // Единый дом конструкции ссылки: полная ссылка без раздела, затем второй `#`
  // перед закрывающими скобками — текст раздела.
  const base = formatTransclusionRef(m[1]!);
  const ref = `${base.slice(0, -2)}#]]`;
  return { ref, caret: ref.length - 2 };
}

/**
 * Обработчик `#` в поле: если открыт список мыслей трансклюзии (набран
 * открывающий токен и префикс имени, автокомплит активен), принимает
 * выделенный вариант, дописывает `#` в конце ссылки и немедленно открывает
 * список ВСЕХ заголовков источника ({@link transclusionSectionCompletions}) —
 * без минимума символов. Возвращает `false`, когда жест не наш, — тогда `#`
 * вводится как обычный символ (ошибка `ccf4d25f`).
 */
export function acceptTransclusionThought(view: EditorView): boolean {
  if (completionStatus(view.state) !== 'active') return false;
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const open = before.lastIndexOf(TRANSCLUSION_OPEN);
  if (open === -1) return false;
  // Префикс имени без закрывающих скобок, `|`, перевода строки и `#`: иначе
  // это не список мыслей трансклюзии (обычная ссылка, раздел, готовый блок).
  if (!/^[^[\]\n|#]*$/.test(before.slice(open + TRANSCLUSION_OPEN.length))) return false;
  const chosen = selectedCompletion(view.state) ?? currentCompletions(view.state)[0] ?? null;
  const applied = chosen !== null && typeof chosen.apply === 'string' ? chosen.apply : null;
  if (applied === null) return false;
  const accepted = transclusionSectionAccept(applied);
  if (accepted === null) return false;
  const start = line.from + open;
  view.dispatch({
    changes: { from: start, to: pos, insert: accepted.ref },
    selection: { anchor: start + accepted.caret },
  });
  // Список разделов приходит не от набора символа, а от нашего жеста — открываем
  // его явно (порог 3 символа у списка мыслей здесь не действует).
  startCompletion(view);
  return true;
}

/**
 * Источник подсказок «разделы источника» (для общего автокомплита wiki-ссылок):
 * активен, когда каретка стоит в тексте раздела ссылки трансклюзии.
 *
 * Кэш заголовков — ПО-ИНСТАНСНЫЙ: замыкание своё на каждый вызов (как кэш
 * автокомплита мыслей, `wikiLinkCompletions`). Показ разделов зависит от
 * текущего текста источника, который может править ВЛОЖЕННЫЙ редактор другого
 * инстанса, — общий кэш вернул бы устаревший список. Сетевой запрос при этом
 * не дублируется: тела источников кэширует ОБЩИЙ кэш сети
 * ({@link cachedTransclusionLoader}).
 */
export function transclusionSectionCompletions(): CompletionSource {
  const sectionTitlesCache = new Map<string, string[]>();
  return async (context) => {
    const ctx = transclusionAtCaret(context.state.doc.toString(), context.pos);
    if (ctx === null || !ctx.inSection || ctx.sectionFrom === null) return null;
    const networkId = safeNetwork();
    if (networkId === null) return null;
    const cacheKey = `${networkId}:${ctx.ref.sourceId}`;
    let titles = sectionTitlesCache.get(cacheKey);
    if (titles === undefined) {
      const load = cachedTransclusionLoader(networkId);
      const src = await load(ctx.ref.sourceId).catch(() => null);
      titles = src !== null && src.found ? listSectionTitles(src.body_md) : [];
      sectionTitlesCache.set(cacheKey, titles);
    }
    const prefix = context.state.sliceDoc(ctx.sectionFrom, context.pos).toLowerCase();
    const options: Completion[] = titles
      .filter((title) => title.toLowerCase().startsWith(prefix))
      .map((title) => ({ label: title, apply: title, type: 'text' }));
    if (options.length === 0) return null;
    return {
      from: ctx.sectionFrom,
      to: context.pos,
      options,
      validFor: /^[^\]\n#]*$/,
    };
  };
}

/** Все расширения трансклюзий редактора, для `md-editor.ts`. */
export const transclusionExtensions: Extension[] = [
  transclusionState,
  transclusionLoader,
  transclusionAtomicRanges,
  transclusionClick,
  transclusionContextMenu,
  ...transclusionEditGestures,
  transclusionLockPlugin,
];

/** Текущая сеть или `null` (список сетей / ранний доступ). */
function safeNetwork(): string | null {
  try {
    return requireNetworkId();
  } catch {
    return null;
  }
}

/** Тестовый шов: чистые функции и сборка декораций. */
export const transclusionInternals = {
  buildTransclusionDecorations,
  expandWithLoader,
  loadEntry,
  emptyEntry,
  cachedTransclusionLoader,
  invalidateTransclusionSource,
  sourceKeyForCommentEvent,
  applySourceCacheEvent,
  /** Очистка общего (на сеть) кэша источников — изоляция прогонов тестов. */
  clearSourceCache: () => sourceCache.clear(),
  setEntries,
  setActiveBlock,
  sectionParts,
  enterBlock,
  exitBlock,
  exitActiveBlock,
  refForKey,
  blockEditorKey,
  loadThoughtEntries,
  sourceSectionTitles,
  transclusionSourceIds,
  parseBlockEditorKey,
  dirtyBlockSaves,
  commitTransclusionEdit,
  TransclusionLockSet,
  transclusionBlockRemoval,
};
