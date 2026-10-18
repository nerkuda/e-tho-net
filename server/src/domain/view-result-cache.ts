/**
 * Кэш результата исполнения отбора (`views/run`) — задача 3f2b0958,
 * ошибка 49e05ea0.
 *
 * На проде повторные запуски одного и того же отбора в течение минуты шли по
 * 164–194 мс каждый: клиентский шторм перечитываний гоняет одни и те же
 * запросы, и reader-пул заново исполняет SQL. Кэш снимает повторную нагрузку
 * независимо от темпа клиента.
 *
 * **Что кэшируется.** Только УСПЕШНЫЙ итог доменной точки
 * `executeViewDefinitionForThought` — страница + `total`, `directions`,
 * `unresolved`, `sort`/`order`, `has_more`/`next_cursor`, `warnings`.
 * Исключения (ошибки валидации, `NOT_FOUND`, красная диагностика) в кэш не
 * попадают: запись выполняется только после нормального возврата.
 *
 * **Ключ.** Нормализованный: сеть, слой, идентичность соединения, пользователь,
 * фокусная мысль, тип мысли, канонизированное определение отбора и все
 * параметры запуска, влияющие на результат (`sort`, `order`, `limit`, `offset`,
 * `profile`, `maxLimit`, `exclusiveSort`). Сеть/слой/пользователь/фокус в
 * ключе — требование изоляции: результаты разных контекстов не смешиваются.
 *
 * **Время.** Кэшируется только отбор, для которого контекст токенов явно
 * объявлен «без времени» (`withTime: false` — профиль `thoughts`). `withTime:
 * true` (`$now`/`$hour*`, единицы `h`/`mi`) и `undefined` (историческая
 * совместимость движка разрешает время) не кэшируются вовсе — иначе пришлось
 * бы гадать, на сколько секунд «заморозить» `$now`. Календарные токены
 * (`$today`, `$weekStart`…) разрешаются в UTC-дату (см.
 * `thought-type-view-tokens.ts`), поэтому в ключ входит UTC-день и
 * `first_day_of_week` сети. Смена суток — естественная смена ключа.
 *
 * **Инвалидация — по счётчику изменений, не по TTL.** Поколение кэша
 * складывается из:
 *   1. process-wide счётчика сети, который двигает обёртка записи
 *      (`runWriteCore`) после коммита, реально изменившего данные, и фасад
 *      write-пула (`heavy-write.ts`) после ответа воркера;
 *   2. `PRAGMA data_version` соединения — ловит коммиты других соединений
 *      (write-пул, другой процесс на том же `data.db`).
 * Любая семантическая запись в сеть двигает поколение; записи, которые не
 * меняют данные (например, событие `thought-type-view.run`), — не двигают.
 * Счётчик сети глобальный (не послойный) осознанно: запись в основу видна всем
 * слоям, поэтому инвалидация целой сети — безопасная сторона. Результаты
 * разных слоёв при этом не смешиваются: слой входит в ключ.
 *
 * **Размер.** LRU по числу записей и по оценке памяти; при переполнении
 * вытесняется самая старая запись. Ограничения — константы
 * {@link DEFAULT_MAX_ENTRIES}/{@link DEFAULT_MAX_BYTES}, тесты могут их
 * уменьшить через {@link setViewResultCacheLimits}.
 *
 * **Чего кэш НЕ делает.** Не обходит проверки доступа и валидацию входа:
 * REST/MCP проверяют членство в сети до вызова домена, а домен до обращения к
 * кэшу резолвит мысль (`getThought`) и валидирует токены
 * (`validateDefinitionForTokens`). Промах идёт обычным путём — в reader-пул.
 */

import { createHash } from 'node:crypto';

import type { NetworkDb } from '../db/network-db.js';
import type { RunViewQueryOptions, RunViewResult } from './thought-type-views-service.js';

