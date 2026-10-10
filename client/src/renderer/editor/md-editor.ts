/**
 * CodeMirror 6 markdown editor (task M2) — the editing half of the
 * view/edit markdown field, replacing the plain textarea.
 *
 * The editor keeps the document as markdown text (the single source of
 * truth); live-preview decorations (M6) build on this foundation without
 * changing the document model.
 */

import { completionKeymap, completionStatus } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tags } from '@lezer/highlight';
import {
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
  type SelectionRange,
} from '@codemirror/state';
import { Decoration, drawSelection, EditorView, keymap, tooltips, type DecorationSet } from '@codemirror/view';

import { findMatches } from './text-search.js';
import {
  toggleCollapseAtCaret as runCollapseToggle,
  type CollapseToggleMode,
} from './comment-collapse.js';
import { livePreview, mdWidgetClick } from './md-live.js';
import { wikiLinkAutocompletion, wikiLinkLanguage } from './wiki-link.js';
import { wikiIdExtensions } from './wiki-id-plugin.js';
import {
  blockEditorKey,
  enterBlock,
  exitActiveBlock,
  transclusionExtensions,
  transclusionRefStartingAt,
} from './transclusion.js';
import { blockEditorStoreFacet } from './transclusion-nested.js';
import { wikiLinkLegacyActions } from './wiki-link-legacy-actions.js';

/** Callbacks of the editor (the field orchestrates view/edit modes). */
export interface MdEditorCallbacks {
  /** Fired on every document change with the current markdown. */
  onInput?: (md: string) => void;
  /** Esc pressed while the autocomplete dropdown is closed. */
  onEscape?: () => void;
  /** Ctrl/Cmd+Enter: commit the edit and return to the view. */
  onCommit?: () => void;
  /**
   * Focus left the editor (commit point of the field). Получает событие
   * `focusout`, чтобы поле могло отличить уход фокуса наружу от перехода на
   * собственный элемент поля (панель поиска, тулбар) — см.
   * `markdown-field.ts` (`editorBlurCommits`).
   */
  onBlur?: (event: FocusEvent) => void;
  /**
   * Дополнительные расширения CM6 (например, точечное перекрытие сочетаний
   * команд поля комментария через `Prec.high` — задача ab0c4470).
   */
  extraExtensions?: Extension[];
}

/** Снимок текста и главного выделения редактора. */
export interface MdEditorSnapshot {
  /** Полный текст документа (markdown). */
  text: string;
  /** Начало выделения (меньший офсет); равен `to` при каретке. */
  from: number;
  /** Конец выделения (больший офсет). */
  to: number;
}

/** Одна правка диапазона: заменить `[from, to)` на `insert`. */
export interface MdEditorChange {
  from: number;
  to?: number;
  insert?: string;
}

/** Транзакция правки редактора (текст и/или выделение). */
export interface MdEditorEdit {
  changes: MdEditorChange | readonly MdEditorChange[];
  selection?: { anchor: number; head?: number };
  /**
   * Прокрутить поле к итоговому выделению (`scrollIntoView` CM6). Нужно
   * командам, чья правка заменяет документ целиком (например, перемещение
   * строк `moveLine`): такая замена рушит якорь прокрутки контейнера, и без
   * явного прокручивания к каретке поле «прыгает» к началу документа
   * (ошибка `ffb49898`). Прочие команды оставляют флаг не выставленным.
   */
  scrollIntoView?: boolean;
}

/**
 * Подсветка вхождений поиска в редакторе (панель поиска поля комментария,
 * задача 045f98db): запрос и текущее совпадение. `null` — подсветка снята.
 */
export interface MdSearchHighlight {
  query: string;
  /** Текущее совпадение (подсвечивается сильнее), либо `null`. */
  current: { from: number; to: number } | null;
}

