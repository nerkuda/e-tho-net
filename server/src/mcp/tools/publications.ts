/**
 * publications.ts — источник операций подсистемы «Публикации» для `etn.ops`
 * (0.11.1, задача 8f6857f8, карточки cab597a8 управление, f236bb22 чтение,
 * a610c091 экспорт; свернуто в guide+ops задачей 094653b6).
 *
 * 0.11.1 (задача 094653b6, ADR b2eebf8b/8358eea9): 25 собственных MCP-
 * инструментов публикаций и полок сняты из `tools/list` и перенесены в паттерн
 * «гайд + исполнитель» (`etn.guide` + `etn.ops`). Здесь остаются ТЕ ЖЕ
 * обработчики — как карта `PUBLICATION_OPS_HANDLERS`, которую подхватывает
 * диспетчер `etn.ops` (tools/ops.ts). Реестр действий и темы гайда —
 * tools/ops-catalog.ts; регистраций инструментов больше нет.
 *
 * Фасад над ТЕМИ ЖЕ доменными сервисами, что REST (`routes/publications.ts`):
 * валидация и ошибки совпадают с REST (общие контракты в `contracts.ts`),
 * мутации идут через `runWrite` (ADR 162d8e7a) — события, журнал и аудит
 * собирает обёртка. SQL и `emit`/`record*Activity` в фасаде запрещены
 * (сторож `guard-server-layers`).
 *
 * **Экспорт.** REST отдаёт джобу во временном файле; MCP — сами данные:
 * `publications.export` без `with_assets` возвращает `content` (текст файла для
 * записи агентом), с `with_assets: true` — `artifact` (base64 zip с `assets/`);
 * `publications.export_batch` всегда zip-артефакт. Сборка — общий домен
 * (`buildPublicationArtifact`/`buildPublicationBatchArtifact`), поэтому документ
 * и детерминизм идентичны REST-экспорту (требование a26135ad).
 */

import { z } from 'zod';

