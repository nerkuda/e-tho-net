/**
 * Wiki-links (task M3): `[[имя мысли|синоним]]`.
 *
 * The shared renderer (@etn/markdown) emits view-mode HTML
 * `<span class="wiki-link" data-wiki-target="…">label</span>`; this module adds
 * the editor-side syntax node (so the link gets syntax colours), the `[[`
 * autocomplete against the network's thoughts (server search, prefix match,
 * `scope=names` — titles and synonyms) and a delegated click handler that
 * focuses the linked thought (resolved by name at click time, never at render
 * time — names may change after the HTML is cached).
 */

import { autocompletion, type Completion, type CompletionSource } from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import { tags } from '@lezer/highlight';
import type { MarkdownExtension } from '@lezer/markdown';

import { WIKI_LINK_CLASS, WIKI_LINK_TARGET_ATTR } from '@etn/markdown';

import { requireNetworkId, setFocus } from '../app.js';
import { errText } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';

/** Chars allowed inside an in-progress wiki prefix (no closing/alias/newline). */
const WIKI_PREFIX_RE = /^[^[\]\n|]*$/;

/**
 * Parses the text before the caret (a single line) for an in-progress wiki
 * link: the last `[[` followed only by prefix characters. Returns the `[[`
 * position and the typed prefix, or `null` when the caret is not inside one
 * (closed link, alias part after `|`, or an empty prefix).
 */
export function wikiPrefixAt(before: string): { open: number; prefix: string } | null {
  const open = before.lastIndexOf('[[');
  if (open === -1) return null;
  const rest = before.slice(open + 2);
  if (rest === '' || !WIKI_PREFIX_RE.test(rest)) return null;
  return { open, prefix: rest };
}

/** Lezer node: `[[…]]` becomes a `WikiLink` span styled as a link. */
const wikiLinkMarkdownExt: MarkdownExtension = {
  defineNodes: [{ name: 'WikiLink', style: tags.link }],
  parseInline: [
    {
      name: 'WikiLink',
      parse(cx, next, pos) {
        if (next !== 91 /* [ */ || cx.char(pos + 1) !== 91) return -1;
        const end = cx.text.indexOf(']]', pos + 2);
        if (end === -1) return -1;
        const content = cx.slice(pos + 2, end);
        if (content === '' || content.includes('\n') || content.includes('\r')) return -1;
        return cx.addElement(cx.elt('WikiLink', pos, end));
      },
    },
  ],
};

/** Language extension for `markdown({ extensions: […] })`. */
export function wikiLinkLanguage(): MarkdownExtension {
  return wikiLinkMarkdownExt;
}

/** Short cache of search results per prefix (thought lists change rarely). */
const COMPLETION_TTL_MS = 10_000;

/** Loads prefix matches over titles + synonyms from the server search. */
async function loadCompletions(networkId: string, prefix: string): Promise<Completion[]> {
  try {
    const res = await etn.thoughts.search(networkId, { q: prefix, scope: 'names', limit: 20 });
    return res.by_names.map((hit) => ({
      label: hit.title,
      type: 'text',
      apply: `${hit.title}]]`,
    }));
  } catch {
    return [];
  }
}

function wikiLinkCompletions(): CompletionSource {
  const cache = new Map<string, { expires: number; options: Completion[] }>();
  return async (context) => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const hit = wikiPrefixAt(before);
    if (hit === null) return null;

    let cached = cache.get(hit.prefix);
    if (cached === undefined || cached.expires < Date.now()) {
      cached = {
        expires: Date.now() + COMPLETION_TTL_MS,
        options: await loadCompletions(requireNetworkId(), hit.prefix),
      };
      cache.set(hit.prefix, cached);
    }
    if (cached.options.length === 0) return null;
    return {
      from: line.from + hit.open + 2,
      options: cached.options,
      validFor: WIKI_PREFIX_RE,
    };
  };
}

/** Autocomplete extension: opens on `[[` + typed prefix, inserts `имя]]`. */
export function wikiLinkAutocompletion(): Extension {
  return autocompletion({ override: [wikiLinkCompletions()], activateOnTyping: true });
}

/**
 * Resolves a wiki target to a thought and focuses it (best-effort: exact title
 * match first, then the closest name/synonym hit; a miss shows a notice).
 */
export async function openWikiTarget(name: string): Promise<void> {
  const networkId = requireNetworkId();
  try {
    const res = await etn.thoughts.search(networkId, { q: name, scope: 'names', limit: 10 });
    const hit = res.by_names.find((h) => h.title === name) ?? res.by_names[0];
    if (hit === undefined) {
      notice(`Мысль «${name}» не найдена.`, 'error');
      return;
    }
    await setFocus(hit.thought_id);
  } catch (err) {
    notice(`Не удалось открыть «${name}»: ${errText(err)}`, 'error');
  }
}

let navigationWired = false;

/** Installs the delegated view-mode click handler (call once from main.ts). */
export function initWikiLinkNavigation(): void {
  if (navigationWired) return;
  navigationWired = true;
  document.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const link = target?.closest?.(`.${WIKI_LINK_CLASS}`);
    if (!(link instanceof HTMLElement)) return;
    const name = link.getAttribute(WIKI_LINK_TARGET_ATTR);
    if (name === null || name === '') return;
    void openWikiTarget(name);
  });
}
