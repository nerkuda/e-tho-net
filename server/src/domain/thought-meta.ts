/**
 * Enriched thought read (task N2, docs/05-mcp-server.md §3): «сигналы
 * полноты» для MCP-агентов — сколько у мысли входящих/исходящих активных
 * связей, вложений и хронологических записей, плюс (превью или полный
 * текст) единственного постоянного комментария.
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

import type { ThoughtMeta, ThoughtMetaFull } from '@etn/shared';

import { getPermanentFull, getPermanentPreview } from './comment-service.js';
import type { NetworkDb } from '../db/network-db.js';

/** Escape a thought id for a LIKE pattern (paired with `ESCAPE '\'`). */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

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
  // Multiple thought_ref values are stored as a JSON array of ids
  // (02-data-model.md §3.5) — the LIKE arm matches ids inside such arrays.
  const usage_count = count(
    "property_values_v WHERE owner_type = 'thought'" +
      " AND (value_thought_ref = ? OR value_thought_ref LIKE ? ESCAPE '\\')",
    thoughtId,
    `%"${escapeLike(thoughtId)}"%`,
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
  return { ...counters, permanent };
}
