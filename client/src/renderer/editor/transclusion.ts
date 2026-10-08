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
 * **Правка блока и захват источника (задачи `f59d24e1`, `e2c14673`).**
 * Двойной клик по блоку или Enter при каретке внутри ссылки переводят блок в
 * режим правки (`setBlockEdit`): текст источника вставляется в то же поле
 * ВМЕСТО ссылки (диапазон `blockEdit`), поэтому на него действуют все команды и
 * сочетания родительского редактора. С этого момента на мысль-источник ставится
 * захват существующим механизмом `lib/lock-guard.ts` (`/locks`, `edit.*`) и
 * снимается при выходе. Сохранение («Сохранить трансклюзию», Ctrl+Enter) пишет
 * изменённый текст обратно в постоянный комментарий источника через существующий
 * API (`etn.comments.update`, для раздела — слияние раздела в тело) под захватом;
 * отмена (Esc, «Отменить трансклюзию») восстанавливает ссылку без записи. Чужой
 * захват даёт на блоке «замочек» 🔒 и в правку не пускает; при захваченном
 * источнике запись отклоняется сервером `409 LOCKED` (ошибка `68be6829`).
 *
 * **Вложенный блок из просмотра (ошибка `23570aef`).** Позиции ссылки
 * ВЛОЖЕННОГО источника в `body_md` контейнера не существует (разные исходники
 * дают одинаковую развёртку — см. ошибку `5ecb9f0b`), поэтому двойной клик
 * внутри вложенного блока в просмотре открывает правку блока вложенного
 * источника ({@link beginNestedBlockEdit}): текст источника вставляется на
 * месте ВНЕШНЕЙ ссылки, а её исходник сохраняется в `refRaw` и возвращается при
 * сохранении/отмене — контейнер не портится (вектор ошибки `3c51aee8` закрыт).
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
 * замена идёт блоком на весь диапазон ссылки, а сам блок ВЫДЕЛЯЕТСЯ как единое
 * целое — кликом и стрелкой, входящей в него (ошибка `5312142d`); внутрь блока
 * каретка не встаёт. Выделение блока целиком показывается РАМКОЙ ВОКРУГ него
 * (класс `cm-transclusion-block--covered`), а не подсветкой текста/пробелов
 * внутри (ошибка `39553204`). Блок — replace-виджет `block: true`, в DOM он
 * лежит прямым потомком `.cm-content` (вне `.cm-line`), поэтому подавление
 * нативного выделения внутри — селектором БЕЗ `.cm-line` (иначе не матчит).
 * Ссылка правится чипом и поповером (элемент `7a479549`), правка блока —
 * двойным кликом или Enter на выделенном блоке.
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
 * команды навигации ({@link transclusionNavHandlers}).
 *
 * **Свёрнутость разделов внутри блока (задача `1b405a92`, требование
 * `e04d84f7`).** Виджет блока декорирует своё содержимое через
 * `decorateCommentView` с состоянием своего пути вставки (фабрика из
 * `collapseScopeFacet`, ставит `markdown-field`): один и тот же источник в
 * разных контейнерах хранит свёрнутость раздельно. Просмотр идёт тем же путём
 * (обход `.md-transclusion` в `decorateCommentView`).
 *
 * **Правка блока (ошибка `4204e34c`).** Пока текст источника вставлен в поле
 * вместо ссылки (`blockEdit`), `transclusionState` отдаёт диапазон правки
 * фасетом `blockEditCollapseFacet`: заголовки блока в CM6 нумеруются своим
 * namespace и сворачиваются состоянием пути вставки, не трогая собственные
 * разделы поля-контейнера.
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
  Facet,
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
import type { AnyRealtimeEvent, Comment } from '@etn/shared';

import { requireNetworkId } from '../app.js';
import { div, el } from '../lib/dom.js';
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
import {
  blockEditCollapseFacet,
  collapseScopeFacet,
  decorateCommentView,
} from './comment-collapse.js';

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
/**
 * Контейнер ховер-кнопки блока (правый верхний угол, элемент `7a479549`):
 * «Редактировать трансклюзию» показывается на наведении в режиме правки
 * окружения. Правка ССЫЛКИ идёт чипом-шапкой, отдельной кнопки нет.
 */
export const TRANSCLUSION_ACTIONS_CLASS = 'cm-transclusion-actions';
/** Плашка ошибки источника/раздела. */
export const TRANSCLUSION_ERROR_CLASS = 'cm-transclusion-error';
/** Атомарный токен `#<id>` при вводе ссылки (создание ссылки не меняется). */
export const TRANSCLUSION_ID_CLASS = 'cm-transclusion-id';
/** Блок в режиме правки (рамка как у облачка, задача f59d24e1). */
export const TRANSCLUSION_EDITING_CLASS = 'cm-transclusion-block--editing';
/**
 * Блок целиком покрыт выделением (ошибка `39553204`): пользователь видит блок
 * как единое целое — CSS рисует рамку ВОКРУГ блока и подавляет нативную
 * подсветку текста/пробелов внутри (выделение блока как атома, `5312142d`).
 */
