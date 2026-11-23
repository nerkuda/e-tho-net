/**
 * Live preview (task M6): WYSIWYM-декорации markdown-редактора.
 *
 * Неактивные блоки отображаются так, как они будут выглядеть в HTML-просмотре:
 * маркеры синтаксиса (решётки заголовков, `*` emphasis, `>` цитат, URL ссылок)
 * скрываются, а целые блоки (fenced-код, картинки, таблицы, wiki-ссылки,
 * горизонтальные линейки) становятся DOM-виджетами, отрендеренными ТЕМ ЖЕ
 * конвейером @etn/markdown, который создаёт кешированный серверный HTML.
 * Курсор внутри блока (или клик по виджету) показывает исходный markdown.
 *
 * Декорации выдаёт StateField (block-декорации, пересекающие переносы строк,
 * из ViewPlugin запрещены); клики по виджетам обрабатывает domEventHandlers.
 *
 * Разбор HTML блоков-виджетов идёт через кеш `md-render-cache.ts` (ошибка
 * 83785f1e): `buildDecorations` пересобирается на каждую транзакцию, а исходник
 * неактивного блока при правке в другом месте не меняется — без кеша
 * markdown-it разбирал его заново на каждый введённый символ.
 */

import { syntaxTree } from '@codemirror/language';
import { EditorState, Facet, StateField, type Range, type SelectionRange } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';

import {
  TASK_MARKER_PATTERN,
  WIKI_LINK_CLASS,
  WIKI_LINK_DATE_ATTR,
  WIKI_LINK_DATE_CLASS,
  WIKI_LINK_TIME_ATTR,
  formatDateLinkLabel,
  parseDateLinkTarget,
  parseTaskLines,
  type TaskLine,
} from '@etn/markdown';

import { t } from '../lib/i18n.js';
import { choiceControl } from '../lib/ui/choice-row.js';
import { isCollapsedHiddenAt, setCollapseEffect } from './comment-collapse.js';
import { renderMermaidBlocks } from './md-mermaid.js';
import { cachedRenderMarkdown } from './md-render-cache.js';

/** Корневой класс всех виджетов live preview. */
export const MD_WIDGET_CLASS = 'md-widget';

/**
 * Обработчик левого клика по легаси-виджету wiki-ссылки. Ставит `wiki-link.ts`
 * при инициализации (`initWikiLinkNavigation`) — так развилка «резолв имени →
 * конвертация в id-формат → открытие» (0.12.2, задача 8e4e3dc5) живёт рядом с
 * навигацией по ссылкам, а `md-live` не тянет её модуль в себя (иначе цикл
 * `wiki-link ↔ md-live`). Клик по легаси-ссылке НЕ раскрывает исходник (M6 для
 * прочих виджетов сохраняется) — развилка выполняется прямо на `mousedown`,
 * пока виджет ещё в DOM.
 */
let legacyWikiLinkClickHandler:
  ((widget: HTMLElement, view: EditorView, event: MouseEvent) => void) | null = null;

/** Регистрирует обработчик легаси-виджета (см. {@link legacyWikiLinkClickHandler}). */
export function setLegacyWikiLinkClickHandler(
  handler: ((widget: HTMLElement, view: EditorView, event: MouseEvent) => void) | null,
): void {
  legacyWikiLinkClickHandler = handler;
}

/**
 * Обработчик левого клика по date-чипу в редакторе (0.16.1, требование
 * 31fe2cc9): открывает день в «Дневнике». Ставит `wiki-link.ts` при
 * инициализации — тот же приём, что у легаси-ссылки: клик по виджету
 * перехватывается на `mousedown`, пока узел ещё в DOM.
 */
let dateChipClickHandler: ((date: string) => void) | null = null;

/** Регистрирует обработчик клика по date-чипу (см. {@link dateChipClickHandler}). */
export function setDateChipClickHandler(handler: ((date: string) => void) | null): void {
  dateChipClickHandler = handler;
}

/**
 * Передать клик по date-чипу обработчику дня — ЕДИНЫЙ вход для чипа редактора
 * (`mousedown`, здесь) и чипа просмотра (делегированный `click`,
 * `wiki-link.ts`). Возвращает `false`, если обработчик ещё не зарегистрирован
 * (навигация не инициализирована) — тогда чип ведёт себя как прочий виджет.
 */
export function clickDateChip(date: string): boolean {
  if (dateChipClickHandler === null) return false;
  dateChipClickHandler(date);
  return true;
}

/**
 * Блочное правило (M6-фикс): блок активен, пока каретка/выделение
 * пересекает его диапазон ВКЛЮЧИТЕЛЬНО — от первого до последнего символа
 * блока маркеры не скрываются.
 */
export function isInRangeInclusive(
  ranges: readonly SelectionRange[],
  from: number,
  to: number,
): boolean {
  return ranges.some((r) => r.from <= to && r.to >= from);
}

/**
 * Инлайн-правило (M6-фикс): элемент активен, пока каретка внутри него или
 * непосредственно перед/после (позиции `from-1` … `to`).
 */
export function isNearInline(ranges: readonly SelectionRange[], from: number, to: number): boolean {
  return ranges.some((r) => {
    if (r.empty) return r.from >= from - 1 && r.from <= to;
    return r.to >= from - 1 && r.from <= to + 1;
  });
}

/**
 * Что уже отрисовано в DOM каждого HTML-виджета — мемо per-DOM (`WeakMap`, как
 * `renderedContent` в `transclusion.ts`): у нескольких живых полей свои DOM, и
 * «последний отрисованный HTML» в модульной переменной сломал бы соседей.
 * Сдвиг блока правкой текста ВЫШЕ меняет `from/to`, а содержимое оставляет
 * прежним — без мемо CM6 пересоздавал бы виджет и заново рендерил mermaid на
 * каждый введённый символ (ошибка `4df5e284`).
 */
