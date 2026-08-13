/**
 * Editor group: mentions (H12, 08-ui-spec.md §6.3; 03-server-api.md §13).
 *
 * Thought-only. Lists thoughts/links whose comments contain the thought's
 * title or a synonym; clicking a hit focuses the mentioning thought or opens
 * the mentioning link in the editor.
 */

import type { MentionHit } from '@etn/shared';

import { setFocus } from '../app.js';
import { div, el, errText, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { requireNetworkId } from '../app.js';
import { openLinkInEditor, registerGroupBuilder, type EditorContext } from './editor.js';

/** Registers the mentions group (thoughts only). */
export function registerMentionsGroup(): void {
  registerGroupBuilder((ctx) => {
    if (ctx.ownerType !== 'thought') return null;
    return { id: 'mentions', title: 'Упоминания', buildBody: () => buildMentionsBody(ctx) };
  });
}

/** Builds the mentions list. */
function buildMentionsBody(ctx: EditorContext): HTMLElement {
  const networkId = requireNetworkId();
  const box = div('mentions-body');
  void reload();

  async function reload(): Promise<void> {
    box.replaceChildren(el('span', 'muted', 'Загрузка…'));
    let hits: MentionHit[];
    try {
      hits = await etn.thoughts.mentions(networkId, ctx.ownerId);
    } catch (err) {
      box.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
      return;
    }
    box.replaceChildren();
    if (hits.length === 0) {
      box.append(el('p', 'muted', 'Название нигде не упоминается.'));
      return;
    }
    for (const hit of hits) {
      const item = div('mention-item');
      const kind = span(hit.owner_type === 'thought' ? '💭' : '🔗', 'muted');
      const title = el('span', undefined, hit.title);
      title.style.fontWeight = '600';
      const snippet = el('div', 'muted', hit.snippet);
      snippet.style.fontSize = '11px';
      item.append(kind, title, snippet);
      item.addEventListener('click', () => void open(hit));
      box.append(item);
    }
  }

  /** Opens the mentioning entity (thought → focus, link → editor). */
  async function open(hit: MentionHit): Promise<void> {
    if (hit.owner_type === 'thought') {
      void setFocus(hit.owner_id);
      return;
    }
    try {
      const link = await etn.links.get(networkId, hit.owner_id);
      openLinkInEditor(link);
    } catch {
      // stale link
    }
  }

  return box;
}