export const TRANSCLUSION_COVERED_CLASS = 'cm-transclusion-block--covered';
/** Диапазон редактируемого текста блока в режиме правки (задача e2c14673). */
export const TRANSCLUSION_EDIT_RANGE_CLASS = 'cm-transclusion-edit-range';
/** Первая строка вложенного поля правки блока (ошибка 9c2e077a). */
export const TRANSCLUSION_EDIT_FIRST_CLASS = 'cm-transclusion-edit-range--first';
/** Последняя строка вложенного поля правки блока (ошибка 9c2e077a). */
export const TRANSCLUSION_EDIT_LAST_CLASS = 'cm-transclusion-edit-range--last';
/** «Замочек» блока при чужом захвате источника (задача f59d24e1). */
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

/** Метка ссылки в свёрнутом виде: имя мысли и, при наличии, раздел. */
export function transclusionLinkLabel(title: string, section: string | null): string {
  const name = title !== '' ? title : t('comment.transclusion.untitled');
  return section === null ? name : `${name} · ${section}`;
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

let sourceCacheWired = false;

/**
 * Центральная инвалидация общего кэша источников по realtime (подключается из
 * `app.ts` при старте, рядом с `initLockCache`). ЛЮБАЯ запись постоянного
 * комментария-источника — обычная правка комментария, черновик, хроно-путь, MCP,
 * чужая правка — приходит из main в рендерер событием `comment.*`, в том числе
 * автору записи (broadcast-to-all), поэтому ОДНА подписка покрывает все пути
 * записи: отдельные вызовы `etn.comments.update` ловить не нужно. Идемпотентно.
 */
export function initTransclusionSourceCache(): void {
  if (sourceCacheWired) return;
  sourceCacheWired = true;
  onRoutedRealtimeEvent((evt) => {
    const key = sourceKeyForCommentEvent(evt);
    if (key !== null) sourceCache.delete(key);
  });
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
 * Эффект режима правки блока трансклюзии (задача `f59d24e1`): значение —
 * id мысли-источника, в правку которого входит пользователь, либо `null` для
 * выхода. Захват источника ставится/снимается плагином по смене значения.
 */
export const setBlockEdit = StateEffect.define<string | null>();

/**
 * Дескриптор активной правки блока (задача `e2c14673`): координаты вставленного
 * в поле текста источника и исходная ссылка для восстановления при отмене.
 */
export interface BlockEditState {
  sourceId: string;
  section: string | null;
  /** Исходный markdown ссылки-трансклюзии — восстанавливается при отмене. */
  refRaw: string;
  /** Начало редактируемого текста в документе. */
  from: number;
  /** Конец редактируемого текста (исключительно). */
  to: number;
}

/** Эффект установки/снятия дескриптора правки блока (диапазон текста). */
export const setBlockEditRange = StateEffect.define<BlockEditState | null>();

/** Эффект сброса кэша ссылок по ключам (после записи в источник — перечитать). */
const dropEntries = StateEffect.define<string[]>();

/** Эффект обновления карты чужих захватов источников (`sourceId` → имя). */
const setLockedSources = StateEffect.define<ReadonlyMap<string, string>>();

/** Состояние плагина: кэш данных, декорации и атомарные токены. */
interface TransclusionStateData {
  networkId: string | null;
  cache: Map<string, TransclusionEntry>;
  /** Источник в режиме правки блока, либо `null` (задача f59d24e1). */
  editingSourceId: string | null;
  /** Дескриптор редактируемого текста блока, либо `null` (задача e2c14673). */
  blockEdit: BlockEditState | null;
  /** Чужие захваты источников: `sourceId` → имя держателя (задача f59d24e1). */
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
    /** Источник блока — для «замочка» и входа в правку. */
    readonly sourceId: string,
    /** Блок в режиме правки (задача f59d24e1). */
    readonly editing: boolean,
    /** Имя чужого держателя захвата источника, либо `null` (задача f59d24e1). */
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
      other.editing === this.editing &&
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
    // Без класса `md-widget`: его клик обрабатывает mdWidgetClick (md-live.ts),
    // иначе было бы двойное перемещение каретки.
    box.className =
      `${TRANSCLUSION_BLOCK_CLASS} comment-view` +
      (this.editing ? ` ${TRANSCLUSION_EDITING_CLASS}` : '') +
      (this.covered ? ` ${TRANSCLUSION_COVERED_CLASS}` : '');
    box.dataset.mdFrom = String(this.from);
    box.dataset.mdTo = String(this.to);
    box.dataset['transclusionSource'] = this.sourceId;

    // «Замочек» при чужом захвате источника (требование 647fa34a): источник
    // правит другой участник — вход в правку блока заблокирован.
    if (this.lockedBy !== null) {
      box.append(createTransclusionLockBadge(this.lockedBy));
    }

    if (this.entry.error !== null) {
      const err = document.createElement('div');
      err.className = TRANSCLUSION_ERROR_CLASS;
      err.textContent =
        this.entry.error === 'source'
          ? t('comment.transclusion.noSource')
          : t('comment.transclusion.noSection');
      box.append(err);
      return box;
    }

    // Шапка-чип «имя · раздел» (элемент `7a479549`, задача `68591b8a`): всегда
    // видна, клик открывает поповер правки ссылки (выбор мысли и раздела,
    // команды навигации) — сырой правки ссылки и сворачивания блока больше нет.
    box.append(
      createTransclusionHead(transclusionLinkLabel(this.entry.title, this.section), (event) => {
        const ref = transclusionRefStartingAt(view.state.doc.toString(), this.from);
        if (ref !== null) openTransclusionLinkPopover(view, ref, event.currentTarget as HTMLElement);
      }),
    );

    // Ховер-кнопка в правом верхнем углу (элемент 7a479549): «Редактировать
    // трансклюзию» — вход в правку блока (как двойной клик/Enter). Правка
    // ССЫЛКИ идёт чипом-шапкой, прежней кнопки «Редактировать ссылку» нет.
    // В режиме правки блока кнопка скрыта: сначала выходят из правки.
    if (!this.editing) {
      const actions = document.createElement('div');
      actions.className = TRANSCLUSION_ACTIONS_CLASS;
      const editBlock = iconButton({
        icon: svgIcon('pencil', 12),
        role: 'ghost',
        size: 's',
        title: t('comment.transclusion.editBlock'),
        onClick: () => {
          const ref = transclusionRefStartingAt(view.state.doc.toString(), this.from);
          if (ref !== null) void beginBlockEdit(view, ref);
        },
      });
      editBlock.addEventListener('mousedown', (event) => event.preventDefault());
      actions.append(editBlock);
      box.append(actions);
    }

    const body = document.createElement('div');
    body.innerHTML = this.entry.html ?? '';
    box.append(body);

    // Сворачивание разделов внутри блока — своим состоянием на путь вставки
    // (ТП2, задача 1b405a92, требование e04d84f7): в правке блок показывает
    // готовый HTML, поэтому декорируем своё содержимое как область просмотра.
    const factory = view.state.facet(collapseScopeFacet);
    if (factory !== null) {
      const path = [this.sourceId];
      decorateCommentView(body, factory(path), factory, path);
    }
    return box;
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

/** Офсеты начал строк текста — для линейных декораций рамки правки блока. */
function lineStartOffsets(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** Индекс строки, содержащей позицию `pos` (двоичный поиск по началам строк). */
function lineIndexAt(starts: readonly number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Строит декорации и атомарные диапазоны для текущего состояния. */
export function buildTransclusionDecorations(
  source: string,
  selection: { from: number; to: number },
  cache: Map<string, TransclusionEntry>,
  networkId: string | null,
  /** Источник в режиме правки блока, либо `null` (задача f59d24e1). */
  editingSourceId: string | null = null,
  /** Чужие захваты источников: `sourceId` → имя держателя (задача f59d24e1). */
  lockedSources: ReadonlyMap<string, string> = NO_LOCKS,
  /** Дескриптор редактируемого текста блока, либо `null` (задача e2c14673). */
  blockEdit: BlockEditState | null = null,
): { deco: DecorationSet; atomic: RangeSet<Decoration> } {
  const parts: Array<{ from: number; to: number; value: Decoration }> = [];
  const atomParts: Array<{ from: number; to: number; value: Decoration }> = [];
  const refs = parseTransclusions(source);
  // Диапазон активной правки блока: ссылки внутри него остаются обычным
  // редактируемым текстом (не заменяются виджетами), а сам диапазон получает
  // рамку-обводку (задача e2c14673).
  const beFrom = blockEdit === null ? -1 : blockEdit.from;
  const beTo = blockEdit === null ? -1 : blockEdit.to;

  for (const ref of refs) {
    if (blockEdit !== null && ref.start >= beFrom && ref.end <= beTo) continue;
    const idFrom = ref.start + OPEN_LEN;
    const innerEnd = ref.end - 2;
    const hash2 = source.indexOf('#', idFrom + 1);
    const idTo = hash2 !== -1 && hash2 < innerEnd ? hash2 : innerEnd;
    const key = networkId === null ? null : transclusionCacheKey(networkId, ref);
    const entry = key === null ? undefined : cache.get(key);
    const title = entry?.title ?? '';
    const deleted = entry !== undefined && !entry.exists;
    const lockedBy = lockedSources.get(ref.sourceId) ?? null;
    // Выделение покрывает диапазон ссылки целиком — блок показывается как
    // выделенное единое целое (ошибка 39553204): рамка вокруг, без подсветки
    // внутреннего текста (неделимость блока — ошибка 5312142d).
    const covered = coversRef(selection, ref.start, ref.end);

    // Режим правки блока перекрывает прочие режимы: блок остаётся блоком даже
    // при каретке внутри ссылки (задача f59d24e1).
    if (editingSourceId !== null && editingSourceId === ref.sourceId) {
      // Неделимость блока при навигации стрелками (задача a2b68d72): диапазон
      // целиком атомарен — курсор не заходит внутрь развёрнутого блока.
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
            true,
            lockedBy,
            covered,
            ref.section,
          ),
          inclusive: false,
        }),
      });
      continue;
    }

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
    // блок распадается в исходный markdown (блокер верификатора).
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
          false,
          lockedBy,
          covered,
          ref.section,
        ),
        inclusive: false,
      }),
    });
  }

  // Вложенное поле правки блока (ошибка 9c2e077a): рамку рисуем ЛИНЕЙНЫМИ
  // декорациями на каждой строке диапазона — получается одно сплошное
  // прямоугольное поле внутри окружения. Прежняя одна inline-`mark` на весь
  // диапазон рвала рамку по строкам (каждая строка — свой box-shadow), отсюда
  // «обведённые рамкой строки» вместо вложенного поля.
  if (blockEdit !== null && blockEdit.to > blockEdit.from) {
    const docLen = source.length;
    const from = Math.max(0, Math.min(blockEdit.from, docLen));
    const to = Math.max(from, Math.min(blockEdit.to, docLen));
    if (to > from) {
      const starts = lineStartOffsets(source);
      const firstLine = lineIndexAt(starts, from);
      const lastLine = lineIndexAt(starts, to - 1);
      for (let line = firstLine; line <= lastLine; line += 1) {
        const classes = [TRANSCLUSION_EDIT_RANGE_CLASS];
        if (line === firstLine) classes.push(TRANSCLUSION_EDIT_FIRST_CLASS);
        if (line === lastLine) classes.push(TRANSCLUSION_EDIT_LAST_CLASS);
        parts.push({
          from: starts[line]!,
          to: starts[line]!,
          value: Decoration.line({ class: classes.join(' ') }),
        });
      }
    }
  }

  return { deco: Decoration.set(parts, true), atomic: RangeSet.of(atomParts, true) };
}

