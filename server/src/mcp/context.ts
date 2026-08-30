/**
 * MCP runtime context + shared helpers for tool/resource handlers.
 *
 * {@link McpRuntime} bundles the injected deps with the resolved limits and
 * the per-session write budget. The helpers here implement the three
 * cross-cutting rules of the MCP facade (docs/05-mcp-server.md):
 *   * every network-scoped call re-checks membership (`getMemberRole`) —
 *     the agent sees exactly the networks of its key's user (05 §2.1);
 *   * read-only keys are rejected on mutating tools (05 §6.3);
 *   * domain errors are surfaced as MCP tool errors with the canonical
 *     `ETN error [CODE]` text so the agent gets actionable messages.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  BASE_LAYER_ID,
  EtnError,
  type LayerEcho,
  type RealtimeEventMap,
  type RealtimeEventType,
} from '@etn/shared';

import { openNetworkDb, type NetworkDb } from '../db/network-db.js';
import { recordAudit } from '../auth/audit.js';
import { resolveSessionLayer } from '../domain/layer-service.js';
import { emitDomainEvent, type DomainEventActor } from '../realtime/emit.js';
import type { ResolvedMcpLimits } from './limits.js';
import { resolveMcpLimits, WriteRateLimiter } from './limits.js';
import type { McpDeps } from './types.js';

/** Everything a tool/resource handler needs during one MCP call. */
export interface McpRuntime {
  deps: McpDeps;
  /** Resolved operation limits (F6). */
  limits: ResolvedMcpLimits;
  /** Per-session sliding-window write budget (F6). */
  writes: WriteRateLimiter;
}

/** Build the runtime for a deps bundle (limits resolved once per server). */
export function createRuntime(deps: McpDeps): McpRuntime {
  const limits = resolveMcpLimits(deps.systemDb, deps.auth.maxWritesPerMinute);
  return { deps, limits, writes: new WriteRateLimiter(limits.maxWritesPerMinute) };
}

/**
 * Whether the authenticated principal may access this network: an explicit
 * `network_members` row, or a global system administrator, who holds
 * owner-equivalent access to every network regardless of membership
 * (06-auth.md §4.1, task 0.4.2 bug-fix). Single source of truth for every
 * network-scoped MCP tool/resource — mirrors the REST `requireNetworkMember`
 * guard in `auth/access-control.ts`.
 */
export function hasNetworkAccess(rt: McpRuntime, networkId: string): boolean {
  if (rt.deps.auth.isAdmin) {
    return true;
  }
  return rt.deps.systemDb.getMemberRole(rt.deps.auth.userId, networkId) !== null;
}

/** Throw `FORBIDDEN` unless {@link hasNetworkAccess} holds for this network. */
export function assertNetworkAccess(rt: McpRuntime, networkId: string): void {
  if (!hasNetworkAccess(rt, networkId)) {
    throw new EtnError(
      'FORBIDDEN',
      `You are not a member of network ${networkId}; this API key cannot access it.`,
      { network_id: networkId },
    );
  }
}

/**
 * Synthetic "client id" MCP sessions use for `session_layers` (task S10,
 * 13-layers.md §7.1). MCP has no per-installation `Client-Id` concept (05
 * §2.2 — an agent just passes `network_id` in every call), so the API key is
 * the closest thing to a stable channel identity: each key keeps its own
 * independently selected layer, the same way two REST clients with different
 * `Client-Id` headers never share one. Prefixed so it can never collide with
 * a real REST client UUID.
 */
export function mcpLayerClientId(rt: McpRuntime): string {
  return `mcp:${rt.deps.auth.keyId}`;
}

/**
 * Resolve the calling API key's current layer for `networkId` (task S10,
 * 13-layers.md §7.1) — the MCP counterpart of `routes/helpers.ts`'s
 * `resolveRequestLayer`, keyed by {@link mcpLayerClientId} instead of a REST
 * `Client-Id`. Always re-reads `session_layers`: unlike a REST request, one
 * {@link McpRuntime} outlives many tool calls, possibly against different
 * networks, so nothing is memoised on `rt` itself.
 */
export function resolveRuntimeLayer(rt: McpRuntime, networkId: string): LayerEcho {
  const base = openNetworkDb(rt.deps.dataDir, networkId, rt.deps.logger, BASE_LAYER_ID);
  return resolveSessionLayer(base, rt.deps.auth.userId, mcpLayerClientId(rt));
}

/**
 * Open the network's `data.db` **in the session's current layer** (task S10,
 * 13-layers.md §10.2), asserting the authenticated user has access first
 * ({@link assertNetworkAccess} — member or global admin). This is the default
 * open path used by every read/write tool, so layer-awareness is a property
 * of this one function rather than a change repeated at each call site —
 * matching the spec's "не отдельный набор инструментов, а сквозное свойство
 * существующих" (13-layers.md §10.2).
 */
export function openMemberNetwork(rt: McpRuntime, networkId: string): NetworkDb {
  assertNetworkAccess(rt, networkId);
  const layer = resolveRuntimeLayer(rt, networkId);
  return openNetworkDb(rt.deps.dataDir, networkId, rt.deps.logger, layer.id);
}

