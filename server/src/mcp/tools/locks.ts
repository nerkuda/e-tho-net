/**
 * locks.ts — MCP-инструменты области «registerLocksTools».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import { z } from 'zod';
import { MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import type { EditAcquiredData, EditReleasedData } from '@etn/shared';
import {
  acquireLock,
  clearLocksForUser,
  listLocks,
  releaseLock,
} from '../../domain/lock-service.js';
import { LocksAcquire, LocksClear, LocksList, LocksRelease } from '../../contracts.js';
import type { LockRow } from '../../domain/lock-service.js';
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

export function registerLocksTools(mcp: McpServer, rt: McpRuntime): void {
  const LocksAcquireSchema = z.object({
    network_id: NetworkId,
    entity_type: z.string().min(1),
    entity_id: z.string().min(1),
  });
  mcp.registerTool(
    'etn.locks.acquire',
    {
      title: 'Захватить объект',
      description:
        'Acquire (or refresh) the lock on `(entity_type, entity_id)` for the calling user. Idempotent for ' +
        'the same user — a repeated acquire updates `client_id` / `acquired_at_ms` and returns the existing ' +
        'row. A different holder is rejected with `LOCKED` carrying the holder coordinates in ' +
        '`details.holder`. Returns the canonical `LockRow`.',
      inputSchema: LocksAcquire.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.locks.acquire'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const lock = runWrite(ndb, fx, () => {
          const acquired = acquireLock(ndb, {
            entityType: args.entity_type,
            entityId: args.entity_id,
            userId: rt.deps.auth.userId,
            clientId: null, // MCP-сессия не несёт Client-Id — соответствует REST-вызову без заголовка.
          });
          const data: EditAcquiredData = {
            entity_type: acquired.entity_type,
            entity_id: acquired.entity_id,
            lock_id: acquired.id,
            user_id: acquired.user_id,
            client_id: acquired.client_id,
            acquired_at_ms: acquired.acquired_at_ms,
          };
          return {
            result: acquired,
            events: [{ type: 'edit.acquired', data }],
            audit: {
              action: 'etn.locks.acquire',
              targetType: acquired.entity_type,
              targetId: acquired.entity_id,
              details: { lock_id: acquired.id },
            },
          };
        });
        return {
          ...lock,
          request_id: String(extra.requestId),
        } satisfies LockRow & { request_id: string };
      }),
  );

  const LocksReleaseSchema = z.object({
    network_id: NetworkId,
    lock_id: z.string().min(1),
  });
  mcp.registerTool(
    'etn.locks.release',
    {
      title: 'Снять свой захват',
      description:
        'Release the lock with id `lock_id` for the calling user. Only the holder may release — anyone ' +
        'else gets `FORBIDDEN`; an unknown lock id is `LOCK_NOT_FOUND`. Returns `{ released: true }`.',
      inputSchema: LocksRelease.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.locks.release'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const released = runWrite(ndb, fx, () => {
          const dropped = releaseLock(ndb, args.lock_id, rt.deps.auth.userId);
          const data: EditReleasedData = {
            entity_type: dropped.entity_type,
            entity_id: dropped.entity_id,
            lock_id: dropped.id,
            user_id: dropped.user_id,
            client_id: dropped.client_id,
          };
          return {
            result: dropped,
            events: [{ type: 'edit.released', data }],
            audit: {
              action: 'etn.locks.release',
              targetType: dropped.entity_type,
              targetId: dropped.entity_id,
              details: { lock_id: dropped.id },
            },
          };
        });
        return {
          released: true as const,
          lock_id: released.id,
          request_id: String(extra.requestId),
        };
      }),
  );

  const LocksClearSchema = z.object({
    network_id: NetworkId,
    user_id: z.string().min(1),
  });
  mcp.registerTool(
    'etn.locks.clear',
    {
      title: 'Снять все захваты участника',
      description:
        'Remove every lock held by `user_id` in the network — any network member may invoke this for any ' +
        'other member (равноправие). Returns `{ cleared: number }`.',
      inputSchema: LocksClear.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.locks.clear'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const removed = runWrite(ndb, fx, () => {
          const cleared = clearLocksForUser(ndb, args.user_id);
          return {
            result: cleared,
            events: cleared.map((lock) => ({
              type: 'edit.cleared' as const,
              data: {
                entity_type: lock.entity_type,
                entity_id: lock.entity_id,
                lock_id: lock.id,
                user_id: lock.user_id,
                client_id: lock.client_id,
                reason: 'manual' as const,
              },
            })),
            audit: {
              action: 'etn.locks.clear',
              targetType: 'network',
              targetId: args.network_id,
              details: { user_id: args.user_id, cleared: cleared.length },
            },
          };
        });
        return {
          cleared: removed.length,
          request_id: String(extra.requestId),
        };
      }),
  );

  const LocksListSchema = z.object({
    network_id: NetworkId,
    user_id: z.string().min(1).nullable().optional(),
    client_id: z.string().min(1).nullable().optional(),
  });
  mcp.registerTool(
    'etn.locks.list',
    {
      title: 'Активные захваты сети',
      description:
        'List active locks in the network, optionally filtered by `user_id` and/or `client_id` (a single ' +
        'value each; `null` or omitted removes the constraint). Returns the same ' +
        '`{ data: LockRow[], meta: { total, offset, limit } }` envelope as `GET /locks`.',
      inputSchema: LocksList.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.locks.list'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const locks = listLocks(ndb, {
          userId: args.user_id === undefined ? undefined : args.user_id,
          clientId: args.client_id === undefined ? undefined : args.client_id,
        });
        return {
          data: locks,
          meta: {
            total: locks.length,
            offset: 0,
            limit: locks.length,
          },
        };
      }),
  );

  // =========================================================================
  // Deduplication (§4.3)
  // =========================================================================
}
