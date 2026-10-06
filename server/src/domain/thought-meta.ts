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
import { createBodyExpander } from './transclusion-service.js';
import type { NetworkDb } from '../db/network-db.js';
import { getLinkType } from './link-type-service.js';
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
  deletion_blocks: number;
} {
  const count = (sql: string, ...params: unknown[]): number =>
    (ndb.prepare(`SELECT COUNT(*) AS c FROM ${sql}`).get(...params) as { c: number }).c;

  // Только ЖИВЫЕ рёбра — `marked_for_deletion = 0` (ошибка 1a7e8fde): счётчики
  // должны быть согласованы с `link_stats` (355319d4), где корзинные рёбра
  // уже не учитываются.
  const parents_count = count(
    'links_v WHERE target_id = ? AND active = 1 AND marked_for_deletion = 0',
    thoughtId,
  );
  const children_count = count(
    'links_v WHERE source_id = ? AND active = 1 AND marked_for_deletion = 0',
    thoughtId,
  );
  const attachments_count = count(
    "attachments_v WHERE owner_type = 'thought' AND owner_id = ?",
    thoughtId,
  );
  const chrono_count = count(
    "comments_v WHERE owner_type = 'thought' AND owner_id = ? AND kind = 'chronological'",
    thoughtId,
  );
  // Блокировки удаления — два плеча (миграция 040). Поле blocking-only и
  // называется по смыслу — `deletion_blocks` (задача cfc55b01; прежнее имя
  // `usage_count` вводило в заблуждение, потому что «Использование» после
  // c0a2a2e6 показывает ВСЕ рёбра свойств-связей):
  //   * новое: рёбра блокирующих свойств-связей (0.8.1, dbf1e4aa). Направление
  //     свойства задаёт блокируемый конец: `out` — цель ребра, `in` — источник.
  //     Направление живёт в ПРИВЯЗКЕ (`type_properties.side`, миграция 042, ошибка
  //     083dcde5), поэтому свойство может давать оба направления — по записи на
  //     пару (property_id, direction), у свойства без привязок fallback на
  //     `config.direction`;
  //   * legacy: в живой БД thought_ref-свойств быть не должно, но value-handling
  //     (тесты, унаследованные архивы) считает и одиночные значения, и
  //     вхождения id в JSON-массив `value_thought_ref` — иначе счётчик прыгает
  //     после миграции и удаление цели не блокируется.
  // (Зеркало countThoughtRefUsages в property-service; прямой импорт невозможен
  // из-за цикла thought-service → thought-meta. Направление по стороне привязки
  // обязано совпадать с этой функцией — согласованность держит тест
  // thought-meta.test «deletion_blocks согласован с countThoughtRefUsages».)
  const legacyUsageCount = count(
    `property_values_v
     WHERE owner_type = 'thought'
       AND value_thought_ref IS NOT NULL
       AND (value_thought_ref = ? OR value_thought_ref LIKE ? ESCAPE '\\')`,
    thoughtId,
    `%"${thoughtId.replace(/[\\%_]/g, (ch) => `\\${ch}`)}"%`,
  );
  const linkUsageCount = count(
    `links_v l JOIN (
       SELECT DISTINCT property_id, link_type_id, direction FROM (
         SELECT p.id AS property_id,
                json_extract(p.config, '$.link_type_id') AS link_type_id,
                CASE WHEN tp.side = 'source' THEN 'out'
                     WHEN tp.side = 'target' THEN 'in'
                     ELSE COALESCE(json_extract(p.config, '$.direction'), 'out') END AS direction
           FROM properties_v p
           LEFT JOIN (SELECT DISTINCT property_id, side FROM type_properties_v) tp
             ON tp.property_id = p.id
          WHERE p.value_type = 'link' AND p.config IS NOT NULL
            AND json_extract(p.config, '$.blocks_target_deletion') = 1
       )
     ) b
        ON ((b.link_type_id IS NULL AND l.type_id IS NULL) OR l.type_id = b.link_type_id)
     WHERE l.active = 1 AND l.marked_for_deletion = 0
       AND ((b.direction = 'out' AND l.target_id = ?)
         OR (b.direction = 'in' AND l.source_id = ?))`,
    thoughtId,
    thoughtId,
  );
  return {
    parents_count,
    children_count,
    attachments_count,
    chrono_count,
    deletion_blocks: legacyUsageCount + linkUsageCount,
  };
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
  // MCP-фасад (этот сервис используется только MCP-инструментами и ресурсом
  // `etn.thought`) отдаёт текст комментария с развёрнутыми трансклюзиями
  // (ТП2, задача bcfc7eb7). Развёртка — над полным телом до обрезки превью.
  const expand = createBodyExpander(ndb);
  const permanent =
    opts.fullPermanent === true
      ? getPermanentFull(ndb, 'thought', thoughtId, expand)
      : getPermanentPreview(ndb, 'thought', thoughtId, undefined, expand);
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
 * Профиль влияния мысли (0.7.2, 0.8.3) — задача 327be956, требование описано
 * в спеке операции `etn.thoughts.get` (85f18572): активные связи мысли,
 * сгруппированные по `(type_id, direction)`. Считается одним SQL (`UNION ALL`
 * двух `GROUP BY` по `links_v`) — без зависимости от `getNeighbors`, который
 * читает соединение с `thoughts_v` и тащит за собой сортировки/ручные позиции.
 * Нулевые группы в выдачу не попадают.
 *
 * 0.8.3 (требование «Карточка отдаёт связи счётчиками»): каждая запись несёт
 * оба имени типа связи рядом с `link_type_id` (`name_forward`/`name_reverse`).
 * Отдельного справочника `link_types` внутри блока больше нет — он дублировал
 * те же имена и раздувал карточку; описания типов живут в `etn.types.list`.
 *
 * `type_id = null` означает нетипизированное ребро (отдельная группа) — у
 * такой записи оба имени `null`: расшифровывать нечего.
 *
 * Считаются только ЖИВЫЕ рёбра: `active = 1 AND marked_for_deletion = 0`
 * (ошибка 355319d4 — «счётчики активных связей» в описании свойства не
 * должны включать рёбра корзины).
 */
export function getLinkStats(ndb: NetworkDb, thoughtId: string): LinkStats {
  const rows = ndb
    .prepare(
      // `marked_for_deletion = 0` (ошибка 355319d4): счётчики активных связей
      // не считают рёбра, помеченные на удаление, — иначе профиль влияния
      // противоречил бы таблице свойств, где такое ребро уже не значится.
      `SELECT type_id AS link_type_id, 'in' AS direction, COUNT(*) AS count
         FROM links_v WHERE target_id = ? AND active = 1 AND marked_for_deletion = 0
         GROUP BY type_id
       UNION ALL
       SELECT type_id AS link_type_id, 'out' AS direction, COUNT(*) AS count
         FROM links_v WHERE source_id = ? AND active = 1 AND marked_for_deletion = 0
         GROUP BY type_id`,
    )
    .all(thoughtId, thoughtId) as Array<{
    link_type_id: string | null;
    direction: 'in' | 'out';
    count: number;
  }>;
  // Имена типов — одним проходом по уникальным id (getLinkType сам вернёт
  // `null` для удалённого типа, тогда имена остаются `null`).
  const stats: LinkStatEntry[] = rows.map((row) => {
    const type = row.link_type_id === null ? null : getLinkType(ndb, row.link_type_id);
    return {
      link_type_id: row.link_type_id,
      direction: row.direction,
      count: row.count,
      name_forward: type?.name_forward ?? null,
      name_reverse: type?.name_reverse ?? null,
    };
  });
  return { stats };
}
