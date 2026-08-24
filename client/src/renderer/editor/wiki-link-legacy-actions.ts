/**
 * Legacy wiki-link context action (task R10, docs/12-wiki-id-refs.md §5.1).
 *
 * Adds a «Обновить формат на [[#<id>]]» item to the right-click menu when
 * the user clicks on a legacy `[[Имя|alias]]` wiki-link span inside the
 * editor. The legacy span carries `data-wiki-target="<name>"` but no
 * `data-wiki-id`; the action resolves the name through the server's name
 * search and rewrites the document to use the ID-based form, which is
 * resilient to renames.
 *
 * The replacement is idempotent — once a link is in ID form, this action
 * simply doesn't fire on it (the `data-wiki-id` selector excludes it).
 */

import { WIKI_LINK_TARGET_ATTR } from '@etn/markdown';
import type { EditorView } from '@codemirror/view';
import { ViewPlugin } from '@codemirror/view';

import { requireNetworkId } from '../app.js';
import { etn } from '../lib/etn.js';
import { showMenuAt, type MenuItem } from '../lib/menu.js';
import { notice } from '../lib/notice.js';

interface ResolvedName {
  thoughtId: string;
  title: string;
}

async function resolveName(networkId: string, name: string): Promise<ResolvedName | null> {
  try {
    const res = await etn.thoughts.search(networkId, { q: name, scope: 'names', limit: 10 });
    const exact = res.by_names.find((h) => h.title === name);
    const hit = exact ?? res.by_names[0];
    if (hit === undefined) return null;
    return { thoughtId: hit.thought_id, title: hit.title };
  } catch {
    return null;
  }
}

/**
 * Replace a legacy `[name|alias]` (or `[name]`) with the ID-based form
 * `[#<id>|alias]` (or `[#<id>]`) directly in the document.
 */
function rewriteToId(view: EditorView, nameStart: number, nameEnd: number, name: string, id: string): void {
  // Replace only the `name` slice inside the existing `[`/`]`/`|` brackets.
  // We leave `[[` and `]]` untouched so the surrounding syntax is preserved.
  view.dispatch({
    changes: { from: nameStart, to: nameEnd, insert: `#${id}` },
    selection: view.state.selection,
  });
  void name; // (the original `name` is no longer needed once we've replaced it)
}

/**
 * Compute the `[nameStart, nameEnd]` range of the target name portion of a
 * legacy wiki-link span. The name starts right after `[[` and ends at `|`
 * (if alias is present) or `]]`. We locate these markers relative to the
 * span's position in the document source.
 */
function findNameRange(view: EditorView, span: HTMLElement): { start: number; end: number } | null {
  const source = view.state.doc.toString();
  const start = view.posAtDOM(span, 0);
  if (start < 0) return null;
  const openAt = source.indexOf('[[', start);
  if (openAt === -1) return null;
  const nameStart = openAt + 2;
  const closeAt = source.indexOf(']]', nameStart);
  if (closeAt === -1) return null;
  const pipeAt = source.indexOf('|', nameStart);
  const nameEnd = pipeAt > 0 && pipeAt < closeAt ? pipeAt : closeAt;
  return { start: nameStart, end: nameEnd };
}

/**
 * The view plugin. Wires `contextmenu` on the editor's DOM to detect legacy
 * wiki-link spans, resolve their target name, and offer an in-place rewrite.
 */
export const wikiLinkLegacyActions = ViewPlugin.fromClass(
  class {
    readonly view: EditorView;
    constructor(view: EditorView) {
      this.view = view;
      view.contentDOM.addEventListener('contextmenu', this.onContextMenu);
    }

    destroy(): void {
      this.view.contentDOM.removeEventListener('contextmenu', this.onContextMenu);
    }

    onContextMenu = (event: MouseEvent): void => {
      const target = event.target as Element | null;
      if (target === null) return;
      const span = target.closest(`.wiki-link[data-legacy-link="true"]`);
      if (!(span instanceof HTMLElement)) return;
      const name = span.getAttribute(WIKI_LINK_TARGET_ATTR);
      if (name === null || name === '') return;

      event.preventDefault();
      void this.showMenu(name, span, event);
    };

    async showMenu(name: string, span: HTMLElement, event: MouseEvent): Promise<void> {
      const view = this.view;
      const networkId = safeNetworkId();
      if (networkId === null) return;

      const resolved = await resolveName(networkId, name);
      const items: MenuItem[] = [];

      if (resolved === null) {
        // Cannot resolve — surface the failure as a notice + a manual fallback.
        notice(`Не удалось найти мысль «${name}» для перевода на [[#<id>]].`, 'error');
        return;
      }

      items.push({
        label: `Обновить формат на [[#<id>]] (${resolved.title})`,
        onClick: () => {
          const range = findNameRange(view, span);
          if (range === null) {
            notice('Не удалось определить позицию ссылки в документе.', 'error');
            return;
          }
          rewriteToId(view, range.start, range.end, name, resolved.thoughtId);
        },
      });
      items.push({
        label: 'Открыть мысль',
        onClick: () => {
          void etn.thoughts
            .get(networkId, resolved.thoughtId)
            .catch(() => undefined)
            .then((thought) => {
              if (thought !== undefined) {
                span.click();
              }
            });
        },
      });

      showMenuAt(event.clientX, event.clientY, items);
    }
  },
);

function safeNetworkId(): string | null {
  try {
    return requireNetworkId();
  } catch {
    return null;
  }
}
