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
 * Wrap every registered tool callback so that each call lands in the aggregate
 * telemetry table `mcp_tool_call_metrics` (task 940a499d, entity b05c48df) and,
 * when the caller passed a file journal, its name + duration land in that
 * journal too (task 1dd33e23 §3).
 *
 * The wrapper is the single shared registration seam: a newly registered tool
 * is counted automatically — there is no per-tool hook to forget. Rules
 * (entity b05c48df): every call counts, reads and writes, successes and
 * errors; read-only keys are counted the same; nothing goes to `audit_log`,
 * real-time or the write budget; arguments are never stored (only the tool
 * name, the `network_id` extracted from the parsed arguments, and the calling
 * key's id). A telemetry failure must never break the call itself — the
 * increment is fully guarded and only logs.
 *
 * The override is an untyped-through wrapper around the SDK's generic
 * `registerTool` — hence the single cast; arguments pass through untouched.
 */
function instrumentToolCalls(mcp: McpServer, rt: McpRuntime): void {
  const fileLog = rt.deps.fileLog;
  const recordMetric = (name: string, args: unknown, isError: boolean): void => {
    try {
      const networkId =
        typeof args === 'object' && args !== null && typeof (args as { network_id?: unknown }).network_id === 'string'
          ? (args as { network_id: string }).network_id
          : null;
      rt.deps.systemDb.recordToolCallMetric({
        toolName: name,
        networkId,
        apiKeyId: rt.deps.auth.keyId,
        isError,
        now: new Date().toISOString(),
      });
    } catch (err) {
      rt.deps.logger.warn({ err, tool: name }, 'mcp tool-call metric increment failed');
    }
  };
  type RegisterToolFn = McpServer['registerTool'];
  const original = mcp.registerTool.bind(mcp) as RegisterToolFn;
  const wrapped = ((name: string, config: Parameters<RegisterToolFn>[1], cb: never) => {
    const timedCb = async (...args: unknown[]) => {
      const startedAt = performance.now();
      try {
        const result = await (cb as unknown as (...a: unknown[]) => unknown)(...args);
        recordMetric(name, args[0], isToolErrorResult(result));
        return result;
      } catch (err) {
        recordMetric(name, args[0], true);
        throw err;
      } finally {
        fileLog?.mcpToolCall(name, performance.now() - startedAt);
      }
    };
    return (original as unknown as (n: string, c: unknown, f: unknown) => unknown)(
      name,
      config,
      timedCb,
    ) as ReturnType<RegisterToolFn>;
  }) as unknown as RegisterToolFn;
  mcp.registerTool = wrapped;
}

/** Whether a tool-callback result represents a failed call (`runTool` marks
 *  domain/schema errors with `isError: true`; a thrown error is handled by the
 *  wrapper's catch arm). */
function isToolErrorResult(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { isError?: unknown }).isError === true
  );
}

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
  instrumentToolCalls(mcp, rt);
  registerResources(mcp, rt);
  registerTools(mcp, rt);
  registerPrompts(mcp, rt);
  return mcp;
}

/** Build the runtime (resolves L1 limits) and hand it to the SDK builder. */
export function createMcpServerFromRuntime(deps: Parameters<typeof createRuntime>[0]): McpServer {
  return buildEtnMcpServer(createRuntime(deps));
}
