/**
 * Автолинк явных схем БЕЗ `//` — в частности `mailto:…` (ошибка 37458cbc,
 * круг 3).
 *
 * Зачем. Паритет режимов (замечание пользователя 2026-10-03 / задача 5de0332d,
 * ошибка 37458cbc) требует: строка, которую редактор подсвечивает как ссылку
 * (GFM Autolink у Lezer — `http:`, `https:`, `mailto:`, `www.`, адреса), в
 * просмотре тоже должна быть ссылкой. Встроенное внутристрочное правило
 * markdown-it срабатывает ТОЛЬКО на `://`, поэтому `mailto:user@example.com`
 * оставалось текстом; ловившее его ядровое правило выключено в круге 2 (оно же
 * автолинкало protocol-relative `//host`, см. `renderer.ts`).
 *
 * Что делает. Правило зеркалит встроенное (`rules_inline/linkify.mjs`), но
 * срабатывает на схеме, за которой НЕ следует `://`. Схема читается из
 * `state.pending` тем же SCHEME_RE (RFC3986), а сам адрес отдаёт
 * `md.linkify.matchAtStart` — то есть решает linkify-it со своими схемами и
 * нормализацией, ровно как ядровое правило. Поэтому `mailto:` становится
 * ссылкой, а `data:`, `javascript:`, `http:x`, `//host` и «голые» домены
 * остаются текстом: их нет в схемах linkify-it либо в allow-list
 * `md.validateLink` (плагин безопасности `link.ts` проверяет результат повторно).
 *
 * `://` правило пропускает — это область встроенного `linkify` (иначе `http(s):`
 * обрабатывался бы дважды). Разметка позиций (sourceMap) — в `source-map.ts`
 * (inline capture общий для обоих правил автолинка).
 */

import type MarkdownIt from 'markdown-it';

/** Имя правила: по нему `source-map.ts` вешает разметку позиций. */
export const SCHEME_AUTOLINK_RULE = 'linkify_scheme';

/** Схема в конце `state.pending` (та же регулярка, что у встроенного правила). */
const SCHEME_RE = /(?:^|[^a-z0-9.+-])([a-z][a-z0-9+.-]*)$/i;

const COLON = 0x3a; // :
const SLASH = 0x2f; // /

/** Минимум, что правило читает у состояния inline-парсера сверх типов. */
interface InlineStateLike {
  linkLevel?: number;
}

/**
 * Регистрирует правило автолинка схем без `//` (сразу после встроенного
 * `linkify` — они делят одну область «явная схема» и не пересекаются).
 */
export function schemeAutolinkPlugin(md: MarkdownIt): void {
  md.inline.ruler.after('linkify', SCHEME_AUTOLINK_RULE, (state, silent) => {
    // Внутри метки ссылки автолинка нет — как у встроенного правила.
    if (((state as unknown as InlineStateLike).linkLevel ?? 0) > 0) return false;
    const pos = state.pos;
    if (state.src.charCodeAt(pos) !== COLON) return false;
    // `://` — область встроенного правила `linkify`.
    if (
      state.src.charCodeAt(pos + 1) === SLASH &&
      state.src.charCodeAt(pos + 2) === SLASH
    ) {
      return false;
    }
    const proto = SCHEME_RE.exec(state.pending)?.[1];
    if (proto === undefined) return false;
    const link = md.linkify.matchAtStart(state.src.slice(pos - proto.length));
    if (link === null) return false;
    // Защита от бесконечного цикла, как у встроенного правила: адрес обязан
    // быть длиннее самой схемы.
    if (link.url.length <= proto.length) return false;
    const fullUrl = md.normalizeLink(link.url);
    if (!md.validateLink(fullUrl)) return false;
    if (!silent) {
      // Схема уходит из накопленного текста в ссылку (встроенное правило).
      state.pending = state.pending.slice(0, -proto.length);
      const tokenOpen = state.push('link_open', 'a', 1);
      tokenOpen.attrs = [['href', fullUrl]];
      tokenOpen.markup = 'linkify';
      tokenOpen.info = 'auto';
      const tokenText = state.push('text', '', 0);
      tokenText.content = md.normalizeLinkText(link.url);
      const tokenClose = state.push('link_close', 'a', -1);
      tokenClose.markup = 'linkify';
      tokenClose.info = 'auto';
    }
    state.pos += link.url.length - proto.length;
    return true;
  });
}
