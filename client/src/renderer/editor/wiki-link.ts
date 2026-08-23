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

import { WIKI_LINK_CLASS, WIKI_LINK_TARGET_ATTR, WIKI_LINK_ID_ATTR, WIKI_LINK_NETWORK_ATTR } from '@etn/markdown';
import type { Thought } from '@etn/shared';

import { openNetwork, requireNetworkId, setFocus } from '../app.js';
import { showDialog } from '../lib/dialog.js';
import { el, errText } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { isThoughtInResults, openStructuresThought } from '../screens/structures/structures.js';
import { setActiveView } from '../screens/active-view.js';
import { openChronicleThought } from '../screens/chronicle/chronicle.js';
import { store } from '../state.js';

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
      // До правила Link: иначе `[[мысль|алиас]]` разбирается как
      // ссылка-ссылка (LinkReference), и wiki-узел не создаётся.
      before: 'Link',
      parse(cx, next, pos) {
        if (next !== 91 /* [ */ || cx.char(pos + 1) !== 91) return -1;
        // cx.text — только текущий инлайн-блок, позиции — документальные:
        // ищем «]]» в координатах блока, результат переводим обратно.
        const rel = cx.text.indexOf(']]', pos - cx.offset + 2);
        if (rel === -1) return -1;
        const end = cx.offset + rel;
        const content = cx.slice(pos + 2, end);
        if (content === '' || content.includes('\n') || content.includes('\r')) return -1;
        // Узел покрывает обе закрывающие скобки.
        return cx.addElement(cx.elt('WikiLink', pos, end + 2));
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
      // ID-based wiki-link (фаза R): вставляем `[[#<id>]]`, чтобы ссылка
      // пережила переименование. Имя подтянется view-резолвером.
      type: 'text',
      apply: `#${hit.thought_id}]]`,
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
 * Диалог «переключиться на карту мыслей?» (M11): мысль не отображается в
 * текущих результатах структуры.
 */
function confirmSwitchToMap(): Promise<boolean> {
  return new Promise((resolve) => {
    showDialog({
      title: 'Мысль не отображается',
      body: el(
        'p',
        'dialog-text',
        'Эта мысль не отображается в структуре мыслей. Переключиться на карту мыслей?',
      ),
      buttons: [
        { label: 'Нет', onClick: () => resolve(false) },
        { label: 'Да', primary: true, onClick: () => resolve(true) },
      ],
    });
  });
}

/**
 * Opens an already-resolved thought by the current view's rules (M11): on the
 * canvas — focus; in structures — activation among displayed thoughts, else a
 * "switch to the map?" dialog; in the chronicle — open in the editor without
 * moving canvas focus (08-ui-spec.md §17). An inactive thought with «скрывать
 * неактуальное» on is refused with a notice. Shared by wiki-links (name
 * resolved here) and the mentions auto-annotation (L24, id already known —
 * see `mentions-annotate.ts`).
 */
export async function openThoughtByRef(thought: Thought): Promise<void> {
  if (!thought.active && !store.state.showInactive) {
    notice('Не могу открыть неактуальную мысль — неактуальные мысли не отображаются.', 'error');
    return;
  }

  if (store.state.activeView === 'structures') {
    if (isThoughtInResults(thought.id)) {
      await openStructuresThought(thought.id);
      return;
    }
    if (await confirmSwitchToMap()) {
      setActiveView('map');
      await setFocus(thought.id);
    }
    return;
  }

  if (store.state.activeView === 'chronicle') {
    // The chronicle view opens the thought in the editor without moving the
    // canvas focus (08-ui-spec.md §17).
    await openChronicleThought(thought.id);
    return;
  }

  await setFocus(thought.id);
}

/**
 * Разрешает wiki-цель в мысль и открывает её по правилам режима (M11) через
 * {@link openThoughtByRef}.
 */
export async function openWikiTarget(name: string): Promise<void> {
  const networkId = requireNetworkId();
  let thoughtId: string | null = null;
  try {
    const res = await etn.thoughts.search(networkId, { q: name, scope: 'names', limit: 10 });
    const hit = res.by_names.find((h) => h.title === name) ?? res.by_names[0];
    thoughtId = hit?.thought_id ?? null;
  } catch (err) {
    notice(`Не удалось открыть «${name}»: ${errText(err)}`, 'error');
    return;
  }
  if (thoughtId === null) {
    notice(`Мысль «${name}» не найдена.`, 'error');
    return;
  }

  let thought: Thought;
  try {
    thought = await etn.thoughts.get(networkId, thoughtId);
  } catch (err) {
    notice(`Не удалось открыть «${name}»: ${errText(err)}`, 'error');
    return;
  }

  await openThoughtByRef(thought);
}

/**
 * Разрешает ID-ссылку ([[#<id>]] / [[n:<net>#<id>]]) в мысль и открывает её
 * (task R8). Если `targetNetworkId` отличается от текущей, сначала
 * переключает активную сеть через {@link openNetwork} — это меняет
 * `currentNetworkId` в store, после чего `etn.thoughts.get` уже работает в
 * нужной сети. Если сеть недоступна (403/404) — сообщение пользователю.
 */
export async function openWikiIdTarget(targetNetworkId: string, thoughtId: string): Promise<void> {
  const currentNetworkId = safeCurrentNetworkId();

  if (targetNetworkId !== currentNetworkId) {
    try {
      await openNetwork(targetNetworkId);
    } catch (err) {
      notice(
        `Сеть недоступна: ${errText(err)}. Ссылка на мысль в другой сети не может быть открыта.`,
        'error',
      );
      return;
    }
  }

  let thought: Thought;
  try {
    thought = await etn.thoughts.get(targetNetworkId, thoughtId);
  } catch (err) {
    notice(`Мысль удалена или недоступна: ${errText(err)}`, 'error');
    return;
  }

  await openThoughtByRef(thought);
}

/**
 * Wrapper around `requireNetworkId` that catches the synchronous throw
 * (no active network) and returns null. The click handler can degrade
 * gracefully instead of crashing when the user is on the network list.
 */
function safeCurrentNetworkId(): string | null {
  try {
    return requireNetworkId();
  } catch {
    return null;
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
    // Внутри редактора клик раскрывает исходник блока (M6), а не переходит;
    // снятые со страницы виджеты (клик уже раскрыл блок) тоже пропускаются.
    if (!link.isConnected || link.closest('.cm-editor') !== null) return;

    // ID-based form (task R8): прямой lookup по UUID, без FTS-поиска.
    // Кросс-сеть — сначала переключаем активную сеть через openNetwork.
    const id = link.getAttribute(WIKI_LINK_ID_ATTR);
    if (id !== null && id !== '') {
      const targetNetworkId = link.getAttribute(WIKI_LINK_NETWORK_ATTR) ?? safeCurrentNetworkId();
      if (targetNetworkId === null) {
        notice('Сначала откройте сеть.', 'error');
        return;
      }
      void openWikiIdTarget(targetNetworkId, id);
      return;
    }

    // Legacy name-based form (M3): резолюция через FTS-поиск по имени.
    const name = link.getAttribute(WIKI_LINK_TARGET_ATTR);
    if (name === null || name === '') return;
    void openWikiTarget(name);
  });
}
