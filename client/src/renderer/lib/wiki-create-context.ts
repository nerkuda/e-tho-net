/**
 * Comment-context registry for a markdown field (карточка ETN 34ffbd75;
 * уточнено задачей 8e4e3dc5, 0.12.2).
 *
 * Клик по элементу внутри поля комментария иногда должен знать ВЛАДЕЛЬЦА поля
 * (мысль или связь): флоу «создать отсутствующую мысль по legacy-ссылке»
 * (`editor/wiki-link-create.ts`) берёт владельца родителем новой мысли, а
 * открытие `etnimg://`-вложения (`lib/etnimg-link.ts`) — владельцем вложения.
 * Оба идут от кликнутого элемента вверх к ближайшему корню `.md-field`, который
 * при создании привязал себя здесь (`bindWikiCreateContext`, `commentContext`-
 * опция `editor/markdown-field.ts`).
 *
 * Deliberately dependency-free (no imports): `editor/markdown-field.ts`,
 * `editor/wiki-link-create.ts` и `lib/etnimg-link.ts` импортируют этот модуль,
 * а импорт чужих соседей закрыл бы цикли зависимостей. Keep it that way.
 */

/** Owner of a comment: the thought or the link the comment is attached to. */
export type WikiCommentOwnerType = 'thought' | 'link';

/**
 * Владелец поля комментария, привязанный к его корню (`.md-field`). Потребители
 * ({@link findWikiCreateContext}) читают только владельца.
 */
export interface WikiCreateCommentContext {
  ownerType: WikiCommentOwnerType;
  ownerId: string;
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
