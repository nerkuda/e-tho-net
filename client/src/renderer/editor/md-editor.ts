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

import { wikiLinkAutocompletion, wikiLinkLanguage } from './wiki-link.js';

/** Callbacks of the editor (the field orchestrates view/edit modes). */
export interface MdEditorCallbacks {
  /** Fired on every document change with the current markdown. */
  onInput?: (md: string) => void;
  /** Esc pressed while the autocomplete dropdown is closed. */
  onEscape?: () => void;
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
  { tag: tags.monospace, fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, monospace' },
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
  '&': { backgroundColor: 'transparent', fontSize: '13px' },
  '.cm-content': {
    fontFamily: 'inherit',
    lineHeight: '1.55',
    caretColor: 'var(--accent)',
    padding: '2px 0',
  },
  '.cm-line': { padding: '0 4px 0 2px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--accent-soft)',
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
        // then the completion keymap closes it first).
        keymap.of([
          {
            key: 'Escape',
            run: (v) => {
              if (completionStatus(v.state) === 'active') return false;
              cb.onEscape?.();
              return true;
            },
          },
          indentWithTab,
        ]),
        history(),
        drawSelection(),
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
