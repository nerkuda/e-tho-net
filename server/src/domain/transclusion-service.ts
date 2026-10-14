/**
 * Server-side resolver and body expander for comment transclusions
 * (ТП2 «Трансклюзии комментариев», задача `bcfc7eb7`, ADR `85a7a01e`,
 * требования `2fb33964`, `166a7555`, `39e30070`).
 *
 * Parsing and expansion live ONLY in `@etn/markdown`
 * (`expandTransclusions`): the package has no database access and receives
 * source texts through the injected resolver-dependency. This module is the
 * server's resolver — it reads the permanent comment of a source thought of the
 * SAME network through the layer-resolving `comments_v` view. Recursion, the
 * depth cap (5) and the cycle guard all stay inside `@etn/markdown`; the server
 * never parses transclusion references itself (guard
 * `own-transclusion-outside-package`).
 *
 * The expander is applied ONLY on the MCP delivery path (agent-facing reads):
 * `body_md` in the database keeps the transclusion references, so REST
 * responses and the client widgets (ТП2 «Трансклюзии комментариев») always read
 * the raw form. See «MCP. Сервер отдаёт body_md с развёрнутыми трансклюзиями»
 * in the ТП2 permanent comment.
 */

import {
  expandTransclusions,
  parseTransclusions,
  renderMarkdown,
  type TransclusionLabels,
  type TransclusionResolver,
} from '@etn/markdown';
import type { TransclusionLostWarning } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';

/**
 * Серверные подписи контейнеров трансклюзий для рендера публикаций
 * (`env.transclusionLabels`): те же русские строки, что клиент берёт из `t()`
 * (`comment.transclusion.*`, client/src/renderer/lib/locales/ru.ts). Единый
 * рендерер строк не знает — их передаёт вызывающий, а сервер не имеет доступа
 * к клиентским локалям, поэтому строки захардкожены (ошибка `3b3035cf`).
 */
export const SERVER_TRANSCLUSION_LABELS: TransclusionLabels = {
  noSource: 'Нет источника трансклюзии',
  noSection: 'Нет раздела в источнике трансклюзии',
  skipped: 'Ссылка не раскрыта',
};

/**
 * Transform applied to a FULL `body_md` before it is sliced into a preview or
 * returned as-is. Injected as an opaque dependency by the MCP facades; the
 * domain comment readers stay transport-agnostic (REST passes nothing).
 */
export type BodyExpander = (body_md: string) => string;

/** Развёрнутое тело комментария в паре `body_md`/`body_html` (MCP-выдача). */
export interface PresentedBody {
  body_md: string;
  body_html: string;
}

/**
 * Build a {@link TransclusionResolver} over one network connection. Called by
 * `@etn/markdown` once per reference; the same source may be referenced several
 * times (including from nested levels), so the resolved full permanent body is
 * cached per source id for the lifetime of the resolver.
 *
 * A source with no permanent comment (absent thought, torn-down comment, or a
 * link/chronological owner) resolves to `{ found: false }` — the package emits
 * the `missing` marker of the ADR `85a7a01e` format.
 */
export function createTransclusionResolver(ndb: NetworkDb): TransclusionResolver {
  const cache = new Map<string, { found: boolean; body_md: string }>();
  return (sourceId: string) => {
    const cached = cache.get(sourceId);
    if (cached !== undefined) return cached;
    const row = ndb
      .prepare(
        `SELECT body_md FROM comments_v
          WHERE owner_type = 'thought' AND owner_id = ? AND kind = 'permanent'
          LIMIT 1`,
      )
      .get(sourceId) as { body_md: string } | undefined;
    const resolved =
      row === undefined
        ? { found: false, body_md: '' }
        : { found: true, body_md: row.body_md };
    cache.set(sourceId, resolved);
    return resolved;
  };
}

/**
 * Build a {@link BodyExpander} bound to one network connection. The returned
 * function expands transclusions up to the package's depth cap (5) with the
 * ADR `85a7a01e` boundary markers; a body without references is returned
 * unchanged.
 */
