/**
 * publications.ts — MCP-инструменты подсистемы «Публикации» (0.11.1, задача
 * 8f6857f8; карточки cab597a8 управление, f236bb22 чтение, a610c091 экспорт).
 *
 * Фасад над ТЕМИ ЖЕ доменными сервисами, что REST (`routes/publications.ts`):
 * валидация и ошибки совпадают с REST (общие контракты в `contracts.ts`),
 * мутации идут через `runWrite` (ADR 162d8e7a) — события, журнал и аудит
 * собирает обёртка. SQL и `emit`/`record*Activity` в фасаде запрещены
 * (сторож `guard-server-layers`).
 *
 * Прогрессивное раскрытие (ADR b2eebf8b): `description` несут суть и краткую
 * сигнатуру, детали (рецепты, `node_key`, семантика исключений, режимы
 * экспорта) — тема гайда `etn.guide { topic: "publications" }`.
 *
 * **Экспорт.** REST отдаёт джобу во временном файле; MCP — сами данные:
 * `etn.publications.export` без `with_assets` возвращает `content` (текст
 * файла для записи агентом), с `with_assets: true` — `artifact` (base64 zip с
 * `assets/`); `etn.publications.export_batch` всегда zip-артефакт. Сборка —
 * общий домен (`buildPublicationArtifact`/`buildPublicationBatchArtifact`),
 * поэтому документ и детерминизм идентичны REST-экспорту (требование a26135ad).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  BASE_LAYER_ID,
  EtnError,
  MCP_TOOL_ANNOTATIONS,
  type Publication,
  type PublicationActiveFilter,
  type PublicationCreateInput,
  type PublicationOrderItem,
  type PublicationSort,
  type PublicationUpdateInput,
  type SavedFilterDefinition,
} from '@etn/shared';

import type { NetworkDb } from '../../db/network-db.js';
import type { McpRuntime } from '../context.js';
import {
  mcpWriteFx,
  openMemberNetwork,
  openMemberNetworkBase,
  requireWritable,
  requireWriteBudget,
  runTool,
  runWrite,
  runWriteTool,
} from '../context.js';
import {
  addPublicationExclusion,
  addShelfItem,
  checkPublicationDeletion,
  checkShelfDeletion,
  createPublication,
  createShelf,
  deleteShelf,
  ensureDefaultShelf,
  getPublication,
  getShelf,
  listPublications,
  listShelves,
  purgePublication,
  rebuildPublication,
  removePublicationExclusion,
  removeShelfItem,
  restorePublication,
  restoreShelf,
  setPublicationOrder,
  trashPublication,
  trashShelf,
  updatePublication,
  updateShelf,
} from '../../domain/publication-service.js';
import {
  acceptPublicationCandidate,
  assemblePublication,
  buildPublicationExportDocument,
  listPublicationCandidates,
  listPublicationUsage,
  publicationMembershipCache,
} from '../../domain/publication-assembly-service.js';
import {
  buildPublicationArtifact,
  buildPublicationBatchArtifact,
  buildPublicationZipBuffer,
  publicationSlug,
} from '../../domain/publication-export-service.js';
import {
  McpPublicationAccept,
  McpPublicationAssembly,
  McpPublicationCandidates,
  McpPublicationCreate,
  McpPublicationDelete,
  McpPublicationDeletionCheck,
  McpPublicationExclusions,
  McpPublicationExport,
  McpPublicationExportBatch,
  McpPublicationGet,
  McpPublicationList,
  McpPublicationOrder,
  McpPublicationRebuild,
  McpPublicationRestore,
  McpPublicationTrash,
  McpPublicationUpdate,
  McpPublicationUsage,
  McpShelfAssign,
  McpShelfCreate,
  McpShelfDelete,
  McpShelfDeletionCheck,
  McpShelfList,
  McpShelfRestore,
  McpShelfTrash,
  McpShelfUpdate,
} from '../../contracts.js';

/** Снимок публикации для журнала ({ id, title }) с `NOT_FOUND`, если строки нет. */
function publicationRef(ndb: NetworkDb, id: string): Pick<Publication, 'id' | 'title'> {
  const pub = getPublication(ndb, id);
  if (pub === null) {
    throw new EtnError('NOT_FOUND', `publication ${id} not found`, { entity: 'publication', id });
  }
  return pub;
}

/**
 * Отображаемое имя пользователя для авторства-фолбэка «пусто → создатель»
 * (паритет с REST `resolveUserName` в `routes/publications.ts`).
 */
function resolveUserName(rt: McpRuntime): (userId: string) => string | null {
  return (userId) => {
    const user = rt.deps.systemDb.getUserById(userId);
    return user === null ? null : (user.display_name ?? user.username);
  };
}

