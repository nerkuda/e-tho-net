/**
 * MCP tools dispatcher (task F4, docs/05-mcp-server.md §4).
 *
 * Веха 7 версии 0.8.2 (ADR 8c93f03a): монолитная 'registerTools' (~6000
 * строк) разбита на модули по областям в каталоге 'tools/'. Каждый модуль
 * экспортирует функцию-регистратор; 'registerTools' вызывает их.
 *
 * 0.8.3 (задача 86ef2ff4, ADR b2eebf8b/8358eea9): редкие операции сняты из
 * постоянного набора и упакованы в 'etn.guide' + 'etn.ops' (tools/ops.ts,
 * реестр — tools/ops-catalog.ts). Их модули удалены или урезаны; новые два
 * инструмента регистрируются первыми, чтобы ссылка гайда на исполнитель была
 * видна сразу.
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
import { registerNetworksReadTools } from './tools/networks.js';
import { registerFindDuplicatesTool, registerThoughtsReadTools } from './tools/thoughts-read.js';
import { registerCommentsGetTool, registerCommentsWriteTools } from './tools/comments.js';
import { registerTypesListTool } from './tools/types.js';
import { registerViewsRunTool } from './tools/views.js';
import { registerLayersReadTools, registerLayersWriteTools } from './tools/layers.js';
import { registerChronicleQueryTool } from './tools/chronicle.js';
import { registerThoughtsWriteTools } from './tools/thoughts-write.js';
import { registerPropertiesTools } from './tools/properties.js';
import { registerBundleTools } from './tools/bundles.js';
import { registerActivityTools } from './tools/activity.js';
import { registerInstructionsTool } from './tools/instructions.js';
import { registerOntologyTools } from './tools/ontology.js';
import { registerGuideTools } from './tools/ops.js';

/**
 * Register all 'etn.*' tools on a freshly built {@link McpServer}.
 * Вызовы идут в порядке, сохраняющем привычную группировку витрины.
 */
export function registerTools(mcp: McpServer, rt: McpRuntime): void {
  registerGuideTools(mcp, rt);
  registerNetworksReadTools(mcp, rt);
  registerThoughtsReadTools(mcp, rt);
  registerCommentsGetTool(mcp, rt);
  registerTypesListTool(mcp, rt);
  registerViewsRunTool(mcp, rt);
  registerLayersReadTools(mcp, rt);
  registerChronicleQueryTool(mcp, rt);
  registerLayersWriteTools(mcp, rt);
  registerThoughtsWriteTools(mcp, rt);
  registerCommentsWriteTools(mcp, rt);
  registerPropertiesTools(mcp, rt);
  registerBundleTools(mcp, rt);
  registerFindDuplicatesTool(mcp, rt);
  registerActivityTools(mcp, rt);
  registerInstructionsTool(mcp, rt);
  registerOntologyTools(mcp, rt);
  // 0.11.1 (задача 094653b6): публикации и полки свёрнуты в `etn.guide` +
  // `etn.ops` (ADR b2eebf8b/8358eea9); их обработчики — в tools/publications.ts,
  // регистраций собственных инструментов больше нет.
}