/** Handle of a mounted editor. */
export interface MdEditor {
  /** The editor's DOM node (paste listener target). */
  readonly dom: HTMLElement;
  getValue(): string;
  setValue(md: string): void;
  /** Inserts markdown at the caret (newline-separated when mid-line). */
  insertAtCaret(text: string): void;
  /**
   * Ставит каретку на позицию (клампится по длине документа), фокусирует
   * редактор и прокручивает к курсору. Нужно двойному клику по тексту
   * публикации: курсор в месте клика/начале абзаца (задача ea1b5f14).
   */
  setCaret(position: number): void;
  /**
   * Ставит выделение `[anchor, head]` (оба клампятся по длине документа),
   * фокусирует редактор и прокручивает к нему. Нужно входу в правку из
   * просмотра: каретка и выделенное слово — в месте клика (задача 189da39e).
   */
  setSelection(anchor: number, head: number): void;
  /**
   * Входит во вложенный редактор блока трансклюзии, начинающегося в позиции
   * `position` документа (ошибка `f3dd9fe3`): двойной клик по слову внутри
   * блока в просмотре входит в правку, монтирует вложенный редактор и ставит
   * выделение по вхождению `findText` (слово под кликом) — «курсор в месте
   * клика», как в обычном тексте. Без вхождения — каретка в начало блока.
   * Заблокированный/превышенная глубина блок — no-op (`enterBlock`).
   */
  enterBlockAt(position: number, findText?: string): void;
  focus(): void;
  focusToEnd(): void;
  blur(): void;
  destroy(): void;
  /** Текст и главное выделение — вход чистых преобразований команд. */
  snapshot(): MdEditorSnapshot;
  /** Применяет правку (текст и/или выделение) одной транзакцией. */
  applyEdit(edit: MdEditorEdit): void;
  /** Подписка на изменения текста/выделения (для состояния кнопок тулбара). */
  subscribe(listener: () => void): () => void;
  /**
   * Подсвечивает все вхождения запроса подсветкой CM6 (панель поиска поля,
   * задача 045f98db). `null` снимает подсветку.
   */
  setSearchHighlight(highlight: MdSearchHighlight | null): void;
  /**
   * Выделяет диапазон и прокручивает к нему, НЕ забирая фокус у панели поиска
   * (навигация F3/Enter из панели). Фокус остаётся там, где был.
   */
  selectMatch(from: number, to: number): void;
  /**
   * Сворачивает/разворачивает раздел под кареткой в режиме правки (команды
   * `comment.fold`/`comment.unfold`, умолчания Ctrl+Up / Ctrl+Down; задача
   * 558cac34). `fold` — свернуть, `unfold` — развернуть, `toggle` —
   * переключить. Возвращает `false` как no-op, если под кареткой нет
   * сворачиваемого раздела.
   */
  toggleCollapseAtCaret(mode: CollapseToggleMode): boolean;
}

/** Эффект установки подсветки поиска. */
const setSearchHighlightEffect = StateEffect.define<MdSearchHighlight | null>();

/** Состояние подсветки: текущий запрос и собранные декорации. */
interface MdSearchState {
  highlight: MdSearchHighlight | null;
  deco: DecorationSet;
}

const searchMatchMark = Decoration.mark({ class: 'cm-md-search-hit' });
const searchCurrentMark = Decoration.mark({ class: 'cm-md-search-hit cm-md-search-hit--current' });

/** Собирает декорации подсветки всех вхождений запроса (текущее — сильнее). */
function buildSearchDecorations(text: string, highlight: MdSearchHighlight | null): DecorationSet {
  if (highlight === null || highlight.query === '') return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const match of findMatches(text, highlight.query)) {
    const current =
      highlight.current !== null &&
      highlight.current.from === match.from &&
      highlight.current.to === match.to;
    builder.add(match.from, match.to, current ? searchCurrentMark : searchMatchMark);
  }
  return builder.finish();
}

const mdSearchField = StateField.define<MdSearchState>({
  create: () => ({ highlight: null, deco: Decoration.none }),
  update(value, tr) {
    let highlight = value.highlight;
    let touched = false;
    for (const effect of tr.effects) {
      if (effect.is(setSearchHighlightEffect)) {
        highlight = effect.value;
        touched = true;
      }
    }
    if (tr.docChanged) touched = true;
    if (!touched) return value;
    return { highlight, deco: buildSearchDecorations(tr.state.doc.toString(), highlight) };
  },
  provide: (field) => EditorView.decorations.from(field, (state) => state.deco),
});

