/**
 * Comment-context registry for the «создать отсутствующую мысль по
 * legacy-ссылке» flow (task «Создание отсутствующих мыслей по legacy-ссылкам
 * на них», карточка ETN 34ffbd75).
 *
 * A click on an unresolvable legacy wiki-link `[[имя|текст]]` inside a
 * comment's view mode must know WHICH comment it lives in (owner thought/link,
 * permanent vs chronological, the comment id) and how to repaint that field
 * after the links are rewritten to the `[[#<id>]]` form. The click is handled
 * by the delegated document listener in `editor/wiki-link.ts`, so the context
 * has to be discoverable from the clicked element: every markdown field built
 * by `editor/markdown-field.ts` with a `commentContext` option binds its root
 * (`.md-field`) here, and the flow (`editor/wiki-link-create.ts`) walks up
 * from the clicked span with {@link findWikiCreateContext}.
 *
 * Deliberately dependency-free (no imports): `editor/markdown-field.ts` and
 * `editor/wiki-link-create.ts` both import this module, while importing each
 * other's neighbours would close module cycles (markdown-field →
 * mentions-annotate → wiki-link → wiki-link-create → add-dialog → canvas →
 * editor → comments → markdown-field). Keep it that way.
 */

/** Owner of a comment: the thought or the link the comment is attached to. */
export type WikiCommentOwnerType = 'thought' | 'link';

/**
 * Everything the create-missing-thought flow needs about the comment whose
 * view was clicked. Bound per `.md-field` root; the getters read live state
 * (a chronological tab rebuilds the field per selected entry, a permanent
 * comment may be created by a later save).
 */
export interface WikiCreateCommentContext {
  ownerType: WikiCommentOwnerType;
  ownerId: string;
  /** Which comment kind this field renders. */
  commentKind: 'permanent' | 'chronological';
  /**
   * Id of the comment shown right now, or `null` when it is not known (a
   * brand-new chronological entry that has not been saved yet).
   */
  getCommentId(): string | null;
  /** Repaints the field after `[[имя]]` links were rewritten to `[[#<id>]]`. */
  refresh(md: string, html: string): void;
  /** Optional hook after a successful rewrite (e.g. the chrono table's short
   * text preview). */
  afterLinksReplaced?(): void;
}

const contexts = new WeakMap<HTMLElement, WikiCreateCommentContext>();

/** Binds a field root (`.md-field`) to its comment context. */
export function bindWikiCreateContext(root: HTMLElement, ctx: WikiCreateCommentContext): void {
  contexts.set(root, ctx);
}

/**
 * The comment context of the markdown field containing `el` (walks up to the
 * closest `.md-field` root), or `null` when the element is not inside a
 * comment field that opted into the flow.
 */
export function findWikiCreateContext(el: Element | null): WikiCreateCommentContext | null {
  const root = el?.closest('.md-field');
  if (!(root instanceof HTMLElement)) return null;
  return contexts.get(root) ?? null;
}
