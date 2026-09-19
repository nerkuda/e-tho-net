/**
 * attachments.ts — MCP-инструменты области «registerAttachmentsTools».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import { z } from 'zod';
import { ATTACHMENT_KINDS, MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import type { McpMutationResult } from '@etn/shared';
import {
  copyAttachment,
  createAttachment,
  deleteAttachment,
  getAttachment,
  searchAttachments,
  updateAttachment,
} from '../../domain/attachment-service.js';
import {
  AttachmentsAdd,
  AttachmentsCopy,
  AttachmentsDelete,
  AttachmentsSearch,
  AttachmentsUpdate,
} from '../../contracts.js';
import { search } from '../../domain/search-service.js';
import {
  mcpWriteFx,
  openMemberNetwork,
  requireWritable,
  requireWriteBudget,
  runTool,
  runWrite,
  runWriteTool,
} from '../context.js';
import { NetworkId } from './shared.js';

export function registerAttachmentsTools(mcp: McpServer, rt: McpRuntime): void {
  const AddAttachmentSchema = z.object({
    network_id: NetworkId,
    owner_type: z.enum(['thought', 'link']),
    owner_id: z.string().min(1),
    kind: z.enum(ATTACHMENT_KINDS),
    url: z.string().min(1).nullable().optional(),
    file_path: z.string().min(1).nullable().optional(),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  });
  mcp.registerTool(
    'etn.attachments.add',
    {
      title: 'Добавить вложение',
      description:
        'Attach a URL or a local file path to a thought/link (`kind` selects which; for `url` ' +
        'provide `url`, for `file` provide `file_path`). Returns { id, version: 0 }.',
      inputSchema: AttachmentsAdd.schema,
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const attachment = runWrite(ndb, fx, () => {
          const created = createAttachment(
            ndb,
            args.owner_type,
            args.owner_id,
            {
              kind: args.kind,
              url: args.url ?? null,
              file_path: args.file_path ?? null,
              title: args.title ?? null,
              description: args.description ?? null,
            },
            rt.deps.auth.userId,
          );
          return {
            result: created,
            events: [{ type: 'attachment.created', data: { attachment: created } }],
            activity: [{ kind: 'attachment', action: 'created', attachment: created }],
            audit: {
              action: 'etn.attachments.add',
              targetType: 'attachment',
              targetId: created.id,
              details: args,
            },
          };
        });
        return {
          id: attachment.id,
          version: 0,
          request_id: String(extra.requestId),
        } satisfies McpMutationResult;
      }),
  );

  const CopyAttachmentSchema = z.object({
    network_id: NetworkId,
    attachment_id: z.string().min(1),
    target_owner_type: z.enum(['thought', 'link']),
    target_owner_ids: z.array(z.string().min(1)).min(1),
  });
  mcp.registerTool(
    'etn.attachments.copy',
    {
      title: 'Скопировать вложение',
      description:
        'Copy an existing attachment to one or more target thoughts: each target receives a new row ' +
        'carrying the same visible fields as the source; the underlying file is not duplicated. Targets ' +
        'that already own the same attachment (same kind + same url/file_path) are skipped silently. ' +
        'Returns one `{id, version: 0, request_id}` per created row.',
      inputSchema: AttachmentsCopy.schema,
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const result = runWrite(ndb, fx, () => {
          const copied = copyAttachment(
            ndb,
            args.attachment_id,
            { target_owner_type: args.target_owner_type, target_owner_ids: args.target_owner_ids },
            rt.deps.auth.userId,
          );
          return {
            result: copied,
            events: copied.created.map((attachment) => ({
              type: 'attachment.created' as const,
              data: { attachment },
            })),
            activity: copied.created.map((attachment) => ({
              kind: 'attachment' as const,
              action: 'created' as const,
              attachment,
            })),
            audit: {
              action: 'etn.attachments.copy',
              targetType: 'attachment',
              targetId: args.attachment_id,
              details: args,
            },
          };
        });
        return result.created.map((a) => ({
          id: a.id,
          version: 0,
          request_id: String(extra.requestId),
        })) satisfies McpMutationResult[];
      }),
  );

  const SearchAttachmentsSchema = z.object({
    network_id: NetworkId,
    q: z.string().min(1),
    kind: z.enum(ATTACHMENT_KINDS).optional(),
    exclude_owner_type: z.enum(['thought', 'link']).optional(),
    exclude_owner_id: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  });
  mcp.registerTool(
    'etn.attachments.search',
    {
      title: 'Поиск вложений',
      description:
        'Search attachments across the network by keywords over title, description, url and file_path ' +
        '(case-insensitive LIKE, no FTS index). `q` uses the `etn.thoughts.search` mini-syntax: AND of ' +
        'include-words, `-word` exclusion, `*` infix wildcard. Pass `exclude_owner_type`/' +
        '`exclude_owner_id` to hide rows already attached to a specific owner.',
      inputSchema: AttachmentsSearch.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.attachments.search'],
    },
    (args, _extra) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const { items } = searchAttachments(ndb, {
          q: args.q,
          kind: args.kind,
          exclude_owner_type: args.exclude_owner_type,
          exclude_owner_id: args.exclude_owner_id,
          limit: args.limit,
          offset: args.offset,
        });
        return items;
      }),
  );

  // =========================================================================
  // `etn.attachments.update` (задача 6d45ab37, спека 0b23a32a, P1-паритет
  // MCP↔REST `PATCH /attachments/{id}`). Last-write-wins по метаданным
  // (title/description/url/file_path); kind неизменяем после создания.
  // =========================================================================
  const UpdateAttachmentSchema = z.object({
    network_id: NetworkId,
    attachment_id: z.string().min(1),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    file_path: z.string().nullable().optional(),
  });
  mcp.registerTool(
    'etn.attachments.update',
    {
      title: 'Изменить вложение',
      description:
        'Правка метаданных (title/description/url/file_path). Last-write-wins (у `attachments` нет ' +
        '`version`). `kind` неизменяем. Возвращает `{ id, version }`.',
      inputSchema: AttachmentsUpdate.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.attachments.update'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const changes: {
          title?: string | null;
          description?: string | null;
          url?: string | null;
          file_path?: string | null;
        } = {};
        if (args.title !== undefined) changes.title = args.title;
        if (args.description !== undefined) changes.description = args.description;
        if (args.url !== undefined) changes.url = args.url;
        if (args.file_path !== undefined) changes.file_path = args.file_path;
        const attachment = runWrite(ndb, fx, () => {
          const updated = updateAttachment(ndb, args.attachment_id, changes, rt.deps.auth.userId);
          return {
            result: updated,
            events: [{ type: 'attachment.updated', data: { id: updated.id, changes } }],
            activity: [{ kind: 'attachment', action: 'updated', attachment: updated }],
            audit: {
              action: 'etn.attachments.update',
              targetType: 'attachment',
              targetId: updated.id,
              details: args,
            },
          };
        });
        return {
          id: attachment.id,
          version: 0,
          request_id: String(extra.requestId),
        } satisfies McpMutationResult;
      }),
  );

  // =========================================================================
  // `etn.attachments.delete` (задача 6d45ab37, спека 0b23a32a, P1-паритет
  // MCP↔REST `DELETE /attachments/{id}`). Отвязывает вложение от владельца;
  // физический файл НЕ удаляется — server-side cleanup в domain
  // `deleteAttachment` (S4, 13-layers.md §5.3) решает судьбу файла по
  // оставшимся ссылкам.
  // =========================================================================
  const DeleteAttachmentSchema = z.object({
    network_id: NetworkId,
    attachment_id: z.string().min(1),
  });
  mcp.registerTool(
    'etn.attachments.delete',
    {
      title: 'Удалить вложение',
      description:
        'Отвязка вложения от владельца. Физический файл НЕ удаляется — судьбу решает domain ' +
        'по оставшимся ссылкам. Возвращает `{ deleted: true }`.',
      inputSchema: AttachmentsDelete.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.attachments.delete'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        runWrite(ndb, fx, () => {
          // Берём снимок ДО удаления — он уйдёт в журнал (как REST DELETE
          // /attachments/:id).
          const existing = getAttachment(ndb, args.attachment_id);
          deleteAttachment(ndb, args.attachment_id);
          return {
            result: undefined,
            events: [{ type: 'attachment.deleted', data: { id: args.attachment_id } }],
            ...(existing === null
              ? {}
              : {
                  activity: [
                    {
                      kind: 'attachment' as const,
                      action: 'deleted' as const,
                      attachment: existing,
                    },
                  ],
                }),
            audit: {
              action: 'etn.attachments.delete',
              targetType: 'attachment',
              targetId: args.attachment_id,
              details: args,
            },
          };
        });
        return { deleted: true, request_id: String(extra.requestId) };
      }),
  );
}
