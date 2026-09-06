/**
 * Integration tests for the activity-log maintenance operations (задача
 * 6bcccd2b «Свёртка и обрезка журнала, авто-свёртка при слиянии слоёв»,
 * требования 76443b7e «свёртка», 9921a32b «обрезка», 1f7f789b
 * «авто-свёртка при слиянии слоя»).
 *
 *   * `POST /activity/rollup` — свёртка журнала до `until_ms` по семантике
 *     «живая сущность → создание + последняя правка, удалённая → единственная
 *     запись удаления»;
 *   * `POST /activity/truncate` — обрезка журнала до `until_ms` безусловно;
 *   * паритет REST/MCP для обеих операций (стандарт 9e5cff3f);
 *   * авто-свёртка при merge слоя — в основе по каждой затронутой сущности
 *     остаётся ровно одна итоговая запись;
 *   * удаление слоя без слияния — все его события исчезают без следа.
 *
 * Тесты идут через REST-инжекторы в обход UI: подтверждение операций — это
 * ответственность клиента, сервер сам по себе ничего не блокирует
 * (требование 6bcccd2b).
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';

import { describe, it } from 'node:test';

import type { ActivityRow, Layer } from '@etn/shared';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  toolJson,
  toolText,
  type McpTestContext,
} from './mcp-helpers.js';

interface ActivityRowWithLayer extends ActivityRow {
  layer_id: string | null;
}

interface ActivityListResponse {
  data: ActivityRowWithLayer[];
  meta: { total: number; offset: number; limit: number };
}

interface MergeResponse {
  data: {
    applied: Record<string, number>;
    skipped: unknown[];
    reorder_collapsed: unknown[];
    reserve_layer_id: string | null;
    purged: number;
    activity_rollup: { groups: number; removed: number };
  };
}

async function listAllActivity(
  ctx: RestTestContext,
  filter: Record<string, unknown> = {},
): Promise<ActivityRowWithLayer[]> {
  const params = new URLSearchParams();
  params.set('limit', '200');
  params.set('offset', '0');
  for (const [k, v] of Object.entries(filter)) params.set(k, String(v));
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/networks/${ctx.networkId}/activity?${params.toString()}`,
    headers: authHeaders(ctx),
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
  const json = res.json() as ActivityListResponse;
  return json.data;
}

async function callRollup(
  ctx: RestTestContext,
  untilMs: number,
): Promise<{ removed: number; kept: number }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/activity/rollup`,
    headers: authHeaders(ctx),
    payload: { until_ms: untilMs },
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
  return res.json().data as { removed: number; kept: number };
}

async function callTruncate(
  ctx: RestTestContext,
  untilMs: number,
): Promise<{ removed: number }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/activity/truncate`,
    headers: authHeaders(ctx),
    payload: { until_ms: untilMs },
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
  return res.json().data as { removed: number };
}

async function createThought(ctx: RestTestContext, title: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts`,
    headers: authHeaders(ctx),
    payload: { title },
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return (res.json().data as { id: string }).id;
}

async function updateThought(
  ctx: RestTestContext,
  id: string,
  changes: Record<string, unknown>,
): Promise<void> {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${id}`,
    headers: authHeaders(ctx),
    payload: changes,
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
}

async function deleteThought(ctx: RestTestContext, id: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${id}`,
    headers: authHeaders(ctx),
  });
  assert.ok(res.statusCode === 200 || res.statusCode === 204, res.body?.toString());
}

async function createLayer(ctx: RestTestContext, title: string): Promise<Layer> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/layers`,
    headers: authHeaders(ctx),
    payload: { title },
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return res.json().data as Layer;
}

async function selectLayer(ctx: RestTestContext, layerId: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/layers/${layerId}/select`,
    headers: authHeaders(ctx),
    payload: {},
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
}

async function mergeLayer(
  ctx: RestTestContext,
  layerId: string,
): Promise<MergeResponse['data']> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/layers/${layerId}/merge`,
    headers: authHeaders(ctx),
    payload: {},
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
  return (res.json() as MergeResponse).data;
}

async function deleteLayer(ctx: RestTestContext, layerId: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/v1/networks/${ctx.networkId}/layers/${layerId}`,
    headers: authHeaders(ctx),
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
}

describe('Activity maintenance (6bcccd2b)', { skip: !nativeAvailable() }, () => {
  describe('POST /activity/rollup', () => {
    it('оставляет создание + последнюю правку для живой сущности', async () => {
      const ctx = await buildRestContext();
      try {
        // Шаг 1: создаём мысль и три раза правим — получим 4 строки
        // (created + 3 × updated).
        const id = await createThought(ctx, 'A');
        await updateThought(ctx, id, { title: 'A1' });
        await updateThought(ctx, id, { title: 'A2' });
        await updateThought(ctx, id, { title: 'A3' });

        const before = await listAllActivity(ctx, { entity_id: id });
        assert.equal(before.length, 4);
        // Самая свежая запись — самая поздняя правка. Берём её `occurred_at_ms`
        // как границу: ≤ неё уйдут все 4 строки, и свёртка оставит
        // ровно `created + последний updated` = 2.
        const cutoff = before[0]!.occurred_at_ms;

        const result = await callRollup(ctx, cutoff);
        assert.equal(result.removed, 2, 'удалено 2 промежуточные строки');
        assert.equal(result.kept, 2, 'оставлены created + последняя updated');

        const after = await listAllActivity(ctx, { entity_id: id });
        assert.equal(after.length, 2);
        const actions = after.map((r) => r.action).sort();
        assert.deepEqual(actions, ['created', 'updated']);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('для удалённой сущности оставляет ровно одну запись удаления', async () => {
      const ctx = await buildRestContext();
      try {
        const id = await createThought(ctx, 'B');
        await updateThought(ctx, id, { title: 'B1' });
        await updateThought(ctx, id, { title: 'B2' });
        await deleteThought(ctx, id);

        const before = await listAllActivity(ctx, { entity_id: id });
        assert.equal(before.length, 4);
        // Самая свежая запись — удаление. Граница = её время: вся история
        // попадает в свёртку, и т.к. последнее событие — `deleted`, остаётся
        // только оно.
        const cutoff = before[0]!.occurred_at_ms;

        const result = await callRollup(ctx, cutoff);
        assert.equal(result.removed, 3, 'удалены created и обе промежуточные правки');
        assert.equal(result.kept, 1, 'осталась только запись удаления');

        const after = await listAllActivity(ctx, { entity_id: id });
        assert.equal(after.length, 1);
        assert.equal(after[0]!.action, 'deleted');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('не трогает записи позже until_ms', async () => {
      const ctx = await buildRestContext();
      try {
        const old = await createThought(ctx, 'old');
        // Любая запись до «новой» — наша граница.
        const oldFirst = (await listAllActivity(ctx, { entity_id: old }))[0]!;
        const newer = await createThought(ctx, 'newer');

        const result = await callRollup(ctx, oldFirst.occurred_at_ms);
        assert.equal(result.removed, 0);
        assert.equal(result.kept, 1);

        // Все свежие записи остались как есть.
        const fresh = await listAllActivity(ctx, { entity_id: newer });
        assert.equal(fresh.length, 1);
        assert.equal(fresh[0]!.action, 'created');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('откатывается при ошибке: на частичном прогрессе состояние не меняется', async () => {
      const ctx = await buildRestContext();
      try {
        const a = await createThought(ctx, 'atomic-a');
        const b = await createThought(ctx, 'atomic-b');
        await updateThought(ctx, a, { title: 'atomic-a-1' });
        await updateThought(ctx, b, { title: 'atomic-b-1' });

        // Передадим неверный until_ms (отрицательное число) — операция
        // должна выбросить ошибку валидации и не задеть журнал.
        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/activity/rollup`,
          headers: authHeaders(ctx),
          payload: { until_ms: -1 },
        });
        assert.equal(res.statusCode, 422);

        // Журнал не изменился — те же 4 строки.
        const after = await listAllActivity(ctx);
        assert.equal(after.length, 4);
      } finally {
        await closeRestContext(ctx);
      }
    });
  });

  describe('POST /activity/truncate', () => {
    it('удаляет все записи до until_ms включительно', async () => {
      const ctx = await buildRestContext();
      try {
        await createThought(ctx, 't1');
        await createThought(ctx, 't2');
        const midpoint = Date.now();

        // Небольшая задержка, чтобы следующие операции гарантированно
        // оказались позже `midpoint`.
        await new Promise((r) => setTimeout(r, 5));
        await createThought(ctx, 't3');

        const before = await listAllActivity(ctx);
        assert.ok(before.length >= 3);

        const result = await callTruncate(ctx, midpoint);
        assert.ok(result.removed >= 2);

        const after = await listAllActivity(ctx);
        assert.ok(
          after.length <= before.length - 2,
          `ожидали удаление ≥ 2 строк, осталось ${after.length} из ${before.length}`,
        );
        // Все оставшиеся записи — позже границы.
        for (const row of after) {
          assert.ok(row.occurred_at_ms > midpoint);
        }
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('возвращает removed=0 при пустом диапазоне', async () => {
      const ctx = await buildRestContext();
      try {
        await createThought(ctx, 'singleton');
        const result = await callTruncate(ctx, 0);
        assert.equal(result.removed, 0);
        const after = await listAllActivity(ctx);
        assert.equal(after.length, 1);
      } finally {
        await closeRestContext(ctx);
      }
    });
  });

  describe('авто-свёртка при merge слоя', () => {
    it('после merge в основе остаётся ровно одна итоговая запись на сущность', async () => {
      const ctx = await buildRestContext();
      try {
        // Сначала создаём мысль в основе — событие `created` относится к
        // базовой сессии (`layer_id = BASE_LAYER_ID`), не к null.
        const id = await createThought(ctx, 'mergeable');

        // Открываем слой, делаем три правки — получаем три события с
        // `layer_id = <новый слой>`.
        const layer = await createLayer(ctx, 'edit-layer');
        await selectLayer(ctx, layer.id);
        await updateThought(ctx, id, { title: 'm1' });
        await updateThought(ctx, id, { title: 'm2' });
        await updateThought(ctx, id, { title: 'm3' });

        const beforeMerge = await listAllActivity(ctx, { entity_id: id });
        // 1 (created, base) + 3 (updated, layer) = 4 строки.
        assert.equal(
          beforeMerge.length,
          4,
          `ожидали 4 строки до merge, получили ${beforeMerge.length}`,
        );

        // Сливаем слой.
        const report = await mergeLayer(ctx, layer.id);
        // Детальные записи слоя свернулись в одну итоговую группу, 3
        // детальные строки удалены.
        assert.equal(report.activity_rollup.groups, 1);
        assert.equal(report.activity_rollup.removed, 3);

        // В основе теперь две итоговые записи по сущности: оригинальный
        // `created` (из базовой сессии) + авто-свёрнутая `updated`
        // (со временем последней правки в слое, `layer_id = null` —
        // снимка слоя, не условия ленты).
        const afterMerge = await listAllActivity(ctx, { entity_id: id });
        assert.equal(
          afterMerge.length,
          2,
          `ожидали 2 итоговые строки, получили ${afterMerge.length}`,
        );
        const actions = afterMerge.map((r) => r.action).sort();
        assert.deepEqual(actions, ['created', 'updated']);
        // Авто-свёрнутая запись относится к основе: `layer_id = null`.
        const autoRow = afterMerge.find((r) => r.action === 'updated')!;
        assert.equal(autoRow.layer_id, null);
        // Время — самое позднее из детальных правок слоя.
        assert.equal(autoRow.occurred_at_ms, beforeMerge[0]!.occurred_at_ms);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('для сущности, только созданной в слое, итоговая запись — created', async () => {
      const ctx = await buildRestContext();
      try {
        // Открываем слой.
        const layer = await createLayer(ctx, 'create-layer');
        await selectLayer(ctx, layer.id);

        // Создаём мысль уже в слое.
        const id = await createThought(ctx, 'only-in-layer');
        await updateThought(ctx, id, { title: 'twice-1' });
        await updateThought(ctx, id, { title: 'twice-2' });

        const beforeMerge = await listAllActivity(ctx, { entity_id: id });
        assert.equal(beforeMerge.length, 3);
        assert.ok(beforeMerge.every((r) => r.layer_id === layer.id));

        await mergeLayer(ctx, layer.id);

        // После свёртки — ровно одна итоговая запись по сущности.
        const afterMerge = await listAllActivity(ctx, { entity_id: id });
        assert.equal(afterMerge.length, 1, `ожидали 1 итоговую запись, получили ${afterMerge.length}`);
        assert.equal(afterMerge[0]!.action, 'created');
        assert.equal(afterMerge[0]!.layer_id, null);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('для удалённой в слое сущности остаётся запись удаления', async () => {
      const ctx = await buildRestContext();
      try {
        // Создаём мысль в основе — событие `created` живёт в базовой
        // сессии и не затрагивается авто-свёрткой.
        const id = await createThought(ctx, 'to-delete-in-layer');

        // Открываем слой и удаляем мысль там.
        const layer = await createLayer(ctx, 'delete-layer');
        await selectLayer(ctx, layer.id);
        await deleteThought(ctx, id);

        await mergeLayer(ctx, layer.id);

        // Две итоговые записи: оригинальный `created` + авто-свёрнутый
        // `deleted` (из слоя).
        const afterMerge = await listAllActivity(ctx, { entity_id: id });
        assert.equal(
          afterMerge.length,
          2,
          `ожидали 2 итоговые строки, получили ${afterMerge.length}`,
        );
        const actions = afterMerge.map((r) => r.action).sort();
        assert.deepEqual(actions, ['created', 'deleted']);
      } finally {
        await closeRestContext(ctx);
      }
    });
  });

  describe('удаление слоя без слияния', () => {
    it('удаляет все события, привязанные к слою', async () => {
      const ctx = await buildRestContext();
      try {
        // Слой с двумя правками.
        const layer = await createLayer(ctx, 'doomed-layer');
        await selectLayer(ctx, layer.id);
        const id = await createThought(ctx, 'doomed-thought');
        await updateThought(ctx, id, { title: 'd1' });
        await updateThought(ctx, id, { title: 'd2' });

        const beforeDelete = await listAllActivity(ctx, { entity_id: id });
        assert.ok(beforeDelete.length >= 3);
        const layerEvents = beforeDelete.filter((r) => r.layer_id === layer.id);
        assert.ok(layerEvents.length >= 3);

        // Удаляем слой — события должны исчезнуть вместе с ним.
        await deleteLayer(ctx, layer.id);

        const afterDelete = await listAllActivity(ctx, { entity_id: id });
        assert.equal(
          afterDelete.length,
          0,
          `ожидали 0 строк после удаления слоя, получили ${afterDelete.length}`,
        );
      } finally {
        await closeRestContext(ctx);
      }
    });
  });

  describe('паритет REST/MCP', () => {
    it('etn.activity.rollup через MCP даёт тот же результат, что и REST на той же выборке', async () => {
      const restCtx = await buildRestContext();
      const overrides = {
        dataDir: restCtx.dataDir,
        systemDb: restCtx.sys,
        networkId: restCtx.networkId,
      };
      let mcpCtx: McpTestContext | undefined;
      try {
        // Создаём немного данных для свёртки.
        await createThought(restCtx, 'pariety-a');
        await createThought(restCtx, 'pariety-b');
        const all = await listAllActivity(restCtx);
        const cutoff = all[Math.floor(all.length / 2)]!.occurred_at_ms;

        // REST: свёртка половины записей.
        const restResult = await callRollup(restCtx, cutoff);

        // MCP-сессия поверх той же сети (разделяем dataDir / systemDb /
        // networkId с REST-фикстурой; `closeMcpContext` пропустит общие
        // ресурсы, чтобы `closeRestContext` потом отработал чисто).
        // Граница та же — MCP должен получить те же 0 удалений и
        // оставшиеся строки, что и REST после его свёртки.
        mcpCtx = await buildMcpContext(overrides);
        const handle = await connectMcpClient(mcpCtx, restCtx.adminKey);
        try {
          const callResult = await handle.client.callTool({
            name: 'etn.activity.rollup',
            arguments: { network_id: restCtx.networkId, until_ms: cutoff },
          });
          assert.equal(callResult.isError, undefined, toolText(callResult));
          const json = toolJson(callResult) as { removed: number; kept: number };
          // После REST обе операции (REST, потом MCP) идемпотентны на
          // этой выборке — повторный запуск свёртки на уже свёрнутых
          // данных должен вернуть (0, N).
          assert.equal(json.removed, 0);
          assert.equal(json.kept, restResult.kept);
        } finally {
          await handle.close();
        }
      } finally {
        if (mcpCtx) await closeMcpContext(mcpCtx, overrides);
        await closeRestContext(restCtx);
      }
    });

    it('etn.activity.truncate через MCP возвращает те же счётчики, что и REST', async () => {
      const restCtx = await buildRestContext();
      const overrides = {
        dataDir: restCtx.dataDir,
        systemDb: restCtx.sys,
        networkId: restCtx.networkId,
      };
      let mcpCtx: McpTestContext | undefined;
      try {
        // Сначала — REST truncate с одной границей.
        await createThought(restCtx, 'trunc-a');
        await createThought(restCtx, 'trunc-b');
        const midpoint = Date.now();
        await new Promise((r) => setTimeout(r, 5));
        await createThought(restCtx, 'trunc-c');
        const restResult = await callTruncate(restCtx, midpoint);

        // Затем MCP truncate по той же границе — должен вернуть
        // removed=0 (всё уже удалено REST'ом) — идемпотентность.
        mcpCtx = await buildMcpContext(overrides);
        const handle = await connectMcpClient(mcpCtx, restCtx.adminKey);
        try {
          const callResult = await handle.client.callTool({
            name: 'etn.activity.truncate',
            arguments: { network_id: restCtx.networkId, until_ms: midpoint },
          });
          assert.equal(callResult.isError, undefined, toolText(callResult));
          const json = toolJson(callResult) as { removed: number };
          assert.equal(json.removed, 0);
          // И свежие строки (trunc-c) на месте.
          const after = await listAllActivity(restCtx);
          assert.equal(after.length, 1);
          // `entity_title` хранится как снимок формата «мысль без типа, «…»».
          assert.match(after[0]!.entity_title, /«trunc-c»/);
          // Sanity-check: REST действительно что-то удалил.
          assert.ok(restResult.removed >= 2);
        } finally {
          await handle.close();
        }
      } finally {
        if (mcpCtx) await closeMcpContext(mcpCtx, overrides);
        await closeRestContext(restCtx);
      }
    });
  });
});
