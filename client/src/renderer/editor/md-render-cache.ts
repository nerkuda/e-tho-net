/**
 * Кеш HTML-разбора markdown для live-preview (ошибка `83785f1e`).
 *
 * **Зачем.** `buildDecorations` (`editor/md-live.ts`) на каждую транзакцию
 * (`docChanged`/`selection`, доразбор дерева) заново обходит дерево и для
 * неактивных блоков-виджетов (fenced-код, картинка, таблица) вызывала
 * `renderMarkdown`. Markdown-it разбирал исходник блока на каждый символ,
 * набранный в ЛЮБОМ месте комментария, хотя исходник блока не менялся. Правка
 * `4df5e284` сняла пересоздание DOM и повторный `renderMermaidBlocks` при
 * сдвиге смещений, но сам разбор остался — это остаточный расход.
 *
 * **Ключ — исходник блока И опции рендера.** `@etn/markdown` отдаёт разный HTML
 * при разных опциях: `sourceMap` добавляет разметку узлов (`data-md-start/end`),
 * `transclusion` подставляет подписи маркеров, `maxLength` задаёт потолок
 * входа. Кеш «по одному исходнику» вернул бы чужой вариант (карта источников
 * рендерится в `markdown-field.ts`, live-preview — иные блоки). Правило ключа
 * общее: кеш обязан быть корректным для любой комбинации опций, а не только
 * для текущих вызовов.
 *
 * **Инвалидация — по содержимому.** Изменился исходник блока — другой ключ,
 * прежняя запись остаётся до вытеснения. Сеть, язык и слой в ключ не входят:
 * HTML блока-виджета (код, картинка, таблица) от них не зависит, а всё, что
 * зависит (подписи трансклюзий), приходит опциями — то есть уже в ключе.
 *
 * **Не течёт.** Размер ограничен и по числу записей, и по суммарной длине
 * исходников: редактор за долгую сессию правит много блоков, и неограниченный
 * кеш копил бы историю всех правок. Вытеснение — LRU (обращение обновляет
 * запись), исходник крупнее общего потолка не кешируется вовсе.
 */

import { renderMarkdown, type RenderOptions } from '@etn/markdown';

/** Потолок числа записей: живых блоков в поле — единицы, запас на историю правок. */
export const MD_RENDER_CACHE_MAX_ENTRIES = 64;

/** Потолок суммарной длины исходников в кеше (символов): ~0.5 МБ памяти. */
export const MD_RENDER_CACHE_MAX_CHARS = 262_144;

/** Одна запись: готовый HTML и «вес» исходника для учёта потолка. */
interface MdRenderCacheEntry {
  html: string;
  chars: number;
}

/**
 * Счётчики кеша. `parses` — реальные вызовы `renderMarkdown` (промахи),
 * `hits` — HTML взят из кеша; сумма — число обращений (одно обращение на блок
 * на каждую пересборку декораций).
 */
export interface MdRenderCacheStats {
  parses: number;
  hits: number;
  entries: number;
  chars: number;
}

/** Кеш: порядок вставки `Map` — очередь LRU (свежая запись в конце). */
const cache = new Map<string, MdRenderCacheEntry>();
let cacheChars = 0;
let parses = 0;
let hits = 0;

/**
 * Сериализация опций для ключа. Пустые опции (обычный вызов live-preview) дают
 * пустую строку — самый частый случай не платит за сериализацию.
 *
 * Порядок ключей объекта подписей берётся как есть (`JSON.stringify`), поэтому
 * два равных набора подписей, собранных в разном порядке, дадут разные ключи —
 * это лишний промах, а не неверный HTML.
 */
function optionsKey(options: RenderOptions): string {
  const labels = options.transclusion?.labels ?? null;
  const maxLength = options.maxLength ?? null;
  if (options.sourceMap !== true && maxLength === null && labels === null) return '';
  return JSON.stringify([options.sourceMap === true, maxLength, labels]);
}

/** Поиск в кеше с обновлением очереди LRU. */
function lookup(key: string): MdRenderCacheEntry | null {
  const entry = cache.get(key);
  if (entry === undefined) return null;
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

/** Вставка с вытеснением по потолкам; слишком крупный исходник не кешируется. */
function store(key: string, html: string, chars: number): void {
  if (chars > MD_RENDER_CACHE_MAX_CHARS) return;
  cache.set(key, { html, chars });
  cacheChars += chars;
  for (const [oldKey, oldEntry] of cache) {
    if (cache.size <= MD_RENDER_CACHE_MAX_ENTRIES && cacheChars <= MD_RENDER_CACHE_MAX_CHARS) {
      break;
    }
    // Только что вставленная запись — в конце очереди, до неё цикл не дойдёт,
    // пока потолки не поднимут: одна запись всегда остаётся в кеше.
    cache.delete(oldKey);
    cacheChars -= oldEntry.chars;
  }
}

/**
 * `renderMarkdown` с кешем по (исходник + опции рендера). Замена прямого
 * вызова для мест, которые перерисовывают ОДИН И ТОТ ЖЕ срез много раз
 * (live-preview блоков), — вывод побайтово равен `renderMarkdown`.
 *
 * @throws как `renderMarkdown` (не строка, превышен `maxLength`): ошибки не
 * кешируются.
 */
export function cachedRenderMarkdown(source: string, options: RenderOptions = {}): string {
  const key = `${optionsKey(options)}\u0000${source}`;
  const entry = lookup(key);
  if (entry !== null) {
    hits += 1;
    return entry.html;
  }
  parses += 1;
  const html = renderMarkdown(source, options);
  store(key, html, source.length);
  return html;
}

/**
 * Тестовый шов и счётчик GUI-стенда (тестовая сборка выкладывает его на
 * `window.__etnMdRenderCache`, см. `app.ts`): значения читаются для проверки
 * «разбор не повторяется», `reset` очищает кеш и счётчики.
 */
export const mdRenderCacheInternals = {
  stats(): MdRenderCacheStats {
    return { parses, hits, entries: cache.size, chars: cacheChars };
  },
  reset(): void {
    cache.clear();
    cacheChars = 0;
    parses = 0;
    hits = 0;
  },
};
