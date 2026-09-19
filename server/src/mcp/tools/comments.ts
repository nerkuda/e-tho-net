/**
 * comments.ts — MCP-инструменты области «registerCommentsGetTool, registerCommentsWriteTools».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import { z } from 'zod';
import { COMMENT_KINDS, COMMENT_OWNER_TYPES, COMMENT_TARGETS_MAX, MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import type { CommentTarget, McpMutationResult } from '@etn/shared';
import { getThoughtOrThrow } from '../../domain/thought-service.js';
import { CommentsDelete, CommentsEdit, CommentsGet, CommentsUpdate, CommentsUpsert } from '../../contracts.js';
import { createCommentWithTargets, deleteComment, editComment, getComment, listComments, updateComment } from '../../domain/comment-service.js';
import { recordCommentActivity } from '../../domain/activity-service.js';
import { subgraph } from '../../domain/graph-traversal.js';
import { auditAgentCall, emitAgentActivityEvent, emitAgentEvent, openMemberNetwork, requireWritable, requireWriteBudget, runTool, runWriteTool } from '../context.js';
import { NetworkId, ThoughtId, ExpectedVersion } from './shared.js';

export function registerCommentsGetTool(mcp: McpServer, rt: McpRuntime): void {
  const GetCommentSchema = z
    .object({
      network_id: NetworkId,
      comment_id: z.string().min(1).optional(),
      thought_id: ThoughtId.optional(),
    })
    .refine((a) => (a.comment_id === undefined) !== (a.thought_id === undefined), {
      message: 'provide exactly one of comment_id or thought_id',
    });
  mcp.registerTool(
    'etn.comments.get',
    {
      title: 'Комментарий (полный текст)',
      description:
        'Fetch one comment in full: by `comment_id` — any comment (permanent or chronological) with its ' +
        'complete `body_md`; by `thought_id` — the thought\'s permanent comment, or `{thought_id, permanent: ' +
        'null}` when absent. Use when a preview (`meta.permanent`, `subgraph` comments) reports `truncated: ' +
        'true`.',
      inputSchema: CommentsGet.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.comments.get'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        if (args.comment_id !== undefined) {
          const comment = getComment(ndb, args.comment_id);
          if (comment === null) {
            throw new Error(`ETN error [NOT_FOUND]: comment ${args.comment_id} not found`);
          }
          return comment;
        }
        // The refine guarantees exactly one of the two; TS needs an explicit check.
        if (args.thought_id === undefined) {
          throw new Error('ETN error [VALIDATION_ERROR]: thought_id required');
        }
        getThoughtOrThrow(ndb, args.thought_id);
        const permanent =
          listComments(ndb, 'thought', args.thought_id).find((c) => c.kind === 'permanent') ??
          null;
        return { thought_id: args.thought_id, permanent };
      }),
  );

}

export function registerCommentsWriteTools(mcp: McpServer, rt: McpRuntime): void {
  const CommentTargetSchema = z.object({
    owner_type: z.enum(COMMENT_OWNER_TYPES),
    owner_id: z.string().min(1),
  });
  const UpsertCommentSchema = z
    .object({
      network_id: NetworkId,
      owner_type: z.enum(COMMENT_OWNER_TYPES).optional(),
      owner_id: z.string().min(1).optional(),
      targets: z.array(CommentTargetSchema).min(1).max(COMMENT_TARGETS_MAX).optional(),
      kind: z.enum(COMMENT_KINDS),
      title: z.string().nullable().optional(),
      body_md: z.string().min(1),
      valid_from: z.string().min(1).optional(),
      valid_to: z.string().nullable().optional(),
    })
    .refine(
      (v) => (v.owner_type !== undefined && v.owner_id !== undefined) !== (v.targets !== undefined),
      { message: 'provide exactly one of { owner_type + owner_id } or { targets }' },
    )
    .refine((v) => v.targets === undefined || v.kind === 'chronological', {
      message: 'targets is only allowed for kind: "chronological" (a permanent comment has exactly one owner)',
    });
  mcp.registerTool(
    'etn.comments.upsert',
    {
      title: 'Создать/обновить комментарий',
      description:
        'For `permanent`: creates the single permanent comment of the owner, or updates it when it already ' +
        'exists. For `chronological`: always appends a new dated entry (`valid_from`/`valid_to`); pass ' +
        '`targets: [{owner_type, owner_id}]` (1..100, first is the primary owner) instead of ' +
        '`owner_type`+`owner_id` to attach the same entry to several thoughts/links at once. ' +
        'Returns { id, version }.',
      inputSchema: CommentsUpsert.schema,
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const targets: CommentTarget[] =
          args.targets ?? [{ owner_type: args.owner_type!, owner_id: args.owner_id! }];
        const primary = targets[0]!;
        if (args.kind === 'permanent') {
          const existing = listComments(ndb, primary.owner_type, primary.owner_id).find(
            (c) => c.kind === 'permanent',
          );
          if (existing !== undefined) {
            const changes = {
              ...(args.title === undefined ? {} : { title: args.title }),
              body_md: args.body_md,
            };
            const comment = updateComment(
              ndb,
              existing.id,
              changes,
              undefined,
              rt.deps.auth.userId,
            );
            emitAgentActivityEvent(
              rt,
              args.network_id,
              'comment.updated',
              { id: comment.id, changes, version: comment.version },
              ndb,
              extra.requestId,
            );
            auditAgentCall(rt, 'etn.comments.upsert', args.network_id, 'comment', comment.id, args);
            return {
              id: comment.id,
              version: comment.version,
              request_id: String(extra.requestId),
            } satisfies McpMutationResult;
          }
        }
        const comment = createCommentWithTargets(
          ndb,
          targets,
          {
            kind: args.kind,
            title: args.title ?? null,
            body_md: args.body_md,
            ...(args.valid_from === undefined ? {} : { valid_from: args.valid_from }),
            ...(args.valid_to === undefined ? {} : { valid_to: args.valid_to }),
          },
          rt.deps.auth.userId,
        );
        emitAgentActivityEvent(rt, args.network_id, 'comment.created', { comment }, ndb, extra.requestId);
        auditAgentCall(rt, 'etn.comments.upsert', args.network_id, 'comment', comment.id, args);
        return {
          id: comment.id,
          version: comment.version,
          request_id: String(extra.requestId),
        } satisfies McpMutationResult;
      }),
  );

  const CommentChanges = z
    .object({
      title: z.string().nullable().optional(),
      body_md: z.string().min(1).optional(),
      valid_from: z.string().min(1).optional(),
      valid_to: z.string().nullable().optional(),
    })
    .refine((c) => Object.keys(c).length > 0, { message: 'changes must not be empty' });
  const UpdateCommentSchema = z.object({
    network_id: NetworkId,
    comment_id: z.string().min(1),
    changes: CommentChanges,
    expected_version: ExpectedVersion,
  });
  mcp.registerTool(
    'etn.comments.update',
    {
      title: 'Изменить комментарий',
      description:
        'Patch an existing comment (chronological or permanent) by `comment_id` — last-write-wins per ' +
        'field. `valid_from`/`valid_to` apply to chronological entries only and are ignored for permanent ' +
        'ones. `expected_version` enables optimistic concurrency — on mismatch the call fails with ' +
        'VERSION_CONFLICT. Returns { id, version }.',
      inputSchema: CommentsUpdate.schema,
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const comment = updateComment(
          ndb,
          args.comment_id,
          args.changes,
          args.expected_version,
          rt.deps.auth.userId,
        );
        emitAgentActivityEvent(
          rt,
          args.network_id,
          'comment.updated',
          { id: comment.id, changes: args.changes, version: comment.version },
          ndb,
          extra.requestId,
        );
        auditAgentCall(rt, 'etn.comments.update', args.network_id, 'comment', comment.id, args);
        return {
          id: comment.id,
          version: comment.version,
          request_id: String(extra.requestId),
        } satisfies McpMutationResult;
      }),
  );

  // Задача d28abe04 (0.7.2): секционная правка комментария ops-ами одной
  // транзакцией. Поддерживает append / prepend / replace_section /
  // delete_section; адресация секций — по тексту markdown-заголовка
  // (виртуальная первая строка для текстов без `#`).
  const EditAppendOp = z.object({ op: z.literal('append'), text: z.string().min(1) });
  const EditPrependOp = z.object({ op: z.literal('prepend'), text: z.string().min(1) });
  const EditReplaceSectionOp = z.object({
    op: z.literal('replace_section'),
    section: z.string().min(1),
    text: z.string().min(1),
  });
  const EditDeleteSectionOp = z.object({
    op: z.literal('delete_section'),
    section: z.string().min(1),
  });
  const EditOpSchema = z.discriminatedUnion('op', [
    EditAppendOp,
    EditPrependOp,
    EditReplaceSectionOp,
    EditDeleteSectionOp,
  ]);
  const EditCommentSchema = z
    .object({
      network_id: NetworkId,
      comment_id: z.string().min(1).optional(),
      thought_id: ThoughtId.optional(),
      expected_version: ExpectedVersion,
      ops: z.array(EditOpSchema).min(1),
    })
    .refine((a) => (a.comment_id === undefined) !== (a.thought_id === undefined), {
      message: 'provide exactly one of comment_id or thought_id',
    });
  mcp.registerTool(
    'etn.comments.edit',
    {
      title: 'Частичная правка комментария',
      description:
        'Edit a comment by parts: `append`/`prepend`/`replace_section`/' +
        '`delete_section` ops applied sequentially in one transaction ' +
        '(failure rolls back the call). Addressing by markdown heading ' +
        'text; for heading-less text the first non-empty line is a virtual ' +
        'heading. `comment_id` XOR `thought_id`. Returns ' +
        '`{ id, version, sections[], chars_total }`.',
      inputSchema: CommentsEdit.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.comments.edit'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        let targetId: string;
        if (args.thought_id !== undefined) {
          // Постоянный комментарий мысли: проверяем, что мысль существует,
          // и достаём единственный постоянный комментарий через listComments.
          getThoughtOrThrow(ndb, args.thought_id);
          const permanent =
            listComments(ndb, 'thought', args.thought_id).find((c) => c.kind === 'permanent') ??
            null;
          if (permanent === null) {
            throw new Error(
              `ETN error [NOT_FOUND]: thought ${args.thought_id} has no permanent comment`,
            );
          }
          targetId = permanent.id;
        } else if (args.comment_id !== undefined) {
          targetId = args.comment_id;
        } else {
          // refine гарантирует одну из двух; здесь — для TS.
          throw new Error('ETN error [VALIDATION_ERROR]: comment_id or thought_id required');
        }
        const result = editComment(
          ndb,
          targetId,
          args.ops,
          args.expected_version,
          rt.deps.auth.userId,
        );
        emitAgentActivityEvent(
          rt,
          args.network_id,
          'comment.updated',
          {
            id: result.id,
            changes: { body_md: result.body_md },
            version: result.version,
          },
          ndb,
          extra.requestId,
        );
        auditAgentCall(rt, 'etn.comments.edit', args.network_id, 'comment', result.id, {
          expected_version: args.expected_version,
          ops_count: args.ops.length,
        });
        return {
          id: result.id,
          version: result.version,
          sections: result.sections,
          chars_total: result.chars_total,
          request_id: String(extra.requestId),
        };
      }),
  );

  const DeleteCommentSchema = z.object({
    network_id: NetworkId,
    comment_id: z.string().min(1),
    expected_version: ExpectedVersion,
  });
  mcp.registerTool(
    'etn.comments.delete',
    {
      title: 'Удалить комментарий',
      description:
        'Delete a comment (chronological or permanent) by `comment_id` together with all its ' +
        'attachments to owners. Returns { id, version: 0 }.',
      inputSchema: CommentsDelete.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.comments.delete'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const existing = getComment(ndb, args.comment_id);
        if (existing === null) {
          throw new Error(`ETN error [NOT_FOUND]: comment ${args.comment_id} not found`);
        }
        deleteComment(ndb, args.comment_id, args.expected_version);
        emitAgentEvent(
          rt,
          args.network_id,
          'comment.deleted',
          {
            owner_type: existing.owner_type,
            owner_id: existing.owner_id,
            id: args.comment_id,
          },
          extra.requestId,
        );
        recordCommentActivity(ndb, {
          networkId: args.network_id,
          userId: rt.deps.auth.userId,
          action: 'deleted',
          comment: existing,
          layerId: ndb.layerId,
        });
        auditAgentCall(rt, 'etn.comments.delete', args.network_id, 'comment', args.comment_id, {
          expected_version: args.expected_version,
        });
        return {
          id: args.comment_id,
          version: 0,
          request_id: String(extra.requestId),
        } satisfies McpMutationResult;
      }),
  );

}
