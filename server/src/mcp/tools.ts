/**
 * MCP tools dispatcher (task F4, docs/05-mcp-server.md §4).
 *
 * Веха 7 версии 0.8.2 (ADR 8c93f03a): монолитная 'registerTools' (~6000
 * строк) разбита на модули по областям в каталоге 'tools/'. Каждый модуль
 * экспортирует функцию-регистратор; 'registerTools' вызывает их в прежнем
 * порядке, так что состав и порядок инструментов в 'tools/list' не
 * изменились. Общие z-схемы и резолверы — 'tools/shared.ts'.
 *
 * Mutating tools are facades over the **same domain services as REST**
 * (05 §7): membership is re-checked per call, the read-only flag and the
 * per-minute write budget are enforced, each successful write emits its
 * catalogue real-time event and appends an 'activity_log' row plus an
 * 'audit_log' row — so agent-made changes fan out to network participants
 * exactly like human ones.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { McpRuntime } from './context.js';
import { registerNetworksReadTools, registerNetworksWriteTools } from './tools/networks.js';
import { registerFindDuplicatesTool, registerThoughtsReadTools } from './tools/thoughts-read.js';
import { registerTrashListTool, registerTrashPurgeTool } from './tools/trash.js';
import { registerCommentsGetTool, registerCommentsWriteTools } from './tools/comments.js';
import { registerExportTool } from './tools/export.js';
import { registerTypesListTool } from './tools/types.js';
import { registerViewsRunTool } from './tools/views.js';
import { registerChangesListTool } from './tools/changes.js';
import { registerMetricsTools } from './tools/metrics.js';
import { registerLayersReadTools, registerLayersWriteTools } from './tools/layers.js';
import { registerChronicleQueryTool } from './tools/chronicle.js';
import { registerMembersListTool } from './tools/members.js';
import { registerThoughtsWriteTools } from './tools/thoughts-write.js';
import { registerAttachmentsTools } from './tools/attachments.js';
import { registerPropertiesTools, registerUsageClearTool } from './tools/properties.js';
import { registerBundleTools } from './tools/bundles.js';
import { registerLocksTools } from './tools/locks.js';
import { registerActivityTools } from './tools/activity.js';
import { registerInstructionsTool } from './tools/instructions.js';
import { registerOntologyTools } from './tools/ontology.js';
import { registerTransferTools } from './tools/transfer.js';

/**
 * Register all 'etn.*' tools on a freshly built {@link McpServer}.
 * Вызовы идут в том же порядке, что и в монолите до вехи 7.
 */
export function registerTools(mcp: McpServer, rt: McpRuntime): void {
  registerNetworksReadTools(mcp, rt);
  registerThoughtsReadTools(mcp, rt);
  registerTrashListTool(mcp, rt);
  registerCommentsGetTool(mcp, rt);
  registerExportTool(mcp, rt);
  registerTypesListTool(mcp, rt);
  registerViewsRunTool(mcp, rt);
  registerChangesListTool(mcp, rt);
  registerMetricsTools(mcp, rt);
  registerLayersReadTools(mcp, rt);
  registerChronicleQueryTool(mcp, rt);
  registerMembersListTool(mcp, rt);
  registerLayersWriteTools(mcp, rt);
  registerThoughtsWriteTools(mcp, rt);
  registerCommentsWriteTools(mcp, rt);
  registerAttachmentsTools(mcp, rt);
  registerPropertiesTools(mcp, rt);
  registerBundleTools(mcp, rt);
  registerTrashPurgeTool(mcp, rt);
  registerUsageClearTool(mcp, rt);
  registerLocksTools(mcp, rt);
  registerFindDuplicatesTool(mcp, rt);
  registerActivityTools(mcp, rt);
  registerNetworksWriteTools(mcp, rt);
  registerInstructionsTool(mcp, rt);
  registerOntologyTools(mcp, rt);
  registerTransferTools(mcp, rt);
}