/** Syntax colours through the app's CSS variables (follows light/dark themes). */
const mdHighlightStyle = HighlightStyle.define([
  // Насыщенность заголовка задаёт общее правило строки `.cm-md-h*` в
  // `styles/editor.css` (единый источник с просмотром, ошибка 45989471) —
  // здесь вес не дублируется.
  { tag: tags.strong, fontWeight: 'var(--md-strong-weight)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--accent)' },
  { tag: tags.monospace, fontFamily: 'var(--md-mono)' },
  { tag: tags.url, color: 'var(--accent)' },
  { tag: tags.meta, color: 'var(--text-dim)' },
]);

/**
 * Fenced-code languages offered in the editor (task M4). The full
 * `language-data` registry autoloads ~40 packages — only the installed set is
 * kept, so a missing language falls back to plain text instead of a failed
 * dynamic import.
 */
const CODE_LANG_ALIASES = new Set([
  'javascript',
  'js',
  'jsx',
  'typescript',
  'ts',
  'python',
  'py',
  'json',
  'html',
  'css',
  'sql',
  'xml',
  'yaml',
  'yml',
  'rust',
  'rs',
  'go',
  'java',
  'cpp',
  'c++',
  'php',
]);
const codeLanguages = languages.filter((l) => l.alias?.some((a) => CODE_LANG_ALIASES.has(a)));

const mdTheme = EditorView.theme({
  // Размер шрифта через переменную — масштабирование Ctrl+колесом (M9)
  // действует сразу на все поля.
  '&': { backgroundColor: 'transparent', fontSize: 'var(--md-font-size)' },
  // Базовый стиль CodeMirror ставит моноширинный шрифт на .cm-scroller;
  // редактор использует шрифт интерфейса, как и HTML-просмотр.
  '.cm-scroller': { fontFamily: 'inherit' },
  '.cm-content': {
    fontFamily: 'inherit',
    lineHeight: 'var(--md-line-height)',
    caretColor: 'var(--accent)',
    padding: '2px 0',
  },
  '.cm-line': { padding: '0 4px 0 2px' },
  // Размеры/отступы/цвета markdown-конструкций (заголовки `.cm-md-h1…h6`,
  // цитата `.cm-md-quote-line`, плашка `.cm-md-inline-code`) задаются ОДНИМ
  // правилом на оба режима в `styles/editor.css` (единый источник типографики
  // просмотра и живого редактирования, ошибка 45989471) — здесь их копий нет.
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  // Выделение текста (06b18f19/e8146cdc) красится в styles.css
  // (.cm-editor .cm-selectionBackground): селекторы встроенного baseTheme CM
  // (.cm-baseTheme.cm-light …) специфичнее правила темы, поэтому перекраска
  // здесь не работает — !important-правило в styles.css перекрывает их.
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-placeholder': { color: 'var(--text-faint)' },
  '.cm-panels': { backgroundColor: 'var(--surface)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    // Тултипы CM6 (автокомплит `[[`, подсказки разделов) порталятся в body
    // (см. mdEditorExtensions). Базовый стиль CM6 держит `.cm-tooltip { z-index: 500 }`,
    // а `.dialog-backdrop` диалогов стоит на 900 — тултип уходил ПОД подложку
    // в md-полях внутри диалогов (ошибка 7aee1df3). Проектная конвенция для
    // body-mounted попапов — 950 (`.type-combo-list`, type-combobox.css:51-52,
    // «above the dialog stack»). Тема ставится после baseTheme (Prec.lowest),
    // поэтому перекрывает z-index базового стиля.
    zIndex: '950',
  },
});

/**
 * Прокрутка каретки к видимой части — для поля, которое растёт по содержимому.
 *
 * Поле markdown растёт по контенту (08-ui-spec.md §6.4), поэтому скроллит не
 * сам редактор, а контейнер панели (`.ui-comment--scroll`, `.editor-scroll`,
 * тело диалога). Штатный обход предков в CodeMirror считает скроллером ЛЮБОЙ
 * предок с `scrollHeight > clientHeight` — в том числе flex-контейнеры с
 * `overflow: visible` (`md-field`, `ui-comment__body`): они ужаты флексом и
 * формально переполнены, но прокрутить их нельзя (`scrollTop` не меняется).
 * Мало того, их боксом CodeMirror обрезает прямоугольник каретки — до
 * настоящего скроллера доходит «почти видимая» каретка, и он сдвигается на
 * считанные пиксели: стрелка вниз и Ctrl+End уводят каретку за пределы
 * видимой части, текст за ней не следует (ошибка f4f99e3f). Здесь обход
 * повторён, но скроллером считается только элемент с непрозрачным `overflow`.
 * Реализована стратегия `nearest` — других редактор полей не запрашивает.
 */
