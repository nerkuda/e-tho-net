/**
 * Позиционный разбор date-ссылок ОДНОЙ строки (0.16.1, задача 632eca85;
 * ADR «date-ссылка приоритетнее одноимённой мысли» fa50de55; стандарт
 * «единый markdown-рендерер» 673fa25f).
 *
 * Зачем модуль. Правка строки задачи (PATCH /tasks: move) сдвигает даты прямо
 * в `body_md` источника, по позициям. Держать регэксп даты рядом с сервером
 * нельзя: грамматика date-ссылок живёт только в этом пакете, и второй разбор
 * неизбежно разошёлся бы с рендером (сторож
 * `guard-markdown-single-renderer`). Поэтому границы ссылки в тексте берутся
 * из правила `wiki_link` единого рендерера, а цель проверяется тем же
 * {@link parseDateLinkTarget}, что и при рендере.
 *
 * Следствия для потребителя: inline-code (`` `[[2026-12-01]]` ``) и цели,
 * которые грамматика не признаёт date-ссылкой (`[[2026-01-05T10:00]]` —
 * legacy-ссылка по имени), в результат не попадают, хотя по форме похожи на
 * дату.
 */

import { getRenderer } from './renderer.js';
import { parseDateLinkTarget, type DateLinkParts, type WikiLinkMeta } from './wiki-link.js';

/** Найденная date-ссылка строки с позициями для точечной замены. */
export interface DateLinkSpan {
  /** Начало ссылки `[[` в переданной строке (включительно). */
  start: number;
  /** Конец ссылки после `]]` (исключительно). */
  end: number;
  /** Начало ЦЕЛИ без скобок и без `|алиаса` — там стоит ISO-дата. */
  targetStart: number;
  /** Конец цели (исключительно). */
  targetEnd: number;
  /** Разобранная цель: дата и необязательное время. */
  parts: DateLinkParts;
}

/**
 * Найти все date-ссылки строки в порядке документа.
 *
 * Строка разбирается `parseInline` того же инстанса markdown-it: блочная
 * разметка (`- `, `- [ ] `, отступ) в позиционном разборе не участвует, а
 * offsets потомков совпадают с offsets переданной строки.
 *
 * @throws когда `source` не строка.
 */
export function findDateLinkSpans(source: string): DateLinkSpan[] {
  if (typeof source !== 'string') {
    throw new Error('findDateLinkSpans: source must be a string');
  }
  const spans: DateLinkSpan[] = [];
  for (const token of getRenderer().parseInline(source, {})) {
    if (token.type !== 'inline') continue;
    for (const child of token.children ?? []) {
      if (child.type !== 'wiki_link') continue;
      const meta = child.meta as WikiLinkMeta | null;
      if (meta === null || meta.kind !== 'date') continue;
      const link = meta.mdRelativeLink ?? null;
      if (link === null) continue;
      // Цель в исходнике — подстрока между скобками до `|`; берём её позицию
      // поиском самого target: правило обрезает пробелы, и `[[ 2026-11-20 ]]`
      // тоже валидная date-ссылка.
      const innerStart = link.start + 2;
      const innerEnd = Math.max(innerStart, link.end - 2);
      const targetAt = source.slice(innerStart, innerEnd).indexOf(meta.target);
      if (targetAt === -1) continue;
      const parts =
        meta.date === null
          ? parseDateLinkTarget(meta.target)
          : { date: meta.date, time: meta.time };
      if (parts === null) continue;
      spans.push({
        start: link.start,
        end: link.end,
        targetStart: innerStart + targetAt,
        targetEnd: innerStart + targetAt + meta.target.length,
        parts,
      });
    }
  }
  return spans;
}