export function createBodyExpander(ndb: NetworkDb): BodyExpander {
  const resolve = createTransclusionResolver(ndb);
  return (body_md: string): string => expandTransclusions(body_md, resolve);
}

/**
 * Build a {@link BodyExpander} that expands transclusions WITHOUT the ADR
 * `85a7a01e` boundary markers (`markers: false`): plain expanded text only.
 * Used for the Markdown export of publications (the boundary HTML comments must
 * never leak into the file) and for MCP chronicle `snippet`/preview text
 * (ошибка `a3fb62b6`), where neither the raw link nor the markers may show. An
 * absent/skipped source simply contributes nothing.
 */
export function createPlainBodyExpander(ndb: NetworkDb): BodyExpander {
  const resolve = createTransclusionResolver(ndb);
  return (body_md: string): string =>
    expandTransclusions(body_md, resolve, { markers: false });
}

/** Историческое имя {@link createPlainBodyExpander} (превью-текст MCP). */
export const createSnippetExpander = createPlainBodyExpander;

/**
 * Соответствие офсетов РАЗВЁРНУТОГО текста исходному `body_md` (ошибка
 * `3b3035cf`). Развёртка копирует собственные фрагменты текста (между
 * ссылками-трансклюзиями) ДОСЛОВНО, поэтому нужны две вещи: понять, попал ли
 * офсет внутрь вставки (там разметка `data-md-*` не ставится — резолв каретки
 * идёт фолбэком), и перевести офсет собственного фрагмента обратно в координаты
 * `body_md` (иначе клик по своим абзацам «плывёт» относительно `body_md`).
 */
export interface ExpandedOffsetAlign {
  /** Офсет внутри вставки (между собственными фрагментами) — разметку не ставим. */
  insideInsertion(offset: number): boolean;
  /** Исходный офсет для офсета развёрнутого текста. */
  toRaw(offset: number): number;
}

/** Строка-маркер границы развёртки (ADR `85a7a01e`) в развёрнутом тексте. */
const TRANSCLUSION_MARKER_LINE_RE =
  /^<!--[ \t]*etn:transclusion[ \t]+(begin|end|skip|missing)\b[^\n]*-->[ \t]*$/gm;

/** Ближайший маркер развёртки на/после `from`; `kind` — вид, `end` — за строкой. */
function nextTransclusionMarker(
  expanded: string,
  from: number,
): { kind: string; end: number } | null {
  TRANSCLUSION_MARKER_LINE_RE.lastIndex = from;
  const match = TRANSCLUSION_MARKER_LINE_RE.exec(expanded);
  return match === null ? null : { kind: match[1]!, end: match.index + match[0].length };
}

/**
 * Позиция сразу за блоком вставки, начинающимся на/после `from`: за закрывающим
 * маркером `end` (с учётом вложенности) либо за листовым `skip`/`missing`.
 * `-1` — маркера нет.
 */
function insertionBlockEnd(expanded: string, from: number): number {
  let depth = 0;
  let pos = from;
  for (;;) {
    const marker = nextTransclusionMarker(expanded, pos);
    if (marker === null) return -1;
    if (marker.kind === 'begin') depth += 1;
    else if (marker.kind === 'end') {
      depth -= 1;
      if (depth <= 0) return marker.end;
    } else if (depth === 0) return marker.end; // skip|missing — листовая вставка
    pos = marker.end;
  }
}

/**
 * Строит {@link ExpandedOffsetAlign} для пары «исходный → развёрнутый текст».
 *
 * Один проход по собственным фрагментам сырого текста в порядке следования:
 * каждый ищется в развёрнутом тексте НАЧИНАЯ С ПОЗИЦИИ ЗА ЗАКРЫВАЮЩИМ МАРКЕРОМ
 * предыдущей вставки ({@link insertionBlockEnd}), а не от конца предыдущего
 * своего фрагмента. Иначе текст вставки (её источника), содержащий такой же
 * фрагмент, засчитывался бы за собственный — разметка с чужими офсетами
 * попадала ВНУТРЬ `md-transclusion`, а истинный свой текст оставался без
 * разметки (блокер круга 4). Разбор ссылок — только парсером `@etn/markdown`
 * (`parseTransclusions`), своего разбора ссылок-трансклюзий здесь нет (сторож
 * `own-transclusion-outside-package`).
 *
 * `null` — трансклюзий нет либо фрагменты не удалось сопоставить (тогда разметку
 * оставляем как есть — лучше, чем испортить офсеты).
 */
