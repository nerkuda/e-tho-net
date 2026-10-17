/**
 * Батчер `thoughts.resolve` для затронутых realtime-волной id (задача
 * `96d7f05d`, ошибка `49e05ea0`).
 *
 * **Зачем.** Потребители ref-метаданных (облачка холста, чипы условий отбора,
 * корни поддерева) перечитывают мысль по id на каждое событие волны. Один батч
 * агента из ~13 событий давал десятки POST `thoughts/resolve` (на проде —
 * resolve до 295 мс), которые занимали очередь HTTP и reader-пул.
 *
 * **Что делает.** За окно собирает затронутые id ОТ ВСЕХ потребителей и делает
 * один (или несколько, по серверному лимиту) `thoughts.resolve`. Адресация
 * ключей запросов не меняется: батчер работает ниже уровня экранов.
 *
 * **Два режима.**
 *  - `windowed: true` — realtime-волна: сбор идёт окно
 *    {@link REALTIME_REFETCH_WINDOW_MS} (trailing), как у перечитываний
 *    реестра. Вызывается из инвалидаций, порождённых событиями.
 *  - `windowed: false` (по умолчанию) — действие пользователя/открытие панели:
 *    запросы схлопываются в микротаске и уходят сразу, без задержки.
 *
 * Сбой запроса отклоняет промисы всех участников окна — потребители и раньше
 * трактовали resolve как best-effort (`catch`).
 */

import { THOUGHT_RESOLVE_MAX_IDS, type ThoughtRef } from '@etn/shared';

import { etn } from './etn.js';
import { REALTIME_REFETCH_WINDOW_MS } from './live/query-registry.js';

/** Один потребитель, ожидающий свои id в общем окне. */
interface RefCall {
  ids: readonly string[];
  resolve: (refs: ThoughtRef[]) => void;
  reject: (error: unknown) => void;
}

/** Накопитель одного окна по сети. */
interface RefBucket {
  ids: Set<string>;
  calls: RefCall[];
  /** Микротаска уже запланирована (немедленный режим). */
  microtaskScheduled: boolean;
  /** Таймер окна (realtime-режим). */
  timer: ReturnType<typeof setTimeout> | null;
}

const buckets = new Map<string, RefBucket>();

/**
 * Разрешить имена/метаданные мыслей батчем. Возвращает найденные карточки в
 * порядке запрошенных id (отсутствующие/удалённые пропускаются).
 */
export function resolveThoughtRefs(
  networkId: string,
  ids: readonly string[],
  options: { windowed?: boolean } = {},
): Promise<ThoughtRef[]> {
  const unique = [...new Set(ids.filter((id) => id !== ''))];
  if (networkId === '' || unique.length === 0) return Promise.resolve([]);

  return new Promise<ThoughtRef[]>((resolve, reject) => {
    let bucket = buckets.get(networkId);
    if (bucket === undefined) {
      bucket = { ids: new Set(), calls: [], microtaskScheduled: false, timer: null };
      buckets.set(networkId, bucket);
    }
    for (const id of unique) bucket.ids.add(id);
    bucket.calls.push({ ids: unique, resolve, reject });

    if (options.windowed === true) {
      // Trailing debounce: каждое новое событие волны продлевает окно.
      if (bucket.timer !== null) clearTimeout(bucket.timer);
      bucket.timer = setTimeout(() => flush(networkId), REALTIME_REFETCH_WINDOW_MS);
      return;
    }
    if (bucket.microtaskScheduled) return;
    bucket.microtaskScheduled = true;
    queueMicrotask(() => flush(networkId));
  });
}

/** Отправить накопленное окно одной сети (не более лимита на запрос). */
function flush(networkId: string): void {
  const bucket = buckets.get(networkId);
  if (bucket === undefined) return;
  buckets.delete(networkId);
  if (bucket.timer !== null) clearTimeout(bucket.timer);

  const ids = [...bucket.ids];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += THOUGHT_RESOLVE_MAX_IDS) {
    chunks.push(ids.slice(i, i + THOUGHT_RESOLVE_MAX_IDS));
  }
  void Promise.all(chunks.map((chunk) => etn.thoughts.resolve(networkId, chunk)))
    .then((pages) => {
      const byId = new Map<string, ThoughtRef>();
      for (const page of pages) for (const ref of page) byId.set(ref.id, ref);
      for (const call of bucket.calls) {
        call.resolve(
          call.ids.map((id) => byId.get(id)).filter((ref): ref is ThoughtRef => ref !== undefined),
        );
      }
    })
    .catch((error: unknown) => {
      for (const call of bucket.calls) call.reject(error);
    });
}

/** Тестовый хук — сбросить накопленные окна между тестами. */
export function __resetThoughtRefBatch(): void {
  for (const bucket of buckets.values()) {
    if (bucket.timer !== null) clearTimeout(bucket.timer);
  }
  buckets.clear();
}
