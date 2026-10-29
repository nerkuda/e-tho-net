/**
 * custom-views.ts — MCP-инструмент `etn.custom_views.write` (0.14.1, задача
 * 769fde88; операция 97d1a0d3, ADR 2a758041).
 *
 * Батч-запись ВНЕТИПОВЫХ отборов одной мысли: 1–50 элементов create/update/
 * delete, одна транзакция «всё или ничего», один write-бюджет и одна строка
 * `audit_log`; real-time события — по одному на фактически изменённый отбор.
 *
 * Инструмент отдельный, а не секция `etn.ontology.write`/`etn.thoughts.write`:
 * владелец отбора — мысль, а не реестр сети, и отбор — настройка отображения,
 * а не единица знания (ADR 2a758041). Логика батча — в домене
 * (`writeThoughtCustomViews`), здесь только фасад: права, бюджет, транзакция,
 * события и аудит — те же правила, что у REST CRUD (операция 5e55b7bb).
 *
 * Чтение агентом — без нового инструмента: внетиповые отборы видны в
 * `meta.views` карточек (`etn.thoughts.get/resolve/subgraph`, дискриминатор
 * `scope: 'thought'`), исполнение — `etn.views.run`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { McpRuntime } from '../context.js';
import type { AnyWriteEvent } from '../../domain/write-wrapper.js';
import { MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import { CustomViewsWrite } from '../../contracts.js';
import {
  toEffectiveCustomView,
  writeThoughtCustomViews,
} from '../../domain/thought-custom-views-service.js';
import {
  mcpWriteFx,
  openMemberNetwork,
  requireWritable,
  requireWriteBudget,
  runWrite,
  runWriteTool,
} from '../context.js';

export function registerCustomViewsWriteTool(mcp: McpServer, rt: McpRuntime): void {
  mcp.registerTool(
    'etn.custom_views.write',
    {
      title: 'Батч-запись внетиповых отборов мысли',
      description:
        'Батч-запись внетиповых отборов одной мысли: `views[]` 1–50, одна транзакция «всё или ' +
        'ничего», один write-бюджет и одна строка `audit_log`; события — по одному на изменённый ' +
        'отбор. Элемент: `action` `create`|`update`|`delete`; create — `ref?` (локальная ссылка ' +
        'батча), `name`, `definition` (JSON-строка), `description?`, `position?`, `is_default?`, ' +
        '`on_duplicate?` (`fail`|`reuse`|`update`); update — полный `id` живого отбора этой мысли XOR ' +
        '`ref`, `expected_version?`, частичный патч (пустой — `VALIDATION_ERROR`); delete — `id` XOR ' +
        '`ref`, без `expected_version`. `ref` резолвится вторым проходом (вперёд и create+delete в ' +
        'батче); неразрешённый — `VALIDATION_ERROR` `views[i].ref`. Чужой `id` — 404; дубль имени — ' +
        '409 `DUPLICATE` (`details.existing_id`). Ответ: `{ items, warnings: [], layer }` — полные ' +
        'карточки create/update и `{ action: "deleted", id }`; чтение — `meta.views` карточек ' +
        '(`scope: "thought"`), исполнение — `etn.views.run`.',
      inputSchema: CustomViewsWrite.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.custom_views.write'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const items = runWrite(ndb, fx, () => {
          const outcome = writeThoughtCustomViews(
            ndb,
            args.thought_id,
            args.views,
            rt.deps.auth.userId,
            String(extra.requestId),
          );

          // По одному событию на фактически изменённый отбор — тот же
          // контракт payload, что у REST CRUD (5d447380): клиент не делает
          // лишний GET. `reuse` изменением не считается и события не даёт.
          const events: AnyWriteEvent[] = [];
          for (const change of outcome.changed) {
            if (change.action === 'created') {
              events.push({
                type: 'thought-custom-view.created',
                data: {
                  thought_id: change.view.thought_id,
                  view: toEffectiveCustomView(change.view),
                },
              });
            } else if (change.action === 'updated') {
              events.push({
                type: 'thought-custom-view.updated',
                data: {
                  thought_id: change.view.thought_id,
                  view_id: change.view.id,
                  changes: change.changes,
                  version: change.view.version,
                  view: toEffectiveCustomView(change.view),
                },
              });
            } else {
              events.push({
                type: 'thought-custom-view.deleted',
                data: {
                  thought_id: change.view.thought_id,
                  view_id: change.view.id,
                  view: toEffectiveCustomView(change.view),
                },
              });
            }
          }

          return {
            result: outcome,
            events,
            // ОДНА строка аудита на весь батч (контракт спеки операции).
            audit: {
              action: 'etn.custom_views.write',
              targetType: 'thought',
              targetId: args.thought_id,
              details: {
                views_count: args.views.length,
                created: outcome.changed.filter((c) => c.action === 'created').length,
                updated: outcome.changed.filter((c) => c.action === 'updated').length,
                deleted: outcome.changed.filter((c) => c.action === 'deleted').length,
              },
            },
          };
        });

        // Конверт операции: `items` по порядку входа, `warnings` — единая
        // форма (источника жёлтой диагностики при записи нет — она считается
        // при исполнении отбора). `layer` добавляет обёртка `runWriteTool`.
        return { items: items.items, warnings: [] };
      }),
  );
}