/** Разумный потолок числа записей: страница отбора — до 200 мыслей. */
export const DEFAULT_MAX_ENTRIES = 200;
/** Потолок оценённого размера кэша (UTF-8 JSON результатов). */
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/** Публичная статистика кэша — доказательство попаданий в тестах и замерах. */
export interface ViewResultCacheStats {
  /** Попадания: второй и последующие запуски того же ключа. */
  hits: number;
  /** Промахи, включая устаревшие записи. */
  misses: number;
  /** Промахи из-за смены поколения (запись в сеть между запусками). */
  stale: number;
  /** Сколько успешных результатов положено в кэш. */
  stores: number;
  /** Сколько записей вытеснено LRU. */
  evictions: number;
  /** Текущее число записей. */
  size: number;
  /** Текущая оценка памяти, байт. */
  bytes: number;
}

interface CacheEntry {
  /** Поколение данных на момент исполнения — см. {@link viewResultCacheGeneration}. */
  generation: string;
  result: RunViewResult;
  /** Оценка размера записи в памяти (UTF-8 JSON). */
  bytes: number;
}

/** LRU: порядок вставки Map — порядок от старых к новым. */
const entries = new Map<string, CacheEntry>();
const counters = {
  hits: 0,
  misses: 0,
  stale: 0,
  stores: 0,
  evictions: 0,
};
/** Process-wide счётчики изменений по сетям (см. модульный комментарий). */
const networkDataVersions = new Map<string, number>();

let maxEntries = DEFAULT_MAX_ENTRIES;
let maxBytes = DEFAULT_MAX_BYTES;
let totalBytes = 0;

/**
 * Отметить, что данные сети изменились. Вызывается после УСПЕШНОГО коммита
 * записи; все записи кэша этой сети, сделанные раньше, станут промахами.
 */
export function bumpNetworkDataVersion(networkId: string): void {
  networkDataVersions.set(networkId, (networkDataVersions.get(networkId) ?? 0) + 1);
}

/** Текущее поколение записей сети (без сигнала конкретного соединения). */
export function getNetworkDataVersion(networkId: string): number {
  return networkDataVersions.get(networkId) ?? 0;
}

/**
 * Поколение данных, к которому относится результат: счётчик сети + сдвиг
 * `PRAGMA data_version` соединения (коммиты других соединений/процессов).
 * Одинаковое поколение = данные не менялись = попадание допустимо.
 */
export function viewResultCacheGeneration(ndb: NetworkDb): string {
  return `${getNetworkDataVersion(ndb.networkId)}:${ndb.dataVersion()}`;
}

/** Входные данные для нормализованного ключа кэша. */
export interface ViewResultCacheKeyInput {
  networkId: string;
  layerId: string;
  instanceId: string;
  userId: string;
  /** Полный id фокусной мысли (после резолва короткого префикса). */
  thoughtId: string;
  thoughtTypeId: string | null;
  /** Определение отбора в исходной (до подстановки токенов) форме. */
  definition: Record<string, unknown>;
  options?: RunViewQueryOptions;
}

/**
 * Собрать ключ кэша или `null`, если результат кэшировать нельзя.
 *
 * `null` — контекст токенов не объявлен явно «без времени» (`withTime` не
 * `false`): `$now`/`$hour*` меняются непрерывно, и любой «замороженный» ответ
 * был бы ложью.
 */
