/**
 * networks.ts — MCP-инструмент «etn.networks.structure».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2).
 *
 * 0.8.3 (задача 86ef2ff4): `networks.list`/`networks.write`/`networks.delete`
 * сняты из постоянного набора и упакованы в `etn.ops` (tools/ops.ts). Здесь
 * остаётся частый `etn.networks.structure`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';

import { NetworksStructure } from '../../contracts.js';
import { EtnError, MCP_TOOL_ANNOTATIONS, STRUCTURE_SECTION_PREVIEW_CHARS } from '@etn/shared';
import { getPermanentPreview } from '../../domain/comment-service.js';
import { createBodyExpander } from '../../domain/transclusion-service.js';
import { getPropertyValuesResolved } from '../../domain/property-service.js';

import { getThoughtMeta } from '../../domain/thought-meta.js';
import { recordReads } from '../../domain/read-metrics-service.js';
import { thoughtTypeCatalog, withSanitizedIcon } from '../catalogs.js';
import { projectTypeRow, projectTypeRows, stripStructuralLinkProperties } from '../../domain/response-projection.js';
import { getThoughtType } from '../../domain/thought-type-service.js';
import { assertNetworkAccess, openMemberNetwork, runTool } from '../context.js';
import { listTocSections } from '../../domain/network-structure-service.js';

export function registerNetworksReadTools(mcp: McpServer, rt: McpRuntime): void {
  // `etn.networks.list` (0.8.3, задача 86ef2ff4) снят из постоянного набора —
  // упакован в `etn.ops { action: "networks.list" }`; `etn.networks.write` и
  // `etn.networks.delete` — там же. Здесь остаётся частый
  // `etn.networks.structure`.
  //
  // etn.networks.structure — O5 read tool. Returns the active thoughts of the
  // network's `table_of_contents` role (task ba024a45 / 0.7.2, ADR 46d17a91 —
  // the legacy `node_section_type_id` column was replaced by `type_roles`).
  // Each section is enriched with a permanent-comment preview, property
  // values, neighbour counts and `deletion_blocks` (задача cfc55b01; прежний
  // `usage_count`, N3) — the same shape agents
  // already know from `etn.thoughts.get` / `etn.thoughts.usage`, so an agent
  // can dive from a structure node straight into a full read.
  //
  // Bug fix (self-description reachability): §3/§4 of docs/05-mcp-server.md
  // describe FOUR markdown self-description fields (`description`,
  // `when_to_use`, `conventions`, `examples`), read via `GET /networks/{id}`
  // or the `etn://networks/{id}` resource. Neither exists as an MCP tool
  // (there is no `etn.networks.get`, and the ZCode MCP client does not expose
  // resources to the agent at all), so `conventions`/`examples` were
  // write-only from the agent's point of view. `etn.networks.structure` is
  // already the tool an agent calls first when orienting in a network. Both
  // `conventions` and `examples` stay OUT of the default payload — they are
  // long, and most orientation flows don't need them; each is returned only
  // when the caller opts in (`include_conventions` / `include_examples`).
  // Требование «networks.structure отдаёт худой перечень разделов» (0.8.3)
  // перевело `conventions` из always-on в опциональный параметр.
  //
  // The response also carries the full `type_roles` dictionary and a
  // conditional `instructions_ref` hint when the network has set the
  // `instructions` role (ADR 717f04df «инструкции-витриной» — agents are
  // told to call `etn.instructions` to read the network's prompt instructions).
  mcp.registerTool(
    'etn.networks.structure',
    {
      title: 'Структура сети',
      description:
        'Read the structure declared via `type_roles.table_of_contents`: active thoughts of that type ' +
        'with permanent-comment previews (600 chars, `truncated`+`comment_id` → `etn.comments.get`), ' +
        'property values (structural link properties «Родители»/«Потомки» are summarized by `counters` ' +
        'and not repeated), neighbour counters (`deletion_blocks` too), `thought_types`. ' +
        '`include_conventions: true` adds ' +
        '`conventions` (off by default); `include_examples: true` adds `examples`. Carries `type_roles` and ' +
        '`instructions_ref` when the `instructions` role is set. ' +
        '`has_structure: false` → empty `sections`, fall back to search/query.',
      inputSchema: NetworksStructure.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.networks.structure'],
    },
    (args) =>
      runTool(async () => {
        const network = rt.deps.systemDb.getNetworkById(args.network_id);
        if (network === null) {
          throw new EtnError('NOT_FOUND', `Network ${args.network_id} not found.`);
        }
        // Access re-check mirrors `openMemberNetwork` (here we only need a
        // single read, so we do not need the ndb unless the network has a
        // structure marker); member or global admin (06-auth.md §4.1).
        assertNetworkAccess(rt, args.network_id);
        const examplesField =
          args.include_examples === true ? { examples: network.examples } : {};
        // Требование «networks.structure отдаёт худой перечень разделов»:
        // `conventions` вынесены в опциональный параметр — по умолчанию не
        // включаются (полный вход в сеть — явным запросом).
        const conventionsField =
          args.include_conventions === true ? { conventions: network.conventions } : {};
        const sectionTypeId =
          typeof network.type_roles.table_of_contents === 'string'
            ? network.type_roles.table_of_contents
            : null;
        // Convention tail: tell the agent where to read the network's instructions.
        // Only present when the network actually set the role — empty `type_roles`
        // must NOT advertise `etn.instructions` (would just return an empty list).
        const instructionsField =
          typeof network.type_roles.instructions === 'string'
            ? {
                instructions_ref:
                  'Эта сеть публикует инструкции для агентов. Прочитайте их через ' +
                  '`etn.instructions { network_id: ' +
                  args.network_id +
                  ' }` перед первым изменением.',
              }
            : {};
        if (sectionTypeId === null) {
          return {
            network_id: args.network_id,
            has_structure: false as const,
            type_roles: network.type_roles,
            ...conventionsField,
            ...instructionsField,
            ...examplesField,
            sections: [],
            thought_types: [],
          };
        }
        // Слой сессии (ошибка 3f535ae8): разделы оглавления читаются тем же
        // контекстом, что и остальные инструменты — правки слоя видны в слое.
        const ndb = openMemberNetwork(rt, args.network_id);
        const rows = listTocSections(ndb, sectionTypeId);

        // Задача 7849008a, требование 6d4ad9ac: фильтр прав для
        // `cross_network_ref` строится один раз для всего обхода `sections`.
        const accessibleNetworkIds = new Set(
          rt.deps.systemDb.listNetworksForUser(rt.deps.auth.userId).map((n) => n.id),
        );

        const sections = projectTypeRows(
          rows.map((row) => {
            const meta = getThoughtMeta(ndb, row.id);
            const permanent = getPermanentPreview(
              ndb,
              'thought',
              row.id,
              STRUCTURE_SECTION_PREVIEW_CHARS,
              // MCP-выдача структуры отдаёт превью с развёрнутыми трансклюзиями
              // (ТП2, задача bcfc7eb7).
              createBodyExpander(ndb),
            );
            const properties = getPropertyValuesResolved(ndb, 'thought', row.id, accessibleNetworkIds);
            return {
              id: row.id,
              title: row.title,
              type_id: row.type_id,
              created_at: row.created_at,
              updated_at: row.updated_at,
              counters: {
                parents_count: meta.parents_count,
                children_count: meta.children_count,
                attachments_count: meta.attachments_count,
                // Блокировки удаления (задача cfc55b01): счётчик blocking-only,
                // тот же источник, что и `meta.deletion_blocks` карточки. До
                // правки здесь стояло `findThoughtUsage().total` — после
                // c0a2a2e6 это все рёбра свойств-связей, то есть имя «usage» (и
                // сама семантика) разошлись с карточкой; теперь единообразно.
                deletion_blocks: meta.deletion_blocks,
              },
              permanent,
              properties,
            };
          }),
        ).map(stripStructuralLinkProperties);

        // O10: count every section the agent looked at while reading the
        // network's structure. `table_of_contents` rows are typically a
        // handful, so this is a tiny batch — kept here for completeness so
        // the owner can see "the agent loaded these sections N times".
        recordReads(ndb, sections.map((s) => s.id), { now: new Date().toISOString() });

        // Reference table: the network's section type plus every other type
        // referenced by the section nodes (caller can dive further without an
        // extra `etn.types.list` round trip).
        // Bug fix (§5.1e): sanitize the section type's own icon — the
        // `thought_types` catalogue below is already sanitized via
        // `thoughtTypeCatalog`, but `node_section_type` is the raw type record.
        const rawSectionType = getThoughtType(ndb, sectionTypeId);
        // Единый сериализатор списочных записей (projection.ts): запись типа
        // теряет визуальные/сервисные поля, но сохраняет `is_root`/`parent_id`
        // (иерархия типов L21) и `icon`.
        const sectionType = rawSectionType === null ? null : projectTypeRow(withSanitizedIcon(rawSectionType));
        const referencedTypeIds = Array.from(
          new Set(
            sections
              .map((s) => s.type_id)
              .filter((tid): tid is string => typeof tid === 'string'),
          ),
        );
        const thoughtTypes = thoughtTypeCatalog(ndb, [
          sectionTypeId,
          ...referencedTypeIds.filter((tid) => tid !== sectionTypeId),
        ]);

        return {
          network_id: args.network_id,
          has_structure: true as const,
          type_roles: network.type_roles,
          node_section_type: sectionType,
          ...conventionsField,
          ...instructionsField,
          ...examplesField,
          sections,
          thought_types: thoughtTypes,
        };
      }),
  );
}
