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
import { Decoration, drawSelection, EditorView, keymap, type DecorationSet } from '@codemirror/view';

import { findMatches } from './text-search.js';
import { livePreview, mdWidgetClick } from './md-live.js';
import { wikiLinkAutocompletion, wikiLinkLanguage } from './wiki-link.js';
import { wikiIdExtensions } from './wiki-id-plugin.js';
import {
  beginNestedBlockEdit,
  cancelBlockEdit,
  isBlockEditing,
  saveBlockEdit,
  transclusionAtCaret,
  transclusionExtensions,
} from './transclusion.js';
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
   * Выход из режима правки блока трансклюзии БЕЗ записи в источник: ссылка
   * восстанавливается (кнопка «Отменить трансклюзию», Esc, уход поля из правки;
   * задачи f59d24e1/e2c14673).
   */
  exitTransclusionEdit(): void;
  /**
   * Запись правки блока трансклюзии в источник (кнопка «Сохранить трансклюзию»,
   * Ctrl+Enter; задача e2c14673). После успеха восстанавливает ссылку.
   */
  saveTransclusionEdit(): Promise<void>;
  /**
   * Идёт ли правка блока трансклюзии (в поле вставлен текст источника вместо
   * ссылки). Пока `true`, поле НЕЛЬЗЯ коммитить целиком: в документе лежит
   * вставленный текст источника, и сохранение контейнера увековечило бы его
   * вместо ссылки (порча данных, ошибка `3c51aee8`).
   */
  isTransclusionEditing(): boolean;
  /**
   * Открывает правку блока ВЛОЖЕННОГО источника из просмотра (ошибка
   * `23570aef`): на месте внешней ссылки (`outerFrom` — её позиция в исходнике
   * поля) вставляется текст источника `sourceId` (при `section` — его раздела).
   * Позиции вложенной ссылки в контейнере нет, поэтому правится источник.
   */
  beginNestedTransclusionEdit(outerFrom: number, sourceId: string, section: string | null): void;
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

/**
 * Markdown, который редактор отдаёт владельцу в `onInput`, либо `null` — если
 * сообщать нечего. Пока идёт правка блока трансклюзии, документ содержит текст
 * источника ВМЕСТО ссылки-трансклюзии (`transclusion.ts`, диапазон `blockEdit`) —
 * это не markdown поля, и отдавать наружу его нельзя: владелец (черновик
 * постоянного комментария, `comments.ts` → `scheduleDraft`) записал бы
 * «растворённую» трансклюзию и после аварийного закрытия предложил бы её к
 * восстановлению (ошибка 59d9b5f3, риск порчи данных). После выхода из правки
 * блок восстанавливает ссылку и `onInput` сообщает корректный текст —
 * обычная запись черновика продолжает работать.
 */
function inputMirrorText(state: EditorState): string | null {
  return isBlockEditing(state) ? null : state.doc.toString();
}

/**
 * Минимум `ViewUpdate`, нужный обвязке `onInput` (реальный `ViewUpdate` CM6
 * структурно ему удовлетворяет). Вынесено отдельным типом, чтобы обвязку
 * можно было прогонять юнит-тестом без настоящего `EditorView`.
 */
export interface MdInputUpdate {
  docChanged: boolean;
  state: EditorState;
}

/**
 * Обвязка `onInput` редактора: единственное место, где текст документа уходит
 * владельцу. Пока идёт правка блока трансклюзии, `inputMirrorText` даёт `null` и
 * вызова НЕ происходит (ошибка 59d9b5f3); вне правки блока владелец получает
 * markdown поля. Именно эту функцию вызывает `EditorView.updateListener` — тест
 * бьёт по ней, поэтому снятие гейта (или `inputMirrorText`) краснит регресс.
 */
function notifyMdInput(update: MdInputUpdate, onInput?: (md: string) => void): void {
  if (!update.docChanged) return;
  const md = inputMirrorText(update.state);
  if (md === null) return;
  onInput?.(md);
}

/** Test seam: the panel-scroll handler and the `onInput` wiring of the editor. */
export const mdEditorInternals = { scrollCaretIntoView, inputMirrorText, notifyMdInput };

/** Creates a markdown editor for the given initial document. */
export function createMdEditor(initial: string, cb: MdEditorCallbacks = {}): MdEditor {
  /** Подписчики на изменения (текст/выделение) — состояние кнопок тулбара. */
  const listeners = new Set<() => void>();
  /** Редактор уничтожен (например, поле вышло из правки) — правки игнорируем. */
  let alive = true;
  const view = new EditorView({
    state: EditorState.create({
      doc: initial,
      extensions: [
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
            run: (v) => {
              // Правку блока трансклюзии записывает её собственный
              // Prec.high-обработчик (transclusion.ts). Если он почему-то не
              // перехватил, контейнер коммитить всё равно нельзя — в документе
              // вставленный текст источника вместо ссылки (ошибка 3c51aee8).
              if (isBlockEditing(v.state)) return false;
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
          // Обвязка `onInput` — единственная точка, где документ уходит
          // владельцу; правка блока трансклюзии подавляется внутри неё
          // (ошибка 59d9b5f3).
          notifyMdInput(update, cb.onInput);
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
      ],
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
    blur: () => view.contentDOM.blur(),
    snapshot: () => {
      const { state } = view;
      const sel = state.selection.main;
      return { text: state.doc.toString(), from: sel.from, to: sel.to };
    },
    applyEdit: (edit) => {
      if (!alive) return;
      view.dispatch({ changes: edit.changes, selection: edit.selection });
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
    exitTransclusionEdit: () => cancelBlockEdit(view),
    saveTransclusionEdit: () => saveBlockEdit(view),
    isTransclusionEditing: () => isBlockEditing(view.state),
    beginNestedTransclusionEdit: (outerFrom, sourceId, section) => {
      const ref = transclusionAtCaret(view.state.doc.toString(), outerFrom)?.ref ?? null;
      if (ref === null) return;
      void beginNestedBlockEdit(view, ref, { sourceId, section });
    },
    destroy: () => {
      alive = false;
      listeners.clear();
      view.destroy();
    },
  };
}