function scrollCaretIntoView(
  view: EditorView,
  range: SelectionRange,
  options: { yMargin: number; xMargin: number },
): boolean {
  // Вертикальную позицию каретки берём из карты высот, а не публичным
  // `coordsAtPos`: обработчик вызывается внутри measure-прохода CodeMirror,
  // где чтение раскладки через публичный API запрещено.
  const block = view.lineBlockAt(range.head);
  const scrollBox = view.scrollDOM.getBoundingClientRect();
  const baseTop = scrollBox.top - view.scrollDOM.scrollTop;
  let top = baseTop + block.top;
  let bottom = baseTop + block.bottom;

  let handled = false;
  for (let node: HTMLElement | null = view.scrollDOM; node !== null; node = node.parentElement) {
    const cs = getComputedStyle(node);
    if (/^(fixed|sticky)$/.test(cs.position)) break;
    // Скроллер — только элемент с непрозрачным `overflow`, у которого есть
    // реальное переполнение. Растянутые по контенту flex-предки с
    // `overflow: visible` (`md-field`, `ui-comment__body`) пропускаем: их
    // прокрутить нельзя, а обрезка прямоугольника по их боксу и ломала
    // следование каретки (см. описание выше).
    if (cs.overflowY === 'visible' || node.scrollHeight <= node.clientHeight) continue;
    const box = node.getBoundingClientRect();
    const boxTop = box.top;
    const boxBottom = box.top + node.clientHeight;
    let move = 0;
    if (top < boxTop + options.yMargin) move = top - (boxTop + options.yMargin);
    else if (bottom > boxBottom - options.yMargin) move = bottom - (boxBottom - options.yMargin);
    if (move !== 0) {
      const before = node.scrollTop;
      node.scrollTop = before + move;
      const moved = node.scrollTop - before;
      top -= moved;
      bottom -= moved;
    }
    // Обрезаем по боксу реального скроллера, чтобы более высокий не сдвинулся
    // из-за каретки, которая уже видна в этом.
    top = Math.max(top, boxTop);
    bottom = Math.min(bottom, boxBottom);
    handled = true;
  }
  // Горизонталь не трогаем: поле переносит длинные строки
  // (`EditorView.lineWrapping`), горизонтальной прокрутки у каретки нет.
  return handled;
}

/** Test seam: прокрутка каретки к видимой части контейнера. */
export const mdEditorInternals = { scrollCaretIntoView };

/**
 * Стек расширений markdown-редактора: язык с wiki-ссылками и трансклюзиями,
 * автокомплит (мысли и разделы источников), live preview, свёрнутость разделов,
 * клавиатурные контексты поля (`lib/keymap` через `wikiLinkLegacyActions`),
 * поиск, трансклюзии и тема.
 *
 * Вынесен отдельной функцией, чтобы markdown-редактор можно было поднять
 * ЛЮБЫМ числом НЕЗАВИСИМЫХ инстансов одним стеком (поле-контейнер комментария и
 * вложенные редакторы блоков трансклюзий — ТП «Живой блок»). Каждому инстансу
 * нужен СВОЙ вызов: часть расширений несёт по-инстансные замыкания (кэш
 * автокомплита `wikiLinkCompletions`, кэш разделов
 * `transclusionSectionCompletions`) — общий массив на два редактора сцепил бы
 * их кэши.
 *
 * `listeners` — подписчики на изменения текста/выделения (состояние кнопок
 * тулбара); свой набор на инстанс. `cb.extraExtensions` идут последними,
 * приоритет задаёт само расширение (`Prec.high`) — задача ab0c4470.
 */
