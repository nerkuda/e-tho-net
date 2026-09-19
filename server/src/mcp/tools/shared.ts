/**
 * Общие хелперы MCP-инструментов (вынесено из `tools.ts`,
 * ADR 8c93f03a, веха 7 версии 0.8.2).
 *
 * Веха 8 (задача c9d5f21e): общие z-схемы (`NetworkId`, `ThoughtId`,
 * `View`, `LinkFilter` и т.п.) переехали в единый модуль контрактов
 * `../../contracts.js` — отсюда они ре-экспортируются для совместимости
 * импортов. Здесь остаются только резолверы, специфичные для MCP-фасада.
 */

import type { NetworkDb } from '../../db/network-db.js';
import { EtnError } from '@etn/shared';
import { z } from 'zod';
import { getComment, getPermanentFull } from '../../domain/comment-service.js';
import { resolveThoughtTypeIdByName } from '../../domain/thought-type-service.js';
import { resolveLinkTypeIdByName } from '../../domain/link-type-service.js';
import { scanMentions } from '../../domain/mentions-scan-service.js';
import { ThoughtsMentionsScan } from '../../contracts.js';

/** Форма аргументов `etn.thoughts.mentions_scan` — единый контракт входа. */
type MentionsScanArgs = z.infer<typeof ThoughtsMentionsScan.schema>;

// Ре-экспорт единых zod-кусков контрактов (веха 8).
export {
  ExpectedVersion,
  LayerId,
  LinkDirection,
  LinkFilter,
  LinkId,
  NetworkId,
  PROPERTY_ID_PROPERTY_CONFLICT,
  ThoughtId,
  TYPE_ID_TYPE_CONFLICT,
  View,
} from '../../contracts.js';

/**
 * Resolve a thought's effective `type_id`: `type_id` as given, or the id
 * resolved from `type` (by name, task O4). Schema `.refine()`s guarantee the
 * two are never both present.
 */
export function effectiveThoughtTypeId(
  ndb: NetworkDb,
  typeId: string | null | undefined,
  typeName: string | undefined,
): string | null | undefined {
  return typeName === undefined ? typeId : resolveThoughtTypeIdByName(ndb, typeName);
}

/**
 * Resolve a link's effective `type_id`: `type_id` as given, or the id
 * resolved from `type` (by `name_forward`/`name_reverse`, task O4). Schema
 * `.refine()`s guarantee the two are never both present.
 */
export function effectiveLinkTypeId(
  ndb: NetworkDb,
  typeId: string | null | undefined,
  typeName: string | undefined,
): string | null | undefined {
  return typeName === undefined ? typeId : resolveLinkTypeIdByName(ndb, typeName);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Helper для `etn.thoughts.mentions_scan` — резолвит текст из `source`
 * (если задан), затем делегирует в {@link scanMentions}. Объединяет две
 * ветви регистрации (read-only и write) в один общий путь, чтобы не
 * дублировать логику разворачивания `source`.
 */
export function executeMentionsScan(
  ndb: NetworkDb,
  args: MentionsScanArgs,
  actorUserId: string,
): { matches: { thought_id: string; title: string; confidence: number; matched_on: 'title' | 'synonym' | 'wildcard' }[]; links_created: number } {
  let text = args.text ?? '';
  let sourceThoughtId = args.source_thought_id;
  if (args.source !== undefined) {
    if (args.source.comment_id !== undefined) {
      const c = getComment(ndb, args.source.comment_id);
      if (c === null) {
        throw new EtnError('NOT_FOUND', `Comment ${args.source.comment_id} not found.`);
      }
      text = c.body_md;
      if (c.owner_type === 'thought') sourceThoughtId = c.owner_id;
    } else if (args.source.thought_id !== undefined) {
      const perm = getPermanentFull(ndb, 'thought', args.source.thought_id);
      text = perm?.body_md ?? '';
      sourceThoughtId = args.source.thought_id;
    }
  }
  if (text === '') {
    return { matches: [], links_created: 0 };
  }
  return scanMentions(ndb, {
    network_id: args.network_id,
    text,
    ...(args.case_sensitive !== undefined ? { case_sensitive: args.case_sensitive } : {}),
    ...(args.use_synonyms !== undefined ? { use_synonyms: args.use_synonyms } : {}),
    ...(args.use_wildcards !== undefined ? { use_wildcards: args.use_wildcards } : {}),
    ...(args.min_confidence !== undefined ? { min_confidence: args.min_confidence } : {}),
    ...(sourceThoughtId !== undefined ? { source_thought_id: sourceThoughtId } : {}),
    ...(args.create_links !== undefined ? { create_links: args.create_links } : {}),
    ...(args.link_type !== undefined ? { link_type: args.link_type } : {}),
    actor_user_id: actorUserId,
  });
}
