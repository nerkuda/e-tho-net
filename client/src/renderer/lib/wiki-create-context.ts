/**
 * Comment-context registry for a markdown field (карточка ETN 34ffbd75;
 * уточнено задачей 8e4e3dc5, 0.12.2).
 *
 * Клик по элементу внутри поля комментария иногда должен знать ВЛАДЕЛЬЦА поля
 * (мысль или связь): флоу «создать отсутствующую мысль по legacy-ссылке»
 * (`editor/wiki-link-create.ts`) берёт владельца родителем новой мысли, а
 * открытие `etnimg://`-вложения (`lib/etnimg-link.ts`) — владельцем вложения.
 * Оба идут от кликнутого элемента вверх к ближайшему корню, который при
 * создании привязал себя здесь (`bindWikiCreateContext`).
 *
 * Корень — НЕ обязательно `.md-field`: привязка указывает сам свой корень, а
 * поиск поднимается по предкам до первого привязанного узла. Так статичные
 * поверхности просмотра без поля markdown (лента «Дневника» — `recordView`)
 * тоже несут контекст, иначе клик по легаси-ссылке в просмотре записи не знал
 * бы владельца и открывал уведомление «мысль не найдена» вместо диалога
 * создания (дефект визуальной проверки, задача 8e4e3dc5).
 *
 * Владелец может прийти ленивым источником (функцией): у статичной поверхности
 * HOME-мысль к моменту сборки карточки ещё не разрешена, а к моменту клика —
 * уже да. Функция вызывается в момент чтения контекста и может вернуть `null`
 * (владельца нет) — тогда потребитель обходится без родителя.
 *
 * Deliberately dependency-free (no imports): `editor/markdown-field.ts`,
 * `editor/wiki-link-create.ts` и `lib/etnimg-link.ts` импортируют этот модуль,
 * а импорт чужих соседей закрыл бы цикли зависимостей. Keep it that way.
 */

/** Owner of a comment: the thought or the link the comment is attached to. */
export type WikiCommentOwnerType = 'thought' | 'link';

/**
 * Владелец поля комментария, привязанный к его корню. Потребители
 * ({@link findWikiCreateContext}) читают только владельца.
 */
export interface WikiCreateCommentContext {
  ownerType: WikiCommentOwnerType;
  ownerId: string;
}

/**
 * Источник контекста: готовый владелец либо ленивая функция (читается в момент
 * клика; `null` — владельца определить не удалось).
 */
export type WikiCreateContextSource =
  | WikiCreateCommentContext
  | (() => WikiCreateCommentContext | null);

const contexts = new WeakMap<HTMLElement, WikiCreateContextSource>();

/** Binds a field/surface root to its comment context (value or lazy getter). */
export function bindWikiCreateContext(root: HTMLElement, ctx: WikiCreateContextSource): void {
  contexts.set(root, ctx);
}

/**
 * The comment context governing the surface containing `el`: walks up the
 * ancestors to the closest root bound via {@link bindWikiCreateContext} and
 * resolves it (lazy sources are called here). Returns `null` when no ancestor
 * is bound or the bound owner is currently unknown.
 */
export function findWikiCreateContext(el: Element | null): WikiCreateCommentContext | null {
  let node: Element | null = el;
  while (node !== null) {
    const source = contexts.get(node as HTMLElement);
    if (source !== undefined) {
      const resolved = typeof source === 'function' ? source() : source;
      if (resolved !== null) return resolved;
    }
    // `parentElement` есть у настоящего DOM; `?? null` защищает от
    // не-DOM-объектов (тестовые заглушки), у которых его нет.
    node = node.parentElement ?? null;
  }
  return null;
}
