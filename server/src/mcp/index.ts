/**
 * MCP facade — public entry point (tasks F1–F6, docs/05-mcp-server.md).
 *
 * {@link createMcpServer} is the factory used by both transports:
 *   * stdio (`etn mcp` CLI command, `mcp/stdio.ts`) — for local agents;
 *   * StreamableHTTP (`GET|POST /mcp`, `mcp/http.ts`) — for remote agents,
 *     mounted on the Fastify server when `ETN_MCP_ENABLED=1`.
 *
 * The factory only assembles dependencies: it resolves the L1 limits from
 * `_system.db.settings` (F6) and delegates SDK construction to
 * {@link buildEtnMcpServer}. All domain logic is shared with REST.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createRuntime } from './context.js';
import { buildEtnMcpServer } from './server.js';
import type { McpDeps } from './types.js';

export { createApiKeyAuthProvider } from './auth.js';
export { createMcpHttpEndpoint, handleMcpNodeRequest, MCP_SESSION_IDLE_TTL_MS } from './http.js';
export type { McpHttpEndpoint, McpHttpOutcome } from './http.js';
export { runStdioMcp } from './stdio.js';
export { resolveMcpLimits, WriteRateLimiter } from './limits.js';
export type { ResolvedMcpLimits } from './limits.js';
export type { McpAuthContext, McpAuthProvider, McpBaseDeps, McpDeps } from './types.js';

/**
 * Create one MCP SDK server acting on behalf of `deps.auth`.
 *
 * @param deps - systemDb, dataDir, pubsub, authProvider (key resolution),
 *   the resolved {@link McpAuthContext} and the logger.
 * @returns a transport-agnostic {@link McpServer} with all `etn://` resources,
 *   `etn.*` tools and prompt templates registered.
 */
export function createMcpServer(deps: McpDeps): McpServer {
  return buildEtnMcpServer(createRuntime(deps));
}