/** Собрать вход создания/патча публикации из плоских аргументов контракта. */
function toCreateInput(args: {
  title: string;
  subtitle?: string | null;
  summary_md?: string | null;
  authorship?: string | null;
  cover_attachment_id?: string | null;
  cover_url?: string | null;
  title_recipe?: Record<string, unknown> | null;
  text_sources?: string[];
  extra_properties?: string[];
  numbering_from?: number | null;
  numbering_to?: number | null;
}): PublicationCreateInput {
  return {
    title: args.title,
    subtitle: args.subtitle ?? null,
    summary_md: args.summary_md ?? null,
    authorship: args.authorship ?? null,
    cover_attachment_id: args.cover_attachment_id ?? null,
    cover_url: args.cover_url ?? null,
    title_recipe: (args.title_recipe ?? null) as SavedFilterDefinition | null,
    ...(args.text_sources !== undefined ? { text_sources: args.text_sources } : {}),
    ...(args.extra_properties !== undefined ? { extra_properties: args.extra_properties } : {}),
    numbering_from: args.numbering_from ?? null,
    numbering_to: args.numbering_to ?? null,
  };
}

/** Собрать патч настроек из плоских аргументов (last-write-wins по полям). */
function toUpdateInput(args: {
  title?: string;
  subtitle?: string | null;
  summary_md?: string | null;
  authorship?: string | null;
  cover_attachment_id?: string | null;
  cover_url?: string | null;
  title_recipe?: Record<string, unknown> | null;
  text_sources?: string[];
  extra_properties?: string[];
  numbering_from?: number | null;
  numbering_to?: number | null;
  active?: boolean;
}): PublicationUpdateInput {
  const changes: PublicationUpdateInput = {};
  if (args.title !== undefined) changes.title = args.title;
  if (args.subtitle !== undefined) changes.subtitle = args.subtitle;
  if (args.summary_md !== undefined) changes.summary_md = args.summary_md;
  if (args.authorship !== undefined) changes.authorship = args.authorship;
  if (args.cover_attachment_id !== undefined)
    changes.cover_attachment_id = args.cover_attachment_id;
  if (args.cover_url !== undefined) changes.cover_url = args.cover_url;
  if (args.title_recipe !== undefined)
    changes.title_recipe = args.title_recipe as SavedFilterDefinition | null;
  if (args.text_sources !== undefined) changes.text_sources = args.text_sources;
  if (args.extra_properties !== undefined) changes.extra_properties = args.extra_properties;
  if (args.numbering_from !== undefined) changes.numbering_from = args.numbering_from;
  if (args.numbering_to !== undefined) changes.numbering_to = args.numbering_to;
  if (args.active !== undefined) changes.active = args.active;
  return changes;
}

