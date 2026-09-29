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
import { EditorState, type SelectionRange } from '@codemirror/state';
import { drawSelection, EditorView, keymap } from '@codemirror/view';

import { livePreview, mdWidgetClick } from './md-live.js';
import { wikiLinkAutocompletion, wikiLinkLanguage } from './wiki-link.js';
import { wikiIdExtensions } from './wiki-id-plugin.js';
import { wikiLinkLegacyActions } from './wiki-link-legacy-actions.js';

/** Callbacks of the editor (the field orchestrates view/edit modes). */
export interface MdEditorCallbacks {
  /** Fired on every document change with the current markdown. */
  onInput?: (md: string) => void;
  /** Esc pressed while the autocomplete dropdown is closed. */
  onEscape?: () => void;
  /** Ctrl/Cmd+Enter: commit the edit and return to the view. */
  onCommit?: () => void;
  /** Focus left the editor (commit point of the field). */
  onBlur?: () => void;
}

/** Handle of a mounted editor. */
export interface MdEditor {
  /** The editor's DOM node (paste listener target). */
  readonly dom: HTMLElement;
  getValue(): string;
  setValue(md: string): void;
  /** Inserts markdown at the caret (newline-separated when mid-line). */
  insertAtCaret(text: string): void;
  focus(): void;
  focusToEnd(): void;
  blur(): void;
  destroy(): void;
}

/** Syntax colours through the app's CSS variables (follows light/dark themes). */
const mdHighlightStyle = HighlightStyle.define([
  // Насыщенность заголовка задаёт общее правило строки `.cm-md-h*` в
  // `styles/editor.css` (единый источник с просмотром, ошибка 45989471) —
  // здесь вес не дублируется.
  { tag: tags.strong, fontWeight: '700' },
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
    lineHeight: '1.55',
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

/** Test seam: the panel-scroll handler of the auto-height markdown editor. */
export const mdEditorInternals = { scrollCaretIntoView };

/** Creates a markdown editor for the given initial document. */
export function createMdEditor(initial: string, cb: MdEditorCallbacks = {}): MdEditor {
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
        EditorView.lineWrapping,
        syntaxHighlighting(mdHighlightStyle, { fallback: true }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) cb.onInput?.(update.state.doc.toString());
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
        wikiLinkLegacyActions,
        livePreview,
        mdWidgetClick,
        mdTheme,
      ],
    }),
  });

  view.dom.addEventListener('focusout', () => {
    cb.onBlur?.();
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
    destroy: () => view.destroy(),
  };
}
