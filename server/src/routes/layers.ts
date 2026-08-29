/**
 * Change-layer routes (task S7, 03-server-api.md §5a; docs/13-layers.md
 * §2, §7, §10.1).
 *
 *   GET    /networks/:networkId/layers                  — list (+hierarchy meta)
 *   POST   /networks/:networkId/layers                  — create under a parent
 *   PATCH  /networks/:networkId/layers/:layerId         — rename / edit comment
 *   DELETE /networks/:networkId/layers/:layerId?cascade=N — subtree delete
 *   POST   /networks/:networkId/layers/:layerId/select  — switch session layer
 *   POST   /networks/:networkId/layers/:layerId/merge   — merge into the parent (S8)
 *
 * Rights (13-layers.md §7.2): identical for every network member. The layer
 * metadata lives outside the branchable tables, so these handlers run on the
 * base-layer connection; the session's selected layer still marks the `current`
 * element of the list. Merge is a separate route (S8), not part of this CRUD.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { BASE_LAYER_ID, EtnError, type LayerMergeReport } from '@etn/shared';

import { sendSuccess } from '../http/responses.js';
import {
  bodyObject,
  fieldNullableString,
  fieldString,
  openRouteNetworkDbBase,
  parseIfMatch,
  queryBoolean,
  queryInt,
  requestBody,
  resolveRequestLayer,
  type RouteDeps,
} from './helpers.js';
import {
  createLayer,
  deleteLayerWithEvents,
  layerSubtreeIds,
  listLayers,
  setSessionLayer,
  updateLayer,
} from '../domain/layer-service.js';
import { mergeLayer, type MergeSelection } from '../domain/merge-service.js';
import { BRANCHABLE_TABLES } from '../db/layer-chain.js';
import type { BranchableTable } from '../db/layer-write.js';
import { closeNetworkDb } from '../db/network-db.js';

/** Route params for a network id. */
interface NetworkIdParams {
  networkId: string;
}

/** Route params for a network + layer id. */
interface LayerParams {
  networkId: string;
  layerId: string;
}

