/**
 * Плоский текстовый поиск в поле комментария (0.12.1, задача 045f98db, ТП1
 * «Команды редактирования комментария»; элемент интерфейса «Панель поиска и
 * замены в поле комментария» `b8eabc22`, требование `d72ea6eb`).
 *
 * Модуль ЧИСТЫЙ (без DOM): поиск обычной подстроки и карта «текст просмотра →
 * узлы». Регулярные выражения не поддерживаются — граница ТП1.
 *
 * Просмотр — HTML, собранный из множества текстовых узлов, разбитых
 * внутристрочной разметкой (`<strong>`, `<em>`). Чтобы вхождение, перешагнувшее
 * границу инлайн-узла, всё же находилось, текст просмотра склеивается в одну
 * строку, а совпадение затем отображается назад на пару (узел, смещение).
 * Между блочными контейнерами вставляется разделитель `\n`, поэтому совпадение
 * не «протекает» сквозь границу абзацев (иначе `<p>foo</p><p>bar</p>` дало бы
 * ложное «oob»).
 */

/** Вхождение в тексте: полуинтервал `[from, to)`. */
export interface TextMatch {
  from: number;
  to: number;
}

/**
 * Все неперекрывающиеся вхождения подстроки в порядке возрастания. Пустой
 * запрос — пустой список. По умолчанию регистр не важен.
 */
export function findMatches(text: string, query: string, caseSensitive = false): TextMatch[] {
  if (query === '') return [];
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const out: TextMatch[] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    out.push({ from: index, to: index + needle.length });
    index = haystack.indexOf(needle, index + needle.length);
  }
  return out;
}

/** Фрагмент текста просмотра: узел (по `id`) и его текст. */
export interface SearchSegment {
  /** Идентификатор узла — по нему собирающая сторона находит `Text`. */
  id: number;
  /** Текст узла. */
  text: string;
  /** Ключ блочного контейнера: разные ключи не склеиваются в один поиск. */
  block: number;
}

/** Отображение сегмента на склеенный текст. */
export interface SegmentSpan {
  id: number;
  /** Начало текста сегмента в склеенной строке. */
  start: number;
  /** Конец текста сегмента (не inclusive). */
  end: number;
}

/** Склеенный текст просмотра и карта его сегментов. */
export interface SearchTextMap {
  text: string;
  spans: SegmentSpan[];
}

/**
 * Склеивает сегменты в один текст, вставляя `\n` на границе блочных
 * контейнеров. Пустые сегменты пропускаются (но и разделителя не создают).
 */
export function buildSearchTextMap(segments: readonly SearchSegment[]): SearchTextMap {
  let text = '';
  const spans: SegmentSpan[] = [];
  let prevBlock: number | null = null;
  for (const seg of segments) {
    if (seg.text === '') continue;
    if (prevBlock !== null && seg.block !== prevBlock) text += '\n';
    const start = text.length;
    text += seg.text;
    spans.push({ id: seg.id, start, end: text.length });
    prevBlock = seg.block;
  }
  return { text, spans };
}

/** Совпадение, отображённое на узлы просмотра: пара (узел, смещение). */
export interface MappedMatch {
  /** Начало в склеенном тексте. */
  from: number;
  /** Конец в склеенном тексте. */
  to: number;
  /** Начало в узле. */
  start: { id: number; offset: number };
  /** Конец в узле (смещение — не inclusive). */
  end: { id: number; offset: number };
}

/** Сегмент, содержащий позицию `index` склеенного текста. */
function spanAt(spans: readonly SegmentSpan[], index: number): SegmentSpan | null {
  for (const span of spans) {
    if (index >= span.start && index < span.end) return span;
  }
  return null;
}

/**
 * Находит вхождения запроса в склеенном тексте и отображает их на узлы.
 * Совпадение, перешагнувшее разделитель блоков (сегменты не соседние),
 * отбрасывается: оно лежит вне сплошного текста одного блока.
 */
export function mapMatches(
  map: SearchTextMap,
  query: string,
  caseSensitive = false,
): MappedMatch[] {
  const out: MappedMatch[] = [];
  for (const match of findMatches(map.text, query, caseSensitive)) {
    const startSpan = spanAt(map.spans, match.from);
    const endSpan = spanAt(map.spans, match.to - 1);
    if (startSpan === null || endSpan === null) continue;
    // Сегменты сплошные (без вставленного разделителя) — совпадение внутри
    // одного блока; иначе оно захватило `\n` и не является вхождением текста.
    const contiguous = endSpan === startSpan || endSpan.start === startSpan.end;
    if (!contiguous) continue;
    out.push({
      from: match.from,
      to: match.to,
      start: { id: startSpan.id, offset: match.from - startSpan.start },
      end: { id: endSpan.id, offset: match.to - endSpan.start },
    });
  }
  return out;
}
