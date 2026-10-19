/**
 * thoughts-write.ts — MCP-инструменты области «registerThoughtsWriteTools».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 *
 * Веха 9 (задача 8b2efe2d): каждый изменяющий тул исполняет запись через
 * доменную обёртку «транзакция → событие → журнал → аудит»; тул собирает
 * только исход записи из результата, а публикует и пишет обёртка после коммита.
 *
 * `etn.thoughts.bulk_update` переведён на фасад write-пула
 * {@link runThoughtsBatch} (задача dba7fabc, ADR ca3a9218): транзакция и журнал
 * активности идут в воркере, события публикует фасад после коммита, а строка
 * аудита остаётся у тула (фасад аудит не пишет).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';

import type { NetworkDb } from '../../db/network-db.js';
import {
  BULK_UPDATE_OP_VALUES,
  ThoughtsBulkUpdate,
} from '../../contracts.js';
import { MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import { runThoughtsBatch } from '../../domain/heavy-write.js';
import { resolveThoughtTypeIdByName } from '../../domain/thought-type-service.js';
import { resolveLinkTypeIdByName } from '../../domain/link-type-service.js';
import {
  mcpWriteFx,
  openMemberNetwork,
  requireWritable,
  requireWriteBudget,
  runWriteTool,
} from '../context.js';

export function registerThoughtsWriteTools(mcp: McpServer, rt: McpRuntime): void {
  /**
   * Разбор `args` для `etn.thoughts.bulk_update`. Возвращает нормализованный
   * объект подмножества `ThoughtBatchArgs`, пригодный для вызова
   * доменного/роутного кода. Используется в фасаде и тестах.
   *
   * XOR-пары (`type`/`type_id`, `link_type`/`link_type_id`) уже отсечены
   * схемой Zod — здесь только нормализация резолва имён в id.
   */
  function normalizeBulkUpdateArgs(
    ndb: NetworkDb,
    op: (typeof BULK_UPDATE_OP_VALUES)[number],
    args: {
      type?: string;
      type_id?: string | null;
      parent_ids?: string[];
      child_ids?: string[];
      link_type?: string;
      link_type_id?: string | null;
    },
  ): {
    type_id: string | null | undefined;
    parent_ids: string[] | undefined;
    child_ids: string[] | undefined;
    link_type_id: string | null | undefined;
  } {
    const out: {
      type_id: string | null | undefined;
      parent_ids: string[] | undefined;
      child_ids: string[] | undefined;
      link_type_id: string | null | undefined;
    } = {
      type_id: undefined,
      parent_ids: undefined,
      child_ids: undefined,
      link_type_id: undefined,
    };
    if (op === 'set_type') {
      out.type_id =
        args.type === undefined ? args.type_id : resolveThoughtTypeIdByName(ndb, args.type);
    }
    if (op === 'link_parents' || op === 'set_only_parents' || op === 'unlink_parents') {
      out.parent_ids = args.parent_ids;
    }
    if (op === 'link_children' || op === 'unlink_children') {
      out.child_ids = args.child_ids;
    }
    if (op === 'link_parents' || op === 'link_children' || op === 'set_only_parents') {
      out.link_type_id =
        args.link_type === undefined
          ? args.link_type_id
          : resolveLinkTypeIdByName(ndb, args.link_type);
    }
    return out;
  }

  // Аргументы массовых операций: минимальный, жёсткий контракт.
  // Запрещаем смешение `type`/`type_id`, `link_type`/`link_type_id` —
  // схемой `.refine()` (задача 77351f03).
  mcp.registerTool(
    'etn.thoughts.bulk_update',
    {
      title: 'Групповые операции над мыслями',
      description:
        'Групповые операции (одна запись бюджета на ВЕСЬ вызов): `op` ∈ {`set_type`,`clear_type`,' +
        '`set_active`,`set_inactive`,`trash`,`link_parents`,`link_children`,`set_only_parents`,' +
        '`unlink_parents`,`unlink_children`}. Возвращает `{ affected, failures[] }`. Без `purge`/`delete`. ' +
        'Неизвестные ключи (в т.ч. параметры op, положенные в корень вместо `args`) отвергаются ' +
        '`VALIDATION_ERROR` (`details.fields`), а не игнорируются.',
      inputSchema: ThoughtsBulkUpdate.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.bulk_update'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const normalized = normalizeBulkUpdateArgs(ndb, args.op, args.args ?? {});
        const ids = [...new Set(args.ids)];
        // Изменение, журнал активности и real-time-эффекты — в домене
        // (задача fffe76f2, ADR 162d8e7a); транзакцию и журнал исполняет
        // write-пул через фасад `runThoughtsBatch`, события фасад публикует
        // строго после коммита (задача dba7fabc, ADR ca3a9218). Аудит — одна
        // запись на КАЖДЫЙ вызов (контракт бюджета 0ff98632); фасад его не
        // пишет, поэтому строка остаётся здесь и появляется после коммита.
        const result = await runThoughtsBatch(ndb, fx, {
          ids,
          op: args.op,
          bulk: normalized,
        });
        if (fx.audit !== undefined) {
          fx.audit({
            action: 'etn.thoughts.bulk_update',
            targetType: 'thought',
            targetId: ids[0] ?? '',
            details: {
              op: args.op,
              ids: ids.length,
              affected: result.affected,
              failures: result.failures.length,
            },
          });
        }
        return { affected: result.affected, failures: result.failures };
      }),
  );
  // `etn.thoughts.delete` (0.8.3, задача 86ef2ff4) снят из постоянного набора
  // — упакован в `etn.ops { action: "thoughts.delete" }` (tools/ops.ts).
  // `etn.thoughts.trash` и `etn.links.restore` (0.8.3, задача d379e091) —
  // тоже действия `etn.ops` (`thoughts.trash`, `links.restore`): обратимые
  // операции корзины, сняты одним мажором без алиасов.
}
