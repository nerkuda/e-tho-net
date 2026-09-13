/**
 * Enriched thought read (task N2, docs/05-mcp-server.md §3): «сигналы
 * полноты» для MCP-агентов — сколько у мысли входящих/исходящих активных
 * связей, вложений и хронологических записей, плюс (превью или полный
 * текст) единственного постоянного комментария. С 0.7.2 сюда же входит
 * `link_stats` — профиль влияния мысли (счётчики связей по типам в обоих
 * направлениях + справочник `link_types`).
 *
 * Цель: агент может решить, какие из отдельных ресурсов/инструментов
 * (`neighbors`, `attachments`, `comments`) ему действительно нужны, не
 * запрашивая их «вслепую». REST-чтение мысли (GET /thoughts/{id}) не
 * меняется — meta добавляется только в MCP-фасад.
 *
 * Все счётчики — COUNT по существующим индексам. Постоянный комментарий
 * возвращается в одной из двух форм:
 *   * по умолчанию — превью {@link getPermanentPreview} (comment-service):
 *     тело обрезано до {@link COMMENT_PREVIEW_CHARS} символов с
 *     метаданными `chars_returned`/`chars_total`/`truncated` — большие
 *     тексты не раздувают выборки сущностей (subgraph, structure, списки);
 *   * при `opts.fullPermanent === true` — полный текст
 *     {@link getPermanentFull}, форма {@link ThoughtMetaFull}
 *     (задача 3ea09a54 «Условная обрезка текстов в ответах MCP»).
 *     Используется только MCP-фасадом `etn.thoughts.get` — это
 *     единственная точка, где агент явно читает одну мысль, и полный
 *     текст её постоянного комментария возвращаётся без обрезки.
 */

import type { LinkStatEntry, LinkStats, ThoughtMeta, ThoughtMetaFull } from '@etn/shared';

import { getPermanentFull, getPermanentPreview } from './comment-service.js';
import type { NetworkDb } from '../db/network-db.js';
import { linkTypeCatalog } from '../mcp/catalogs.js';
import { getEffectiveViewsForThought } from './thought-type-views-service.js';

/** Options for {@link getThoughtMeta}. */
export interface ThoughtMetaOptions {
  /** Return the permanent comment in full (no `chars_*`/`truncated`).
   *  Used only by `etn.thoughts.get` (задача 3ea09a54); all other callers
   *  keep the preview form. */
  fullPermanent?: boolean;
}

/** Build the shared counters block of the thought meta. */
function buildCounters(ndb: NetworkDb, thoughtId: string): {
  parents_count: number;
  children_count: number;
  attachments_count: number;
  chrono_count: number;
  usage_count: number;
} {
  const count = (sql: string, ...params: unknown[]): number =>
    (ndb.prepare(`SELECT COUNT(*) AS c FROM ${sql}`).get(...params) as { c: number }).c;

  const parents_count = count('links_v WHERE target_id = ? AND active = 1', thoughtId);
  const children_count = count('links_v WHERE source_id = ? AND active = 1', thoughtId);
  const attachments_count = count(
    "attachments_v WHERE owner_type = 'thought' AND owner_id = ?",
    thoughtId,
  );
  const chrono_count = count(
    "comments_v WHERE owner_type = 'thought' AND owner_id = ? AND kind = 'chronological'",
    thoughtId,
  );
  // Использование — рёбра блокирующих свойств-связей (0.8.1, dbf1e4aa): мысль,
  // на которую ссылаются. Значения-ссылки больше не хранятся в
  // property_values (миграция 040 упразднила thought_ref). Направление
  // свойства задаёт блокируемый конец: `out` — цель ребра, `in` — источник.
  // (Зеркало countThoughtRefUsages в property-service; прямой импорт невозможен
  // из-за цикла thought-service → thought-meta.)
  const usage_count = count(
    `links_v l JOIN properties_v p
        ON p.value_type = 'link' AND p.config IS NOT NULL
       AND json_extract(p.config, '$.blocks_target_deletion') = 1
       AND l.type_id = json_extract(p.config, '$.link_type_id')
     WHERE l.active = 1 AND l.marked_for_deletion = 0
       AND ((COALESCE(json_extract(p.config, '$.direction'), 'out') = 'out' AND l.target_id = ?)
         OR (json_extract(p.config, '$.direction') = 'in' AND l.source_id = ?))`,
    thoughtId,
    thoughtId,
  );
  return { parents_count, children_count, attachments_count, chrono_count, usage_count };
}

/**
 * Collect the enriched-read block for a thought with the preview form of
 * `meta.permanent`. Read-only; throws nothing (the caller has already
 * resolved the thought).
 */
