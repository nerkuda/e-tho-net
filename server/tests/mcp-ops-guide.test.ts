/**
 * Сквозные тесты `etn.guide` + `etn.ops` (задача 86ef2ff4, версия 0.8.3).
 *
 * Покрывают: реестр гайда (≤ 10 КБ) и инструкцию по `topic`; диспетчер
 * `etn.ops` — неизвестное действие, confirm-отказ для деструктивных, обход по
 * группам действий (locks, attachments, activity, layers, thoughts, trash,
 * export, metrics, networks, members, changes, comments, properties/usage).
 * Детальные семантики групп живут в профильных тестах (`mcp-locks`,
 * `mcp-activity`, `mcp-layers`, `mcp-p3`, `mcp-tools`, `mcp-networks-write`),
 * переведённых на `etn.ops` тем же кодмодом; здесь — сквозная проверка, что
 * каждая группа достижима через диспетчер.
 *
 * Пропускается, если нативный биндинг `better-sqlite3` недоступен.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OPS_ACTION_NAMES } from '../src/mcp/tools/ops-catalog.js';
import {
  callOp,
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  createThoughtViaWrite,
  nativeAvailable,
  toolJson,
  toolText,
} from './mcp-helpers.js';

describe('etn.guide + etn.ops (86ef2ff4)', { skip: !nativeAvailable() }, () => {
  it('etn.guide без topic отдаёт реестр ≤ 10 КБ и перечисляет все действия', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const res = await handle.client.callTool({ name: 'etn.guide', arguments: {} });
        assert.equal(res.isError, undefined, toolText(res));
        const text = toolText(res);
        assert.ok(
          Buffer.byteLength(text, 'utf8') <= 10_240,
          `реестр гайда ${Buffer.byteLength(text, 'utf8')} Б — превышает бюджет 10 КБ`,
        );
        for (const action of OPS_ACTION_NAMES) {
          assert.ok(text.includes(`**${action}**`), `реестр не упоминает действие ${action}`);
        }
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.guide { topic } отдаёт инструкцию, неизвестный topic → VALIDATION_ERROR', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const res = await handle.client.callTool({
          name: 'etn.guide',
          arguments: { topic: 'layers.merge' },
        });
        assert.equal(res.isError, undefined, toolText(res));
        const text = toolText(res);
        assert.match(text, /confirm: true/);
        assert.match(text, /tables/);
        assert.match(text, /missing_closure/);

        const bad = await handle.client.callTool({
          name: 'etn.guide',
          arguments: { topic: 'no.such.action' },
        });
        assert.equal(bad.isError, true);
        assert.match(toolText(bad), /VALIDATION_ERROR/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.ops: неизвестное действие → VALIDATION_ERROR со списком допустимых', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const res = await callOp(handle.client, 'no.such.action', { network_id: ctx.networkId });
        assert.equal(res.isError, true);
        const text = toolText(res);
        assert.match(text, /VALIDATION_ERROR/);
        assert.match(text, /Неизвестное действие/);
        assert.match(text, /locks\.acquire/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.ops: деструктивное без confirm → VALIDATION_ERROR, с confirm проходит', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const thought = await createThoughtViaWrite(handle.client, ctx.networkId, {
          title: 'Кандидат на удаление',
        });

        // Без подтверждения — отказ.
        const refused = await callOp(handle.client, 'thoughts.delete', {
          network_id: ctx.networkId,
          thought_id: thought.id,
        });
        assert.equal(refused.isError, true);
        assert.match(toolText(refused), /VALIDATION_ERROR/);
        assert.match(toolText(refused), /confirm/);

        // С подтверждением — проходит.
        const ok = await callOp(
          handle.client,
          'thoughts.delete',
          { network_id: ctx.networkId, thought_id: thought.id },
          true,
        );
        assert.equal(ok.isError, undefined, toolText(ok));
        assert.equal(toolJson<{ id: string; version: number }>(ok).id, thought.id);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.ops: невалидные params дают каноническую VALIDATION_ERROR действия', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // `layers.create` без обязательного title — та же схема, что была у
        // снятого инструмента.
        const res = await callOp(handle.client, 'layers.create', { network_id: ctx.networkId });
        assert.equal(res.isError, true);
        assert.match(toolText(res), /VALIDATION_ERROR/);
        assert.match(toolText(res), /title/);

        // Лишний ключ верхнего уровня у params отвергается strict-схемой.
        const extra = await callOp(handle.client, 'layers.create', {
          network_id: ctx.networkId,
          title: 'X',
          bogus: 1,
        });
        assert.equal(extra.isError, true);
        assert.match(toolText(extra), /VALIDATION_ERROR/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.ops: каждая группа действий исполняется через диспетчер', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      const c = handle.client;
      const net = ctx.networkId;
      try {
        const thought = await createThoughtViaWrite(c, net, {
          title: 'Подопытная мысль',
          link: { direction: 'parent', target_thought_id: ctx.homeId },
        });

        // ---- networks / members / changes (read) ----
        const networks = toolJson<Array<{ id: string }>>(
          await callOp(c, 'networks.list', {}, false).then((r) => {
            assert.equal(r.isError, undefined, toolText(r));
            return r;
          }),
        );
        assert.ok(networks.some((n) => n.id === net));
        assert.equal(
          (await callOp(c, 'members.list', { network_id: net })).isError,
          undefined,
        );
        const changes = toolJson<{ events: unknown[] }>(
          await callOp(c, 'changes.list', { network_id: net, since_seq: 0 }),
        );
        assert.ok(Array.isArray(changes.events));

        // ---- metrics (read) ----
        assert.equal((await callOp(c, 'metrics.reads', { network_id: net })).isError, undefined);
        assert.equal((await callOp(c, 'metrics.tools', {})).isError, undefined);

        // ---- locks ----
        const acq = toolJson<{ entity_id: string; client_id: string | null }>(
          await callOp(c, 'locks.acquire', {
            network_id: net,
            entity_type: 'thought',
            entity_id: thought.id,
          }),
        );
        assert.equal(acq.client_id, null);
        const lockList = toolJson<{ data: unknown[] }>(
          await callOp(c, 'locks.list', { network_id: net }),
        );
        assert.ok(lockList.data.length >= 1);
        const lockRow = toolJson<{ id: string }>(
          await callOp(c, 'locks.acquire', {
            network_id: net,
            entity_type: 'thought',
            entity_id: thought.id,
          }),
        );
        assert.equal(
          (await callOp(c, 'locks.release', { network_id: net, lock_id: lockRow.id })).isError,
          undefined,
        );

        // ---- attachments ----
        const att = toolJson<{ id: string }>(
          await callOp(c, 'attachments.add', {
            network_id: net,
            owner_type: 'thought',
            owner_id: thought.id,
            kind: 'url',
            url: 'https://example.org/doc',
            title: 'Документ',
          }),
        );
        const found = toolJson<unknown[]>(
          await callOp(c, 'attachments.search', { network_id: net, q: 'example' }),
        );
        assert.ok(found.length >= 1);
        assert.equal(
          (
            await callOp(c, 'attachments.delete', { network_id: net, attachment_id: att.id }, true)
          ).isError,
          undefined,
        );

        // ---- activity ----
        const rolled = toolJson<{ removed: number; kept: number }>(
          await callOp(c, 'activity.rollup', { network_id: net, until_ms: 0 }),
        );
        assert.equal(typeof rolled.removed, 'number');

        // ---- layers ----
        const layer = toolJson<{ id: string }>(
          await callOp(c, 'layers.create', { network_id: net, title: 'Сквозной слой' }),
        );
        assert.equal((await callOp(c, 'layers.diff', { network_id: net, layer_id: layer.id })).isError, undefined);
        assert.equal(
          (await callOp(c, 'layers.diff_doc', { network_id: net, layer_id: layer.id })).isError,
          undefined,
        );
        const renamed = toolJson<{ title: string }>(
          await callOp(c, 'layers.update', { network_id: net, layer_id: layer.id, title: 'Сквозной слой v2' }),
        );
        assert.equal(renamed.title, 'Сквозной слой v2');
        assert.equal(
          (await callOp(c, 'layers.merge', { network_id: net, layer_id: layer.id }, true)).isError,
          undefined,
        );

        // Отдельный слой — под удаление (после merge исходного уже нет).
        const layer2 = toolJson<{ id: string }>(
          await callOp(c, 'layers.create', { network_id: net, title: 'Слой на удаление' }),
        );
        assert.equal(
          (await callOp(c, 'layers.delete', { network_id: net, layer_id: layer2.id }, true)).isError,
          undefined,
        );

        // ---- thoughts (read) ----
        assert.equal(
          (await callOp(c, 'thoughts.path', { network_id: net, from_id: ctx.homeId, to_id: thought.id }))
            .isError,
          undefined,
        );
        assert.equal(
          (await callOp(c, 'thoughts.mentions', { network_id: net, thought_id: thought.id })).isError,
          undefined,
        );
        assert.equal(
          (await callOp(c, 'thoughts.backlinks', { network_id: net, thought_id: thought.id })).isError,
          undefined,
        );
        assert.equal(
          (await callOp(c, 'thoughts.deletion_check', { network_id: net, thought_ids: [thought.id] }))
            .isError,
          undefined,
        );
        assert.equal(
          (
            await callOp(c, 'thoughts.mentions_scan', {
              network_id: net,
              text: 'текст без упоминаний',
              use_synonyms: true,
            })
          ).isError,
          undefined,
        );

        // ---- properties.remove / usage_clear ----
        // `properties.remove` по реальному свойству-связи покрыт в
        // `mcp-tools.test.ts` (переведён на `etn.ops`); здесь — `usage_clear`.
        const cleared = toolJson<{ cleared: number }>(
          await callOp(c, 'usage_clear', { network_id: net, thought_id: thought.id }),
        );
        assert.equal(cleared.cleared, 0);

        // ---- export ----
        const exported = toolJson<{ format: string; content: string }>(
          await callOp(c, 'export.subgraph', { network_id: net, seed_ids: [thought.id], radius: 0 }),
        );
        assert.equal(exported.format, 'markdown');
        assert.equal(typeof exported.content, 'string');

        // ---- trash ----
        await callOp(
          c,
          'thoughts.delete',
          { network_id: net, thought_id: thought.id },
          true,
        );
        const trash = toolJson<{ thoughts: unknown[] }>(
          await callOp(c, 'trash.list', { network_id: net }),
        );
        assert.ok(Array.isArray(trash.thoughts));
        assert.equal((await callOp(c, 'trash.purge', { network_id: net }, true)).isError, undefined);

        // ---- comments.delete ----
        const withComment = await createThoughtViaWrite(c, net, {
          title: 'С комментарием',
          comment: { body_md: 'временный комментарий' },
        });
        await c.callTool({
          name: 'etn.comments.get',
          arguments: { network_id: net, thought_id: withComment.id },
        });
        const commentId = toolJson<{ permanent: { id: string } | null }>(
          await c.callTool({
            name: 'etn.comments.get',
            arguments: { network_id: net, thought_id: withComment.id },
          }),
        ).permanent?.id;
        assert.ok(typeof commentId === 'string');
        assert.equal(
          (await callOp(c, 'comments.delete', { network_id: net, comment_id: commentId }, true)).isError,
          undefined,
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
