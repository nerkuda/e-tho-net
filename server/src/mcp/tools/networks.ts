/**
 * networks.ts — MCP-инструменты области «registerNetworksReadTools, registerNetworksWriteTools».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';

import { NetworksDelete, NetworksStructure, NetworksWrite } from '../../contracts.js';
import { EtnError, MCP_TOOL_ANNOTATIONS, validateTypeRoles } from '@etn/shared';
import type { Network } from '@etn/shared';
import { getPermanentPreview } from '../../domain/comment-service.js';
import { findThoughtUsage, getPropertyValuesResolved } from '../../domain/property-service.js';
import { emitDomainEvent } from '../../realtime/emit.js';

import { getThoughtMeta } from '../../domain/thought-meta.js';
import { recordReads } from '../../domain/read-metrics-service.js';
import { thoughtTypeCatalog, withSanitizedIcon } from '../catalogs.js';
import { projectTypeRow, projectTypeRows } from '../projection.js';
import { getThoughtType } from '../../domain/thought-type-service.js';
import { assertNetworkAccess, auditAgentCall, openMemberNetwork, requireWritable, requireWriteBudget, runTool, runWriteTool } from '../context.js';
import { updateNetwork } from '../../domain/network-write-service.js';
import { listTocSections } from '../../domain/network-structure-service.js';

export function registerNetworksReadTools(mcp: McpServer, rt: McpRuntime): void {
  mcp.registerTool(
    'etn.networks.list',
    {
      title: 'Список сетей',
      description:
        "List every network the API key's user belongs to, with role and member counts, plus the network's " +
        '`description` and `when_to_use` fields. `has_structure: true` — the network exposes its machine-readable ' +
        'structure via `etn.networks.structure`. The agent may only operate on networks returned here.',
      annotations: MCP_TOOL_ANNOTATIONS['etn.networks.list'],
    },
    () =>
      runTool(async () => {
        return rt.deps.systemDb.listNetworksForUser(rt.deps.auth.userId);
      }),
  );

  // etn.networks.structure — O5 read tool. Returns the active thoughts of the
  // network's `table_of_contents` role (task ba024a45 / 0.7.2, ADR 46d17a91 —
  // the legacy `node_section_type_id` column was replaced by `type_roles`).
  // Each section is enriched with a permanent-comment preview, property
  // values, neighbour counts and a usage_count (N3) — the same shape agents
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
  // already the tool an agent calls first when orienting in a network, so we
  // piggy-back `conventions` on its response — no extra round trip. `examples`
  // stays out of the default payload (worked examples tend to be long, and
  // most orientation flows don't need them): it is returned only when the
  // caller opts in via `include_examples`, mirroring the "explicit request"
  // resolution the bug report itself proposed for that field.
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
        'with permanent-comment previews (2000 chars, `truncated`+`comment_id` → `etn.comments.get`), ' +
        'property values, neighbour counters, `thought_types`. Carries `conventions`, `type_roles` and ' +
        '`instructions_ref` when the `instructions` role is set. `include_examples: true` adds `examples`. ' +
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
            conventions: network.conventions,
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
            const permanent = getPermanentPreview(ndb, 'thought', row.id);
            const properties = getPropertyValuesResolved(ndb, 'thought', row.id, accessibleNetworkIds);
            const usage = findThoughtUsage(ndb, row.id);
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
                usage_count: usage.total,
              },
              permanent,
              properties,
            };
          }),
        );

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
          conventions: network.conventions,
          ...instructionsField,
          ...examplesField,
          sections,
          thought_types: thoughtTypes,
        };
      }),
  );

}

export function registerNetworksWriteTools(mcp: McpServer, rt: McpRuntime): void {
  mcp.registerTool(
    'etn.networks.write',
    {
      title: 'Создать или обновить сеть',
      description:
        'Upsert: omit `network_id` to create (caller → owner); pass `network_id` to patch (owner/admin). ' +
        'Editable: `display_name`, `description`, `when_to_use`, `conventions`, `examples`, `type_roles`. ' +
        'Unknown role keys / stale `type_id` → `VALIDATION_ERROR`. Returns the network card.',
      inputSchema: NetworksWrite.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.networks.write'],
    },
    (args, extra) => {
      // `runWriteTool` resolves the session layer through `openNetworkDb`,
      // which would fail on a brand-new network (the directory exists but
      // no row in `_system.db`'s `networks` yet — the layer walker would
      // succeed only after `createNetwork` returns). The clean split is:
      //  * create path → `runTool` (read wrapper, no layer echo);
      //  * patch path  → `runWriteTool` (echoes the existing layer).
      const op = async () => {
        requireWritable(rt);
        requireWriteBudget(rt);

        // 1. Validate `type_roles` shape (unknown role keys) before any I/O.
        const requestedRoles =
          args.type_roles !== undefined ? validateTypeRoles(args.type_roles) : undefined;

        let network: Network;
        if (args.network_id === undefined) {
          // ---- CREATE ---------------------------------------------------
          // Every authenticated principal may create a network (no admin
          // gate); the caller becomes the owner of the new network.
          const displayName = (args.display_name ?? '').trim();
          if (displayName.length === 0) {
            throw new EtnError(
              'VALIDATION_ERROR',
              'display_name обязательно при создании сети.',
              { field: 'display_name' },
            );
          }
          const description =
            args.description === undefined
              ? null
              : typeof args.description === 'string' && args.description === ''
                ? null
                : (args.description ?? null);
          // The service validates that every non-null type id exists in the
          // freshly created data.db. At create time the new network has no
          // thought types yet, so any non-null id here is doomed — we
          // surface that as `VALIDATION_ERROR` instead of letting the
          // service reject it with a less informative message.
          for (const [role, value] of Object.entries(requestedRoles ?? {}) as Array<
            [string, string | null]
          >) {
            if (value !== null) {
              throw new EtnError(
                'VALIDATION_ERROR',
                `На создании сети нельзя указывать непустую роль type_roles.${role}: в новой сети ещё нет типов.`,
                { field: `type_roles.${role}`, value },
              );
            }
          }
          network = await rt.deps.networkService.createNetwork(
            rt.deps.auth.userId,
            displayName,
            description,
            requestedRoles ?? {},
          );
          rt.deps.systemDb.insertAuditLog({
            actorUserId: rt.deps.auth.userId,
            networkId: network.id,
            category: 'network',
            action: 'network.create',
            targetType: 'network',
            targetId: network.id,
            details: {
              display_name: displayName,
              type_roles: requestedRoles ?? {},
              via: 'mcp.etn.networks.write',
            },
          });
        } else {
          // ---- PATCH ----------------------------------------------------
          const networkId = args.network_id;
          const existing = rt.deps.systemDb.getNetworkById(networkId);
          if (existing === null) {
            throw new EtnError('NOT_FOUND', `Сеть ${networkId} не найдена.`, {
              network_id: networkId,
            });
          }
          // Authz: network owner OR global admin (06-auth.md §4.1).
          const role = rt.deps.systemDb.getMemberRole(rt.deps.auth.userId, networkId);
          if (!rt.deps.auth.isAdmin && role !== 'owner') {
            throw new EtnError(
              'FORBIDDEN',
              'Требуются права владельца сети или администратора.',
              { network_id: networkId },
            );
          }
          // Единая доменная реализация патча (ADR 8c93f03a): мерж полей,
          // валидация type_roles, запись, audit_log и список изменений.
          const { network: updated, changes } = updateNetwork(
            rt.deps.systemDb,
            rt.deps.networkService,
            existing,
            {
              ...(args.display_name !== undefined ? { display_name: args.display_name } : {}),
              ...(args.description !== undefined ? { description: args.description } : {}),
              ...(args.when_to_use !== undefined ? { when_to_use: args.when_to_use } : {}),
              ...(args.conventions !== undefined ? { conventions: args.conventions } : {}),
              ...(args.examples !== undefined ? { examples: args.examples } : {}),
              ...(requestedRoles !== undefined ? { type_roles: requestedRoles } : {}),
            },
            { userId: rt.deps.auth.userId, via: 'mcp.etn.networks.write' },
          );
          // Real-time: broadcast only the changed fields so subscribers
          // can merge in place (matches REST PATCH /networks/{id}).
          if (Object.keys(changes).length > 0) {
            emitDomainEvent(
              { systemDb: rt.deps.systemDb, pubsub: rt.deps.pubsub },
              networkId,
              'network.updated',
              changes,
              {
                user_id: rt.deps.auth.userId,
                client_id: rt.deps.auth.keyId,
              },
              { meta: { request_id: String(extra.requestId) } },
            );
          }
          network = updated;
        }
        auditAgentCall(
          rt,
          'etn.networks.write',
          network.id,
          'network',
          network.id,
          {
            created: args.network_id === undefined,
            type_roles_keys: Object.keys(requestedRoles ?? {}),
          },
        );
        return {
          id: network.id,
          display_name: network.display_name,
          owner_id: network.owner_id,
          description: network.description,
          when_to_use: network.when_to_use,
          conventions: network.conventions,
          examples: network.examples,
          type_roles: network.type_roles,
          has_structure: typeof network.type_roles.table_of_contents === 'string',
          created_at: network.created_at,
          updated_at: network.updated_at,
          request_id: String(extra.requestId),
        };
      };
      return args.network_id === undefined
        ? runTool(op)
        : runWriteTool(rt, args.network_id, op);
    },
  );

  // ---------------------------------------------------------------------------
  // этон.networks.delete — destructive; admin only; дополнительно требует
  // `confirm: true` (как для человека).
  // ---------------------------------------------------------------------------
  mcp.registerTool(
    'etn.networks.delete',
    {
      title: 'Удалить сеть',
      description:
        'Destructive: remove a network and its `data.db`. Admin only. Requires `confirm: true`. ' +
        'Returns `{ deleted, network_id, request_id }`.',
      inputSchema: NetworksDelete.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.networks.delete'],
    },
    (args, extra) =>
      runTool(async () => {
        // The doomed network's `data.db` is about to vanish, so we bypass
        // `runWriteTool` (which would re-open the base layer for the layer
        // echo and resurrect the directory through `mkdirSync`). Mutating
        // tools still must observe the read-only + write-budget gates —
        // apply them by hand.
        requireWritable(rt);
        requireWriteBudget(rt);
        if (!rt.deps.auth.isAdmin) {
          throw new EtnError(
            'FORBIDDEN',
            'Удаление сети доступно только администратору сервера.',
            { network_id: args.network_id },
          );
        }
        const existing = rt.deps.systemDb.getNetworkById(args.network_id);
        if (existing === null) {
          throw new EtnError('NOT_FOUND', `Сеть ${args.network_id} не найдена.`, {
            network_id: args.network_id,
          });
        }
        // Emit before the registry row is gone (network_seq/event_log FK).
        emitDomainEvent(
          { systemDb: rt.deps.systemDb, pubsub: rt.deps.pubsub },
          args.network_id,
          'network.deleted',
          { id: args.network_id },
          { user_id: rt.deps.auth.userId, client_id: rt.deps.auth.keyId },
          { meta: { request_id: String(extra.requestId) } },
        );
        await rt.deps.networkService.deleteNetwork(args.network_id);
        rt.deps.systemDb.insertAuditLog({
          actorUserId: rt.deps.auth.userId,
          networkId: args.network_id,
          category: 'network',
          action: 'delete',
          targetType: 'network',
          targetId: args.network_id,
          details: { by_admin: true, via: 'mcp.etn.networks.delete' },
        });
        auditAgentCall(rt, 'etn.networks.delete', args.network_id, 'network', args.network_id, {
          confirm: args.confirm,
        });
        return {
          deleted: true,
          network_id: args.network_id,
          request_id: String(extra.requestId),
        };
      }),
  );

}
