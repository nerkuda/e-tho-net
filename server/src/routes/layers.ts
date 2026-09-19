/**
 * Change-layer routes (task S7, 03-server-api.md §5a; docs/13-layers.md
 * §2, §7, §10.1).
 *
 *   GET    /networks/:networkId/layers                  — list (+hierarchy meta)
 *   POST   /networks/:networkId/layers                  — create under a parent
 *   PATCH  /networks/:networkId/layers/:layerId         — rename / comment / colors
 *   DELETE /networks/:networkId/layers/:layerId?cascade=N — subtree delete
 *   POST   /networks/:networkId/layers/:layerId/select  — switch session layer
 *   POST   /networks/:networkId/layers/:layerId/merge   — merge into the parent (S8)
 *   GET    /networks/:networkId/layers/:layerId/diff     — structural diff (S11)
 *   GET    /networks/:networkId/layers/:layerId/diff/doc — textual diff (S11)
 *
 * Rights (13-layers.md §7.2): identical for every network member. The layer
 * metadata lives outside the branchable tables, so these handlers run on the
 * base-layer connection; the session's selected layer still marks the `current`
 * element of the list. Merge is a separate route (S8), not part of this CRUD.
 *
 * Веха 8 (задача c9d5f21e): вход разбирается едиными контрактами из
 * `contracts.ts` — теми же, что использует MCP-фасад (tools/layers.ts).
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { BASE_LAYER_ID, EtnError, type LayerMergeReport } from '@etn/shared';

import { sendSuccess } from '../http/responses.js';
import {
  openRouteNetworkDbBase,
  resolveRequestLayer,
  type RouteDeps,
} from './helpers.js';
import {
  createLayer,
  deleteLayerWithEvents,
  getLayerSnapshot,
  layerSubtreeIds,
  listLayers,
  setSessionLayer,
  updateLayer,
} from '../domain/layer-service.js';
import { mergeLayer, type MergeSelection } from '../domain/merge-service.js';
import { layerDiffDoc, resolveDiffTarget, structuralLayerDiff } from '../domain/layer-diff-service.js';
import { BRANCHABLE_TABLES } from '../db/layer-chain.js';
import type { BranchableTable } from '../db/layer-write.js';
import { closeNetworkDb, openNetworkDb } from '../db/network-db.js';
import { recordLayerActivity } from '../domain/activity-service.js';
import { LayersCreate, LayersDelete, LayersDiff, LayersDiffDoc, LayersList, LayersMerge, LayersSelect, LayersUpdate, parseRest } from '../contracts.js';

/** `/api/v1/networks*` layer routes plugin factory. */
export function createLayersRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    // --- List (§10.1): hierarchy + metadata; service layers hidden by default.
    app.get(
      '/networks/:networkId/layers',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(LayersList, req);
        const ndb = openRouteNetworkDbBase(deps, input.network_id, app.appLogger);
        const current = resolveRequestLayer(deps.dataDir, req, input.network_id, app.appLogger);
        sendSuccess(reply, listLayers(ndb, { includeService: input.include_service, currentLayerId: current.id }));
      },
    );

    // --- Create (§2.3): under the given parent, default — the session's
    // current layer. Depth limit enforced in the service (422 above 4 levels).
    app.post(
      '/networks/:networkId/layers',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(LayersCreate, req);
        const ndb = openRouteNetworkDbBase(deps, input.network_id, app.appLogger);
        // §2.3: «от указанного родителя (по умолчанию — текущий слой сессии)».
        // Resolve the session layer once and reuse it both as the implicit
        // parent and as the `current` reference for the response: POST /layers
        // must not switch the session, so `current` is computed against the
        // real session layer, not against the newly created layer's id
        // (fix for error 9b159e7a — created.layer.current was always `true`).
        const sessionLayer = resolveRequestLayer(deps.dataDir, req, input.network_id, app.appLogger);
        const parent = input.parent_id ?? sessionLayer.id;
        const layer = createLayer(ndb, {
          parentId: parent,
          title: input.title,
          comment: input.comment,
          gitBranch: input.git_branch,
          colors: (input.colors ?? null) as Parameters<typeof createLayer>[1]['colors'],
          createdBy: req.auth!.user.id,
        });
        recordLayerActivity(ndb, {
          networkId: input.network_id,
          userId: req.auth!.user.id,
          action: 'created',
          layer,
          layerId: req.layerEcho?.id ?? null,
        });
        const layerWithCurrent = { ...layer, current: layer.id === sessionLayer.id };
        sendSuccess(reply, layerWithCurrent, { version: layer.version }, 201);
      },
    );

    // --- Rename / edit comment / replace colours (§2.2, §2.2a): base title is
    // fixed (422), base never carries colours (422).
    app.patch(
      '/networks/:networkId/layers/:layerId',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(LayersUpdate, req);
        // Full replacement of the whole colours object (or null → theme
        // defaults); partial objects are rejected by the validator.
        const colors = input.colors as Parameters<typeof updateLayer>[2]['colors'] | undefined;
        if (input.title === undefined && input.comment === undefined && colors === undefined) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'нечего менять: передайте title и/или comment и/или colors.',
            { fields: ['title', 'comment', 'colors'] },
            req.id,
          );
        }
        const ndb = openRouteNetworkDbBase(deps, input.network_id, app.appLogger);
        // PATCH must not switch the session either: `current` is computed
        // against the real session layer, not against the edited layer's id
        // (same pattern as the createLayer fix 9b159e7a — layer.current used
        // to be always `true` here).
        const sessionLayer = resolveRequestLayer(deps.dataDir, req, input.network_id, app.appLogger);
        const layer = updateLayer(
          ndb,
          input.layer_id,
          {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.comment !== undefined ? { comment: input.comment } : {}),
            ...(colors !== undefined ? { colors } : {}),
          },
          input.expected_version,
          req.auth!.user.id,
        );
        recordLayerActivity(ndb, {
          networkId: input.network_id,
          userId: req.auth!.user.id,
          action: 'updated',
          layer,
          layerId: req.layerEcho?.id ?? null,
        });
        const layerWithCurrent = { ...layer, current: layer.id === sessionLayer.id };
        sendSuccess(reply, layerWithCurrent, { version: layer.version, updated_at: layer.last_activity_at });
      },
    );

    // --- Delete (§2.4): subtree cascade with an explicit confirmation.
    app.delete(
      '/networks/:networkId/layers/:layerId',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(LayersDelete, req);

        // Close the doomed layers' pooled connections first: their temp
        // `layer_chain` would otherwise keep referencing deleted layers.
        const ndb = openRouteNetworkDbBase(deps, input.network_id, app.appLogger);
        const subtreeIds = layerSubtreeIds(ndb, input.layer_id);
        const parentRow = getLayerSnapshot(ndb, input.layer_id);
        for (const id of subtreeIds) {
          if (id !== BASE_LAYER_ID) {
            closeNetworkDb(input.network_id, id);
          }
        }

        // Task S9 (13-layers.md §2.4, §12): re-pointed sessions must be
        // forced into a full resync — record the network's current seq
        // before the cascade so `switched_at_seq` reflects "everything from
        // here on assumes the new layer".
        const switchedAtSeq = app.systemDb.getMaxEventSeq(input.network_id) ?? 0;
        const result = deleteLayerWithEvents(ndb, input.layer_id, input.cascade, switchedAtSeq);
        // Sessions sitting on the deleted subtree were re-pointed to the
        // parent inside the transaction — drop this request's memoised echo
        // so the onSend hook resolves the post-switch layer.
        req.layerEcho = undefined;
        // Push a forced-resync control frame to every already-connected
        // socket sitting on the deleted subtree (13-layers.md §2.4).
        const newLayerId = parentRow?.parent_id ?? BASE_LAYER_ID;
        const newLayerRow = getLayerSnapshot(ndb, newLayerId);
        app.realtimeGateway.notifyLayerDeleted(input.network_id, new Set(subtreeIds), {
          id: newLayerId,
          title: newLayerRow?.title ?? 'Основа',
        });
        // Fan out the standard deletion events of the trash auto-purge so
        // connected clients refresh (same fan-out as POST /trash/purge).
        for (const id of result.deleted_thought_ids) {
          deps.emit(req, input.network_id, 'thought.deleted', { id });
        }
        for (const id of result.deleted_link_ids) {
          deps.emit(req, input.network_id, 'link.deleted', { id });
        }
        if (parentRow) {
          // Сохраняем снимок названия до того, как `deleteLayerWithEvents`
          // физически удалил строку. Слой на момент записи — это текущий
          // сессионный слой после возможного пере-указания; у нас он
          // уже сброшен (`req.layerEcho = undefined` выше), поэтому
          // используем `newLayerId` — именно туда переведены сессии
          // поддерева.
          recordLayerActivity(ndb, {
            networkId: input.network_id,
            userId: req.auth!.user.id,
            action: 'deleted',
            layer: { id: input.layer_id, title: parentRow.title },
            layerId: newLayerId,
          });
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
        const input = parseRest(LayersSelect, req);
        const ndb = openRouteNetworkDbBase(deps, input.network_id, app.appLogger);
        // Task S9 (13-layers.md §12): record the seq boundary of the switch
        // so this session's next `resume`/`etn.changes.list` forces a full
        // resync instead of a delta spanning two different layers' filters.
        const switchedAtSeq = app.systemDb.getMaxEventSeq(input.network_id) ?? 0;
        const layer = setSessionLayer(
          ndb,
          req.auth!.user.id,
          req.auth!.clientId,
          input.layer_id,
          switchedAtSeq,
        );
        // The mutating-response echo must reflect the *new* session layer.
        req.layerEcho = layer;
        // Already-connected sockets of this exact (user, client) session must
        // switch their live delivery filter now and learn their cache is
        // stale — the REST response alone would not reach an open WS.
        app.realtimeGateway.notifyLayerSwitch(input.network_id, req.auth!.user.id, req.auth!.clientId, layer);
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
        const input = parseRest(LayersMerge, req);

        let selection: MergeSelection | undefined;
        if (input.tables !== undefined) {
          selection = {};
          for (const [table, ids] of Object.entries(input.tables as Record<string, string[]>)) {
            if (!(BRANCHABLE_TABLES as readonly string[]).includes(table)) {
              throw new EtnError(
                'VALIDATION_ERROR',
                `неизвестная ветвимая таблица «${table}».`,
                { field: 'tables', table, allowed: BRANCHABLE_TABLES },
                req.id,
              );
            }
            selection[table as BranchableTable] = ids;
          }
        }

        const ndb = openRouteNetworkDbBase(deps, input.network_id, app.appLogger);
        const result = mergeLayer(ndb, input.layer_id, selection, req.auth!.user.id);

        // Exactly one `layer.merged` event per merge (04-realtime.md §11.4):
        // no per-row fan-out of the replayed rows — recipients resync fully.
        // The event's layer attribution is the merge target, not the session.
        const report: LayerMergeReport = {
          applied: result.applied,
          skipped: result.skipped,
          reorder_collapsed: result.reorder_collapsed,
          reserve_layer_id: result.reserve_layer_id,
          purged: result.purged,
          activity_rollup: result.activity_rollup,
        };
        deps.emit(req, input.network_id, 'layer.merged', {
          ...report,
          layer: result.merged_layer,
          target_layer: result.target_layer,
        }, { layerId: result.target_layer.id });
        // The trash auto-purge victims are ordinary deletions outside the
        // merge row set — fan out the standard events for them (as the layer
        // delete route does).
        for (const id of result.deleted_thought_ids) {
          deps.emit(req, input.network_id, 'thought.deleted', { id });
        }
        for (const id of result.deleted_link_ids) {
          deps.emit(req, input.network_id, 'link.deleted', { id });
        }
        sendSuccess(reply, report);
      },
    );

    // --- Structural diff (S11, 13-layers.md §10.3; 03-server-api.md §5a.7):
    // the compact link-structure list the textual diff is blind to. Reads run
    // on two connections — the layer's own context and its parent's.
    app.get(
      '/networks/:networkId/layers/:layerId/diff',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(LayersDiff, req);
        const ndb = openRouteNetworkDbBase(deps, input.network_id, app.appLogger);
        const { layer, target } = resolveDiffTarget(ndb, input.layer_id);
        const layerNdb = openNetworkDb(deps.dataDir, input.network_id, app.appLogger, layer.id);
        const targetNdb = openNetworkDb(deps.dataDir, input.network_id, app.appLogger, target.id);
        sendSuccess(reply, structuralLayerDiff(layerNdb, targetNdb, layer, target));
      },
    );

    // --- Textual diff (S11, §10.3): two deterministically assembled markdown
    // documents for a plain text diff on the client.
    app.get(
      '/networks/:networkId/layers/:layerId/diff/doc',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(LayersDiffDoc, req);
        const ndb = openRouteNetworkDbBase(deps, input.network_id, app.appLogger);
        const { layer, target } = resolveDiffTarget(ndb, input.layer_id);
        const layerNdb = openNetworkDb(deps.dataDir, input.network_id, app.appLogger, layer.id);
        const targetNdb = openNetworkDb(deps.dataDir, input.network_id, app.appLogger, target.id);
        sendSuccess(reply, layerDiffDoc(layerNdb, targetNdb, layer, target));
      },
    );
  };
}
