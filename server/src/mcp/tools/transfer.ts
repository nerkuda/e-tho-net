/**
 * transfer.ts — MCP-инструменты области «registerTransferTools».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import type { AnyWriteEvent, WriteActivityEntry } from '../../domain/write-wrapper.js';

import { openNetworkDb } from '../../db/network-db.js';
import {
  ImportDryRun,
  ImportSubgraph,
  ThoughtsCopySubtree,
  ThoughtsMentionsScan,
} from '../../contracts.js';
import { MCP_MAX_THOUGHTS_PER_WRITE, MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import { getHomeThoughtId, getThoughtOrThrow } from '../../domain/thought-service.js';
import { getLink } from '../../domain/link-service.js';
import { copySubtree as copySubtreeFn } from '../../domain/thought-subtree-copy-service.js';
import {
  importFromBuffer,
  planImportFromBuffer,
  readImportSource,
} from '../../domain/import-service-mcp.js';
import {
  mcpWriteFx,
  openMemberNetwork,
  requireWritable,
  requireWriteBudget,
  resolveRuntimeLayer,
  runTool,
  runWrite,
  runWriteTool,
} from '../context.js';
import { executeMentionsScan } from './shared.js';

export function registerTransferTools(mcp: McpServer, rt: McpRuntime): void {
  mcp.registerTool(
    'etn.thoughts.copy_subtree',
    {
      title: 'Копирование подграфа между сетями',
      description:
        'Сервер сам собирает BFS-снапшот (`max_depth` ≤ 20, потолок ' +
        MCP_MAX_THOUGHTS_PER_WRITE +
        ' узлов) и материализует его в `target_network_id` одной транзакцией. ' +
        '`include` — подмножество частей (`thought`/`links`/`properties`/`comments`/`attachments`). ' +
        '`duplicate_policy`: `fail` — дубль в целевой сети возвращает VALIDATION_ERROR со списком; ' +
        '`reuse` — дубль переиспользуется без перезаписи; `skip` — дубль и весь его подграф пропускаются; ' +
        '`create_always` — всегда новая мысль. `id_remap: true` (default) возвращает `thought_id_map`/' +
        '`link_id_map` для переписывания wiki-ссылок. HOME-мысль как корень — VALIDATION_ERROR. ' +
        'Онтология целевой сети должна покрывать все используемые типы мыслей/связей — иначе ' +
        'VALIDATION_ERROR со списком недостающих. Один write-бюджет + одна строка audit_log.',
      inputSchema: ThoughtsCopySubtree.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.copy_subtree'],
    },
    (args, extra) =>
      runWriteTool(rt, args.target_network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const sourceNdb = openNetworkDb(rt.deps.dataDir, args.source_network_id);
        const targetNdb = openMemberNetwork(rt, args.target_network_id);
        const fx = mcpWriteFx(rt, args.target_network_id, extra.requestId);

        // `target_parent_thought_id` НЕ задан по умолчанию — копия подграфа
        // должна быть «чистой», без автоматической привязки к HOME. Если
        // пользователь явно передал `target_parent_thought_id`, подвешиваем
        // к ней; иначе корневые мысли остаются без входящей связи.
        let parentId: string;
        if (args.target_parent_thought_id !== undefined) {
          parentId = args.target_parent_thought_id;
        } else {
          parentId = '';
        }

        const summary = runWrite(targetNdb, fx, () => {
          const copied = copySubtreeFn({
            source_ndb: sourceNdb,
            target_ndb: targetNdb,
            root_thought_ids: args.root_thought_ids,
            max_depth: args.max_depth ?? 5,
            include: args.include ?? ['thought', 'links', 'properties', 'comments', 'attachments'],
            duplicate_policy: args.duplicate_policy ?? 'fail',
            target_parent_thought_id: parentId,
            actor_user_id: rt.deps.auth.userId,
          });

          // Real-time events: одна запись на созданную/переиспользованную
          // мысль и на созданную связь (per task spec) — из результата.
          const events: AnyWriteEvent[] = [];
          const activity: WriteActivityEntry[] = [];
          for (const [, newId] of Object.entries(copied.thought_id_map)) {
            if (newId === '') continue;
            const thought = getThoughtOrThrow(targetNdb, newId);
            events.push({ type: 'thought.created', data: { thought } });
            activity.push({ kind: 'thought', action: 'created', thought });
          }
          for (const [, newId] of Object.entries(copied.link_id_map)) {
            if (newId === '') continue;
            const link = getLink(targetNdb, newId);
            if (link !== null) {
              events.push({ type: 'link.created', data: { link } });
              activity.push({ kind: 'link', action: 'created', link });
            }
          }
          return {
            result: copied,
            events,
            activity,
            // ONE audit row for the whole call (per task spec).
            audit: {
              action: 'etn.thoughts.copy_subtree',
              targetType: 'network',
              targetId: args.target_network_id,
              details: {
                thoughts_created: copied.thoughts_created,
                thoughts_reused: copied.thoughts_reused,
                thoughts_skipped: copied.thoughts_skipped,
                links_created: copied.links_created,
              },
            },
          };
        });

        const layer = resolveRuntimeLayer(rt, args.target_network_id);
        const includeRemap = args.id_remap !== false;
        return {
          thoughts_created: summary.thoughts_created,
          thoughts_reused: summary.thoughts_reused,
          thoughts_skipped: summary.thoughts_skipped,
          links_created: summary.links_created,
          ...(includeRemap ? { thought_id_map: summary.thought_id_map } : {}),
          ...(includeRemap ? { link_id_map: summary.link_id_map } : {}),
          conflicts: summary.conflicts,
          layer: { id: layer.id, title: layer.title },
          request_id: String(extra.requestId),
        };
      }),
  );
  mcp.registerTool(
    'etn.thoughts.mentions_scan',
    {
      title: 'Поиск упоминаний мыслей в тексте',
      description:
        'Сканирует `text` (или тело комментария `source.comment_id`, или постоянный комментарий мысли ' +
        '`source.thought_id`) на упоминания мыслей текущей сети через FTS по названиям и синонимам. ' +
        'Возвращает `[{thought_id, title, confidence, matched_on}]` с `confidence` по шкале: точное ' +
        'вхождение ≥ 0.9; точное + синоним = 1.0; только синоним = 0.7; `*`-инфикс = 0.6; ниже ' +
        '`min_confidence` отбрасывается. С `create_links: true` создаёт направленные связи от ' +
        '`source_thought_id` к найденным (требует `link_type` и `source_thought_id`). Без `create_links` — ' +
        'read-only.',
      inputSchema: ThoughtsMentionsScan.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.mentions_scan'],
    },
    (args, extra) => {
      // Без create_links — read-only и не требует write-бюджета.
      const willMutate = args.create_links === true;
      if (willMutate) {
        return runWriteTool(rt, args.network_id, () => {
          requireWritable(rt);
          requireWriteBudget(rt);
          const ndb = openMemberNetwork(rt, args.network_id);
          const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
          const result = runWrite(ndb, fx, () => {
            const scanned = executeMentionsScan(ndb, args, rt.deps.auth.userId);
            return {
              result: scanned,
              audit: {
                action: 'etn.thoughts.mentions_scan',
                targetType: 'network',
                targetId: args.network_id,
                details: {
                  matches: scanned.matches.length,
                  links_created: scanned.links_created,
                },
              },
            };
          });
          return {
            matches: result.matches,
            links_created: result.links_created,
            request_id: String(extra.requestId),
          };
        });
      }
      return runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const result = executeMentionsScan(ndb, args, rt.deps.auth.userId);
        return {
          matches: result.matches,
          links_created: result.links_created,
          request_id: String(extra.requestId),
        };
      });
    },
  );
  mcp.registerTool(
    'etn.import.dry_run',
    {
      title: 'Превью импорта .etnx',
      description:
        'Читает `.etnx` (file или base64), валидирует manifest и возвращает план: сколько мыслей/связей/' +
        'вложений создастся в целевой сети. Без побочных эффектов — read-only.',
      inputSchema: ImportDryRun.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.import.dry_run'],
    },
    (args) =>
      runTool(async () => {
        const buf = readImportSource(args.source);
        const plan = await planImportFromBuffer(buf, rt.deps.logger);
        return {
          ok: true as const,
          manifest_version: plan.manifest_version,
          source_network_name: plan.source_network_name,
          plan: plan.plan,
          conflicts: plan.conflicts,
        };
      }),
  );
  mcp.registerTool(
    'etn.import.subgraph',
    {
      title: 'Импорт .etnx',
      description:
        'Применяет `.etnx` (file или base64) к целевой сети одной транзакцией. Требует `confirm: true`. ' +
        '`parent_thought_id` — куда подвесить корневые мысли; по умолчанию — HOME. Возвращает ' +
        '`{ imported: {...counts...}, conflicts: [...], manifest_version, layer, request_id }`. ' +
        'Один write-бюджет + одна строка audit_log. `destructiveHint: true`.',
      inputSchema: ImportSubgraph.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.import.subgraph'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const buf = readImportSource(args.source);
        const ndb = openMemberNetwork(rt, args.network_id);
        let parentId = args.parent_thought_id;
        if (parentId === undefined) {
          const homeId = getHomeThoughtId(ndb);
          if (homeId === null) {
            throw new Error('ETN error [INTERNAL]: target network has no HOME thought');
          }
          parentId = homeId;
        }
        // `importFromBuffer` сам держит импорт одной транзакцией и асинхронен
        // (разбор zip), поэтому обёртка здесь исполняет только пост-коммитные
        // эффекты: события и журнал — из результата импорта.
        const result = await importFromBuffer(
          ndb,
          buf,
          {
            actorUserId: rt.deps.auth.userId,
            parentThoughtId: parentId,
          },
          rt.deps.logger,
          args.collision_policy,
        );

        // Real-time events: одна запись на созданную/обновлённую сущность
        // (мысль, связь, комментарий) — per task spec.
        runWrite(ndb, mcpWriteFx(rt, args.network_id, extra.requestId), () => {
          const events: AnyWriteEvent[] = [];
          const activity: WriteActivityEntry[] = [];
          for (const id of result.createdThoughtIds) {
            const thought = getThoughtOrThrow(ndb, id);
            events.push({ type: 'thought.created', data: { thought } });
            activity.push({ kind: 'thought', action: 'created', thought });
          }
          for (const id of result.createdLinkIds) {
            const link = getLink(ndb, id);
            if (link !== null) {
              events.push({ type: 'link.created', data: { link } });
              activity.push({ kind: 'link', action: 'created', link });
            }
          }
          return {
            result: undefined,
            events,
            activity,
            audit: {
              action: 'etn.import.subgraph',
              targetType: 'network',
              targetId: args.network_id,
              details: {
                thoughts_created: result.thoughts_created,
                thoughts_updated: result.thoughts_updated,
                thoughts_reused: result.thoughts_reused,
                links_created: result.links_created,
                attachments_imported: result.attachments_imported,
              },
            },
          };
        });

        const layer = resolveRuntimeLayer(rt, args.network_id);
        return {
          imported: {
            thoughts_created: result.thoughts_created,
            thoughts_updated: result.thoughts_updated,
            thoughts_reused: result.thoughts_reused,
            links_created: result.links_created,
            permanent_comments_updated: result.permanent_comments_updated,
            chronological_comments_added: result.chronological_comments_added,
            property_values_set: result.property_values_set,
            attachments_imported: result.attachments_imported,
            thought_types_created: result.thought_types_created,
            thought_types_reused: result.thought_types_reused,
            link_types_created: result.link_types_created,
            link_types_reused: result.link_types_reused,
          },
          conflicts: [],
          manifest_version: result.manifest_version,
          layer: { id: layer.id, title: layer.title },
          request_id: String(extra.requestId),
        };
      }),
  );
}