/**
 * Open the network's `data.db` **on the base layer** regardless of the
 * session's selection — for the layer-management tools themselves (`layers`
 * and `session_layers` are not branchable, 13-layers.md §3) and for merge,
 * which must replay physically into the target layer's own connection.
 * Mirrors `routes/helpers.ts`'s `openRouteNetworkDbBase`.
 */
export function openMemberNetworkBase(rt: McpRuntime, networkId: string): NetworkDb {
  assertNetworkAccess(rt, networkId);
  return openNetworkDb(rt.deps.dataDir, networkId, rt.deps.logger, BASE_LAYER_ID);
}

/** Reject mutating tools for read-only keys (05 §6.3). */
export function requireWritable(rt: McpRuntime): void {
  if (rt.deps.auth.readOnly) {
    throw new EtnError(
      'FORBIDDEN',
      'This API key is read-only: it can use resources and read tools, but not mutating tools.',
    );
  }
}

/** Consume one write-budget slot, raising `RATE_LIMITED` when exhausted (F6). */
export function requireWriteBudget(rt: McpRuntime): void {
  if (!rt.writes.tryConsume()) {
    throw new EtnError(
      'RATE_LIMITED',
      `MCP write limit exceeded: at most ${rt.limits.maxWritesPerMinute} writes per minute. ` +
        'Wait and retry.',
    );
  }
}

/** Real-time actor of MCP mutations: the key's user, no client id. */
export function actorOf(rt: McpRuntime): DomainEventActor {
  return { user_id: rt.deps.auth.userId, client_id: null };
}

/** Emit a domain event so agent-made changes fan out like human ones (05 §7). */
export function emitAgentEvent<E extends RealtimeEventType>(
  rt: McpRuntime,
  networkId: string,
  type: E,
  data: RealtimeEventMap[E],
  requestId?: string | number,
): void {
  emitDomainEvent(
    { systemDb: rt.deps.systemDb, pubsub: rt.deps.pubsub },
    networkId,
    type,
    data,
    actorOf(rt),
    {
      ...(requestId === undefined ? {} : { meta: { request_id: String(requestId) } }),
      // Task S10 (13-layers.md §10.2): tag the event with the calling key's
      // actual session layer, not a hardcoded base — visibility fan-out
      // (04-realtime.md §11) depends on it just like it does for REST writes.
      layerId: resolveRuntimeLayer(rt, networkId).id,
    },
  );
}

/**
 * Append an `audit_log` row for a mutating tool call (05 §6.1): category
 * `data`, action = tool name, details = call parameters. Failures never break
 * the tool result ({@link recordAudit} logs and swallows).
 */
export function auditAgentCall(
  rt: McpRuntime,
  tool: string,
  networkId: string | null,
  targetType: string | null,
  targetId: string | null,
  details: unknown,
): void {
  recordAudit(
    rt.deps.systemDb,
    {
      actorUserId: rt.deps.auth.userId,
      networkId,
      category: 'data',
      action: tool,
      targetType,
      targetId,
      details,
    },
    rt.deps.logger,
  );
}

/** Render any thrown value into the agent-facing text of a failed tool call. */
export function etnErrorText(err: unknown): string {
  if (err instanceof EtnError) {
    const details = err.details === undefined ? '' : `\nDetails: ${JSON.stringify(err.details)}`;
    return `ETN error [${err.code}]: ${err.message}${details}`;
  }
  return err instanceof Error
    ? `Unexpected error: ${err.message}`
    : `Unexpected error: ${String(err)}`;
}

/** Wrap a JSON value into an MCP tool result (pretty-printed for the agent). */
export function jsonToolResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** Wrap a plain-text document into an MCP tool result. */
export function textToolResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * Run a tool handler and convert any thrown {@link EtnError} (or unexpected
 * error) into an MCP error result carrying the canonical
 * `ETN error [CODE]: …` message instead of failing the JSON-RPC request.
 */
export async function runTool(fn: () => unknown | Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonToolResult(await fn());
  } catch (err) {
    return { content: [{ type: 'text', text: etnErrorText(err) }], isError: true };
  }
}

/** Add a `layer` echo field to one mutation result (object) or every element
 * of an array of them; anything else (there is none on MVP) passes through. */
function withLayerEcho(value: unknown, layer: LayerEcho): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => withLayerEcho(item, layer));
  }
  if (typeof value === 'object' && value !== null) {
    return { ...(value as Record<string, unknown>), layer };
  }
  return value;
}

/**
 * {@link runTool}, but for mutating tools: echoes the calling session's
 * current layer on the result — `layer: { id, title }` — matching the REST
 * `meta.layer` echo required by 13-layers.md §7.1 ("каждый ответ на запись…
 * обязан содержать эхо текущего слоя"). REST implements the same rule via a
 * single `onSend` hook (server.ts); MCP has no equivalent middleware stage,
 * so this wrapper is the one place every mutating tool funnels through.
 */
export async function runWriteTool(
  rt: McpRuntime,
  networkId: string,
  fn: () => unknown | Promise<unknown>,
): Promise<CallToolResult> {
  try {
    const result = await fn();
    const layer = resolveRuntimeLayer(rt, networkId);
    return jsonToolResult(withLayerEcho(result, layer));
  } catch (err) {
    return { content: [{ type: 'text', text: etnErrorText(err) }], isError: true };
  }
}
