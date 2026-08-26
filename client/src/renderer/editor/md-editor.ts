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
import { EditorState } from '@codemirror/state';
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
  { tag: tags.heading, fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--accent)' },
  { tag: tags.monospace, fontFamily: 'var(--md-mono)' },
  // Цитата: только цвет — рамку/отступ задаёт line-декорация md-live
  // (span-класс подсветки обрамлял бы каждый «>» вложенных цитат).
  { tag: tags.quote, color: 'var(--text-dim)' },
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
  // Цитата: рамка и отступ — на строке, как blockquote в просмотре
  // (.comment-view blockquote). Line-декорацию ставит md-live (одна на
  // строку, у вложенных цитат — только у внешней).
  '.cm-md-quote-line': {
    borderLeft: '3px solid var(--border-strong)',
    paddingLeft: '10px',
  },
  // Заголовки: размеры и межстрочный интервал браузерных стилей h1–h6
  // (просмотр их и использует) — паритет между режимами. Вертикальные
  // отступы — padding, не margin: getBoundingClientRect() не включает
  // margin, и карта высот CodeMirror разошлась бы с раскладкой (стрелки
  // вверх/вниз прыгали бы через строки).
  '.cm-md-h1, .cm-md-h2, .cm-md-h3, .cm-md-h4, .cm-md-h5, .cm-md-h6': {
    fontWeight: '700',
    paddingTop: '0.4em',
    paddingBottom: '0.1em',
  },
  '.cm-md-h1': { fontSize: '2em', lineHeight: '1.25' },
  '.cm-md-h2': { fontSize: '1.5em', lineHeight: '1.25' },
  '.cm-md-h3': { fontSize: '1.17em', lineHeight: '1.25' },
  '.cm-md-h4': { fontSize: '1em', lineHeight: '1.25' },
  '.cm-md-h5': { fontSize: '0.83em', lineHeight: '1.25' },
  '.cm-md-h6': { fontSize: '0.67em', lineHeight: '1.25' },
  // Inline-код: плашка как у <code> в просмотре (.comment-view code).
  '.cm-md-inline-code': {
    background: 'var(--surface-2)',
    padding: '1px 4px',
    borderRadius: '4px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  // Выделение текста (06b18f19): тот же акцентный фон, что и ::selection
  // просмотра (.comment-view в styles.css) — одинаковые цвета в обоих
  // режимах; текст под выделением сохраняет свой цвет (включая подсветку).
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--selection-bg)',
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-placeholder': { color: 'var(--text-faint)' },
  '.cm-panels': { backgroundColor: 'var(--surface)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
  },
});

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
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    },
    blur: () => view.contentDOM.blur(),
    destroy: () => view.destroy(),
  };
}