/** Заглушка данных до загрузки источника. */
function emptyEntry(): TransclusionEntry {
  return { title: '', exists: true, error: null, html: '', body_md: '' };
}

/** Поле состояния: кэш данных, режим правки блока, захваты, декорации. */
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
      editingSourceId: null,
      blockEdit: null,
      lockedSources: NO_LOCKS,
      deco,
      atomic,
    };
  },
  update(state, tr) {
    let networkId = state.networkId;
    let cache = state.cache;
    let editingSourceId = state.editingSourceId;
    let blockEdit = state.blockEdit;
    let lockedSources = state.lockedSources;
    // Диапазон правки блока едет за правками документа (задача e2c14673).
    if (tr.docChanged && blockEdit !== null) {
      const from = tr.changes.mapPos(blockEdit.from, -1);
      const to = tr.changes.mapPos(blockEdit.to, 1);
      if (from !== blockEdit.from || to !== blockEdit.to) {
        blockEdit = { ...blockEdit, from, to };
      }
    }
    for (const effect of tr.effects) {
      if (effect.is(setEntries)) {
        if (cache === state.cache) cache = new Map(cache);
        for (const { key, entry } of effect.value) cache.set(key, entry);
      } else if (effect.is(dropEntries)) {
        if (cache === state.cache) cache = new Map(cache);
        for (const key of effect.value) cache.delete(key);
      } else if (effect.is(setBlockEdit)) {
        editingSourceId = effect.value;
      } else if (effect.is(setBlockEditRange)) {
        blockEdit = effect.value;
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
      editingSourceId === state.editingSourceId &&
      blockEdit === state.blockEdit &&
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
      editingSourceId,
      lockedSources,
      blockEdit,
    );
    return { networkId, cache, editingSourceId, blockEdit, lockedSources, deco, atomic };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (s) => s.deco),
    // Активная правка блока — отдельная область сворачивания для CM6
    // (ошибка 4204e34c): её заголовки адресуются состоянию пути вставки блока,
    // а не состоянию поля-контейнера.
    blockEditCollapseFacet.from(f, (s) =>
      s.blockEdit === null
        ? null
        : { from: s.blockEdit.from, to: s.blockEdit.to, sourceId: s.blockEdit.sourceId },
    ),
  ],
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
 * рисуются replace-виджетом блока (не режим правки ссылки и не свёрнутая
 * ссылка). Нужны навигации-выделению (ошибка `5312142d`).
 */