export function registerPublicationTools(mcp: McpServer, rt: McpRuntime): void {
  // =========================================================================
  // Чтение (карточка f236bb22)
  // =========================================================================

  mcp.registerTool(
    'etn.publications.list',
    {
      title: 'Список публикаций',
      description:
        'List publications of the network with filters and pagination (parity with REST GET ' +
        '/publications). Filters: `q`, `shelf`, `active` (true|false|any), `sort` ' +
        '(manual|title|date|author), `include_trashed`; `limit`/`offset`. Returns `data[]` + ' +
        '`meta { total, offset, limit }`.',
      inputSchema: McpPublicationList.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.publications.list'],
    },
    (args) =>
      runTool(() => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const result = listPublications(ndb, {
          ...(args.q !== undefined ? { q: args.q } : {}),
          ...(args.shelf !== undefined ? { shelf: args.shelf } : {}),
          ...(args.active !== undefined ? { active: args.active as PublicationActiveFilter } : {}),
          ...(args.sort !== undefined ? { sort: args.sort as PublicationSort } : {}),
          ...(args.include_trashed !== undefined ? { include_trashed: args.include_trashed } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.offset !== undefined ? { offset: args.offset } : {}),
        });
        return {
          data: result.items,
          meta: { total: result.total, offset: args.offset ?? 0, limit: args.limit ?? 50 },
        };
      }),
  );

  mcp.registerTool(
    'etn.publications.get',
    {
      title: 'Карточка публикации',
      description:
        'Read one publication card (parity with REST GET /publications/{id}): title, subtitle, ' +
        'summary, authorship, cover, recipes, numbering, active/trash flags, version, plus full ' +
        'metadata — `created_by`/`created_at`, `updated_by`/`updated_at` (last editor) and ' +
        '`assembly_date`. Returns `{ data }`.',
      inputSchema: McpPublicationGet.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.publications.get'],
    },
    (args) =>
      runTool(() => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const publication = getPublication(ndb, args.publication_id);
        if (publication === null) {
          throw new EtnError('NOT_FOUND', `publication ${args.publication_id} not found`, {
            entity: 'publication',
            id: args.publication_id,
          });
        }
        return { data: publication };
      }),
  );

  mcp.registerTool(
    'etn.publications.assembly',
    {
      title: 'Сборка документа публикации',
      description:
        'Assemble the live document of a publication (parity with REST GET /publications/{id}' +
        '/assembly): title block, section tree with preambles/texts, exclusions, warnings. ' +
        'Paginated by ROOT sections (`page`, default 1; page size is the domain constant) — ' +
        'large documents are read page by page. `include_excluded` keeps excluded sections ' +
        'flagged (editor mode). Returns `{ data }`.',
      inputSchema: McpPublicationAssembly.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.publications.assembly'],
    },
    (args) =>
      runTool(() => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const data = assemblePublication(ndb, args.publication_id, rt.deps.auth.userId, {
          ...(args.page !== undefined ? { page: args.page } : {}),
          ...(args.include_excluded !== undefined
            ? { include_excluded: args.include_excluded }
            : {}),
        });
        return { data };
      }),
  );

  mcp.registerTool(
    'etn.publications.candidates',
    {
      title: 'Новые кандидаты публикации',
      description:
        'New candidates of a publication (parity with REST GET /publications/{id}/candidates): ' +
        'recipe-matching thoughts that entered the selection AFTER the last accepted state ' +
        '(temporal semantics, task e754527d) and are not excluded. `breadcrumbs` — the section ' +
        'path in the assembled tree. Paginated with `limit`/`offset`; the debounced membership ' +
        'cache is used. Returns `{ data }` with `items` (thought_id, title, type_id, breadcrumbs), ' +
        '`total`, `limit`, `offset`, `has_more`.',
      inputSchema: McpPublicationCandidates.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.publications.candidates'],
    },
    (args) =>
      runTool(() => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const data = listPublicationCandidates(ndb, args.publication_id, rt.deps.auth.userId, {
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.offset !== undefined ? { offset: args.offset } : {}),
          ...(args.include_excluded !== undefined
            ? { include_excluded: args.include_excluded }
            : {}),
          cache: publicationMembershipCache,
        });
        return { data };
      }),
  );

  mcp.registerTool(
    'etn.publications.accept',
    {
      title: 'Расставить кандидата публикации',
      description:
        'Accept one publication candidate (parity with REST POST /publications/{id}' +
        '/candidates/accept): extinguishes it individually (adds it to the accepted state, so it ' +
        'is no longer a candidate) and appends its node at the END of the local order. Other ' +
        'candidates stay. Idempotent. Returns `{ items }` — the updated order.',
      inputSchema: McpPublicationAccept.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.publications.accept'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const order = runWrite(ndb, fx, () => {
          const items = acceptPublicationCandidate(
            ndb,
            args.publication_id,
            args.thought_id,
            rt.deps.auth.userId,
          );
          const snapshot = publicationRef(ndb, args.publication_id);
          return {
            result: items,
            // Пишется строка порядка — событие то же, что у перестановки.
            events: [
              {
                type: 'publication.order.reordered' as const,
                data: { publication_id: args.publication_id, items },
              },
            ],
            activity: [
              { kind: 'publication' as const, action: 'updated' as const, publication: snapshot },
            ],
            audit: {
              action: 'etn.publications.accept',
              targetType: 'publication',
              targetId: args.publication_id,
              details: { thought_id: args.thought_id },
            },
          };
        });
        return { items: order, request_id: String(extra.requestId) };
      }),
  );

  mcp.registerTool(
    'etn.publications.usage',
    {
      title: 'Использование мысли в публикациях',
      description:
        'Where a thought is used across publications (parity with REST GET /thoughts/{id}' +
        '/publications): role `section`/`text`/`direct`, breadcrumbs or section title, anchor ' +
        'and assembly page. Paginated (`limit`/`offset`); `publication_limit` caps the scanned ' +
        'publications. Returns `{ data }` with `items`, `total`, `limit`, `offset`, `has_more`.',
      inputSchema: McpPublicationUsage.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.publications.usage'],
    },
    (args) =>
      runTool(() => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const data = listPublicationUsage(ndb, args.thought_id, rt.deps.auth.userId, {
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.offset !== undefined ? { offset: args.offset } : {}),
          ...(args.publication_limit !== undefined
            ? { publication_limit: args.publication_limit }
            : {}),
          cache: publicationMembershipCache,
        });
        return { data };
      }),
  );

  mcp.registerTool(
    'etn.shelves.list',
    {
      title: 'Список полок',
      description:
        'List library shelves with their contents (parity with REST GET /shelves). A shelf is a ' +
        'named, manually ordered group of publications shared by network participants; trashed ' +
        'shelves are hidden. Returns `{ data, meta }`. Если живых полок нет, список создаёт ' +
        'дефолтную «Полку» в основе (побочная запись).',
      inputSchema: McpShelfList.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.shelves.list'],
    },
    (args) =>
      runTool(() => {
        const ndb = openMemberNetwork(rt, args.network_id);
        let shelves = listShelves(ndb);
        // Ленивое создание дефолтной полки «Полка» — паритет с REST GET
        // /shelves (0.11.1, задача 8c2660e6; карточка c80951ea v2): сеть без
        // живых полок получает её при первом запросе списка — В ОСНОВЕ. Запись
        // идёт через `runWrite` (ADR 162d8e7a), событие атрибутировано основе.
        if (shelves.length === 0) {
          const baseNdb = openMemberNetworkBase(rt, args.network_id);
          const created = runWrite(baseNdb, mcpWriteFx(rt, args.network_id), () => {
            const shelf = ensureDefaultShelf(baseNdb, rt.deps.auth.userId);
            return {
              result: shelf,
              events:
                shelf === null
                  ? []
                  : [
                      {
                        type: 'shelf.updated' as const,
                        data: { shelf },
                        options: { layerId: BASE_LAYER_ID },
                      },
                    ],
            };
          });
          if (created !== null) shelves = listShelves(ndb);
        }
        return { data: shelves, meta: { total: shelves.length, offset: 0, limit: shelves.length } };
      }),
  );

  // =========================================================================
  // Проверка удаления (0.11.1, задача 00160da1; паритет REST/MCP)
  // =========================================================================

  mcp.registerTool(
    'etn.publications.deletionCheck',
    {
      title: 'Проверка удаления публикации',
      description:
        'Blocking check before purging a publication (parity with REST GET /publications/{id}' +
        '/deletion-check). Read-only: same check `etn.publications.delete` runs. Returns ' +
        '`{ data }` with `blocked` and `blocking { properties, layers }`.',
      inputSchema: McpPublicationDeletionCheck.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.publications.deletionCheck'],
    },
    (args) =>
      runTool(() => {
        const ndb = openMemberNetwork(rt, args.network_id);
        return { data: checkPublicationDeletion(ndb, args.publication_id) };
      }),
  );

  mcp.registerTool(
    'etn.shelves.deletionCheck',
    {
      title: 'Проверка удаления полки',
      description:
        'Blocking check before purging a shelf (parity with REST GET /shelves/{id}/deletion-check). ' +
        'Read-only. Returns `{ data }` with `blocked` (layer context only — purge is base-only) and ' +
        '`blocking { items }` (cascade size, informational).',
      inputSchema: McpShelfDeletionCheck.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.shelves.deletionCheck'],
    },
    (args) =>
      runTool(() => {
        const ndb = openMemberNetwork(rt, args.network_id);
        return { data: checkShelfDeletion(ndb, args.shelf_id) };
      }),
  );

  // =========================================================================
  // Экспорт (карточка a610c091)
  // =========================================================================

  mcp.registerTool(
    'etn.publications.export',
    {
      title: 'Экспорт публикации',
      description:
        'Export one publication as `md` or `html` (same assembly and determinism as REST export). ' +
        'Without `with_assets` returns `content` (the file text for the agent to save). With ' +
        '`with_assets: true` returns `artifact` (base64 zip with the document and an `assets/` ' +
        'directory of server-available attachments) plus `files` and `warnings`.',
      inputSchema: McpPublicationExport.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.publications.export'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const pub = getPublication(ndb, args.publication_id);
        if (pub === null) {
          throw new EtnError('NOT_FOUND', `publication ${args.publication_id} not found`, {
            entity: 'publication',
            id: args.publication_id,
          });
        }
        const document = buildPublicationExportDocument(
          ndb,
          args.publication_id,
          rt.deps.auth.userId,
          resolveUserName(rt),
        );
        const slug = publicationSlug(pub.title);
        const withAssets = args.with_assets === true;
        const artifact = buildPublicationArtifact(
          ndb,
          document,
          args.format,
          withAssets,
          '',
          slug,
        );
        if (!withAssets) {
          const main = artifact.entries[0]!;
          return {
            publication_id: args.publication_id,
            format: args.format,
            filename: main.name,
            content: typeof main.data === 'string' ? main.data : main.data.toString('utf8'),
            warnings: artifact.entry.warnings,
          };
        }
        const zip = await buildPublicationZipBuffer(artifact.entries);
        return {
          publication_id: args.publication_id,
          format: args.format,
          filename: `${slug}.zip`,
          artifact: zip.toString('base64'),
          files: artifact.entry.files,
          warnings: artifact.entry.warnings,
        };
      }),
  );

  mcp.registerTool(
    'etn.publications.export_batch',
    {
      title: 'Пакетный экспорт публикаций',
      description:
        'Export several publications as one zip artifact (base64), one `<slug>/` sub-directory ' +
        'each (parity with REST POST /publications/export-batch). Select by `ids` (≤ domain ' +
        'limit) or `active_only: true`. `with_assets` copies server-available attachments. ' +
        'Per-publication failures are reported in `report` with `status: "error"` and never ' +
        'abort the archive.',
      inputSchema: McpPublicationExportBatch.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.publications.export_batch'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const { entries, report } = buildPublicationBatchArtifact(
          ndb,
          {
            ...(args.ids !== undefined ? { ids: args.ids } : {}),
            ...(args.active_only !== undefined ? { active_only: args.active_only } : {}),
            format: args.format,
            ...(args.with_assets !== undefined ? { with_assets: args.with_assets } : {}),
          },
          rt.deps.auth.userId,
          resolveUserName(rt),
        );
        const zip = await buildPublicationZipBuffer(entries);
        return {
          format: args.format,
          filename: 'publications-export.zip',
          artifact: zip.toString('base64'),
          report,
        };
      }),
  );

  // =========================================================================
  // Управление публикациями (карточка cab597a8)
  // =========================================================================

  mcp.registerTool(
    'etn.publications.create',
    {
      title: 'Создать публикацию',
      description:
        'Create a publication (parity with REST POST /publications). `title` is required; recipes ' +
        '(`title_recipe`, `text_sources`, `extra_properties`), cover (attachment XOR url), ' +
        'numbering and title fields are optional. Validation is identical to REST (same domain). ' +
        'Details — `etn.guide { topic: "publications" }`.',
      inputSchema: McpPublicationCreate.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.publications.create'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const create = toCreateInput(args);
        const publication = runWrite(ndb, fx, () => {
          const created = createPublication(ndb, create, rt.deps.auth.userId);
          return {
            result: created,
            // Отдельного `publication.created` каталог 67b8748e не объявляет:
            // создание узнаётся тем же `publication.updated` (паритет с REST).
            events: [
              {
                type: 'publication.updated' as const,
                data: { id: created.id, changes: create, version: created.version },
              },
            ],
            activity: [
              { kind: 'publication' as const, action: 'created' as const, publication: created },
            ],
            audit: {
              action: 'etn.publications.create',
              targetType: 'publication',
              targetId: created.id,
              details: { title: created.title },
            },
          };
        });
        return { ...publication, request_id: String(extra.requestId) };
      }),
  );

  mcp.registerTool(
    'etn.publications.update',
    {
      title: 'Настроить публикацию',
      description:
        'Patch a publication (parity with REST PATCH /publications/{id}): title, subtitle, ' +
        'summary, authorship, cover, recipes (`title_recipe`/`text_sources`/`extra_properties`), ' +
        'numbering, `active`. All fields optional, last-write-wins. `assembly_date` changes only ' +
        'via rebuild. Details — `etn.guide { topic: "publications" }`.',
      inputSchema: McpPublicationUpdate.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.publications.update'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const changes = toUpdateInput(args);
        const publication = runWrite(ndb, fx, () => {
          const updated = updatePublication(ndb, args.publication_id, changes, rt.deps.auth.userId);
          return {
            result: updated,
            events: [
              {
                type: 'publication.updated' as const,
                data: { id: updated.id, changes, version: updated.version },
              },
            ],
            activity: [
              { kind: 'publication' as const, action: 'updated' as const, publication: updated },
            ],
            audit: {
              action: 'etn.publications.update',
              targetType: 'publication',
              targetId: updated.id,
              details: { fields: Object.keys(changes) },
            },
          };
        });
        return { ...publication, request_id: String(extra.requestId) };
      }),
  );

  mcp.registerTool(
    'etn.publications.order',
    {
      title: 'Порядок узлов публикации',
      description:
        'Set the local order of publication nodes (parity with REST PUT /publications/{id}/order). ' +
        '`items` is a batch of `{ node_key, position }`: `node_key` is a root section thought id ' +
        'or a containing edge id (the same key the assembly returns). Idempotent. One real-time ' +
        'event per batch. Returns `{ items }`.',
      inputSchema: McpPublicationOrder.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.publications.order'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const items: PublicationOrderItem[] = args.items.map((item) => ({
          node_key: item.node_key,
          position: item.position,
        }));
        const order = runWrite(ndb, fx, () => {
          const ordered = setPublicationOrder(ndb, args.publication_id, items, rt.deps.auth.userId);
          const snapshot = publicationRef(ndb, args.publication_id);
          return {
            result: ordered,
            // Батч перестановок — ОДНО событие (каталог 67b8748e).
            events: [
              {
                type: 'publication.order.reordered' as const,
                data: { publication_id: args.publication_id, items: ordered },
              },
            ],
            activity: [
              { kind: 'publication' as const, action: 'updated' as const, publication: snapshot },
            ],
            audit: {
              action: 'etn.publications.order',
              targetType: 'publication',
              targetId: args.publication_id,
              details: { count: items.length },
            },
          };
        });
        return { items: order, request_id: String(extra.requestId) };
      }),
  );

  mcp.registerTool(
    'etn.publications.exclusions',
    {
      title: 'Исключения публикации',
      description:
        'Add or remove a thought exclusion of a publication (card cab597a8; REST pair ' +
        'POST/DELETE /publications/{id}/exclusions). `excluded` (default true) excludes the ' +
        'thought from reading/export while keeping it flagged in the editor; false returns it. ' +
        'Exclusion applies to all occurrences. Idempotent. Returns the full `exclusions` list.',
      inputSchema: McpPublicationExclusions.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.publications.exclusions'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const exclude = args.excluded !== false;
        const exclusions = runWrite(ndb, fx, () => {
          const list = exclude
            ? addPublicationExclusion(
                ndb,
                args.publication_id,
                args.thought_id,
                rt.deps.auth.userId,
              )
            : removePublicationExclusion(ndb, args.publication_id, args.thought_id);
          const snapshot = publicationRef(ndb, args.publication_id);
          return {
            result: list,
            events: [
              {
                type: 'publication.exclusions.changed' as const,
                data: {
                  publication_id: args.publication_id,
                  thought_id: args.thought_id,
                  excluded: exclude,
                },
              },
            ],
            activity: [
              { kind: 'publication' as const, action: 'updated' as const, publication: snapshot },
            ],
            audit: {
              action: 'etn.publications.exclusions',
              targetType: 'publication',
              targetId: args.publication_id,
              details: { thought_id: args.thought_id, excluded: exclude },
            },
          };
        });
        return { exclusions, request_id: String(extra.requestId) };
      }),
  );

  mcp.registerTool(
    'etn.publications.rebuild',
    {
      title: 'Пересобрать публикацию',
      description:
        'Explicitly rebuild a publication (parity with REST POST /publications/{id}/rebuild): ' +
        'stamps `assembly_date` with the current time and drops dead `publication_order` rows ' +
        '(a node key that is no longer a live edge or thought). Changes nothing else. Returns ' +
        'the updated publication.',
      inputSchema: McpPublicationRebuild.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.publications.rebuild'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const publication = runWrite(ndb, fx, () => {
          const rebuilt = rebuildPublication(ndb, args.publication_id, rt.deps.auth.userId);
          return {
            result: rebuilt.publication,
            events: [
              {
                type: 'publication.rebuilt' as const,
                data: {
                  publication_id: rebuilt.publication.id,
                  assembly_date: rebuilt.publication.assembly_date ?? '',
                },
              },
            ],
            activity: [
              {
                kind: 'publication' as const,
                action: 'updated' as const,
                publication: rebuilt.publication,
              },
            ],
            audit: {
              action: 'etn.publications.rebuild',
              targetType: 'publication',
              targetId: rebuilt.publication.id,
              details: {},
            },
          };
        });
        return { ...publication, request_id: String(extra.requestId) };
      }),
  );

  mcp.registerTool(
    'etn.publications.trash',
    {
      title: 'Публикацию в корзину',
      description:
        'Mark a publication for deletion (parity with REST POST /publications/{id}/trash): the ' +
        'lifecycle counterpart of an inactive thought. Blocking rules are the same as REST ' +
        '(holding layers). Idempotent. Returns the updated publication.',
      inputSchema: McpPublicationTrash.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.publications.trash'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const publication = runWrite(ndb, fx, () => {
          const trashed = trashPublication(ndb, args.publication_id, rt.deps.auth.userId);
          return {
            result: trashed,
            events: [{ type: 'publication.trashed' as const, data: { id: trashed.id } }],
            activity: [
              { kind: 'publication' as const, action: 'trashed' as const, publication: trashed },
            ],
            audit: {
              action: 'etn.publications.trash',
              targetType: 'publication',
              targetId: trashed.id,
              details: {},
            },
          };
        });
        return { ...publication, request_id: String(extra.requestId) };
      }),
  );

  mcp.registerTool(
    'etn.publications.restore',
    {
      title: 'Публикацию из корзины',
      description:
        'Restore a publication from trash (parity with REST POST /publications/{id}/restore). ' +
        'Idempotent. Returns the updated publication.',
      inputSchema: McpPublicationRestore.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.publications.restore'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const publication = runWrite(ndb, fx, () => {
          const restored = restorePublication(ndb, args.publication_id, rt.deps.auth.userId);
          return {
            result: restored,
            events: [{ type: 'publication.restored' as const, data: { id: restored.id } }],
            activity: [
              { kind: 'publication' as const, action: 'restored' as const, publication: restored },
            ],
            audit: {
              action: 'etn.publications.restore',
              targetType: 'publication',
              targetId: restored.id,
              details: {},
            },
          };
        });
        return { ...publication, request_id: String(extra.requestId) };
      }),
  );

  mcp.registerTool(
    'etn.publications.delete',
    {
      title: 'Удалить публикацию',
      description:
        'Permanently delete (purge) a publication (parity with REST DELETE /publications/{id}). ' +
        'Base layer only; blocked by live property values of type «Публикация» and by live layer ' +
        'shadows — the same rules as direct REST DELETE. Irreversible: use `trash` to mark first. ' +
        'Returns `{ publication_id, deleted: true }`.',
      inputSchema: McpPublicationDelete.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.publications.delete'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        runWrite(ndb, fx, () => {
          // Снимок для журнала берём до физического удаления строки.
          const snapshot = publicationRef(ndb, args.publication_id);
          purgePublication(ndb, args.publication_id);
          return {
            result: undefined,
            events: [{ type: 'publication.purged' as const, data: { id: args.publication_id } }],
            activity: [
              { kind: 'publication' as const, action: 'deleted' as const, publication: snapshot },
            ],
            audit: {
              action: 'etn.publications.delete',
              targetType: 'publication',
              targetId: args.publication_id,
              details: {},
            },
          };
        });
        return {
          publication_id: args.publication_id,
          deleted: true,
          request_id: String(extra.requestId),
        };
      }),
  );

  // =========================================================================
  // Полки (карточка cab597a8)
  // =========================================================================

  mcp.registerTool(
    'etn.shelves.create',
    {
      title: 'Создать полку',
      description:
        'Create a library shelf (parity with REST POST /shelves). `title` must be unique among ' +
        'live shelves — a taken name is `VALIDATION_ERROR` (`shelf_title_taken`). Returns the ' +
        'new shelf (with empty `items`).',
      inputSchema: McpShelfCreate.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.shelves.create'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const shelf = runWrite(ndb, fx, () => {
          const created = createShelf(ndb, { title: args.title }, rt.deps.auth.userId);
          return {
            result: created,
            events: [{ type: 'shelf.updated' as const, data: { shelf: created } }],
            activity: [{ kind: 'shelf' as const, action: 'created' as const, shelf: created }],
            audit: {
              action: 'etn.shelves.create',
              targetType: 'shelf',
              targetId: created.id,
              details: { title: created.title },
            },
          };
        });
        return { ...shelf, request_id: String(extra.requestId) };
      }),
  );

  mcp.registerTool(
    'etn.shelves.update',
    {
      title: 'Изменить полку',
      description:
        'Rename or reorder a shelf (parity with REST PATCH /shelves/{id}). All fields optional; ' +
        'a taken title is `VALIDATION_ERROR`. Returns the updated shelf.',
      inputSchema: McpShelfUpdate.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.shelves.update'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const shelf = runWrite(ndb, fx, () => {
          const updated = updateShelf(
            ndb,
            args.shelf_id,
            {
              ...(args.title !== undefined ? { title: args.title } : {}),
              ...(args.position !== undefined ? { position: args.position } : {}),
            },
            rt.deps.auth.userId,
          );
          return {
            result: updated,
            events: [{ type: 'shelf.updated' as const, data: { shelf: updated } }],
            activity: [{ kind: 'shelf' as const, action: 'updated' as const, shelf: updated }],
            audit: {
              action: 'etn.shelves.update',
              targetType: 'shelf',
              targetId: updated.id,
              details: {},
            },
          };
        });
        return { ...shelf, request_id: String(extra.requestId) };
      }),
  );

  mcp.registerTool(
    'etn.shelves.delete',
    {
      title: 'Удалить полку',
      description:
        'Permanently delete a shelf (parity with REST DELETE /shelves/{id}). Base layer only ' +
        '(`purge_base_only`); its items cascade, publications stay alive (a shelf is a playlist). ' +
        'Irreversible. Returns `{ shelf_id, deleted: true }`.',
      inputSchema: McpShelfDelete.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.shelves.delete'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        runWrite(ndb, fx, () => {
          // Снимок для журнала — до физического удаления; `getShelf` (не
          // `listShelves`) видит и помеченную в корзину полку.
          const existing = getShelf(ndb, args.shelf_id);
          deleteShelf(ndb, args.shelf_id);
          return {
            result: undefined,
            events: [{ type: 'shelf.deleted' as const, data: { id: args.shelf_id } }],
            activity:
              existing === null
                ? []
                : [{ kind: 'shelf' as const, action: 'deleted' as const, shelf: existing }],
            audit: {
              action: 'etn.shelves.delete',
              targetType: 'shelf',
              targetId: args.shelf_id,
              details: {},
            },
          };
        });
        return { shelf_id: args.shelf_id, deleted: true, request_id: String(extra.requestId) };
      }),
  );

  mcp.registerTool(
    'etn.shelves.trash',
    {
      title: 'Полку в корзину',
      description:
        'Mark a shelf for deletion (parity with REST POST /shelves/{id}/trash). A trashed shelf ' +
        'is hidden from `shelves.list` and purged only in the base layer. Returns the updated shelf.',
      inputSchema: McpShelfTrash.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.shelves.trash'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const shelf = runWrite(ndb, fx, () => {
          const trashed = trashShelf(ndb, args.shelf_id, rt.deps.auth.userId);
          return {
            result: trashed,
            events: [{ type: 'shelf.updated' as const, data: { shelf: trashed } }],
            activity: [{ kind: 'shelf' as const, action: 'trashed' as const, shelf: trashed }],
            audit: {
              action: 'etn.shelves.trash',
              targetType: 'shelf',
              targetId: trashed.id,
              details: {},
            },
          };
        });
        return { ...shelf, request_id: String(extra.requestId) };
      }),
  );

  mcp.registerTool(
    'etn.shelves.restore',
    {
      title: 'Полку из корзины',
      description:
        'Restore a shelf from trash (parity with REST POST /shelves/{id}/restore). Idempotent. ' +
        'Returns the updated shelf.',
      inputSchema: McpShelfRestore.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.shelves.restore'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const shelf = runWrite(ndb, fx, () => {
          const restored = restoreShelf(ndb, args.shelf_id, rt.deps.auth.userId);
          return {
            result: restored,
            events: [{ type: 'shelf.updated' as const, data: { shelf: restored } }],
            activity: [{ kind: 'shelf' as const, action: 'restored' as const, shelf: restored }],
            audit: {
              action: 'etn.shelves.restore',
              targetType: 'shelf',
              targetId: restored.id,
              details: {},
            },
          };
        });
        return { ...shelf, request_id: String(extra.requestId) };
      }),
  );

  mcp.registerTool(
    'etn.shelves.assign',
    {
      title: 'Публикация на полке',
      description:
        'Put or remove a publication on a shelf (card cab597a8; REST pair POST/DELETE /shelves/' +
        '{id}/items). `assigned` (default true) adds the publication — without `position` it goes ' +
        'to the end; false removes it. Idempotent. Returns the updated shelf.',
      inputSchema: McpShelfAssign.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.shelves.assign'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const assign = args.assigned !== false;
        const shelf = runWrite(ndb, fx, () => {
          let updated;
          if (assign) {
            const current = listShelves(ndb).find((s) => s.id === args.shelf_id);
            // Без явной позиции публикация кладётся в конец состава (паритет REST).
            const position =
              args.position ??
              (current === undefined
                ? 1
                : current.items.reduce((max, item) => Math.max(max, item.position), 0) + 1);
            updated = addShelfItem(
              ndb,
              args.shelf_id,
              args.publication_id,
              position,
              rt.deps.auth.userId,
            );
          } else {
            updated = removeShelfItem(ndb, args.shelf_id, args.publication_id);
          }
          return {
            result: updated,
            events: [{ type: 'shelf.updated' as const, data: { shelf: updated } }],
            activity: [{ kind: 'shelf' as const, action: 'updated' as const, shelf: updated }],
            audit: {
              action: 'etn.shelves.assign',
              targetType: 'shelf',
              targetId: args.shelf_id,
              details: { publication_id: args.publication_id, assigned: assign },
            },
          };
        });
        return { ...shelf, request_id: String(extra.requestId) };
      }),
  );
}
