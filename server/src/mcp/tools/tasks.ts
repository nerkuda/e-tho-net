/**
 * actions `tasks.*` исполнителя `etn.ops` (0.16.1, задача f34066e1,
 * операция 22f1ea95, ADR «ростер MCP не растёт» 43abd7dd).
 *
 * Паритет MCP с REST без роста ростера инструментов: новых MCP-инструментов не
 * появляется, реестр действий — `tools/ops-catalog.ts`, темы справочника — там
 * же (`tasks` и `tasks.<action>`). Обработчики — ТЕ ЖЕ доменные функции, что
 * REST (`routes/tasks.ts`): `tasks.list` читает материализованную проекцию
 * (`listTasksAsync`, reader-пул), одиночные `toggle`/`move`/`cancel` правят
 * `body_md` источника через {@link applyTaskOps}, массовые `cancelAll`/`moveAll`
 * — через {@link applyTaskMassCommand}. Поэтому 404/409, адресация
 * `comment_id`+`line_no` и события `comment.updated` совпадают с REST.
 *
 * Чтение — без записи и без write-бюджета (`readOnly`); мутации идут через
 * `runWrite` (ADR 162d8e7a): события, журнал и аудит собирает обёртка.
 * Одиночная правка требует `expected_revision` (схема контракта) — несовпадение
 * даёт `VERSION_CONFLICT` (409), а не тихую перезапись чужой версии текста.
 */

import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { Comment } from '@etn/shared';

import type { McpRuntime } from '../context.js';
import {
  mcpWriteFx,
  openMemberNetwork,
  requireWritable,
  requireWriteBudget,
  runTool,
  runWrite,
  runWriteTool,
  showTrashFor,
} from '../context.js';
import { listTasksAsync } from '../../domain/heavy-read.js';
import {
  applyTaskMassCommand,
  applyTaskOps,
  type TaskMassInput,
  type TaskOpInput,
} from '../../domain/task-service.js';
import {
  McpTaskCancel,
  McpTaskCancelAll,
  McpTaskList,
  McpTaskMove,
  McpTaskMoveAll,
  McpTaskToggle,
} from '../../contracts.js';
import type { OpHandler } from './ops.js';

/** Компактная ссылка на новую ревизию источника (адрес для следующего действия). */
interface TaskRevisionRef {
  id: string;
  version: number;
}

function revisionRefs(comments: readonly Comment[]): TaskRevisionRef[] {
  return comments.map((comment) => ({ id: comment.id, version: comment.version }));
}

/**
 * События правки строк — штатное `comment.updated` источника (новый `body_md`
 * целиком): подписчики сравнивают с открытой панелью и показывают «Обновить».
 */
function commentUpdatedEvents(comments: readonly Comment[]): Array<{
  type: 'comment.updated';
  data: {
    id: string;
    owner_id: string;
    owner_type: Comment['owner_type'];
    kind: Comment['kind'];
    changes: { body_md: string };
    version: number;
  };
}> {
  return comments.map((comment) => ({
    type: 'comment.updated' as const,
    data: {
      id: comment.id,
      owner_id: comment.owner_id,
      owner_type: comment.owner_type,
      kind: comment.kind,
      changes: { body_md: comment.body_md },
      version: comment.version,
    },
  }));
}

/** Записи журнала активности: правка комментария-источника (паритет с REST). */
function commentActivity(comments: readonly Comment[]): Array<{
  kind: 'comment';
  action: 'updated';
  comment: Comment;
}> {
  return comments.map((comment) => ({
    kind: 'comment' as const,
    action: 'updated' as const,
    comment,
  }));
}

/**
 * Одиночная правка строки (toggle/move/cancel): одна операция, один источник,
 * одна транзакция. Ответ — как у `PATCH /tasks`, но ревизии в компактной форме
 * (`{id, version}`): агенту нужен адрес следующего действия, а не тело текста.
 */
function runLineAction(
  rt: McpRuntime,
  networkId: string,
  requestId: string | number | undefined,
  action: 'toggle' | 'move' | 'cancel',
  op: TaskOpInput,
): Promise<CallToolResult> {
  return runWriteTool(rt, networkId, () => {
    requireWritable(rt);
    requireWriteBudget(rt);
    const ndb = openMemberNetwork(rt, networkId);
    const fx = mcpWriteFx(rt, networkId, requestId);
    const result = runWrite(ndb, fx, () => {
      const outcome = applyTaskOps(ndb, [op], fx.userId);
      return {
        result: {
          results: outcome.results,
          revisions: revisionRefs(outcome.revisions),
        },
        events: commentUpdatedEvents(outcome.changed),
        activity: commentActivity(outcome.changed),
        audit: {
          action: `etn.tasks.${action}`,
          targetType: 'comment',
          targetId: op.comment_id,
          details: {
            line_no: op.line_no,
            expected_revision: op.expected_revision,
            ...(op.done !== undefined ? { done: op.done } : {}),
            ...(op.days !== undefined ? { days: op.days } : {}),
            ...(op.months !== undefined ? { months: op.months } : {}),
          },
        },
      };
    });
    return { ...result, request_id: String(requestId) };
  });
}

/**
 * Массовая команда по фильтру (cancelAll/moveAll) — домен `applyTaskMassCommand`
 * тот же, что у массовых `PATCH /tasks`. Деструктивность объявлена в реестре:
 * `etn.ops` требует `confirm: true` до вызова.
 */