const renderedHtml = new WeakMap<HTMLElement, string>();

/** Базовый виджет: HTML-блок из единого рендерера; клик раскрывает исходник. */
class HtmlWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly html: string,
  ) {
    super();
  }

  override eq(other: HtmlWidget): boolean {
    return other.from === this.from && other.to === this.to && other.html === this.html;
  }

  override toDOM(): HTMLElement {
    const box = document.createElement('div');
    box.className = `${MD_WIDGET_CLASS} comment-view`;
    box.dataset.mdFrom = String(this.from);
    box.dataset.mdTo = String(this.to);
    // HTML из @etn/markdown экранируется по построению (тот же контракт,
    // что и у серверного body_html).
    box.innerHTML = this.html;
    renderedHtml.set(box, this.html);
    // Mermaid-блоки рендерятся асинхронно после монтирования виджета (M7).
    // Без requestAnimationFrame: в фоновом окне Electron он не тикает.
    renderMermaidBlocks(box);
    return box;
  }

  /**
   * Обновляет существующий DOM блока вместо его пересоздания (WidgetType API):
   * сдвиг правкой текста выше меняет лишь абсолютные `from/to`, содержимое —
   * нет. `eq` при этом остаётся строгим по смещениям (он и есть триггер этого
   * метода), а `data-md-from/to` пишутся всегда: `mdWidgetMouseDown` читает
   * смещения из DOM, и протухшие атрибуты увели бы каретку в старый диапазон.
   * Пересборка содержимого — только при смене `html` (см. {@link renderedHtml});
   * `renderMermaidBlocks` вызывается лишь на этом пути, чтобы диаграмма не
   * гасла и не перерисовывалась на каждый символ (ошибка `4df5e284`).
   *
   * Тот же приём обязателен и лёгким виджетам ниже (`WikiLinkWidget`,
   * `WikiDateWidget`, `HrWidget`, `TaskCheckboxWidget`, `ListMarkerWidget`,
   * ошибка `65bd3e81`): их `eq` различает смещения, поэтому без `updateDOM`
   * любой ввод текста выше блока пересоздавал DOM.
   */
  override updateDOM(dom: HTMLElement): boolean {
    dom.dataset.mdFrom = String(this.from);
    dom.dataset.mdTo = String(this.to);
    if (renderedHtml.get(dom) === this.html) return true;
    renderedHtml.set(dom, this.html);
    // `pre.mermaid` не переиспользуем: pending `mermaid.render` пишет в
    // отсоединённый узел, и в свежий DOM пришла бы устаревшая диаграмма.
    dom.innerHTML = this.html;
    renderMermaidBlocks(dom);
    return true;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** Виджет wiki-ссылки: отображается алиас (или имя), скобки скрыты. */
class WikiLinkWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly label: string,
    /**
     * Имя цели легаси-ссылки `[[Имя|алиас]]` (пробелы обрезаны). Виджет несёт
     * его в `data-wiki-target` — по образцу виджета имени ID-формы
     * (`WikiLinkLabelWidget`, `wiki-id-plugin`): клик по легаси-ссылке в
     * редакторе идёт в развилку «резолв имени → конвертация → открытие»
     * (0.12.2, задача 8e4e3dc5), а к моменту `click` узел уже снят
     * (`mdWidgetMouseDown` уводит каретку и раскрывает исходник), поэтому
     * перехват делает сам `mousedown`.
     */
    readonly target: string,
  ) {
    super();
  }

  override eq(other: WikiLinkWidget): boolean {
    return (
      other.from === this.from &&
      other.to === this.to &&
      other.label === this.label &&
      other.target === this.target
    );
  }

  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = `${MD_WIDGET_CLASS} wiki-link`;
    span.textContent = this.label;
    span.dataset.mdFrom = String(this.from);
    span.dataset.mdTo = String(this.to);
    span.dataset.wikiTarget = this.target;
    return span;
  }

  /**
   * Сдвиг правкой выше меняет только смещения — узел остаётся (ошибка
   * 65bd3e81). `data-md-from/to` пишутся всегда: `mdWidgetMouseDown` читает
   * смещения из DOM, протухшие атрибуты увели бы каретку в старый диапазон.
   * Смена подписи или цели — повод пересобрать DOM.
   */
  override updateDOM(dom: HTMLElement): boolean {
    dom.dataset.mdFrom = String(this.from);
    dom.dataset.mdTo = String(this.to);
    return dom.textContent === this.label && dom.dataset.wikiTarget === this.target;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** Date-чип в live-preview: тот же вид, что спан просмотра `@etn/markdown`. */
class WikiDateWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly date: string,
    readonly time: string | null,
    readonly label: string,
  ) {
    super();
  }

  override eq(other: WikiDateWidget): boolean {
    return (
      other.from === this.from &&
      other.to === this.to &&
      other.date === this.date &&
      other.time === this.time &&
      other.label === this.label
    );
  }

  override toDOM(): HTMLElement {
    // Классы и data-атрибуты — те же, что у спана просмотра (0.16.1, элемент
    // f9da2100): чип отличим от мысль-ссылки, а обработчики клика и меню
    // работают по единым константам пакета.
    const span = document.createElement('span');
    span.className = `${MD_WIDGET_CLASS} ${WIKI_LINK_CLASS} ${WIKI_LINK_DATE_CLASS}`;
    span.textContent = this.label;
    span.dataset.mdFrom = String(this.from);
    span.dataset.mdTo = String(this.to);
    span.setAttribute(WIKI_LINK_DATE_ATTR, this.date);
    if (this.time !== null) span.setAttribute(WIKI_LINK_TIME_ATTR, this.time);
    return span;
  }

  /**
   * Тот же класс, что у остальных лёгких виджетов (ошибка 65bd3e81): сдвиг
   * обновляет смещения на месте; смена даты, времени или подписи — пересборка.
   */
  override updateDOM(dom: HTMLElement): boolean {
    dom.dataset.mdFrom = String(this.from);
    dom.dataset.mdTo = String(this.to);
    return (
      dom.textContent === this.label &&
      dom.getAttribute(WIKI_LINK_DATE_ATTR) === this.date &&
      (dom.getAttribute(WIKI_LINK_TIME_ATTR) ?? null) === this.time
    );
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** Горизонтальная линейка. */
class HrWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }

  override eq(other: HrWidget): boolean {
    return other.from === this.from && other.to === this.to;
  }

  override toDOM(): HTMLElement {
    // Обёртка несёт вертикальный отступ (padding, не margin — см. шапку
    // `.md-widget` в styles/editor.css), а линию рисует внутренний `hr`: так
    // зазор 6px сверху и снизу совпадает с `margin: 6px 0` у `.comment-view hr`
    // в просмотре (ошибка 47bce601).
    const box = document.createElement('div');
    box.className = `${MD_WIDGET_CLASS} md-hr`;
    box.dataset.mdFrom = String(this.from);
    box.dataset.mdTo = String(this.to);
    const line = document.createElement('hr');
    line.className = 'md-hr-line';
    box.append(line);
    return box;
  }

  /** Линейка неизменна: сдвиг только обновляет смещения (ошибка 65bd3e81). */
  override updateDOM(dom: HTMLElement): boolean {
    dom.dataset.mdFrom = String(this.from);
    dom.dataset.mdTo = String(this.to);
    return true;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** Чекбокс task-списка (`- [ ]` / `- [x]`): заменяет маркер вне активного пункта. */
class TaskCheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }

  override eq(other: TaskCheckboxWidget): boolean {
    return other.checked === this.checked && other.from === this.from && other.to === this.to;
  }

  override toDOM(): HTMLElement {
    // Контрол строит фасад дизайн-системы (сторож `guard-ui-fields`):
    // голый `<input>` в обход `choiceControl` запрещён.
    //
    // Контрол ЖИВОЙ (0.16.1, уточнение 2026-11-19, пункт 10): клик меняет
    // значение В БУФЕРЕ документа (декорация перерисуется по транзакции), а
    // запись в источник делает сохранение поля — отказ от правки оставляет и
    // текст, и задачи прежними.
    const input = choiceControl('checkbox', { checked: this.checked });
    input.classList.add('cm-md-task-checkbox');
    input.dataset.mdFrom = String(this.from);
    input.dataset.mdTo = String(this.to);
    return input;
  }

  /**
   * Сдвиг обновляет смещения на месте (ошибка 65bd3e81). Смена состояния
   * (`checked`) — пересборка: живой контрол пересоздаётся из нового значения,
   * а не правится втихую.
   */
  override updateDOM(dom: HTMLElement): boolean {
    dom.dataset.mdFrom = String(this.from);
    dom.dataset.mdTo = String(this.to);
    return (dom as HTMLInputElement).checked === this.checked;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Отрисованный маркер списка: заменяет исходный `ListMark` вне активного
 * пункта — `•` для маркированного, `N.` для нумерованного (паритет с
 * просмотром, где `<ul>`/`<ol>` рисуют disc/decimal). Пробел-разделитель
 * остаётся в документе, поэтому маркер идёт перед текстом как в просмотре.
 */
class ListMarkerWidget extends WidgetType {
  constructor(readonly marker: string) {
    super();
  }

  override eq(other: ListMarkerWidget): boolean {
    return other.marker === this.marker;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-md-list-marker';
    span.textContent = this.marker;
    return span;
  }

  /**
   * Смещений виджет не несёт (в `eq` только маркер), поэтому сдвиг выше его
   * не трогает вовсе. `updateDOM` нужен смене нумерации в исходнике: текст
   * маркера обновляется на прежнем узле (ошибка 65bd3e81).
   */
  override updateDOM(dom: HTMLElement): boolean {
    dom.textContent = this.marker;
    return true;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Тихая подсказка разбора строки задачи (0.16.1, элемент интерфейса 8773d9df):
 * блок под строкой в фокусе, без фокуса и кликов — только чтение.
 *
 * Текст считает {@link taskHintText} по тому же парсеру, что и проекция задач
 * (`parseTaskLines` пакета `@etn/markdown`), поэтому подсказка не может
 * разойтись с «Задачами периода».
 */
class TaskHintWidget extends WidgetType {
  constructor(readonly hint: string) {
    super();
  }

  override eq(other: TaskHintWidget): boolean {
    return other.hint === this.hint;
  }

  override toDOM(): HTMLElement {
    const box = document.createElement('div');
    box.className = 'cm-md-task-hint';
    box.textContent = this.hint;
    return box;
  }

  /** Подсказка — не интерактивная: клики и фокус остаются строке. */
  override ignoreEvent(): boolean {
    return true;
  }
}

/** Разбор `[[target|alias]]` для виджета wiki-ссылки (пустой алиас = имя). */
export function wikiLabel(source: string): { target: string; label: string } | null {
  const m = /^\[\[([^[\]\n|]+)(?:\|([^\]\n]*))?\]\]$/.exec(source.trim());
  if (m === null) return null;
  const target = m[1]!.trim();
  const alias = m[2]?.trim() ?? '';
  return { target, label: alias !== '' ? alias : target };
}

/**
 * Распознаёт ID-форму wiki-ссылки (`[[#<uuid>]]` / `[[#<uuid>|<alias>]]` /
 * `[[n:<net>#<uuid>]]` и т.п.). Для таких форм live-preview не ставит свой
 * виджет: имя подтягивает на лету плагин `wikiIdPlugin` (R6), который знает
 * про резолв `etn.thoughts.resolve` и atomic range в edit-mode. Иначе
 * `wikiLabel` отдал бы `target = "#<uuid>"` как label, и пользователь видел
 * бы `#<uuid>` вместо имени мысли.
 */
export function isIdWikiLinkTarget(target: string): boolean {
  if (target.startsWith('#')) {
    const id = target.slice(1).trim();
    // Публикация (0.11.1, задача 3275fd8d): `[[#pub:<uuid>]]` — префиксная
    // ID-форма (ADR 7168009e); виджет рисует `wikiIdPlugin`, не live-preview.
    if (id.startsWith('pub:')) {
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id.slice('pub:'.length).trim(),
      );
    }
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  }
  if (target.startsWith('n:')) {
    const hashAt = target.indexOf('#', 2);
    if (hashAt === -1) return false;
    const net = target.slice(2, hashAt).trim();
    const id = target.slice(hashAt + 1).trim();
    return (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(net) &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    );
  }
  return false;
}

/** Сырая форма маркера чекбокса для дешёвого гейта (грамматика — в пакете). */
const TASK_HINT_GATE_RE = new RegExp(TASK_MARKER_PATTERN);

/** Короткая подпись даты в подсказке (`dd.MM.yyyy`). */
function hintDate(iso: string): string {
  return formatDateLinkLabel({ date: iso, time: null });
}

/**
 * Владелец строки задачи — контекст тихой подсказки (ошибка f720cfff, ТЗ
 * 2026-11-17 пункт A): от него зависит, где окажется строка БЕЗ собственных дат.
 *  • `chronological` — хроно-запись: строка попадает в её период записи;
 *  • `permanent` — постоянный комментарий: строка видна во всех периодах;
 *  • `unknown` — контекст не известен (новая строка до сохранения, чужое поле):
 *    обещать период нельзя, работает та же формулировка «срок не задан…».
 */
export type TaskHintOwner = 'chronological' | 'permanent' | 'unknown';

/** Контекст владельца строки для {@link taskHintText}. */
export interface TaskHintContext {
  owner: TaskHintOwner;
  /** Первый день периода записи-владельца (`YYYY-MM-DD`), `null` — неизвестен. */
  fromDay?: string | null;
  /** Последний день периода записи-владельца (`YYYY-MM-DD`), `null` — как `fromDay`. */
  toDay?: string | null;
}

/** Контекст по умолчанию: поле не знает своего владельца. */
export const DEFAULT_TASK_HINT_CONTEXT: TaskHintContext = { owner: 'unknown' };

/**
 * Фасет контекста подсказки: поле задаёт владельца при монтировании редактора
 * (`MdEditorCallbacks.taskHintContext`), live preview читает его при сборке
 * декораций. Значение по умолчанию — {@link DEFAULT_TASK_HINT_CONTEXT}.
 */
export const taskHintContext = Facet.define<TaskHintContext, TaskHintContext>({
  combine: (values) => values[0] ?? DEFAULT_TASK_HINT_CONTEXT,
});

/**
 * Текст тихой подсказки строки задачи по разбору парсера (элемент 8773d9df):
 * роль строки, период/срок и где она появится. Никаких диалогов и действий.
 *
 * Строка БЕЗ своих дат не «бессрочная»: серверная проекция отдаёт ей период
 * записи-владельца (автопериод, уточнение ТЗ 2026-11-16). Поэтому подсказка
 * обязана знать контекст владельца (`context`): у хроно-записи — её период,
 * у постоянного комментария — «во всех периодах» (ошибка f720cfff).
 */
export function taskHintText(
  row: TaskLine,
  context: TaskHintContext = DEFAULT_TASK_HINT_CONTEXT,
): string {
  const parts: string[] = [];
  if (row.subtask) {
    parts.push(t('editor.taskHint.checklist'));
  } else {
    parts.push(row.done ? t('editor.taskHint.done') : t('editor.taskHint.task'));
    if (!row.undated) {
      if (row.periodFrom !== null && row.periodTo !== null && row.periodFrom !== row.periodTo) {
        parts.push(t('editor.taskHint.period', [hintDate(row.periodFrom), hintDate(row.periodTo)]));
      }
      if (row.due !== null) parts.push(t('editor.taskHint.due', hintDate(row.due)));
      parts.push(t('editor.taskHint.appearsPeriod'));
    } else if (context.owner === 'chronological' && context.fromDay != null) {
      // Хроно-запись: строка живёт в периоде записи — показываем его.
      const toDay = context.toDay ?? context.fromDay;
      const range =
        toDay === context.fromDay
          ? hintDate(context.fromDay)
          : `${hintDate(context.fromDay)} – ${hintDate(toDay)}`;
      parts.push(t('editor.taskHint.recordPeriod', [range]));
      parts.push(t('editor.taskHint.appearsPeriod'));
    } else {
      // Постоянный комментарий (или контекст неизвестен) — задача видна везде.
      parts.push(t('editor.taskHint.undatedAllPeriods'));
    }
  }
  return parts.join(' · ');
}

/**
 * Подсказка для строки в фокусе: `null` — строка не задача (или разбор не
 * нашёл её). Парсер вызывается только когда в текущей/предыдущей строке есть
 * маркер чекбокса: обычный текст не платит за разбор документа.
 */
function taskHintAt(
  state: EditorState,
  context: TaskHintContext,
): { pos: number; text: string } | null {
  const line = state.doc.lineAt(state.selection.main.head);
  const previous = line.number > 1 ? state.doc.line(line.number - 1) : null;
  if (
    !TASK_HINT_GATE_RE.test(line.text) &&
    (previous === null || !TASK_HINT_GATE_RE.test(previous.text))
  ) {
    return null;
  }
  const row = parseTaskLines(state.doc.toString()).find((item) => item.lineNo === line.number);
  if (row === undefined || !row.hasCheckbox) return null;
  return { pos: line.to, text: taskHintText(row, context) };
}

/** Строит набор декораций для текущего состояния. */
function buildDecorations(state: EditorState): DecorationSet {
  // Диапазоны собираются в массив и сортируются в Decoration.set: hide-замены
  // имеют startSide −2, mark — 5e8, поэтому на одной позиции (бэктики внутри
  // InlineCode) порядок вставки не монотонен, и RangeSetBuilder не подходит.
  const parts: Array<Range<Decoration>> = [];
  const ranges = state.selection.ranges;

  const hide = (from: number, to: number): void => {
    parts.push({ from, to, value: Decoration.replace({ inclusive: true }) });
  };

  /** Стек диапазонов Blockquote: маркеры цитат «живут» блоком-родителем. */
  const quoteStack: Array<{ from: number; to: number }> = [];

  /**
   * Стек инлайн-родителей (Link / Emphasis-семейство / InlineCode): маркеры
   * детей скрываются только когда неактивен их инлайн-родитель. Позиции детей
   * из итератора — документальные, поэтому диапазоны родителей запоминаются
   * при входе в узел (метод Tree.getChildren не подходит: его координаты
   * зависят от дерева-объекта, а не от узла).
   */
  const inlineStack: Array<{
    kind: 'link' | 'emphasis' | 'code';
    from: number;
    to: number;
    /** Пустое содержимое пары (`====`, `<u></u>`) — маркеры не скрываются. */
    empty?: boolean;
  }> = [];

  /**
   * Стек пунктов списка: маркер списка (`-`/`N.`) и task-маркер (`[ ]`/`[x]`)
   * «принадлежат» своему `ListItem` — его диапазон задаёт активность обоих.
   */
  const listItemStack: Array<{ from: number; to: number }> = [];

  syntaxTree(state).iterate({
    enter(node) {
      // Внутри тела свёрнутого раздела (задача 634f1412) декорации не строим:
      // их диапазоны пересеклись бы с блок-заменой сворачивания.
      if (isCollapsedHiddenAt(state, node.from)) return false;

      const { from, to } = node;

      switch (node.name) {
        // Заголовки: скрыть «# …» до начала текста; блок активен, пока
        // каретка внутри заголовка (включая последний символ). Класс строки
        // задаёт размер/отступы как у h1–h6 в HTML-просмотре (паритет стилей).
        case 'ATXHeading1':
        case 'ATXHeading2':
        case 'ATXHeading3':
        case 'ATXHeading4':
        case 'ATXHeading5':
        case 'ATXHeading6': {
          const level = node.name.slice('ATXHeading'.length);
          // Line-декорация обязана быть нулевой длины (LineDecoration.range
          // бросает RangeError при to !== from): класс применяется к строке,
          // содержащей позицию from — заголовок всегда начинается с её начала.
          parts.push(Decoration.line({ class: `cm-md-h${level}` }).range(from));
          if (!isInRangeInclusive(ranges, from, to)) {
            const m = /^#{1,6} +/.exec(state.sliceDoc(from, to));
            if (m !== null) hide(from, from + m[0].length);
          }
          break;
        }
        // Цитаты: запоминаем диапазон блока; маркеры обрабатываются ниже.
        case 'Blockquote': {
          quoteStack.push({ from, to });
          break;
        }
        // Маркер цитаты: активен, пока каретка внутри её Blockquote. Рамка —
        // line-декорация по одной на строку цитаты, только у внешнего блока
        // (span-класс подсветки обрамлял бы каждый «>» вложенной цитаты).
        case 'QuoteMark': {
          const block = quoteStack[quoteStack.length - 1];
          if (quoteStack.length === 1) {
            // Вертикальные отступы (6px сверху/снизу) — только у первой и
            // последней строки блока: между строками одной цитаты отступа нет,
            // как в просмотре (`styles/editor.css`, `.cm-md-quote-first/-last`).
            const line = state.doc.lineAt(from);
            const classes = ['cm-md-quote-line'];
            if (block !== undefined && line.from === block.from) classes.push('cm-md-quote-first');
            if (block !== undefined && line.to === block.to) classes.push('cm-md-quote-last');
            parts.push(Decoration.line({ class: classes.join(' ') }).range(from));
          }
          const active = block !== undefined && isInRangeInclusive(ranges, block.from, block.to);
          if (!active) {
            const extra = state.sliceDoc(to, to + 1) === ' ' ? 1 : 0;
            hide(from, to + extra);
          }
          break;
        }
        // Инлайн-родители: запоминаем диапазон; маркеры детей — ниже.
        case 'Link': {
          inlineStack.push({ kind: 'link', from, to });
          break;
        }
        case 'Emphasis':
        case 'StrongEmphasis':
        case 'Strikethrough': {
          inlineStack.push({ kind: 'emphasis', from, to });
          break;
        }
        // ТП1: выделение `==…==` и подчёркивание `<u>…</u>` — инлайн-родители
        // (узлы задаёт `wiki-link.ts`). Содержимое отрисовано всегда, как текст
        // жирного: выделение — фоном, подчёркивание — линией; маркеры скрывает
        // обработка `MarkMark`/`UnderlineMark` ниже (по активности родителя).
        case 'Mark':
        case 'Underline': {
          const openLen = node.name === 'Mark' ? 2 : 3;
          const closeLen = node.name === 'Mark' ? 2 : 4;
          // Пустая пара (`====`, `<u></u>`) в рендерер не проходит — там
          // остаётся литерал (markdown/src/mark.ts, underline.ts). Такой же
          // узел лексера содержимого не имеет: маркеры не скрываем.
          const empty = to - from <= openLen + closeLen;
          inlineStack.push({ kind: 'emphasis', from, to, empty });
          if (!empty) {
            parts.push({
              from: from + openLen,
              to: to - closeLen,
              value: Decoration.mark({
                class: node.name === 'Mark' ? 'cm-md-mark' : 'cm-md-underline',
              }),
            });
          }
          break;
        }
        case 'InlineCode': {
          inlineStack.push({ kind: 'code', from, to });
          // Плашка как у <code> в просмотре — mark на весь узел: скрытые
          // бэктики ширины не занимают. Контент inline-кода не является
          // отдельным узлом дерева (CodeText появляется только с codeParser).
          parts.push({ from, to, value: Decoration.mark({ class: 'cm-md-inline-code' }) });
          break;
        }
        // Маркеры инлайн-выделения: видны, пока каретка внутри элемента или
        // непосредственно перед/после него.
        case 'EmphasisMark':
        case 'StrikethroughMark':
        case 'MarkMark':
        case 'UnderlineMark':
        case 'CodeMark': {
          const parent = inlineStack[inlineStack.length - 1];
          if (
            parent !== undefined &&
            parent.kind !== 'link' &&
            parent.empty !== true &&
            !isNearInline(ranges, parent.from, parent.to)
          ) {
            hide(from, to);
          }
          break;
        }
        // URL ссылки: скрыть «(url "title")», оставив видимый текст.
        case 'URL': {
          const link = [...inlineStack].reverse().find((p) => p.kind === 'link');
          if (link !== undefined && !isNearInline(ranges, link.from, link.to)) {
            hide(from - 1, link.to);
          }
          break;
        }
        // HTML-комментарий `<!-- … -->` (ТЗ4 «Дневник без псевдослота»):
        // весь узел — приглушённо-серым, маркеры `<!--`/`-->` скрыты вне
        // курсора. Механизм тот же, что у парных `**` (isNearInline): маркеры
        // видны, когда курсор внутри диапазона или в смежной позиции.
        // Лексер даёт два узла: инлайновый `Comment` и строчный `CommentBlock`.
        // Просмотр не меняется — HTML-комментарий там не рендерится.
        case 'Comment':
        case 'CommentBlock': {
          parts.push({
            from,
            to,
            value: Decoration.mark({ class: 'cm-md-html-comment' }),
          });
          // Длины маркеров фиксированы: `<!--` (4) и `-->` (3). Вырожденный
          // узел короче суммы маркеров маркеры не «съедает».
          if (to - from >= 7 && !isNearInline(ranges, from, to)) {
            hide(from, from + 4);
            hide(to - 3, to);
          }
          break;
        }
        // Пункт списка: его диапазон «владеет» маркером списка (`-`/`N.`) и
        // task-маркером (`[ ]`/`[x]`). Пока каретка внутри пункта или вплотную
        // к нему — исходные маркеры видны; вне — пункт отрисован как в просмотре
        // (ошибка 9d611f5f).
        case 'ListItem': {
          listItemStack.push({ from, to });
          break;
        }
        // Маркер списка (`-`, `*`, `+`, `1.`, `1)`) вне активного пункта.
        // Task-пункт (есть ребёнок `Task`) — маркер скрывается: в просмотре у
        // task-списка маркера нет (`list-style: none`), а `[ ]` заменяет
        // чекбокс. Обычный пункт — вместо исходного маркера отрисовывается
        // маркер списка (`•` / `N.`), как `<ul>`/`<ol>` в просмотре.
        case 'ListMark': {
          const item = listItemStack[listItemStack.length - 1];
          if (item !== undefined && !isNearInline(ranges, item.from, item.to)) {
            const isTask = node.node.parent?.getChild('Task') != null;
            if (isTask) {
              const extra = state.sliceDoc(to, to + 1) === ' ' ? 1 : 0;
              hide(from, to + extra);
            } else {
              const src = state.sliceDoc(from, to);
              const num = /^(\d+)[.)]$/.exec(src);
              parts.push({
                from,
                to,
                value: Decoration.replace({
                  widget: new ListMarkerWidget(num !== null ? `${num[1]}.` : '•'),
                }),
              });
            }
          }
          break;
        }
        // Task-маркер (`[ ]`/`[x]`): вне активного пункта заменяется чекбоксом.
        // Активность — по диапазону `ListItem` (как у маркера списка), чтобы
        // весь пункт раскрывался исходником одновременно.
        case 'TaskMarker': {
          const item = listItemStack[listItemStack.length - 1];
          if (item !== undefined && !isNearInline(ranges, item.from, item.to)) {
            const checked = /[xX]/.test(state.sliceDoc(from + 1, to - 1));
            parts.push({
              from,
              to,
              value: Decoration.replace({ widget: new TaskCheckboxWidget(checked, from, to) }),
            });
          }
          break;
        }
        // Целые блоки — виджеты (активны включительно по диапазону).
        // Дети узла не обрабатываются: внутри диапазона, заменённого
        // виджетом, декорации не отображаются.
        case 'FencedCode': {
          if (!isInRangeInclusive(ranges, from, to)) {
            parts.push({
              from,
              to,
              value: Decoration.replace({
                // Блок занимает несколько строк — обязателен block: true.
                block: true,
                widget: new HtmlWidget(from, to, cachedRenderMarkdown(state.sliceDoc(from, to))),
              }),
            });
            return false;
          }
          break;
        }
        case 'Image': {
          if (!isInRangeInclusive(ranges, from, to)) {
            parts.push({
              from,
              to,
              value: Decoration.replace({
                widget: new HtmlWidget(from, to, cachedRenderMarkdown(state.sliceDoc(from, to))),
              }),
            });
            return false;
          }
          break;
        }
        case 'Table': {
          if (!isInRangeInclusive(ranges, from, to)) {
            parts.push({
              from,
              to,
              value: Decoration.replace({
                // Таблица занимает несколько строк — обязателен block: true.
                block: true,
                widget: new HtmlWidget(from, to, cachedRenderMarkdown(state.sliceDoc(from, to))),
              }),
            });
            return false;
          }
          break;
        }
        case 'HorizontalRule': {
          if (!isInRangeInclusive(ranges, from, to)) {
            parts.push({
              from,
              to,
              value: Decoration.replace({ widget: new HrWidget(from, to) }),
            });
            return false;
          }
          break;
        }
        // Wiki-ссылка — инлайн-элемент: скобки видны и внутри, и сразу
        // после `]]`, чтобы ссылку можно было править.
        case 'WikiLink': {
          // Трансклюзия (восклицательный знак перед скобками) — не wiki-ссылка:
          // её развёртку и виджет ведёт `editor/transclusion.ts` (f72a9134).
          if (from > 0 && state.sliceDoc(from - 1, from) === '!') return false;
          if (!isNearInline(ranges, from, to)) {
            const parsed = wikiLabel(state.sliceDoc(from, to));
            if (parsed !== null) {
              // ID-форма (`[[#<uuid>]]` / `[[n:<net>#<uuid>]]`) — пропускаем
              // live-preview: имя подтягивает на лету `wikiIdPlugin` (R6),
              // который умеет асинхронный резолв и atomic range в edit-mode.
              // Иначе здесь пришлось бы показывать `#<uuid>` как label.
              if (isIdWikiLinkTarget(parsed.target)) return false;
              // Date-ссылка (0.16.1): тот же чип, что в просмотре, а не имя
              // мысли с датой (требование 31fe2cc9, элемент f9da2100).
              const dateParts = parseDateLinkTarget(parsed.target);
              if (dateParts !== null) {
                const label =
                  parsed.label === parsed.target ? formatDateLinkLabel(dateParts) : parsed.label;
                parts.push({
                  from,
                  to,
                  value: Decoration.replace({
                    widget: new WikiDateWidget(from, to, dateParts.date, dateParts.time, label),
                  }),
                });
                return false;
              }
              parts.push({
                from,
                to,
                value: Decoration.replace({
                  widget: new WikiLinkWidget(from, to, parsed.label, parsed.target),
                }),
              });
              return false;
            }
          }
          break;
        }
        default:
          break;
      }
    },
    leave(node) {
      switch (node.name) {
        case 'Blockquote':
          quoteStack.pop();
          break;
        case 'Link':
        case 'Emphasis':
        case 'StrongEmphasis':
        case 'Strikethrough':
        case 'Mark':
        case 'Underline':
        case 'InlineCode':
          inlineStack.pop();
          break;
        case 'ListItem':
          listItemStack.pop();
          break;
        default:
          break;
      }
    },
  });

  // Тихая подсказка строки задачи в фокусе (элемент 8773d9df): блок под
  // строкой, не участвует в вводе и кликах.
  const hint = taskHintAt(state, state.facet(taskHintContext));
  if (hint !== null) {
    parts.push(
      Decoration.widget({ widget: new TaskHintWidget(hint.text), block: true, side: 2 }).range(
        hint.pos,
      ),
    );
  }

  return Decoration.set(parts, true);
}

