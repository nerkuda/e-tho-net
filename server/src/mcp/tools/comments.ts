/**
 * comments.ts — MCP-инструменты области «registerCommentsGetTool, registerCommentsWriteTools».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import { MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import type { McpMutationResult } from '@etn/shared';
import { getThoughtOrThrow } from '../../domain/thought-service.js';
import {
  CommentsDelete,
  CommentsEdit,
  CommentsGet,
  CommentsUpdate,
} from '../../contracts.js';
import {
  deleteComment,
  editComment,
  getComment,
  listComments,
  updateComment,
} from '../../domain/comment-service.js';
import {
  mcpWriteFx,
  openMemberNetwork,
  requireWritable,
  requireWriteBudget,
  runTool,
  runWrite,
  runWriteTool,
} from '../context.js';

export function registerCommentsGetTool(mcp: McpServer, rt: McpRuntime): void {
  mcp.registerTool(
    'etn.comments.get',
    {
      title: 'Комментарий (полный текст)',
      description:
        'Fetch one comment in full: by `comment_id` — any comment (permanent or chronological) with its ' +
        "complete `body_md`; by `thought_id` — the thought's permanent comment, or `{thought_id, permanent: " +
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
          listComments(ndb, 'thought', args.thought_id).find((c) => c.kind === 'permanent') ?? null;
        return { thought_id: args.thought_id, permanent };
      }),
  );
}

export function registerCommentsWriteTools(mcp: McpServer, rt: McpRuntime): void {
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
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const comment = runWrite(ndb, fx, () => {
          const updated = updateComment(
            ndb,
            args.comment_id,
            args.changes,
            args.expected_version,
            rt.deps.auth.userId,
          );
          return {
            result: updated,
            events: [
              {
                type: 'comment.updated',
                data: { id: updated.id, changes: args.changes, version: updated.version },
              },
            ],
            activity: [{ kind: 'comment', action: 'updated', comment: updated }],
            audit: {
              action: 'etn.comments.update',
              targetType: 'comment',
              targetId: updated.id,
              details: args,
            },
          };
        });
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
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
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
        const result = runWrite(ndb, fx, () => {
          const edited = editComment(
            ndb,
            targetId,
            args.ops,
            args.expected_version,
            rt.deps.auth.userId,
          );
          // Журнал — из результата: снимок обновлённого комментария
          // дочитываем из строки (как прежний MCP-диспетчер).
          const comment = getComment(ndb, edited.id);
          return {
            result: edited,
            events: [
              {
                type: 'comment.updated',
                data: {
                  id: edited.id,
                  changes: { body_md: edited.body_md },
                  version: edited.version,
                },
              },
            ],
            ...(comment === null
              ? {}
              : { activity: [{ kind: 'comment' as const, action: 'updated' as const, comment }] }),
            audit: {
              action: 'etn.comments.edit',
              targetType: 'comment',
              targetId: edited.id,
              details: { expected_version: args.expected_version, ops_count: args.ops.length },
            },
          };
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
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        runWrite(ndb, fx, () => {
          const existing = getComment(ndb, args.comment_id);
          if (existing === null) {
            throw new Error(`ETN error [NOT_FOUND]: comment ${args.comment_id} not found`);
          }
          deleteComment(ndb, args.comment_id, args.expected_version);
          return {
            result: undefined,
            events: [
              {
                type: 'comment.deleted',
                data: {
                  owner_type: existing.owner_type,
                  owner_id: existing.owner_id,
                  id: args.comment_id,
                },
              },
            ],
            activity: [{ kind: 'comment', action: 'deleted', comment: existing }],
            audit: {
              action: 'etn.comments.delete',
              targetType: 'comment',
              targetId: args.comment_id,
              details: { expected_version: args.expected_version },
            },
          };
        });
        return {
          id: args.comment_id,
          version: 0,
          request_id: String(extra.requestId),
        } satisfies McpMutationResult;
      }),
  );
}