function runMassCommand(
  rt: McpRuntime,
  networkId: string,
  requestId: string | number | undefined,
  action: 'cancelAll' | 'moveAll',
  command: TaskMassInput,
): Promise<CallToolResult> {
  return runWriteTool(rt, networkId, () => {
    requireWritable(rt);
    requireWriteBudget(rt);
    const ndb = openMemberNetwork(rt, networkId);
    const fx = mcpWriteFx(rt, networkId, requestId);
    const result = runWrite(ndb, fx, () => {
      const outcome = applyTaskMassCommand(ndb, command, fx.userId);
      return {
        result: {
          results: outcome.results,
          revisions: revisionRefs(outcome.revisions),
        },
        events: commentUpdatedEvents(outcome.changed),
        activity: commentActivity(outcome.changed),
        audit: {
          action: `etn.tasks.${action}`,
          targetType: 'network',
          targetId: networkId,
          details: {
            filter: command.filter,
            ...(command.days !== undefined ? { days: command.days } : {}),
            ...(command.months !== undefined ? { months: command.months } : {}),
            applied: outcome.results.filter((entry) => entry.ok).length,
          },
        },
      };
    });
    return { ...result, request_id: String(requestId) };
  });
}

/** Все шесть действий семейства `tasks.*`. */
export const TASK_OPS_HANDLERS: Record<string, OpHandler> = {
  'tasks.list': (rt, p) => {
    const a = p as unknown as z.infer<typeof McpTaskList.schema>;
    return runTool(async () => {
      const ndb = openMemberNetwork(rt, a.network_id);
      return listTasksAsync(ndb, {
        ...(a.scope !== undefined ? { scope: a.scope } : {}),
        ...(a.from !== undefined ? { from: a.from } : {}),
        ...(a.to !== undefined ? { to: a.to } : {}),
        ...(a.thought_id !== undefined ? { thoughtId: a.thought_id } : {}),
        ...(a.comment_id !== undefined ? { commentId: a.comment_id } : {}),
        ...(a.today !== undefined ? { today: a.today } : {}),
        ...(a.cursor !== undefined ? { cursor: a.cursor } : {}),
        ...(a.limit !== undefined ? { limit: a.limit } : {}),
        ...(a.count !== undefined ? { count: a.count } : {}),
        ...(a.include_nested !== undefined ? { includeNested: a.include_nested } : {}),
        // Содержимое корзины: явный параметр, иначе per-user настройка (пачка 11).
        showTrash: a.show_trash ?? showTrashFor(rt, a.network_id),
      });
    });
  },

  'tasks.toggle': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpTaskToggle.schema>;
    return runLineAction(rt, a.network_id, extra.requestId, 'toggle', {
      comment_id: a.comment_id,
      line_no: a.line_no,
      action: 'toggle',
      ...(a.done !== undefined ? { done: a.done } : {}),
      expected_revision: a.expected_revision,
    });
  },

  'tasks.move': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpTaskMove.schema>;
    return runLineAction(rt, a.network_id, extra.requestId, 'move', {
      comment_id: a.comment_id,
      line_no: a.line_no,
      action: 'move',
      ...(a.days !== undefined ? { days: a.days } : {}),
      ...(a.months !== undefined ? { months: a.months } : {}),
      expected_revision: a.expected_revision,
    });
  },

  'tasks.cancel': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpTaskCancel.schema>;
    return runLineAction(rt, a.network_id, extra.requestId, 'cancel', {
      comment_id: a.comment_id,
      line_no: a.line_no,
      action: 'cancel',
      expected_revision: a.expected_revision,
    });
  },

  'tasks.cancelAll': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpTaskCancelAll.schema>;
    return runMassCommand(rt, a.network_id, extra.requestId, 'cancelAll', {
      action: 'cancel-all',
      filter: {
        ...(a.filter.scope !== undefined ? { scope: a.filter.scope } : {}),
        ...(a.filter.from !== undefined ? { from: a.filter.from } : {}),
        ...(a.filter.to !== undefined ? { to: a.filter.to } : {}),
        ...(a.filter.thought_id !== undefined ? { thought_id: a.filter.thought_id } : {}),
        ...(a.filter.comment_id !== undefined ? { comment_id: a.filter.comment_id } : {}),
        ...(a.filter.today !== undefined ? { today: a.filter.today } : {}),
      },
    });
  },

  'tasks.moveAll': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpTaskMoveAll.schema>;
    return runMassCommand(rt, a.network_id, extra.requestId, 'moveAll', {
      action: 'move-all',
      filter: {
        ...(a.filter.scope !== undefined ? { scope: a.filter.scope } : {}),
        ...(a.filter.from !== undefined ? { from: a.filter.from } : {}),
        ...(a.filter.to !== undefined ? { to: a.filter.to } : {}),
        ...(a.filter.thought_id !== undefined ? { thought_id: a.filter.thought_id } : {}),
        ...(a.filter.comment_id !== undefined ? { comment_id: a.filter.comment_id } : {}),
        ...(a.filter.today !== undefined ? { today: a.filter.today } : {}),
      },
      ...(a.days !== undefined ? { days: a.days } : {}),
      ...(a.months !== undefined ? { months: a.months } : {}),
    });
  },
};
