/**
 * Кеш ленивых вычислений членства публикаций (кандидаты/использование) с окном
 * дебаунса — ADR 7adf7778, требование 6e8bc3f0 (задача e754527d, круг 2).
 *
 * Модуль не зависит от доменных сервисов публикаций: его импортируют и сборка
 * (фасады кандидатов/использования), и CRUD публикаций (инвалидация на мутации).
 * Иначе получился бы цикл `publication-service ↔ publication-assembly-service`.
 *
 * **Ключи.** Кандидаты — `(publication_id, слой, параметры)`, использование —
 * `(thought_id, слой, параметры)`. Слой входит в ключ, поэтому смена слоя не
 * отдаёт чужой результат без явного сброса.
 *
 * **Дебаунс/TTL.** Повторный вызов того же ключа внутри окна
 * {@link PUBLICATION_MEMBERSHIP_DEBOUNCE_MS} отдаёт прежний результат, не
 * исполняя рецепт заново; по истечении окна — пересчёт. Этим же окном
 * покрываются изменения мыслей вне контекста публикации (правка/создание мысли
 * — не мутация публикации и кеш явно не сбрасывает): ADR 7adf7778 запрещает
 * поддерживать индекс членства инкрементальными хуками записи мыслей.
 *
 * **Инвалидация.** Мутации публикации (создание/правка, порядок, «расставить»,
 * исключения, пересборка, корзина/восстановление/purge) сбрасывают кеш явно:
 * {@link invalidatePublicationMembershipCache}. Использование зависит от всех
 * публикаций слоя, поэтому при инвалидации оно очищается целиком; у кандидатов
 * снимаются только ключи этой публикации.
 */

import type { PublicationCandidatesResult, PublicationUsageResult } from '@etn/shared';

/** Окно дебаунса серверного кеша членства (мс). */
export const PUBLICATION_MEMBERSHIP_DEBOUNCE_MS = 400;

interface CacheEntry<T> {
  value: T;
  at: number;
}

/**
 * Кеш ленивых вычислений членства (кандидаты/использование) с окном дебаунса:
 * повторный вызов для того же ключа внутри окна отдаёт прежний результат, не
 * исполняя рецепты заново. Один экземпляр на процесс; в тестах сбрасывается
 * {@link resetPublicationMembershipCache}.
 */
export class PublicationMembershipCache {
  private readonly candidates = new Map<string, CacheEntry<PublicationCandidatesResult>>();
  private readonly usage = new Map<string, CacheEntry<PublicationUsageResult>>();

  constructor(
    private readonly windowMs: number = PUBLICATION_MEMBERSHIP_DEBOUNCE_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Кандидаты с кешем (ключ — публикация + слой + параметры). */
  getCandidates(
    key: string,
    compute: () => PublicationCandidatesResult,
  ): PublicationCandidatesResult {
    return this.through(this.candidates, key, compute);
  }

  /** Использование с кешем (ключ — мысль + слой + параметры). */
  getUsage(key: string, compute: () => PublicationUsageResult): PublicationUsageResult {
    return this.through(this.usage, key, compute);
  }

  private through<T>(store: Map<string, CacheEntry<T>>, key: string, compute: () => T): T {
    const entry = store.get(key);
    const now = this.now();
    if (entry !== undefined && now - entry.at < this.windowMs) return entry.value;
    const value = compute();
    store.set(key, { value, at: now });
    return value;
  }

  /**
   * Сбросить кеш публикации после её мутации: кандидаты — только её ключи,
   * использование (зависит от всех публикаций слоя) — целиком.
   */
  invalidatePublication(publicationId: string): void {
    const prefix = `candidates:${publicationId}:`;
    for (const key of this.candidates.keys()) {
      if (key.startsWith(prefix)) this.candidates.delete(key);
    }
    this.usage.clear();
  }

  /** Полный сброс (тесты, смена слоя). */
  clear(): void {
    this.candidates.clear();
    this.usage.clear();
  }
}

/** Процессный кеш членства. */
export const publicationMembershipCache = new PublicationMembershipCache();

/** Сбросить кеш публикации (домен вызывает на каждую мутацию публикации). */
export function invalidatePublicationMembershipCache(publicationId: string): void {
  publicationMembershipCache.invalidatePublication(publicationId);
}

/** Полный сброс процессного кеша членства (тесты). */
export function resetPublicationMembershipCache(): void {
  publicationMembershipCache.clear();
}

/** Ключ кеша кандидатов. */
export function candidatesCacheKey(
  publicationId: string,
  layerId: string,
  includeExcluded: boolean,
  limit: number,
  offset: number,
): string {
  return `candidates:${publicationId}:${layerId}:${includeExcluded ? 1 : 0}:${limit}:${offset}`;
}

/** Ключ кеша использования. */
export function usageCacheKey(
  thoughtId: string,
  layerId: string,
  limit: number,
  offset: number,
  pubLimit: number,
): string {
  return `usage:${thoughtId}:${layerId}:${limit}:${offset}:${pubLimit}`;
}