export function alignExpandedOffsets(raw: string, expanded: string): ExpandedOffsetAlign | null {
  const refs = parseTransclusions(raw);
  if (refs.length === 0) return null;
  const ranges: Array<{ expStart: number; expEnd: number; rawStart: number }> = [];
  let searchFrom = 0;
  let rawCursor = 0;
  for (let i = 0; i <= refs.length; i += 1) {
    const segEnd = i < refs.length ? refs[i]!.start : raw.length;
    if (segEnd > rawCursor) {
      const piece = raw.slice(rawCursor, segEnd);
      const idx = expanded.indexOf(piece, searchFrom);
      if (idx < 0) return null;
      ranges.push({ expStart: idx, expEnd: idx + piece.length, rawStart: rawCursor });
      searchFrom = idx + piece.length;
    }
    if (i < refs.length) {
      const after = insertionBlockEnd(expanded, searchFrom);
      if (after < 0) return null;
      searchFrom = after;
      rawCursor = refs[i]!.end;
    }
  }
  if (ranges.length === 0) return null;
  const containing = (offset: number): (typeof ranges)[number] | undefined =>
    ranges.find((r) => offset >= r.expStart && offset <= r.expEnd);
  return {
    insideInsertion: (offset: number): boolean => containing(offset) === undefined,
    toRaw: (offset: number): number => {
      const hit = containing(offset);
      if (hit !== undefined) return hit.rawStart + (offset - hit.expStart);
      const next = ranges.find((r) => r.expStart > offset);
      if (next !== undefined) return next.rawStart;
      const last = ranges[ranges.length - 1]!;
      return last.rawStart + (last.expEnd - last.expStart);
    },
  };
}

/** Офсет из атрибута `data-md-<name>="N"` тега либо `null`. */
function tagSourceOffset(tag: string, name: 'start' | 'end' | 'after'): number | null {
  const match = new RegExp(`\\sdata-md-${name}="(\\d+)"`).exec(tag);
  return match === null ? null : Number(match[1]);
}

/** Любой атрибут разметки позиций `data-md-*` (со значением или без). */
const MD_ATTR_RE = /\sdata-md-[a-z-]+(?:="[^"]*")?/g;
/** Числовой атрибут-офсет разметки позиций. */
const MD_NUMERIC_ATTR_RE = /\s(data-md-(?:start|end|after))="(\d+)"/g;

/**
 * Переписывает разметку позиций развёрнутого текста (см.
 * {@link alignExpandedOffsets}).
 *
 * ВНУТРИ вставок (`md-transclusion`) разметки source-map не остаётся вовсе:
 * снимаются `data-md-start/end/after`, а также `data-md-leaf`/`data-md-shift`
 * (для них нет числового офсета-опоры, поэтому решение принимается по тегу
 * целиком — если опорный офсет тега внутри вставки, атрибуты тега удаляются).
 * В собственном тексте числовые офсеты переводятся в координаты `body_md`, а
 * `leaf`/`shift` сохраняются (`shift` — границы в РЕНДЕРНЫХ символах, от сдвига
 * источника не зависят).
 */
