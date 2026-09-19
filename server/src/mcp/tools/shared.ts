/**
 * Общие схемы и хелперы MCP-инструментов (вынесено из `tools.ts`,
 * ADR 8c93f03a, веха 7 версии 0.8.2). Модули каталога `tools/`
 * импортируют отсюда общие z-схемы и резолверы.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import { z } from 'zod';
import type { NetworkDb } from '../../db/network-db.js';
import { EtnError, ICON_KINDS, MCP_VIEW_MODES } from '@etn/shared';
import type { McpMentionsScanParams } from '@etn/shared';
import { getComment, getPermanentFull } from '../../domain/comment-service.js';
import { subgraph } from '../../domain/graph-traversal.js';
import { resolveThoughtTypeIdByName } from '../../domain/thought-type-service.js';
import { resolveLinkTypeIdByName } from '../../domain/link-type-service.js';
import { scanMentions } from '../../domain/mentions-scan-service.js';

export const NetworkId = z.string().min(1);
export const ThoughtId = z.string().min(1);
export const LinkId = z.string().min(1);
export const LayerId = z.string().min(1);
export const ExpectedVersion = z.number().int().min(1).optional();

/**
 * Response projection accepted by the read tools that support it (task O12,
 * docs/05-mcp-server.md §4.1): `etn.thoughts.get`, `…neighbors`,
 * `…subgraph`, `…usage`. `compact` (default) drops purely visual and
 * service fields the agent never consumes; `full` keeps the legacy shape.
 */
export const View = z
  .enum(MCP_VIEW_MODES)
  .optional()
  .describe(
    "Response projection: 'compact' (default, drops visual/service fields) or 'full' (legacy shape).",
  );

/**
 * Фильтр обхода по типам связей (задача c965ad03, требование bed23c25):
 * объект `{ type_ids?: string[], include_structural?: boolean }`. Каждый id
 * типа раскрывается вместе с потомками по иерархии `link_types` (L21);
 * `include_structural: true` включает нетипизированные (структурные) связи.
 * Отсутствует — обход по всем рёбрам, как раньше. Общий для
 * `etn.thoughts.query`/`neighbors`/`subgraph`/`path`.
 */
export const LinkFilter = z
  .object({
    type_ids: z.array(z.string().min(1)).optional(),
    include_structural: z.boolean().optional(),
  })
  .optional();

/** Error text shared by every `type_id`/`type` pair (task O4). */
export const TYPE_ID_TYPE_CONFLICT = 'provide at most one of type_id or type';

/** Error text shared by every `property_id`/`property` pair (задача d5ab1630). */
export const PROPERTY_ID_PROPERTY_CONFLICT = 'provide at most one of property_id or property';

/**
 * `direction` of an MCP inline link (`etn.thoughts.create` `link`,
 * `etn.thoughts.upsert_bundle` `links[]`): the value names the role of
 * `target_thought_id` relative to the NEW thought. `parent` — attach the new
 * thought UNDER the target (target becomes its parent); `child` — the NEW
 * thought becomes the parent of the target. Unified with the domain/REST
 * `create_link` direction (docs/03-server-api.md §6.3) — both layers share
 * the same semantics, no translation at the MCP boundary.
 */
export const LinkDirection = z
  .enum(['parent', 'child'])
  .describe(
    'Role of target_thought_id for the NEW thought: "parent" — attach the new thought ' +
      'UNDER target_thought_id (target becomes its parent); "child" — the NEW thought ' +
      'becomes the parent of target_thought_id.',
  );

/** Optional link attached to a freshly created thought (§4.2). `type` (task
 *  O4) resolves a link type by `name_forward`/`name_reverse`, mutually
 *  exclusive with `type_id`. */
export const CreateLink = z
  .object({
    direction: LinkDirection,
    target_thought_id: ThoughtId,
    type_id: z.string().min(1).nullable().optional(),
    type: z.string().min(1).optional(),
  })
  .refine((v) => v.type_id === undefined || v.type === undefined, { message: TYPE_ID_TYPE_CONFLICT })
  .optional();

/** Field subset accepted by `etn.thoughts.update` (mirrors `ThoughtUpdateInput`). */
export const ThoughtChanges = z
  .object({
    title: z.string().min(1).optional(),
    synonyms: z.array(z.string().min(1)).optional(),
    type_id: z.string().min(1).nullable().optional(),
    icon: z.string().nullable().optional(),
    icon_kind: z.enum(ICON_KINDS).optional(),
    active: z.boolean().optional(),
    fg_color: z.string().nullable().optional(),
    bg_color: z.string().nullable().optional(),
    font_bold: z.boolean().optional(),
    font_italic: z.boolean().optional(),
    font_underline: z.boolean().optional(),
    font_strike: z.boolean().optional(),
  })
  .refine((c) => Object.keys(c).length > 0, { message: 'changes must not be empty' });

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
  args: McpMentionsScanParams,
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
