/**
 * Task-list support of the shared renderer (задача 2fc28fa2, требование
 * 673fa25f, ТП1): `- [ ]` renders an unchecked and `- [x]` / `- [X]` a checked
 * disabled checkbox, markdown-it-task-lists style:
 *
 *   <ul class="contains-task-list">
 *     <li class="task-list-item">
 *       <input class="task-list-item-checkbox" type="checkbox" disabled> текст
 *
 * The checkbox is an interactive-looking (but disabled) control: the markup is
 * identical on the server (`body_html`) and in the client, so view, editor
 * widgets and server pre-render agree. Detection runs as a core rule after
 * `inline`, so it works on the token stream without a second markdown parse.
 *
 * Only the first inline of a list item is inspected; a leading `[ ] …` inside
 * ordinary text is left alone.
 */

import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

/** `- [ ] текст` / `- [x] текст` (marker plus at least one space). */
const TASK_MARKER_RE = /^\[([ xX])\]\s+/;
const TASK_MARKER_ONLY_RE = /^\[([ xX])\]/;

/** The `list_item_open` owning the inline token at `idx`, if any. */
function ownerListItemOpen(tokens: Token[], idx: number): Token | null {
  for (let i = idx - 1; i >= 0; i--) {
    const type = tokens[i]!.type;
    if (type === 'list_item_open') return tokens[i]!;
    // Leaving the item (a previous sibling's close) — no owner.
    if (type === 'list_item_close') return null;
  }
  return null;
}

/** The nearest enclosing list-open token before `itemIdx`. */
function parentListOpen(tokens: Token[], itemIdx: number): Token | null {
  for (let i = itemIdx - 1; i >= 0; i--) {
    const type = tokens[i]!.type;
    if (type === 'bullet_list_open' || type === 'ordered_list_open') return tokens[i]!;
  }
  return null;
}

export function taskListPlugin(md: MarkdownIt): void {
  md.core.ruler.after('inline', 'task_list', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const inline = tokens[i]!;
      if (inline.type !== 'inline') continue;
      const first = inline.children?.[0];
      if (first === undefined || first.type !== 'text' || !TASK_MARKER_RE.test(first.content)) {
        continue;
      }
      const itemOpen = ownerListItemOpen(tokens, i);
      if (itemOpen === null) continue;

      const checked = TASK_MARKER_ONLY_RE.exec(first.content)![1]!.toLowerCase() === 'x';
      // Drop the `[x] ` marker from both the rendered child and the raw content.
      first.content = first.content.replace(TASK_MARKER_RE, '');
      inline.content = inline.content.replace(TASK_MARKER_RE, '');

      const checkbox = new state.Token('task_list_checkbox', 'input', 0);
      checkbox.meta = { checked };
      inline.children!.unshift(checkbox);

      itemOpen.attrJoin('class', 'task-list-item');
      const listOpen = parentListOpen(tokens, tokens.indexOf(itemOpen));
      listOpen?.attrJoin('class', 'contains-task-list');
    }
  });

  md.renderer.rules.task_list_checkbox = (tokens, idx) => {
    const meta = tokens[idx]!.meta as { checked?: boolean } | null;
    const checked = meta?.checked === true ? ' checked' : '';
    return `<input class="task-list-item-checkbox" type="checkbox" disabled${checked}>`;
  };
}