export function getThoughtMeta(
  ndb: NetworkDb,
  thoughtId: string,
  opts?: { fullPermanent?: false },
): ThoughtMeta;
/**
 * Collect the enriched-read block for a thought with the full (untruncated)
 * form of `meta.permanent` (задача 3ea09a54). Same counters as the default
 * overload; only the `permanent` field changes shape — see
 * {@link ThoughtMetaFull}.
 */
export function getThoughtMeta(
  ndb: NetworkDb,
  thoughtId: string,
  opts: { fullPermanent: true },
): ThoughtMetaFull;
export function getThoughtMeta(
  ndb: NetworkDb,
  thoughtId: string,
  opts: ThoughtMetaOptions = {},
): ThoughtMeta | ThoughtMetaFull {
  const counters = buildCounters(ndb, thoughtId);
  const permanent =
    opts.fullPermanent === true
      ? getPermanentFull(ndb, 'thought', thoughtId)
      : getPermanentPreview(ndb, 'thought', thoughtId);
  const link_stats = getLinkStats(ndb, thoughtId);
  // `meta.views` (задача c1fa71d4, 0.7.3) — эффективный набор отборов.
  // Считается здесь же, чтобы MCP-фасады могли полагаться на
  // `getThoughtMeta` как единый источник сигналов полноты. REST-вызовы
  // `getThoughtMeta` не делают: meta добавляется только MCP-фасадом.
  const thoughtRow = ndb
    .prepare('SELECT id, type_id FROM thoughts_v WHERE id = ?')
    .get(thoughtId) as { id: string; type_id: string | null } | undefined;
  const views = thoughtRow === undefined
    ? []
    : getEffectiveViewsForThought(ndb, { type_id: thoughtRow.type_id }).map((v) => ({
        id: v.id,
        name: v.name,
        name_key: v.name_key,
        description: v.description,
        defined_on: v.defined_on,
        inherited: v.inherited,
        is_default: v.is_default,
      }));
  return { ...counters, permanent, link_stats, views };
}

/**
 * Профиль влияния мысли (0.7.2) — задача 327be956, требование описано в
 * спеке операции `etn.thoughts.get` (85f18572): активные связи мысли,
 * сгруппированные по `(type_id, direction)`, плюс парный справочник
 * `link_types` (только реально использованные типы). Считается одним SQL
 * (`UNION ALL` двух `GROUP BY` по `links_v`) — без зависимости от `getNeighbors`,
 * который читает соединение с `thoughts_v` и тащит за собой сортировки/ручные
 * позиции. Нулевые группы в выдачу не попадают; типы без пары
 * `(name_forward/reverse/description)` остаются, чтобы агент видел, что за
 * тип.
 *
 * `type_id = null` означает нетипизированное ребро (отдельная группа).
 */
export function getLinkStats(ndb: NetworkDb, thoughtId: string): LinkStats {
  const rows = ndb
    .prepare(
      `SELECT type_id AS link_type_id, 'in' AS direction, COUNT(*) AS count
         FROM links_v WHERE target_id = ? AND active = 1
         GROUP BY type_id
       UNION ALL
       SELECT type_id AS link_type_id, 'out' AS direction, COUNT(*) AS count
         FROM links_v WHERE source_id = ? AND active = 1
         GROUP BY type_id`,
    )
    .all(thoughtId, thoughtId) as Array<{
    link_type_id: string | null;
    direction: 'in' | 'out';
    count: number;
  }>;
  const stats: LinkStatEntry[] = rows.map((row) => ({
    link_type_id: row.link_type_id,
    direction: row.direction,
    count: row.count,
  }));
  // Catalogue of every non-null link type referenced — `linkTypeCatalog`
  // already skips unknown ids, so a stale registry row never breaks the
  // response. `null` link_type_id (untyped group) is not present here:
  // there's nothing to look up.
  const referencedTypeIds = rows
    .map((row) => row.link_type_id)
    .filter((id): id is string => id !== null);
  const full = linkTypeCatalog(ndb, referencedTypeIds);
  // Trim to the four fields `LinkStats.link_types` documents (the shared
  // shape is independent of `LinkTypeRef` to avoid a type-level cycle with
  // `./mcp.ts`).
  const link_types: LinkStats['link_types'] = {};
  for (const [id, entry] of Object.entries(full)) {
    link_types[id] = {
      id: entry.id,
      name_forward: entry.name_forward,
      name_reverse: entry.name_reverse,
      description: entry.description,
    };
  }
  return { stats, link_types };
}