import {
  BASE_LAYER_ID,
  EtnError,
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
import type { OpHandler, Params } from './ops.js';

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

// ---------------------------------------------------------------------------
// Обработчики операций (ключ — короткое имя действия etn.ops)
// ---------------------------------------------------------------------------

/**
 * Все 25 действий семейств `publications.*` и `shelves.*`. Вызываются
 * диспетчером `etn.ops` после валидации `params` по контракту из реестра
 * (tools/ops-catalog.ts). Возвраты — те же, что были у снятых инструментов
 * (контракты и коды ошибок не менялись).
 */
export const PUBLICATION_OPS_HANDLERS: Record<string, OpHandler> = {
  // ---- публикации: чтение (карточка f236bb22) ----------------------------
  'publications.list': (rt, p) => {
    const a = p as unknown as z.infer<typeof McpPublicationList.schema>;
    return runTool(() => {
      const ndb = openMemberNetwork(rt, a.network_id);
      const result = listPublications(ndb, {
        ...(a.q !== undefined ? { q: a.q } : {}),
        ...(a.shelf !== undefined ? { shelf: a.shelf } : {}),
        ...(a.active !== undefined ? { active: a.active as PublicationActiveFilter } : {}),
        ...(a.sort !== undefined ? { sort: a.sort as PublicationSort } : {}),
        ...(a.include_trashed !== undefined ? { include_trashed: a.include_trashed } : {}),
        ...(a.limit !== undefined ? { limit: a.limit } : {}),
        ...(a.offset !== undefined ? { offset: a.offset } : {}),
      });
      return {
        data: result.items,
        meta: { total: result.total, offset: a.offset ?? 0, limit: a.limit ?? 50 },
      };
    });
  },

  'publications.get': (rt, p) => {
    const a = p as unknown as z.infer<typeof McpPublicationGet.schema>;
    return runTool(() => {
      const ndb = openMemberNetwork(rt, a.network_id);
      const publication = getPublication(ndb, a.publication_id);
      if (publication === null) {
        throw new EtnError('NOT_FOUND', `publication ${a.publication_id} not found`, {
          entity: 'publication',
          id: a.publication_id,
        });
      }
      return { data: publication };
    });
  },

  'publications.assembly': (rt, p) => {
    const a = p as unknown as z.infer<typeof McpPublicationAssembly.schema>;
    return runTool(() => {
      const ndb = openMemberNetwork(rt, a.network_id);
      const data = assemblePublication(ndb, a.publication_id, rt.deps.auth.userId, {
        ...(a.page !== undefined ? { page: a.page } : {}),
        ...(a.include_excluded !== undefined ? { include_excluded: a.include_excluded } : {}),
      });
      return { data };
    });
  },

  'publications.candidates': (rt, p) => {
    const a = p as unknown as z.infer<typeof McpPublicationCandidates.schema>;
    return runTool(() => {
      const ndb = openMemberNetwork(rt, a.network_id);
      const data = listPublicationCandidates(ndb, a.publication_id, rt.deps.auth.userId, {
        ...(a.limit !== undefined ? { limit: a.limit } : {}),
        ...(a.offset !== undefined ? { offset: a.offset } : {}),
        ...(a.include_excluded !== undefined ? { include_excluded: a.include_excluded } : {}),
        cache: publicationMembershipCache,
      });
      return { data };
    });
  },

  'publications.usage': (rt, p) => {
    const a = p as unknown as z.infer<typeof McpPublicationUsage.schema>;
    return runTool(() => {
      const ndb = openMemberNetwork(rt, a.network_id);
      const data = listPublicationUsage(ndb, a.thought_id, rt.deps.auth.userId, {
        ...(a.limit !== undefined ? { limit: a.limit } : {}),
        ...(a.offset !== undefined ? { offset: a.offset } : {}),
        ...(a.publication_limit !== undefined ? { publication_limit: a.publication_limit } : {}),
        cache: publicationMembershipCache,
      });
      return { data };
    });
  },

  'publications.deletionCheck': (rt, p) => {
    const a = p as unknown as z.infer<typeof McpPublicationDeletionCheck.schema>;
    return runTool(() => {
      const ndb = openMemberNetwork(rt, a.network_id);
      return { data: checkPublicationDeletion(ndb, a.publication_id) };
    });
  },

  // ---- публикации: экспорт (карточка a610c091) ---------------------------
  'publications.export': (rt, p) => {
    const a = p as unknown as z.infer<typeof McpPublicationExport.schema>;
    return runTool(async () => {
      const ndb = openMemberNetwork(rt, a.network_id);
      const pub = getPublication(ndb, a.publication_id);
      if (pub === null) {
        throw new EtnError('NOT_FOUND', `publication ${a.publication_id} not found`, {
          entity: 'publication',
          id: a.publication_id,
        });
      }
      const document = buildPublicationExportDocument(
        ndb,
        a.publication_id,
        rt.deps.auth.userId,
        resolveUserName(rt),
      );
      const slug = publicationSlug(pub.title);
      const withAssets = a.with_assets === true;
      const artifact = buildPublicationArtifact(ndb, document, a.format, withAssets, '', slug);
      if (!withAssets) {
        const main = artifact.entries[0]!;
        return {
          publication_id: a.publication_id,
          format: a.format,
          filename: main.name,
          content: typeof main.data === 'string' ? main.data : main.data.toString('utf8'),
          warnings: artifact.entry.warnings,
        };
      }
      const zip = await buildPublicationZipBuffer(artifact.entries);
      return {
        publication_id: a.publication_id,
        format: a.format,
        filename: `${slug}.zip`,
        artifact: zip.toString('base64'),
        files: artifact.entry.files,
        warnings: artifact.entry.warnings,
      };
    });
  },

  'publications.export_batch': (rt, p) => {
    const a = p as unknown as z.infer<typeof McpPublicationExportBatch.schema>;
    return runTool(async () => {
      const ndb = openMemberNetwork(rt, a.network_id);
      const { entries, report } = buildPublicationBatchArtifact(
        ndb,
        {
          ...(a.ids !== undefined ? { ids: a.ids } : {}),
          ...(a.active_only !== undefined ? { active_only: a.active_only } : {}),
          format: a.format,
          ...(a.with_assets !== undefined ? { with_assets: a.with_assets } : {}),
        },
        rt.deps.auth.userId,
        resolveUserName(rt),
      );
      const zip = await buildPublicationZipBuffer(entries);
      return {
        format: a.format,
        filename: 'publications-export.zip',
        artifact: zip.toString('base64'),
        report,
      };
    });
  },

  // ---- публикации: управление (карточка cab597a8) ------------------------
  'publications.create': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpPublicationCreate.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const create = toCreateInput(a);
      const publication = runWrite(ndb, fx, () => {
        const created = createPublication(ndb, create, rt.deps.auth.userId);
        return {
          result: created,
          // Отдельного `publication.created` каталог 67b8748e не объявляет:
          // создание узнаётся тем же `publication.updated` (паритет с REST).
          //
          // `changes` — ПОЛНЫЙ созданный DTO, а не тело запроса (ошибка
          // 4efb01bb): иначе клиентский кэш получал частичную запись без
          // `text_sources`/`extra_properties`, и карточка падала на
          // `[...p.text_sources]`. Паритет с REST и с `thought.created`.
          events: [
            {
              type: 'publication.updated' as const,
              data: { id: created.id, changes: created, version: created.version },
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
    });
  },

  'publications.update': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpPublicationUpdate.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const changes = toUpdateInput(a);
      const publication = runWrite(ndb, fx, () => {
        const updated = updatePublication(ndb, a.publication_id, changes, rt.deps.auth.userId);
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
    });
  },

  'publications.order': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpPublicationOrder.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const items: PublicationOrderItem[] = a.items.map((item) => ({
        node_key: item.node_key,
        position: item.position,
      }));
      const order = runWrite(ndb, fx, () => {
        const ordered = setPublicationOrder(ndb, a.publication_id, items, rt.deps.auth.userId);
        const snapshot = publicationRef(ndb, a.publication_id);
        return {
          result: ordered,
          // Батч перестановок — ОДНО событие (каталог 67b8748e).
          events: [
            {
              type: 'publication.order.reordered' as const,
              data: { publication_id: a.publication_id, items: ordered },
            },
          ],
          activity: [
            { kind: 'publication' as const, action: 'updated' as const, publication: snapshot },
          ],
          audit: {
            action: 'etn.publications.order',
            targetType: 'publication',
            targetId: a.publication_id,
            details: { count: items.length },
          },
        };
      });
      return { items: order, request_id: String(extra.requestId) };
    });
  },

  'publications.accept': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpPublicationAccept.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const order = runWrite(ndb, fx, () => {
        const items = acceptPublicationCandidate(
          ndb,
          a.publication_id,
          a.thought_id,
          rt.deps.auth.userId,
        );
        const snapshot = publicationRef(ndb, a.publication_id);
        return {
          result: items,
          // Пишется строка порядка — событие то же, что у перестановки.
          events: [
            {
              type: 'publication.order.reordered' as const,
              data: { publication_id: a.publication_id, items },
            },
          ],
          activity: [
            { kind: 'publication' as const, action: 'updated' as const, publication: snapshot },
          ],
          audit: {
            action: 'etn.publications.accept',
            targetType: 'publication',
            targetId: a.publication_id,
            details: { thought_id: a.thought_id },
          },
        };
      });
      return { items: order, request_id: String(extra.requestId) };
    });
  },

  'publications.exclusions': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpPublicationExclusions.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const exclude = a.excluded !== false;
      const exclusions = runWrite(ndb, fx, () => {
        const list = exclude
          ? addPublicationExclusion(ndb, a.publication_id, a.thought_id, rt.deps.auth.userId)
          : removePublicationExclusion(ndb, a.publication_id, a.thought_id);
        const snapshot = publicationRef(ndb, a.publication_id);
        return {
          result: list,
          events: [
            {
              type: 'publication.exclusions.changed' as const,
              data: {
                publication_id: a.publication_id,
                thought_id: a.thought_id,
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
            targetId: a.publication_id,
            details: { thought_id: a.thought_id, excluded: exclude },
          },
        };
      });
      return { exclusions, request_id: String(extra.requestId) };
    });
  },

  'publications.rebuild': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpPublicationRebuild.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const publication = runWrite(ndb, fx, () => {
        const rebuilt = rebuildPublication(ndb, a.publication_id, rt.deps.auth.userId);
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
            { kind: 'publication' as const, action: 'updated' as const, publication: rebuilt.publication },
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
    });
  },

  'publications.trash': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpPublicationTrash.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const publication = runWrite(ndb, fx, () => {
        const trashed = trashPublication(ndb, a.publication_id, rt.deps.auth.userId);
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
    });
  },

  'publications.restore': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpPublicationRestore.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const publication = runWrite(ndb, fx, () => {
        const restored = restorePublication(ndb, a.publication_id, rt.deps.auth.userId);
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
    });
  },

  'publications.delete': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpPublicationDelete.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      runWrite(ndb, fx, () => {
        // Снимок для журнала берём до физического удаления строки.
        const snapshot = publicationRef(ndb, a.publication_id);
        purgePublication(ndb, a.publication_id);
        return {
          result: undefined,
          events: [{ type: 'publication.purged' as const, data: { id: a.publication_id } }],
          activity: [
            { kind: 'publication' as const, action: 'deleted' as const, publication: snapshot },
          ],
          audit: {
            action: 'etn.publications.delete',
            targetType: 'publication',
            targetId: a.publication_id,
            details: {},
          },
        };
      });
      return {
        publication_id: a.publication_id,
        deleted: true,
        request_id: String(extra.requestId),
      };
    });
  },

  // ---- полки (карточка cab597a8) -----------------------------------------
  'shelves.list': (rt, p) => {
    const a = p as unknown as z.infer<typeof McpShelfList.schema>;
    return runTool(() => {
      const ndb = openMemberNetwork(rt, a.network_id);
      let shelves = listShelves(ndb);
      // Ленивое создание дефолтной полки «Полка» — паритет с REST GET
      // /shelves (0.11.1, задача 8c2660e6; карточка c80951ea v2): сеть без
      // живых полок получает её при первом запросе списка — В ОСНОВЕ. Запись
      // идёт через `runWrite` (ADR 162d8e7a), событие атрибутировано основе.
      if (shelves.length === 0) {
        const baseNdb = openMemberNetworkBase(rt, a.network_id);
        const created = runWrite(baseNdb, mcpWriteFx(rt, a.network_id), () => {
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
    });
  },

  'shelves.deletionCheck': (rt, p) => {
    const a = p as unknown as z.infer<typeof McpShelfDeletionCheck.schema>;
    return runTool(() => {
      const ndb = openMemberNetwork(rt, a.network_id);
      return { data: checkShelfDeletion(ndb, a.shelf_id) };
    });
  },

  'shelves.create': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpShelfCreate.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const shelf = runWrite(ndb, fx, () => {
        const created = createShelf(ndb, { title: a.title }, rt.deps.auth.userId);
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
    });
  },

  'shelves.update': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpShelfUpdate.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const shelf = runWrite(ndb, fx, () => {
        const updated = updateShelf(
          ndb,
          a.shelf_id,
          {
            ...(a.title !== undefined ? { title: a.title } : {}),
            ...(a.position !== undefined ? { position: a.position } : {}),
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
    });
  },

  'shelves.delete': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpShelfDelete.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      runWrite(ndb, fx, () => {
        // Снимок для журнала — до физического удаления; `getShelf` (не
        // `listShelves`) видит и помеченную в корзину полку.
        const existing = getShelf(ndb, a.shelf_id);
        deleteShelf(ndb, a.shelf_id);
        return {
          result: undefined,
          events: [{ type: 'shelf.deleted' as const, data: { id: a.shelf_id } }],
          activity:
            existing === null
              ? []
              : [{ kind: 'shelf' as const, action: 'deleted' as const, shelf: existing }],
          audit: {
            action: 'etn.shelves.delete',
            targetType: 'shelf',
            targetId: a.shelf_id,
            details: {},
          },
        };
      });
      return { shelf_id: a.shelf_id, deleted: true, request_id: String(extra.requestId) };
    });
  },

  'shelves.trash': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpShelfTrash.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const shelf = runWrite(ndb, fx, () => {
        const trashed = trashShelf(ndb, a.shelf_id, rt.deps.auth.userId);
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
    });
  },

  'shelves.restore': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpShelfRestore.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const shelf = runWrite(ndb, fx, () => {
        const restored = restoreShelf(ndb, a.shelf_id, rt.deps.auth.userId);
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
    });
  },

  'shelves.assign': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpShelfAssign.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const assign = a.assigned !== false;
      const shelf = runWrite(ndb, fx, () => {
        let updated;
        if (assign) {
          const current = listShelves(ndb).find((s) => s.id === a.shelf_id);
          // Без явной позиции публикация кладётся в конец состава (паритет REST).
          const position =
            a.position ??
            (current === undefined
              ? 1
              : current.items.reduce((max, item) => Math.max(max, item.position), 0) + 1);
          updated = addShelfItem(ndb, a.shelf_id, a.publication_id, position, rt.deps.auth.userId);
        } else {
          updated = removeShelfItem(ndb, a.shelf_id, a.publication_id);
        }
        return {
          result: updated,
          events: [{ type: 'shelf.updated' as const, data: { shelf: updated } }],
          activity: [{ kind: 'shelf' as const, action: 'updated' as const, shelf: updated }],
          audit: {
            action: 'etn.shelves.assign',
            targetType: 'shelf',
            targetId: a.shelf_id,
            details: { publication_id: a.publication_id, assigned: assign },
          },
        };
      });
      return { ...shelf, request_id: String(extra.requestId) };
    });
  },
};

/** Тип `params` для обработчиков (реэкспорт ради читаемости импорта). */
export type { Params };