export function buildViewResultCacheKey(input: ViewResultCacheKeyInput): string | null {
  const options = input.options;
  const tokenContext = options?.tokenContext;
  // Кэшируем только при ЯВНОМ «без времени» (профиль `thoughts`). `true` —
  // `$now`/`$hour*` меняются непрерывно; `undefined` — историческая
  // совместимость движка разрешает время, и замораживать такой ответ нельзя.
  if (tokenContext?.withTime !== false) return null;

  // Календарные токены разрешаются в UTC-дату (thought-type-view-tokens.ts),
  // поэтому граница «сутки» — тоже UTC.
  const nowMs = tokenContext?.nowMs ?? Date.now();
  const utcDay = new Date(nowMs).toISOString().slice(0, 10);

  const payload = {
    version: 1,
    network_id: input.networkId,
    layer_id: input.layerId,
    connection_id: input.instanceId,
    user_id: input.userId,
    thought_id: input.thoughtId,
    thought_type_id: input.thoughtTypeId,
    definition: canonicalize(input.definition),
    run: {
      sort: options?.sort ?? null,
      order: options?.order ?? null,
      // Эффективные значения: `undefined` и явный дефолт дают одинаковый
      // результат, значит и один ключ.
      limit: options?.limit ?? 100,
      offset: options?.offset ?? 0,
      profile: options?.profile ?? 'thoughts',
      max_limit: options?.maxLimit ?? null,
      exclusive_sort: options?.exclusiveSort === true,
    },
    time: {
      utc_day: utcDay,
      first_day_of_week: tokenContext?.firstDayOfWeek ?? null,
    },
  };

  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Взять результат из кэша. `null` — промах (нет записи или поколение данных
 * сменилось). Устаревшая запись удаляется сразу: она уже никогда не оживёт.
 */
export function lookupViewResult(key: string, generation: string): RunViewResult | null {
  const entry = entries.get(key);
  if (entry === undefined) {
    counters.misses += 1;
    return null;
  }
  if (entry.generation !== generation) {
    counters.stale += 1;
    counters.misses += 1;
    removeEntry(key, entry);
    return null;
  }
  // LRU: освежаем позицию.
  entries.delete(key);
  entries.set(key, entry);
  counters.hits += 1;
  return entry.result;
}

/** Положить успешный результат в кэш, вытеснив старые записи при переполнении. */
export function storeViewResult(key: string, generation: string, result: RunViewResult): void {
  const bytes = estimateBytes(result);
  const previous = entries.get(key);
  if (previous !== undefined) {
    totalBytes -= previous.bytes;
    entries.delete(key);
  }
  entries.set(key, { generation, result, bytes });
  totalBytes += bytes;
  counters.stores += 1;
  evictOverflow();
}

/** Текущая статистика кэша (копия — вызывающий не меняет внутреннее состояние). */
export function getViewResultCacheStats(): ViewResultCacheStats {
  return { ...counters, size: entries.size, bytes: totalBytes };
}

/**
 * Сбросить кэш и счётчики. Для тестов и для корректного старта нового
 * жизненного цикла процесса.
 */
export function resetViewResultCache(): void {
  entries.clear();
  networkDataVersions.clear();
  totalBytes = 0;
  counters.hits = 0;
  counters.misses = 0;
  counters.stale = 0;
  counters.stores = 0;
  counters.evictions = 0;
  maxEntries = DEFAULT_MAX_ENTRIES;
  maxBytes = DEFAULT_MAX_BYTES;
}

/**
 * Уменьшить/изменить лимиты кэша (тесты вытеснения и эксплуатационная
 * настройка). Переполнение вытесняется немедленно.
 */
export function setViewResultCacheLimits(limits: {
  maxEntries?: number;
  maxBytes?: number;
}): void {
  if (limits.maxEntries !== undefined) {
    maxEntries = Math.max(0, Math.floor(limits.maxEntries));
  }
  if (limits.maxBytes !== undefined) {
    maxBytes = Math.max(0, Math.floor(limits.maxBytes));
  }
  evictOverflow();
}

/** Удалить запись и скорректировать счётчик памяти. */
function removeEntry(key: string, entry: CacheEntry): void {
  entries.delete(key);
  totalBytes -= entry.bytes;
}

/** Вытеснять самые старые записи, пока не уложимся в оба лимита. */
function evictOverflow(): void {
  while (entries.size > maxEntries || totalBytes > maxBytes) {
    const oldestKey = entries.keys().next().value as string | undefined;
    if (oldestKey === undefined) return;
    const oldest = entries.get(oldestKey);
    if (oldest === undefined) return;
    removeEntry(oldestKey, oldest);
    counters.evictions += 1;
  }
}

/** Оценка памяти записи по UTF-8-длине сериализованного результата. */
function estimateBytes(result: RunViewResult): number {
  return Buffer.byteLength(JSON.stringify(result), 'utf8');
}

/**
 * Канонизация JSON-значения: ключи объектов сортируются рекурсивно, порядок
 * элементов массивов сохраняется (он значим для AST). Нужна, чтобы одинаковые
 * логически определения из REST и MCP давали один ключ независимо от порядка
 * полей в JSON.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}