/** Live-preview декорации (block-декорации требует StateField, не ViewPlugin). */
export const livePreview = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update: (decorations, tr) => {
    // Переключение свёрнутости раздела (задача 634f1412) меняет набор
    // пропускаемых узлов — декорации перестраиваются вместе с ним.
    const collapseToggled = tr.effects.some((effect) => effect.is(setCollapseEffect));
    // Parse-worker (`@codemirror/language`, ViewPlugin) доразбирает документ
    // транзакцией с эффектом `Language.setState`: ни `docChanged`, ни
    // `selection` в ней нет. Ссылка дерева меняется только на транзакциях
    // языка (обычные правки/выделения дерево не трогают), поэтому сравнение
    // ссылок — дешёвый и точный признак доразбора (ошибка `8c890ee7`):
    // без него хвост длинного комментария остаётся без разметки до правки.
    const treeGrown = !tr.docChanged && syntaxTree(tr.state) !== syntaxTree(tr.startState);
    if (tr.docChanged || tr.selection || collapseToggled || treeGrown) {
      return buildDecorations(tr.state);
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * Обработчик `mousedown` виджета live-preview: клик по виджету уводит каретку
 * в диапазон блока — декорации раскрывают исходный markdown.
 *
 * Реагирует только на ОСНОВНУЮ кнопку мыши (`event.button === 0`): правый и
 * средний клик — жесты вызова контекстного меню, они не должны менять
 * выделение и разворачивать виджет (ошибка `87751f42`, тот же класс, что
 * `27b95e60` в `transclusion.ts`). Событие при этом не гасим — `contextmenu`
 * открывает меню поля поверх прежнего состояния. Родной обработчик CM6 на
 * неосновных кнопках выделение не двигает (`view/dist/index.js`:
 * basicMouseSelection — только при `button == 0`).
 */
export function mdWidgetMouseDown(event: MouseEvent, view: EditorView): boolean {
  if (event.button !== 0) return false;
  const target = event.target as Element | null;
  // Чекбокс задачи живого предпросмотра (0.16.1, уточнение 2026-11-19, пункт 10):
  // его корень — сам `choiceControl`, БЕЗ класса `md-widget`, поэтому общая ветка
  // «увести каретку в диапазон» раньше не срабатывала вовсе, а собственный
  // `mousedown` CM6 ставил каретку рядом с `[ ]` и перерисовывал декорации.
  // Виджет исчезал ДО `click`/`change`, и переключение буфера не происходило
  // (живой дефект пачки 3). Переключаем документ прямо здесь: транзакция меняет
  // `[ ]`↔`[x]` одной правкой, виджет перерисовывается уже с новым значением.
  const checkbox = target?.closest?.('.cm-md-task-checkbox');
  if (checkbox !== null && checkbox !== undefined) {
    const box = checkbox as HTMLElement;
    const from = Number(box.dataset['mdFrom']);
    const to = Number(box.dataset['mdTo']);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
    event.preventDefault();
    return toggleTaskMarkerInDoc(view, from, to);
  }
  const widget = target?.closest?.(`.${MD_WIDGET_CLASS}`);
  if (!(widget instanceof HTMLElement)) return false;

  // Date-чип: левый клик открывает день в «Дневнике» (0.16.1, требование
  // 31fe2cc9), исходник НЕ раскрывается. Обработчик ставит `wiki-link.ts`
  // (`setDateChipClickHandler`), чтобы `md-live` не тянул навигацию в себя.
  const date = widget.getAttribute(WIKI_LINK_DATE_ATTR);
  if (date !== null && date !== '' && clickDateChip(date)) {
    event.preventDefault();
    return true;
  }

  // Легаси-виджет wiki-ссылки: левый клик уходит в развилку (резолв имени →
  // конвертация → открытие), исходник НЕ раскрывается (0.12.2, задача
  // 8e4e3dc5). Проверяем до общего «увести каретку в диапазон».
  if (
    widget.classList.contains('wiki-link') &&
    (widget.dataset.wikiTarget ?? '') !== '' &&
    legacyWikiLinkClickHandler !== null
  ) {
    event.preventDefault();
    legacyWikiLinkClickHandler(widget, view, event);
    return true;
  }

  const fromRaw = widget.dataset.mdFrom;
  const toRaw = widget.dataset.mdTo;
  if (fromRaw === undefined || toRaw === undefined) return false;
  const from = Number(fromRaw);
  const to = Number(toRaw);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to - from < 2) return false;

  let pos = from + 1;
  const coords = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (coords !== null && coords > from && coords < to) pos = coords;
  view.dispatch({
    selection: { anchor: Math.min(pos, to - 1) },
    scrollIntoView: false,
    userEvent: 'select',
  });
  return true;
}

/** Клик по виджету: каретка в диапазон блока — декорации раскроют исходник. */
export const mdWidgetClick = EditorView.domEventHandlers({
  mousedown: mdWidgetMouseDown,
});

/** Имя шага истории для переключения чекбокса из буфера (отмена — штатный undo). */
const TASK_TOGGLE_USER_EVENT = 'input.taskToggle';

/**
 * Переключить маркер чекбокса В ДОКУМЕНТЕ редактора (0.16.1, уточнение
 * 2026-11-19, пункт 10). Диапазон `[from, to)` — `TaskMarker` живой декорации,
 * то есть ровно `[ ]` / `[x]`; правится ОДИН символ между скобками.
 *
 * Запись в источник (комментарий) не делается: изменение попадает в буфер и
 * уходит на сервер штатным сохранением поля. Отказ от правки (Esc) откатывает
 * документ к сохранённому тексту, поэтому ни текст, ни задачи не меняются.
 */
export function toggleTaskMarkerInDoc(view: EditorView, from: number, to: number): boolean {
  const source = view.state.sliceDoc(from, to);
  const match = /^\[([ xX])\]$/.exec(source);
  if (match === null) return false;
  const next = match[1] === ' ' ? 'x' : ' ';
  if (next === match[1]) return false;
  view.dispatch({
    changes: { from: from + 1, to: from + 2, insert: next },
    userEvent: TASK_TOGGLE_USER_EVENT,
  });
  return true;
}

/**
 * Клик по чекбоксу live-preview меняет значение в буфере (пункт 10). Виджет
 * живёт ТОЛЬКО в режиме правки (документ CM6), поэтому отдельной ветки
 * «просмотр» здесь нет: в просмотре `body_html` чекбоксы ведёт
 * `editor/task-checkbox-toggle.ts` записью в источник.
 */
export const mdTaskCheckboxToggle = EditorView.domEventHandlers({
  change(event, view) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return false;
    if (!target.classList.contains('cm-md-task-checkbox')) return false;
    const from = Number(target.dataset['mdFrom']);
    const to = Number(target.dataset['mdTo']);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
    return toggleTaskMarkerInDoc(view, from, to);
  },
});