function blockRanges(state: EditorState): BlockRange[] {
  const field = state.field(transclusionState, false);
  if (field === undefined) return [];
  const selection = state.selection.main;
  const out: BlockRange[] = [];
  for (const ref of parseTransclusions(state.doc.toString())) {
    if (field.editingSourceId !== null && field.editingSourceId === ref.sourceId) {
      out.push({ from: ref.start, to: ref.end, ref });
      continue;
    }
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
 * Навигация-выделение блока-атома стрелками (ошибка `5312142d`). Стрелка,
 * входящая в блок из позиции перед/после, выделяет блок ЦЕЛИКОМ одним шагом;
 * следующее нажатие уводит каретку за его границу (блок остаётся единым).
 * Возвращает `true`, если нажатие обработано (иначе стрелку отдаём CM6).
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
  else if (dir === 'down') block = blockOnLineAfter(state, blocks, pos);
  else block = blockOnLineBefore(state, blocks, pos);
  if (block === null) return false;
  view.dispatch({
    selection: { anchor: block.from, head: block.to },
    scrollIntoView: true,
    userEvent: 'select',
  });
  return true;
}

/**
 * Обработчик `mousedown` трансклюзий: клик по блоку ВЫДЕЛЯЕТ его целиком как
 * единый атом (ошибка `5312142d`), клик по шапке-чипу открывает поповер правки
 * ссылки (каретку не двигает), клик вне правки блока завершает её записью в
 * источник (задача `e2c14673`).
 *
 * Реагирует только на ОСНОВНУЮ кнопку мыши (`event.button === 0`): правый и
 * средний клик — жесты вызова контекстного меню, они не должны менять
 * выделение (ошибка `27b95e60`). Событие при этом не гасим — `contextmenu`
 * открывает меню поверх прежнего состояния. Родной обработчик CM6 на неосновных
 * кнопках выделение не двигает (`view/dist/index.js`: basicMouseSelection —
 * только при `button == 0`).
 */
export function transclusionMouseDown(event: MouseEvent, view: EditorView): boolean {
  if (event.button !== 0) return false;
  const target = event.target as Element | null;
  // Шапка-чип блока (элемент 7a479549): клик открывает поповер правки ссылки,
  // каретку не двигаем — событие обработает сам чип (`createTransclusionHead`
  // гасит `mousedown`, сохраняя фокус редактора).
  if (target !== null && target.closest(`.${TRANSCLUSION_HEAD_CLASS}`) !== null) return true;
  // Ховер-кнопка блока: не трогаем курсор, событие обработает сама кнопка.
  if (target !== null && target.closest(`.${TRANSCLUSION_ACTIONS_CLASS}`) !== null) return true;
  // Клик вне редактируемого текста блока — записать изменения блока в
  // источник и выйти из режима правки блока (задача e2c14673, элемент
  // 2b116d37). Курсор ставится обычным путём (return false).
  const be = view.state.field(transclusionState, false)?.blockEdit ?? null;
  if (be !== null) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null || pos < be.from || pos > be.to) {
      void saveBlockEdit(view);
      return false;
    }
    return false;
  }
  const block = target?.closest?.(`.${TRANSCLUSION_BLOCK_CLASS}`);
  if (block instanceof HTMLElement) {
    // Блок выделяется как ЕДИНОЕ ЦЕЛОЕ (ошибка 5312142d): клик ставит выделение
    // на весь диапазон блока, а не каретку внутрь ссылки (иначе блок распался бы
    // в исходный markdown) и не «поглощается» молча, как раньше. Диапазон берём
    // из атрибутов виджета; каретка внутрь атомарного диапазона не встаёт.
    const from = Number(block.dataset['mdFrom']);
    const to = Number(block.dataset['mdTo']);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return true;
    const sel = view.state.selection.main;
    if (sel.from === from && sel.to === to) return true; // уже выделен — не трогаем
    view.dispatch({
      selection: { anchor: from, head: to },
      scrollIntoView: false,
      userEvent: 'select',
    });
    return true;
  }
  return false;
}