export function mdEditorExtensions(
  cb: MdEditorCallbacks = {},
  listeners: Set<() => void> = new Set(),
): Extension[] {
  return [
    // Esc cancels the edit (unless the autocomplete dropdown is open —
    // then the completion keymap closes it first). Ctrl/Cmd+Enter
    // commits and returns to the view (M10).
    keymap.of([
      {
        key: 'Escape',
        run: (v) => {
          if (completionStatus(v.state) === 'active') return false;
          cb.onEscape?.();
          return true;
        },
      },
      {
        key: 'Mod-Enter',
        run: () => {
          cb.onCommit?.();
          return true;
        },
      },
      indentWithTab,
    ]),
    history(),
    drawSelection(),
    // Прокрутка каретки к видимой в контейнере панели, а не в самом поле
    // (поле растёт по содержимому) — см. scrollCaretIntoView.
    EditorView.scrollHandler.of(scrollCaretIntoView),
    // Тултипы редактора (автокомплит `[[`, подсказки разделов) — порталом в
    // `document.body` (ошибка 7aee1df3). Причина: дизайн-система ставит
    // `container-type: inline-size` на каркасы (`.fp-host`, `.ui-table` и др.),
    // а inline-size-контейнмент создаёт containing block для `position: fixed`
    // потомков. Дефолтный `position: fixed` тултип CM6 внутри такого каркаса
    // отсчитывался от ЕГО верхнего края (каркас «Дневника» ниже тулбара на
    // ~127px) и всплывал не у каретки, а ниже (иногда за краем окна). Вынос
    // контейнера тултипов в `body` уводит их из-под контейнмента: fixed-координаты
    // снова отсчитываются от вьюпорта. Тема переносится CM6 (container несёт
    // themeClasses редактора). Гард — тестовые headless-инстансы без DOM.
    ...(typeof document !== 'undefined' && document.body != null
      ? [tooltips({ parent: document.body })]
      : []),
    // Нативная проверка орфографии (задача 1e373ac7). CodeMirror 6 в
    // updateAttrs() принудительно ставит `spellcheck="false"` на contentDOM,
    // поэтому ошибки в комментарии не подчёркивались, в отличие от обычных
    // полей (`lib/ui/field.ts`, spellcheck по умолчанию true). Фасет
    // contentAttributes применяется после и возвращает атрибуту true; языки
    // спеллчекера задаёт главный процесс (client/src/main/index.ts).
    EditorView.contentAttributes.of({ spellcheck: 'true' }),
    EditorView.lineWrapping,
    syntaxHighlighting(mdHighlightStyle, { fallback: true }),
    EditorView.updateListener.of((update) => {
      // Единственная точка, где markdown документа уходит владельцу поля.
      // Текст блоков трансклюзий живёт во ВЛОЖЕННЫХ редакторах и в документ
      // контейнера не попадает — гейт подавления больше не нужен.
      if (update.docChanged) cb.onInput?.(update.state.doc.toString());
      if (update.docChanged || update.selectionSet) {
        for (const listener of listeners) listener();
      }
    }),
    // The markdown keymap (Enter/Backspace list handling) must outrank
    // the default keymap below.
    markdown({
      base: markdownLanguage,
      addKeymap: true,
      codeLanguages,
      extensions: [wikiLinkLanguage()],
    }),
    keymap.of([...historyKeymap, ...completionKeymap, ...defaultKeymap]),
    wikiLinkAutocompletion(),
    ...wikiIdExtensions,
    ...transclusionExtensions,
    wikiLinkLegacyActions,
    livePreview,
    mdWidgetClick,
    mdSearchField,
    mdTheme,
    // Дополнительные расширения вызывающего (точечные перекрытия сочетаний
    // команд поля — задача ab0c4470). Идут последними; приоритет задаётся
    // самим расширением (`Prec.high`), а не порядком подключения.
    ...(cb.extraExtensions ?? []),
  ];
}

