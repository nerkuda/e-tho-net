/**
 * Инлайн-узлы ТП1 редактора комментария (ошибка 475fc35e): выделение `==…==`
 * и подчёркивание `<u>…</u>`.
 *
 * Лексер `@codemirror/lang-markdown` не знает этих конструкций: `==` — просто
 * текст, а `<u>` разбирается как `HTMLTag`. Узлы описаны здесь, чтобы живой
 * просмотр (`md-live.ts`) мог различить маркеры и содержимое. Механика — как
 * у GFM-зачёркивания: делимитеры пар `==`/`==` и `<u>`/`</u>` разрешаются в
 * узлы `Mark`/`Underline`, содержимое между ними парсится обычным конвейером
 * (вложенный `**` и т.п.). Паритет с единым рендерером: пустая пара
 * (`====`, `<u></u>`) даёт узел с ПУСТЫМ содержимым — `md-live.ts` такие
 * маркеры не скрывает, оставляя литерал, как и `@etn/markdown`
 * (`markdown/src/mark.ts`, `underline.ts`).
 */

import { tags } from '@lezer/highlight';
import type { DelimiterType, MarkdownExtension } from '@lezer/markdown';

/** Делимитеры `==…==`: пара даёт узел `Mark` и два `MarkMark`. */
const markDelim: DelimiterType = { resolve: 'Mark', mark: 'MarkMark' };

/** Делимитеры `<u>…</u>`: узел `Underline` и два `UnderlineMark`. */
const underlineDelim: DelimiterType = { resolve: 'Underline', mark: 'UnderlineMark' };

/** Сравнение кода буквы с `u`/`U` (как в едином рендерере). */
function isUChar(code: number): boolean {
  return (code | 0x20) === 0x75;
}

/** Расширение языка с инлайн-узлами ТП1 для `markdown({ extensions: […] })`. */
export const markdownInlineExt: MarkdownExtension = {
  defineNodes: [
    { name: 'Mark' },
    { name: 'MarkMark', style: tags.processingInstruction },
    { name: 'Underline' },
    { name: 'UnderlineMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'Mark',
      // Как GFM Strikethrough — после Emphasis, чтобы `==` не мешал `*`/`_`.
      after: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== 0x3d /* = */ || cx.char(pos + 1) !== 0x3d) return -1;
        // `==` может и открывать, и закрывать — пару разрешает лексер.
        return cx.addDelimiter(markDelim, pos, pos + 2, true, true);
      },
    },
    {
      name: 'Underline',
      // До HTMLTag: иначе `<u>`/`</u>` поглощаются как HTML-теги.
      before: 'HTMLTag',
      parse(cx, next, pos) {
        if (next !== 0x3c /* < */) return -1;
        const second = cx.char(pos + 1);
        // Открывающий `<u>` — три символа, имя тега регистронезависимо.
        if (isUChar(second) && cx.char(pos + 2) === 0x3e /* > */) {
          return cx.addDelimiter(underlineDelim, pos, pos + 3, true, false);
        }
        // Закрывающий `</u>` — четыре символа.
        if (second === 0x2f /* / */ && isUChar(cx.char(pos + 2)) && cx.char(pos + 3) === 0x3e) {
          return cx.addDelimiter(underlineDelim, pos, pos + 4, false, true);
        }
        return -1;
      },
    },
  ],
};