/** `/api/v1/networks*` layer routes plugin factory. */
export function createLayersRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    // --- List (§10.1): hierarchy + metadata; service layers hidden by default.
    app.get(
      '/networks/:networkId/layers',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const query = req.query as Record<string, unknown>;
        const includeService = queryBoolean(query.include_service, 'include_service', req.id);
        const ndb = openRouteNetworkDbBase(deps, networkId, app.appLogger);
        const current = resolveRequestLayer(deps.dataDir, req, networkId, app.appLogger);
        sendSuccess(reply, listLayers(ndb, { includeService, currentLayerId: current.id }));
      },
    );

    // --- Create (§2.3): under the given parent, default — the session's
    // current layer. Depth limit enforced in the service (422 above 4 levels).
    app.post(
      '/networks/:networkId/layers',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const body = bodyObject(req.body, req.id);
        const title = fieldString(body, 'title', req.id);
        if (title === undefined || title.trim().length === 0) {
          throw new EtnError('VALIDATION_ERROR', 'title обязателен.', { field: 'title' }, req.id);
        }
        const explicitParent = fieldNullableString(body, 'parent_id', req.id);
        const comment = fieldNullableString(body, 'comment', req.id);
        const gitBranch = fieldNullableString(body, 'git_branch', req.id);

        const ndb = openRouteNetworkDbBase(deps, networkId, app.appLogger);
        // §2.3: «от указанного родителя (по умолчанию — текущий слой сессии)».
        const parent =
          explicitParent !== undefined && explicitParent !== null
            ? explicitParent
            : resolveRequestLayer(deps.dataDir, req, networkId, app.appLogger).id;
        const layer = createLayer(ndb, {
          parentId: parent,
          title,
          comment,
          gitBranch,
          createdBy: req.auth!.user.id,
        });
        sendSuccess(reply, layer, { version: layer.version }, 201);
      },
    );

    // --- Rename / edit comment (§2.2): base title is fixed (422).
    app.patch(
      '/networks/:networkId/layers/:layerId',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, layerId } = req.params as LayerParams;
        const body = bodyObject(req.body, req.id);
        const title = fieldString(body, 'title', req.id);
        const comment = fieldNullableString(body, 'comment', req.id);
        if (title === undefined && comment === undefined) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'нечего менять: передайте title и/или comment.',
            { fields: ['title', 'comment'] },
            req.id,
          );
        }
        const expectedVersion = parseIfMatch(
          req.headers['if-match'] as string | undefined,
          req.id,
        );
        const ndb = openRouteNetworkDbBase(deps, networkId, app.appLogger);
        const layer = updateLayer(
          ndb,
          layerId,
          { ...(title !== undefined ? { title } : {}), ...(comment !== undefined ? { comment } : {}) },
          expectedVersion,
        );
        sendSuccess(reply, layer, { version: layer.version, updated_at: layer.last_activity_at });
      },
    );

    // --- Delete (§2.4): subtree cascade with an explicit confirmation.
    app.delete(
      '/networks/:networkId/layers/:layerId',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, layerId } = req.params as LayerParams;
        const query = req.query as Record<string, unknown>;
        const cascade = queryInt(query.cascade, undefined, {
          field: 'cascade',
          min: 0,
          requestId: req.id,
        });

        // Close the doomed layers' pooled connections first: their temp
        // `layer_chain` would otherwise keep referencing deleted layers.
        const ndb = openRouteNetworkDbBase(deps, networkId, app.appLogger);
        const subtreeIds = layerSubtreeIds(ndb, layerId);
        const parentRow = ndb
          .prepare('SELECT parent_id, title FROM layers WHERE id = ?')
          .get(layerId) as { parent_id: string | null; title: string } | undefined;
        for (const id of subtreeIds) {
          if (id !== BASE_LAYER_ID) {
            closeNetworkDb(networkId, id);
          }
        }

        // Task S9 (13-layers.md §2.4, §12): re-pointed sessions must be
        // forced into a full resync — record the network's current seq
        // before the cascade so `switched_at_seq` reflects "everything from
        // here on assumes the new layer".
        const switchedAtSeq = app.systemDb.getMaxEventSeq(networkId) ?? 0;
        const result = deleteLayerWithEvents(ndb, layerId, cascade, switchedAtSeq);
        // Sessions sitting on the deleted subtree were re-pointed to the
        // parent inside the transaction — drop this request's memoised echo
        // so the onSend hook resolves the post-switch layer.
        req.layerEcho = undefined;
        // Push a forced-resync control frame to every already-connected
        // socket sitting on the deleted subtree (13-layers.md §2.4).
        const newLayerId = parentRow?.parent_id ?? BASE_LAYER_ID;
        const newLayerRow = ndb.prepare('SELECT title FROM layers WHERE id = ?').get(newLayerId) as
          | { title: string }
          | undefined;
        app.realtimeGateway.notifyLayerDeleted(networkId, new Set(subtreeIds), {
          id: newLayerId,
          title: newLayerRow?.title ?? 'Основа',
        });
        // Fan out the standard deletion events of the trash auto-purge so
        // connected clients refresh (same fan-out as POST /trash/purge).
        for (const id of result.deleted_thought_ids) {
          deps.emit(req, networkId, 'thought.deleted', { id });
        }
        for (const id of result.deleted_link_ids) {
          deps.emit(req, networkId, 'link.deleted', { id });
        }
        sendSuccess(reply, { deleted: result.deleted, purged: result.purged, skipped: result.skipped });
      },
    );

    // --- Switch the session's current layer (§7.1): all later requests of
    // this (user, client) — reads and writes — run in the new layer.
    app.post(
      '/networks/:networkId/layers/:layerId/select',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, layerId } = req.params as LayerParams;
        const ndb = openRouteNetworkDbBase(deps, networkId, app.appLogger);
        // Task S9 (13-layers.md §12): record the seq boundary of the switch
        // so this session's next `resume`/`etn.changes.list` forces a full
        // resync instead of a delta spanning two different layers' filters.
        const switchedAtSeq = app.systemDb.getMaxEventSeq(networkId) ?? 0;
        const layer = setSessionLayer(
          ndb,
          req.auth!.user.id,
          req.auth!.clientId,
          layerId,
          switchedAtSeq,
        );
        // The mutating-response echo must reflect the *new* session layer.
        req.layerEcho = layer;
        // Already-connected sockets of this exact (user, client) session must
        // switch their live delivery filter now and learn their cache is
        // stale — the REST response alone would not reach an open WS.
        app.realtimeGateway.notifyLayerSwitch(networkId, req.auth!.user.id, req.auth!.clientId, layer);
        sendSuccess(reply, layer);
      },
    );

    // --- Merge the layer into its parent (S8, 13-layers.md §8; 03-server-api.md
    // §5a.6). Full merge (no `tables`) or a closed partial subset; any
    // conflict/closure failure is a 422 carrying the lists. The route runs on
    // the base-layer connection — the replay writes the target's rows
    // physically and the trash auto-purge deletes physically.
    app.post(
      '/networks/:networkId/layers/:layerId/merge',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, layerId } = req.params as LayerParams;
        const body = requestBody(req);

        let selection: MergeSelection | undefined;
        const tablesValue = body.tables;
        if (tablesValue !== undefined) {
          if (typeof tablesValue !== 'object' || tablesValue === null || Array.isArray(tablesValue)) {
            throw new EtnError(
              'VALIDATION_ERROR',
              'tables должен быть объектом { таблица: [id, …] }.',
              { field: 'tables' },
              req.id,
            );
          }
          selection = {};
          for (const [table, ids] of Object.entries(tablesValue as Record<string, unknown>)) {
            if (!(BRANCHABLE_TABLES as readonly string[]).includes(table)) {
              throw new EtnError(
                'VALIDATION_ERROR',
                `неизвестная ветвимая таблица «${table}».`,
                { field: 'tables', table, allowed: BRANCHABLE_TABLES },
                req.id,
              );
            }
            if (!Array.isArray(ids) || ids.some((item) => typeof item !== 'string')) {
              throw new EtnError(
                'VALIDATION_ERROR',
                `tables.${table} должен быть массивом строк (логических id строк слоя).`,
                { field: 'tables', table },
                req.id,
              );
            }
            selection[table as BranchableTable] = ids as string[];
          }
        }

        const ndb = openRouteNetworkDbBase(deps, networkId, app.appLogger);
        const result = mergeLayer(ndb, layerId, selection, req.auth!.user.id);

        // Exactly one `layer.merged` event per merge (04-realtime.md §11.4):
        // no per-row fan-out of the replayed rows — recipients resync fully.
        // The event's layer attribution is the merge target, not the session.
        const report: LayerMergeReport = {
          applied: result.applied,
          skipped: result.skipped,
          reorder_collapsed: result.reorder_collapsed,
          reserve_layer_id: result.reserve_layer_id,
          purged: result.purged,
        };
        deps.emit(req, networkId, 'layer.merged', {
          ...report,
          layer: result.merged_layer,
          target_layer: result.target_layer,
        }, { layerId: result.target_layer.id });
        // The trash auto-purge victims are ordinary deletions outside the
        // merge row set — fan out the standard events for them (as the layer
        // delete route does).
        for (const id of result.deleted_thought_ids) {
          deps.emit(req, networkId, 'thought.deleted', { id });
        }
        for (const id of result.deleted_link_ids) {
          deps.emit(req, networkId, 'link.deleted', { id });
        }
        sendSuccess(reply, report);
      },
    );
  };
}