/** Creates a markdown editor for the given initial document. */
export function createMdEditor(initial: string, cb: MdEditorCallbacks = {}): MdEditor {
  /** Подписчики на изменения (текст/выделение) — состояние кнопок тулбара. */
  const listeners = new Set<() => void>();
  /** Редактор уничтожен (например, поле вышло из правки) — правки игнорируем. */
  let alive = true;
  const view = new EditorView({
    state: EditorState.create({
      doc: initial,
      // Стек расширений общий для поля-контейнера и вложенных редакторов;
      // каждый инстанс получает СВОЙ вызов (по-инстансные кэши расширений).
      extensions: mdEditorExtensions(cb, listeners),
    }),
  });

  view.dom.addEventListener('focusout', (event) => {
    cb.onBlur?.(event);
  });

  return {
    dom: view.dom,
    getValue: () => view.state.doc.toString(),
    setValue: (md: string) => {
      const len = view.state.doc.length;
      view.dispatch({
        changes: { from: 0, to: len, insert: md },
        selection: { anchor: Math.min(view.state.selection.main.head, md.length) },
      });
    },
    insertAtCaret: (text: string) => {
      const { state } = view;
      const pos = state.selection.main.head;
      const before = pos > 0 ? state.doc.sliceString(pos - 1, pos) : '';
      const insert = before !== '' && before !== '\n' ? `\n${text}` : text;
      view.dispatch({
        changes: { from: pos, to: pos, insert },
        selection: { anchor: pos + insert.length },
      });
      view.focus();
    },
    focus: () => view.focus(),
    setCaret: (position: number) => {
      const anchor = Math.max(0, Math.min(view.state.doc.length, Math.trunc(position)));
      view.focus();
      view.dispatch({ selection: { anchor }, scrollIntoView: true });
    },
    setSelection: (anchorPos: number, headPos: number) => {
      const len = view.state.doc.length;
      const anchor = Math.max(0, Math.min(len, Math.trunc(anchorPos)));
      const head = Math.max(0, Math.min(len, Math.trunc(headPos)));
      view.focus();
      view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
    },
    enterBlockAt: (position: number, findText?: string) => {
      const ref = transclusionRefStartingAt(view.state.doc.toString(), Math.trunc(position));
      if (ref === null) return;
      // Монтаж/активация вложенного редактора синхронны (см. `enterBlock`).
      enterBlock(view, ref, false);
      const store = view.state.facet(blockEditorStoreFacet);
      if (store === null) return;
      const key = blockEditorKey(ref.sourceId, ref.section);
      // Слово под двойным кликом — выделение в месте клика; не найдено — каретка
      // в начало блока (её уже поставил `enterBlock`).
      if (findText !== undefined && findText !== '') store.selectByText(key, findText);
    },
    focusToEnd: () => {
      view.focus();
      // `scrollIntoView` (замечание проверки f4f99e3f): без него при входе в
      // правку длинного комментария каретка ставится в конец документа вне
      // видимой части поля, и панель не прокручивается к курсору.
      view.dispatch({
        selection: { anchor: view.state.doc.length },
        scrollIntoView: true,
      });
    },
    blur: () => {
      // Если фокус во вложенном редакторе блока, `contentDOM.blur()` контейнера
      // — no-op (фокус не у него), и поле не ушло бы в просмотр. Сначала
      // возвращаем фокус контейнеру (вложенный редактор при этом выходит из
      // блока своим `focusout`), затем отпускаем фокус контейнера.
      view.focus();
      exitActiveBlock(view);
      view.contentDOM.blur();
    },
    snapshot: () => {
      const { state } = view;
      const sel = state.selection.main;
      return { text: state.doc.toString(), from: sel.from, to: sel.to };
    },
    applyEdit: (edit) => {
      if (!alive) return;
      view.dispatch({
        changes: edit.changes,
        selection: edit.selection,
        scrollIntoView: edit.scrollIntoView,
      });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setSearchHighlight: (highlight) => {
      view.dispatch({ effects: setSearchHighlightEffect.of(highlight) });
    },
    selectMatch: (from, to) => {
      const len = view.state.doc.length;
      const anchor = Math.max(0, Math.min(len, Math.trunc(from)));
      const head = Math.max(anchor, Math.min(len, Math.trunc(to)));
      // Фокус НЕ забираем: навигация идёт из панели поиска, её поле должно
      // остаться активным (F3/Enter продолжают работать).
      view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
    },
    toggleCollapseAtCaret: (mode) => runCollapseToggle(view, mode),
    destroy: () => {
      alive = false;
      listeners.clear();
      view.destroy();
    },
  };
}
