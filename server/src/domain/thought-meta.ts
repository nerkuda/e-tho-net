/**
 * Enriched thought read (task N2, docs/05-mcp-server.md §3): «сигналы
 * полноты» для MCP-агентов — сколько у мысли входящих/исходящих активных
 * связей, вложений и хронологических записей, плюс превью единственного
 * постоянного комментария.
 *
 * Цель: агент может решить, какие из отдельных ресурсов/инструментов
 * (`neighbors`, `attachments`, `comments`) ему действительно нужны, не
 * запрашивая их «вслепую». REST-чтение мысли (GET /thoughts/{id}) не
 * меняется — meta добавляется только в MCP-фасад.
 *
 * Все счётчики — COUNT по существующим индексам; permanent — один SELECT по
 * частичному уникальному индексу `idx_comments_permanent_one`. Тело
 * постоянного комментария возвращается порцией не длиннее
 * {@link PERMANENT_COMMENT_PREVIEW_CHARS} символов с метаданными
 * `chars_returned`/`chars_total`/`truncated` — большие тексты не раздувают
 * ответ, а агент видит, что полный текст доступен отдельным запросом.
 */

import { PERMANENT_COMMENT_PREVIEW_CHARS, type ThoughtMeta } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';

/**
 * Collect the enriched-read block for a thought. Read-only; throws nothing
 * (the caller has already resolved the thought).
 */
export function getThoughtMeta(ndb: NetworkDb, thoughtId: string): ThoughtMeta {
  const count = (sql: string, param: unknown): number =>
    (ndb.prepare(`SELECT COUNT(*) AS c FROM ${sql}`).get(param) as { c: number }).c;

  const parents_count = count('links WHERE target_id = ? AND active = 1', thoughtId);
  const children_count = count('links WHERE source_id = ? AND active = 1', thoughtId);
  const attachments_count = count(
    "attachments WHERE owner_type = 'thought' AND owner_id = ?",
    thoughtId,
  );
  const chrono_count = count(
    "comments WHERE owner_type = 'thought' AND owner_id = ? AND kind = 'chronological'",
    thoughtId,
  );

  const permanentRow = ndb
    .prepare(
      `SELECT body_md, valid_from, created_at, updated_at FROM comments
       WHERE owner_type = 'thought' AND owner_id = ? AND kind = 'permanent'
       LIMIT 1`,
    )
    .get(thoughtId) as
    | { body_md: string; valid_from: string; created_at: string; updated_at: string }
    | undefined;

  const permanent =
    permanentRow === undefined
      ? null
      : (() => {
          const total = permanentRow.body_md.length;
          const returned = Math.min(total, PERMANENT_COMMENT_PREVIEW_CHARS);
          return {
            body_md: permanentRow.body_md.slice(0, returned),
            chars_returned: returned,
            chars_total: total,
            truncated: total > returned,
            valid_from: permanentRow.valid_from,
            created_at: permanentRow.created_at,
            updated_at: permanentRow.updated_at,
          };
        })();

  return {
    parents_count,
    children_count,
    attachments_count,
    chrono_count,
    permanent,
  };
}
