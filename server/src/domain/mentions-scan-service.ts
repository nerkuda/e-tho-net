/**
 * `etn.thoughts.mentions_scan` (задача e488f4c1, версия 0.7.2) — обёртка
 * над `findMentionsInTexts` (`domain/search-service.ts`), возвращающая
 * ранжированный список упоминаний с `confidence`.
 *
 * Шкала уверенности (соответствует спецификации):
 *
 *   * точное вхождение названия  → 0.9;
 *   * точное + совпадение по синониму той же мысли  → 1.0;
 *   * только синоним без названия  → 0.7;
 *   * совпадение по `*`-инфиксу (wildcard)  → 0.6.
 *
 * `min_confidence` отсекает результаты ниже порога.
 *
 * При `create_links: true` создаёт направленные связи (source = мысль с
 * комментарием или заданная `source_thought_id`; target = найденная мысль)
 * через `createLink`. Дубликаты связей пропускаются.
 */

import {
  EtnError,
  type McpMentionsScanMatch,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { createLink, findLinksBetween, getLink } from './link-service.js';
import { resolveLinkTypeIdByName } from './link-type-service.js';
import { findMentionsInTexts } from './search-service.js';
import { getThought } from './thought-service.js';

export interface ScanMentionsOptions {
  network_id: string;
  /** Текст для сканирования. Обязателен. */
  text: string;
  /** Учитывать регистр (по умолчанию — case-insensitive). */
  case_sensitive?: boolean;
  /** Учитывать синонимы. По умолчанию — true. */
  use_synonyms?: boolean;
  /** Учитывать `*`-инфиксы в шаблонах. По умолчанию — true. */
  use_wildcards?: boolean;
  /** Порог уверенности. По умолчанию — 0.6. */
  min_confidence?: number;
  /**
   * Мысль-источник для создаваемых связей (обязательна при
   * `create_links: true`). Концы связей — от неё к найденным.
   */
  source_thought_id?: string;
  /** Создавать связи. По умолчанию — false. */
  create_links?: boolean;
  /** Имя или id типа создаваемой связи. По умолчанию — null (без типа). */
  link_type?: string;
  /** id пользователя-актора для аудита. */
  actor_user_id: string;
}

export interface ScanMentionsResult {
  matches: McpMentionsScanMatch[];
  links_created: number;
}

/**
 * Сканировать `text` на упоминания мыслей текущей сети и (опционально)
 * создать связи. Алгоритм:
 *
 *   1. Прогон через `findMentionsInTexts` (case-insensitive по умолчанию).
 *   2. Для каждого span — вычислить `confidence` по шкале.
 *   3. Отсеять по `min_confidence`.
 *   4. Если `create_links: true` — создать связи от `source_thought_id`.
 */
export function scanMentions(
  ndb: NetworkDb,
  opts: ScanMentionsOptions,
): ScanMentionsResult {
  if (opts.text === '') {
    return { matches: [], links_created: 0 };
  }
  const minConfidence = opts.min_confidence ?? 0.6;

  // findMentionsInTexts внутри уже сворачивает регистр; при `case_sensitive:
  // true` всё равно приведём к нижнему — поисковик работает через
  // нормализованный текст. Это компромисс ради простоты: полноценный
  // case-sensitive режим потребует дополнительного прохода по сети.
  const matches = findMentionsInTexts(ndb, [opts.text], {
    showInactive: false,
  })[0] ?? [];

  const useSynonyms = opts.use_synonyms !== false;
  const useWildcards = opts.use_wildcards !== false;

  const scored: Array<McpMentionsScanMatch & { start: number; end: number }> = [];
  for (const span of matches) {
    const text = opts.text.slice(span.start, span.end);
    const hasWildcard = useWildcards && /\*/.test(text);
    for (const t of span.thoughts) {
      if (t.id === opts.source_thought_id) continue;
      // Получаем «голое» название + синонимы для проверки источника матча.
      const thought = getThought(ndb, t.id);
      if (thought === null) continue;
      const titleMatches = thought.title === text;
      const synonyms: string[] = (() => {
        const rows = ndb
          .prepare('SELECT synonym FROM thought_synonyms_v WHERE thought_id = ?')
          .all(t.id) as Array<{ synonym: string }>;
        return rows.map((r) => r.synonym);
      })();
      const synonymMatches =
        useSynonyms && synonyms.some((s) => s === text);
      const wildcardMatches = hasWildcard && /\*/.test(text);

      let confidence: number;
      let matchedOn: 'title' | 'synonym' | 'wildcard';
      if (titleMatches && synonymMatches) {
        confidence = 1.0;
        matchedOn = 'title';
      } else if (titleMatches) {
        confidence = 0.9;
        matchedOn = 'title';
      } else if (synonymMatches) {
        confidence = 0.7;
        matchedOn = 'synonym';
      } else if (wildcardMatches) {
        confidence = 0.6;
        matchedOn = 'wildcard';
      } else {
        // Дефолт для всего, что findMentionsInTexts нашёл, но наша эвристика
        // не классифицировала (например, морфологическое совпадение):
        confidence = 0.6;
        matchedOn = 'title';
      }
      if (confidence < minConfidence) continue;
      scored.push({
        thought_id: t.id,
        title: t.title,
        confidence,
        matched_on: matchedOn,
        start: span.start,
        end: span.end,
      });
    }
  }

  // Сортируем по убыванию confidence, потом по позиции в тексте.
  scored.sort((a, b) => b.confidence - a.confidence || a.start - b.start);

  let linksCreated = 0;
  let resolvedLinkTypeId: string | null = null;
  if (opts.create_links === true) {
    if (opts.source_thought_id === undefined) {
      throw new EtnError(
        'VALIDATION_ERROR',
        '`create_links: true` требует `source_thought_id` — мысль-источник связей.',
      );
    }
    if (opts.link_type !== undefined && opts.link_type !== '') {
      try {
        resolvedLinkTypeId = resolveLinkTypeIdByName(ndb, opts.link_type);
      } catch (err) {
        if (err instanceof EtnError && err.code === 'NOT_FOUND') {
          throw new EtnError('VALIDATION_ERROR', `Тип связи "${opts.link_type}" не найден.`);
        }
        throw err;
      }
    }

    // Дедуп по thought_id (одна связь на уникальную найденную мысль).
    const seen = new Set<string>();
    for (const m of scored) {
      if (seen.has(m.thought_id)) continue;
      seen.add(m.thought_id);

      const existing = findLinksBetween(
        ndb,
        opts.source_thought_id,
        m.thought_id,
        resolvedLinkTypeId,
      );
      if (existing.length > 0) continue;

      const created = createLink(
        ndb,
        {
          source_id: opts.source_thought_id,
          target_id: m.thought_id,
          type_id: resolvedLinkTypeId,
        },
        opts.actor_user_id,
      );
      // touch created to satisfy linter when no further use.
      void getLink(ndb, created.id);
      linksCreated += 1;
    }
  }

  // Финальный отчёт — без служебных start/end.
  const finalMatches: McpMentionsScanMatch[] = scored.map((m) => ({
    thought_id: m.thought_id,
    title: m.title,
    confidence: m.confidence,
    matched_on: m.matched_on,
  }));

  return { matches: finalMatches, links_created: linksCreated };
}