export function remapExpandedSourceOffsets(html: string, align: ExpandedOffsetAlign): string {
  return html.replace(/<[a-zA-Z][^>]*>/g, (tag: string) => {
    if (!/\sdata-md-/.test(tag)) return tag;
    const anchor =
      tagSourceOffset(tag, 'start') ?? tagSourceOffset(tag, 'after') ?? tagSourceOffset(tag, 'end');
    if (anchor !== null && align.insideInsertion(anchor)) {
      return tag.replace(MD_ATTR_RE, '');
    }
    return tag.replace(MD_NUMERIC_ATTR_RE, (whole, name: string, value: string) => {
      const mapped = align.toRaw(Number(value));
      return mapped === Number(value) ? whole : ` ${name}="${mapped}"`;
    });
  });
}

/**
 * Развёрнутый текст превью-рендер с офсетами, «свёрнутыми» в координаты
 * исходного `body_md` (ошибка `3b3035cf`): трансклюзии раскрыты, а `data-md-*`
 * собственного текста точны относительно `body_md`. `render` — рендер `@etn/markdown`
 * (публикационный, с `sourceMap`); развёртку и разбор даёт общий пакет.
 */
export function withRawSourceOffsets(
  raw: string,
  expanded: string,
  html: string,
): string {
  const align = alignExpandedOffsets(raw, expanded);
  return align === null ? html : remapExpandedSourceOffsets(html, align);
}


/**
 * Презентер тела комментария для MCP-инструментов, отдающих РЯДОМ `body_md` и
 * `body_html` (`etn.comments.get`, `etn.chronicle.query`): разворачивает
 * трансклюзии (как {@link createBodyExpander}) и пересобирает `body_html` из
 * РАЗВЁРНУТОГО текста тем же единым рендерером `@etn/markdown`, каким собран
 * кеш при записи (`comment-service`). Иначе кешированный `body_html` остаётся
 * собранным из исходного текста и показывает нетронутую ссылку-трансклюзию
 * (ошибка `a6da3d37`).
 *
 * Маркеры границ ADR `85a7a01e` — HTML-комментарии, поэтому рендер их скрывает
 * и пользовательского текста они не касаются. Рендер идёт без ограничения
 * длины: развёрнутый текст (до 5 уровней) может превысить дефолтный лимит
 * `renderMarkdown`, и чтение упало бы — тогда как сам `body_md` агенту нужен
 * целиком.
 */
export function createBodyPresenter(ndb: NetworkDb): (body_md: string) => PresentedBody {
  const expand = createBodyExpander(ndb);
  return (body_md: string): PresentedBody => {
    const expanded = expand(body_md);
    return { body_md: expanded, body_html: renderMarkdown(expanded, { maxLength: Infinity }) };
  };
}

/**
 * Source ids whose live transclusions disappeared between two versions of a
 * markdown field (ТП2, задача `ed796c43`, требование `822a9149`).
 *
 * The references are parsed by the single `@etn/markdown` parser
 * (`parseTransclusions`) — the server never parses the transclusion syntax
 * itself (ADR `8c41387c`, guard `own-transclusion-outside-package`). SETS of
 * source ids are compared, so a reference moved or repeated elsewhere in the
 * text is not a loss, while dropping one of several (or replacing `A` with `B`)
 * is. Order follows the ORIGINAL text so the warning is stable and readable.
 *
 * `before` with no references — or a non-markdown field — yields `[]`.
 */
export function lostTransclusionSources(before: string, after: string): string[] {
  const beforeIds = parseTransclusions(before).map((ref) => ref.sourceId);
  if (beforeIds.length === 0) return [];
  const afterIds = new Set(parseTransclusions(after).map((ref) => ref.sourceId));
  const lost: string[] = [];
  const seen = new Set<string>();
  for (const id of beforeIds) {
    if (afterIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    lost.push(id);
  }
  return lost;
}

/**
 * Warning for a markdown write that lost live transclusions, or `null` when
 * nothing was lost (требование `822a9149`). The write is advisory — the caller
 * still applies it and merely attaches the warning to the response.
 */
export function transclusionLossWarning(
  before: string,
  after: string,
): TransclusionLostWarning | null {
  const sources = lostTransclusionSources(before, after);
  return sources.length === 0 ? null : { code: 'TRANSCLUSION_LOST', sources };
}
