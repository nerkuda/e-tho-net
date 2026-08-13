/**
 * SDK MCP-server construction (task F1, docs/05-mcp-server.md §1–2).
 *
 * Builds a `@modelcontextprotocol/sdk` {@link McpServer} with the full
 * catalogue registered: all `etn://` resources (F3), all `etn.*` tools (F4)
 * and the four prompt templates (F5). The SDK performs the `initialize`
 * handshake automatically and advertises `protocolVersion` and the server
 * capabilities; tools/resources/prompts are enumerated from the registrations.
 *
 * The returned server is transport-agnostic — the same instance kind is served
 * over stdio (`etn mcp`) and StreamableHTTP (`/mcp`) by the entry points in
 * `mcp/stdio.ts` / `mcp/http.ts`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { SERVER_VERSION } from '../version.js';
import { createRuntime, type McpRuntime } from './context.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerTools } from './tools.js';

/** Server identity announced in `initialize` (05 §9). */
export const MCP_SERVER_NAME = 'etn-mcp-server';

/** Usage guidance advertised to the client alongside the capability list. */
const MCP_INSTRUCTIONS =
  'ETN graph-of-thoughts MCP server. The agent acts as the user whose API key ' +
  'authenticated the session and can only touch networks that user belongs to. ' +
  'Before creating a thought, always call etn.thoughts.find_duplicates. ' +
  'Mutating tools emit real-time events to all network participants.';

/**
 * Assemble an SDK {@link McpServer} over the given runtime (deps + auth +
 * limits). Registration order is fixed: resources, tools, prompts.
 */
export function buildEtnMcpServer(rt: McpRuntime): McpServer {
  const mcp = new McpServer(
    { name: MCP_SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        resources: { listChanged: false },
        tools: { listChanged: false },
        prompts: { listChanged: false },
      },
      instructions: MCP_INSTRUCTIONS,
    },
  );
  registerResources(mcp, rt);
  registerTools(mcp, rt);
  registerPrompts(mcp, rt);
  return mcp;
}

/** Build the runtime (resolves L1 limits) and hand it to the SDK builder. */
export function createMcpServerFromRuntime(deps: Parameters<typeof createRuntime>[0]): McpServer {
  return buildEtnMcpServer(createRuntime(deps));
}