/** Клики по блоку: выделение блока целиком; шапка/кнопка обрабатывают себя сами. */
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
  const from = Number(el.dataset.mdFrom);
  if (!Number.isFinite(from)) return null;
  // Ищем ссылку по НАЧАЛУ диапазона (`data-md-from`), а не по каретке: с
  // исключающими границами `transclusionAtCaret` на `start` ссылка не находится.
  return transclusionRefStartingAt(view.state.doc.toString(), from);
}

/**
 * Ссылка-БЛОК под целью события (`.cm-transclusion-block`) — для двойного
 * клика (вход в правку блока).
 */
function transclusionBlockRefAt(view: EditorView, target: Element | null): TransclusionRef | null {
  const el = target?.closest?.(`.${TRANSCLUSION_BLOCK_CLASS}`);
  if (!(el instanceof HTMLElement)) return null;
  const from = Number(el.dataset.mdFrom);
  if (!Number.isFinite(from)) return null;
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
 * Обработчики меню блока (элемент `1e0fb0bd`): «Редактировать» — вход в правку
 * блока (режим этого модуля) плюс четыре команды навигации
 * ({@link transclusionNavHandlers}). Прежних «Изменить ссылку» и сворачивания
 * блока нет — ссылка правится чипом-шапкой и поповером.
 */
export function transclusionMenuHandlers(
  view: EditorView,
  ref: TransclusionRef,
): Record<string, () => void> {
  return {
    'transclusion.edit': () => {
      void beginBlockEdit(view, ref);
    },
    ...transclusionNavHandlers(ref.sourceId, ref.raw),
  };
}

/**
 * Контекстное меню блока трансклюзии (элемент `1e0fb0bd`): правый клик по блоку
 * в режиме правки окружения. Пока блок в правке, действует меню поля — там блок
 * уже обычный текст. Событие гасится, чтобы не дошло до меню поля
 * (`markdown-field` слушает `editor.dom`). Открывается поверх текущего
 * состояния: `mousedown` по неосновной кнопке выделение не двигает (см.
 * {@link transclusionMouseDown}, ошибка `27b95e60`).
 */
export function transclusionContextMenuHandler(event: MouseEvent, view: EditorView): boolean {
  if (isBlockEditing(view.state)) return false;
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
 * Режим правки блока и захват источника (задача f59d24e1)
 * ------------------------------------------------------------------ */

/**
 * Хост поля комментария: уведомление о входе/выходе из правки блока. Поле
 * подменяет кнопки под полем на «Отменить/Сохранить трансклюзию»
 * (элемент интерфейса `2b116d37`). Фасет необязателен — без хоста режим
 * правки работает, но кнопки поля не переключаются.
 */
export interface TransclusionEditHost {
  /** Режим правки блока включён (`true`) или выключен (`false`). */
  onBlockEditChange(editing: boolean): void;
}

/** Фасет хоста поля: единственное значение (последнее — при нескольких). */
const transclusionEditHostFacet = Facet.define<TransclusionEditHost, TransclusionEditHost | null>({
  combine: (values) => values[values.length - 1] ?? null,
});

/** Расширение-хост для поля: уведомляет о входе/выходе из правки блока. */
export function transclusionEditHostExtension(host: TransclusionEditHost): Extension {
  return transclusionEditHostFacet.of(host);
}

/** Ссылка трансклюзии под позицией `pos`, либо `null`. */
function transclusionRefAt(view: EditorView, pos: number): TransclusionRef | null {
  return transclusionAtCaret(view.state.doc.toString(), pos)?.ref ?? null;
}

/**
 * Активна ли правка блока (есть редактируемый текст источника). Пока она
 * активна, `Enter` НЕ перехватывается: его обрабатывает родительский keymap
 * (перевод строки/список), иначе клавиша «мертва» и хоткеи родительского
 * редактора не действуют на текст блока.
 */
export function isBlockEditing(state: EditorState): boolean {
  return state.field(transclusionState, false)?.blockEdit != null;
}

/**
 * Восстанавливает исходную ссылку вместо текста блока и выходит из правки.
 *
 * Каретку ставим ЗА восстановленным блоком (ошибка `640c0ade`): при
 * автоматическом отображении позиции она оставалась на месте прежнего текста —
 * визуально над блоком, а блок не перерисовывался. Явная позиция на правой
 * границе блока (границы {@link transclusionAtCaret} исключающие) сразу
 * оставляет блок в режиме просмотра. Дополнительные эффекты (`extraEffects`,
 * например сброс кэша источника) применяются ТОЙ ЖЕ транзакцией — тогда
 * пересчёт декораций и перепланирование загрузчика идут сразу, без движения
 * каретки.
 */
export function restoreBlockEdit(
  view: EditorView,
  be: BlockEditState,
  extraEffects: readonly StateEffect<unknown>[] = [],
): void {
  const len = view.state.doc.length;
  const from = Math.max(0, Math.min(be.from, len));
  const to = Math.max(from, Math.min(be.to, len));
  view.dispatch({
    changes: { from, to, insert: be.refRaw },
    selection: { anchor: from + be.refRaw.length },
    scrollIntoView: true,
    effects: [setBlockEdit.of(null), setBlockEditRange.of(null), ...extraEffects],
  });
}

/** Выход из режима правки блока БЕЗ записи в источник (Esc, «Отменить»). */
export function cancelBlockEdit(view: EditorView): void {
  const be = view.state.field(transclusionState, false)?.blockEdit ?? null;
  if (be === null) {
    view.dispatch({ effects: [setBlockEdit.of(null), setBlockEditRange.of(null)] });
    return;
  }
  restoreBlockEdit(view, be);
}

/** Историческое имя: выход из правки блока = отмена (записи нет). */
export const exitBlockEdit = cancelBlockEdit;

/** Источник и раздел, текст которых открывается в правку блока. */
export interface BlockEditTarget {
  sourceId: string;
  /** Раздел источника, либо `null` — весь постоянный комментарий. */
  section: string | null;
}

/**
 * Вход в режим правки блока: вместо ссылки `replaceRef` в поле вставляется
 * текст источника `target` — правка идёт в том же поле, поэтому команды и
 * сочетания родительского редактора действуют на текст блока. Раздел — только
 * его содержимое (заголовок живёт в ссылке). Захват источника ставит плагин по
 * смене `editingSourceId`.
 *
 * Для обычного блока (задача `e2c14673`) `replaceRef` и `target` описывают
 * одну и ту же ссылку; для ВЛОЖЕННОГО блока из просмотра (ошибка `23570aef`)
 * замена идёт на месте ВНЕШНЕЙ ссылки контейнера, а текст берётся из вложенного
 * источника — ссылка возвращается при сохранении/отмене (`refRaw`), поэтому
 * контейнер не портится.
 */
async function startBlockEdit(
  view: EditorView,
  replaceRef: TransclusionRef,
  target: BlockEditTarget,
  placeCaret: boolean,
): Promise<void> {
  const networkId = safeNetwork();
  if (networkId === null) return;
  const key = transclusionCacheKeyParts(networkId, target.sourceId, target.section);
  const cached = view.state.field(transclusionState, false)?.cache.get(key);
  // Битый источник (нет мысли/раздела) в правку не открываем.
  if (cached !== undefined && (cached.error !== null || !cached.exists)) return;
  let body = cached?.body_md ?? '';
  if (cached === undefined) {
    // Вход в правку читает источник ВСЕГДА свежим (без общего кэша сети):
    // пользователь правит текущий текст источника, а не то, что когда-то
    // отрисовал другой инстанс. Общий кэш ({@link cachedTransclusionLoader})
    // обслуживает отрисовку блоков и подсказки разделов.
    const src = await defaultTransclusionLoader(networkId)(target.sourceId).catch(() => null);
    if (src === null || !src.found) return;
    body = src.body_md;
  }
  const text = target.section === null ? body : sectionBodyForEdit(body, target.section);
  if (text === null) return; // раздела нет — в правку не входим
  // Ссылка могла исчезнуть/сдвинуться, пока грузили источник.
  const fresh = transclusionRefStartingAt(view.state.doc.toString(), replaceRef.start);
  if (fresh === null || fresh.sourceId !== replaceRef.sourceId) return;
  view.dispatch({
    changes: { from: fresh.start, to: fresh.end, insert: text },
    // Открытие вложенного блока из просмотра переводит каретку в начало
    // вставленного текста: пользователь сразу попадает в правку блока.
    ...(placeCaret ? { selection: { anchor: fresh.start } } : {}),
    effects: [
      setBlockEdit.of(target.sourceId),
      setBlockEditRange.of({
        sourceId: target.sourceId,
        section: target.section,
        refRaw: fresh.raw,
        from: fresh.start,
        to: fresh.start + text.length,
      }),
    ],
  });
}

/**
 * Вход в правку блока по ссылке контейнера (задача `e2c14673`): текст берётся
 * из самого источника ссылки.
 */
async function beginBlockEdit(view: EditorView, ref: TransclusionRef): Promise<void> {
  await startBlockEdit(view, ref, { sourceId: ref.sourceId, section: ref.section }, false);
}

/**
 * Вход в правку блока ВЛОЖЕННОГО источника из просмотра (ошибка `23570aef`).
 * Позиции вложенной ссылки в `body_md` контейнера не существует (текст приходит
 * из источника другой мысли), поэтому на месте ВНЕШНЕЙ ссылки `outerRef`
 * вставляется текст вложенного источника `target`, а `outerRef.raw` сохраняется
 * для восстановления — контейнер при этом не меняется.
 */
export async function beginNestedBlockEdit(
  view: EditorView,
  outerRef: TransclusionRef,
  target: BlockEditTarget,
): Promise<void> {
  await startBlockEdit(view, outerRef, target, true);
}

/**
 * Записывает изменённый текст блока в постоянный комментарий источника
 * (задача `e2c14673`) через существующий API правки комментария под захватом;
 * после записи восстанавливает ссылку. Ошибка (в т.ч. `409 LOCKED` при чужом
 * захвате — ошибка `68be6829`) оставляет правку открытой и показывает
 * уведомление. Предупреждение о переходе границы раздела не запрещает запись.
 */
export async function saveBlockEdit(view: EditorView): Promise<void> {
  const be = view.state.field(transclusionState, false)?.blockEdit ?? null;
  if (be === null) return;
  const networkId = safeNetwork();
  if (networkId === null) return;
  const text = view.state.doc.sliceString(be.from, be.to);
  let perm: Comment | undefined;
  try {
    const comments = await etn.comments.list(networkId, 'thought', be.sourceId);
    perm = comments.find((c) => c.kind === 'permanent');
  } catch {
    perm = undefined;
  }
  if (perm === undefined) {
    notice(t('comment.transclusion.noSource'), 'warning');
    return;
  }
  let newBody = text;
  if (be.section !== null) {
    const merged = mergeSectionContent(perm.body_md, be.section, text);
    if (merged === null) {
      notice(t('comment.transclusion.noSection'), 'warning');
      return;
    }
    newBody = merged;
    if (sectionBoundaryCrossed(perm.body_md, be.section, text)) {
      notice(t('comment.transclusion.sectionBoundary'), 'warning');
    }
  }
  try {
    await etn.comments.update(networkId, perm.id, { body_md: newBody }, perm.version);
  } catch {
    // В том числе 409 LOCKED: источник захвачен другим участником.
    notice(t('comment.transclusion.saveError'), 'error');
    return;
  }
  const current = view.state.field(transclusionState, false)?.blockEdit ?? null;
  if (current === null) return;
  // Источник изменился — сбрасываем кэш, блок в просмотре перечитывается. Для
  // вложенного блока (ошибка 23570aef) ещё и внешняя ссылка контейнера: её блок
  // содержит отредактированный текст источника. Восстановление ссылки, закрытие
  // правки, постановка каретки за блок и сброс кэша идут ОДНОЙ транзакцией
  // (ошибка 640c0ade): иначе каретка оставалась над блоком, а декорации/загрузчик
  // не пересчитывались без движения каретки.
  const keys = new Set<string>([
    transclusionCacheKeyParts(networkId, current.sourceId, current.section),
  ]);
  for (const outer of parseTransclusions(current.refRaw)) {
    keys.add(transclusionCacheKeyParts(networkId, outer.sourceId, outer.section));
  }
  // Записанный источник больше не актуален — сбрасываем его из ОБЩЕГО кэша
  // сети, иначе повторная загрузка вернула бы старое тело (источник виден всем
  // инстансам, включая вложенные редакторы).
  invalidateTransclusionSource(networkId, current.sourceId);
  restoreBlockEdit(view, current, [dropEntries.of([...keys])]);
}

/**
 * Двойной клик НА блоке открывает правку блока (ошибка `5312142d`). Ссылку
 * берём из DOM-элемента блока, а не из координат: у блока-виджета позиция под
 * мышью лежит на его границе, где {@link transclusionAtCaret} (исключающие
 * границы) ссылку уже не находит. Двойной клик по шапке-чипу правку блока НЕ
 * открывает — чип обрабатывает себя сам (открытие поповера).
 */
export function transclusionDblClick(event: MouseEvent, view: EditorView): boolean {
  const be = view.state.field(transclusionState, false)?.blockEdit ?? null;
  if (be !== null) return true;
  const target = event.target as Element | null;
  if (target !== null && target.closest?.(`.${TRANSCLUSION_HEAD_CLASS}`) != null) return true;
  const ref = transclusionBlockRefAt(view, target);
  if (ref === null) return false;
  void beginBlockEdit(view, ref);
  return true;
}

/** Вход в режим правки блока: двойной клик и Enter (элемент `2b116d37`). */
export const transclusionEditGestures = [
  Prec.high(
    keymap.of([
      {
        key: 'Enter',
        run: (view) => {
          // Открытый автокомплит (мысли/разделы) обрабатывает Enter сам.
          if (completionStatus(view.state) === 'active') return false;
          // В правке блока Enter — обычный перевод строки: не перекрываем
          // родительский keymap (defaultKeymap/markdown). Иначе клавиша «мертва»
          // и хоткеи родительского редактора не действуют на текст блока.
          if (isBlockEditing(view.state)) return false;
          // Блок выделен целиком — Enter переводит его в режим правки
          // (ошибка 5312142d). На строке ПЕРЕД/ПОСЛЕ блока каретка на границе
          // ссылки, покрытия нет — Enter остаётся обычным переводом строки.
          const covering = refCoveringSelection(view.state, view.state.selection.main);
          if (covering !== null) {
            void beginBlockEdit(view, covering);
            return true;
          }
          const ref = transclusionRefAt(view, view.state.selection.main.head);
          if (ref === null) return false;
          void beginBlockEdit(view, ref);
          return true;
        },
      },
      {
        key: 'Mod-Enter',
        run: (view) => {
          // Ctrl+Enter в правке блока — записать блок в источник, оставаясь в
          // правке окружения; повторный Ctrl+Enter запишет окружение (e2c14673).
          if (view.state.field(transclusionState, false)?.blockEdit === null) return false;
          void saveBlockEdit(view);
          return true;
        },
      },
      {
        key: 'Escape',
        run: (view) => {
          // Открытый автокомплит закрывает Escape сам.
          if (completionStatus(view.state) === 'active') return false;
          const be = view.state.field(transclusionState, false)?.blockEdit ?? null;
          // Esc в правке блока отменяет её, не отменяя правку всего поля.
          if (be === null) return false;
          cancelBlockEdit(view);
          return true;
        },
      },
      // `#` при открытом списке мыслей трансклюзии принимает выделенную мысль
      // и сразу открывает список разделов источника (ошибка `ccf4d25f`,
      // элемент `7a479549`). В любом другом состоянии `#` — обычный ввод.
      { key: '#', run: (view) => acceptTransclusionThought(view) },
      // Навигация-выделение блока-атома стрелками (ошибка 5312142d): стрелка,
      // входящая в блок из позиции перед/после, выделяет его целиком; обычные
      // шаги вне блока отдаём CM6 (обработчик возвращает false).
      { key: 'ArrowRight', run: (view) => transclusionBlockArrow(view, 'right') },
      { key: 'ArrowLeft', run: (view) => transclusionBlockArrow(view, 'left') },
      { key: 'ArrowDown', run: (view) => transclusionBlockArrow(view, 'down') },
      { key: 'ArrowUp', run: (view) => transclusionBlockArrow(view, 'up') },
    ]),
  ),
  EditorView.domEventHandlers({
    dblclick: transclusionDblClick,
  }),
] as const;

/** Сравнивает карты чужих захватов (чтобы не слать лишние транзакции). */
function sameLockMap(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

/**
 * Плагин режима правки блока: держит захват мысли-источника, пока блок в
 * правке (существующий механизм `lib/lock-guard.ts`, ADR `fdb1a271`), и ведёт
 * карту чужих захватов для «замочка» (требование `647fa34a`). Запись в источник
 * выполняет {@link saveBlockEdit} (задача `e2c14673`).
 */
const transclusionEditPlugin = ViewPlugin.fromClass(
  class {
    handle: LockHandle | null = null;
    source: string | null = null;
    host: TransclusionEditHost | null = null;
    disposed = false;
    /** Пересбор карты захватов уже запланирована (микрозадача). */
    locksScheduled = false;
    unsubscribe: () => void;

    constructor(readonly view: EditorView) {
      this.unsubscribe = subscribeLockCache(() => this.refreshLocks());
      this.refreshLocks();
      this.sync(this.view.state);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) this.refreshLocks();
      const before = update.startState.field(transclusionState, false)?.editingSourceId ?? null;
      const after = update.state.field(transclusionState, false)?.editingSourceId ?? null;
      if (before !== after) this.sync(update.state);
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

    /** Реагирует на смену источника в правке: захват нового, снятие старого. */
    sync(state: EditorState): void {
      const next = state.field(transclusionState, false)?.editingSourceId ?? null;
      this.host = state.facet(transclusionEditHostFacet);
      if (next === this.source) return;
      releaseHeld(this.handle);
      this.handle = null;
      this.source = next;
      this.host?.onBlockEditChange(next !== null);
      if (next === null) return;
      const source = next;
      void acquireOrShowBlocked('thought', source).then((outcome) => {
        if (this.disposed || this.source !== source) return;
        this.handle = lockHandleFromOutcome('thought', source, outcome);
        if (outcome.kind === 'blocked') {
          // Источник держит другой участник — в правку не входим, «замочек» уже
          // показан картой захватов (lock-guard сам уведомил пользователя).
          // Отменяем правку — ссылка восстанавливается (e2c14673).
          cancelBlockEdit(this.view);
          this.refreshLocks();
        }
      });
    }

    destroy(): void {
      this.disposed = true;
      this.unsubscribe();
      releaseHeld(this.handle);
      this.handle = null;
      this.host?.onBlockEditChange(false);
    }
  },
);

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
  transclusionEditPlugin,
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
  /** Очистка общего (на сеть) кэша источников — изоляция прогонов тестов. */
  clearSourceCache: () => sourceCache.clear(),
  setEntries,
  setBlockEditRange,
  dropEntries,
  sectionParts,
  beginBlockEdit,
  beginNestedBlockEdit,
  saveBlockEdit,
  restoreBlockEdit,
  loadThoughtEntries,
  sourceSectionTitles,
};
