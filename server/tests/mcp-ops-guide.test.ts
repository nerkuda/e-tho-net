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

import { formatCrossNetworkAddress } from '@etn/shared';

import { GUIDE_TOPIC_NAMES, OPS_ACTION_NAMES } from '../src/mcp/tools/ops-catalog.js';
import { NetworkServiceImpl } from '../src/domain/network-service.js';
import { createLogger } from '../src/logger.js';
import { closeNetworkDb } from '../src/db/network-db.js';
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
        for (const topic of GUIDE_TOPIC_NAMES) {
          assert.ok(text.includes(`**${topic}**`), `реестр не упоминает тему ${topic}`);
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

        // 0.8.3 (задача 2bf09236): детали частых операций вынесены в темы
        // гайда — они отдаются по `topic` без бюджета префилла.
        const ontologyTopic = await handle.client.callTool({
          name: 'etn.guide',
          arguments: { topic: 'ontology.write' },
        });
        assert.equal(ontologyTopic.isError, undefined, toolText(ontologyTopic));
        assert.match(toolText(ontologyTopic), /value_type/);
        assert.match(toolText(ontologyTopic), /reparent_blocked_by_layer/);
        // 8c64fdd4: тема обязана однозначно говорить, что принимают `parent`
        // и `id`, — `parent` только id (имя не резолвится), `id` только
        // существующий элемент.
        // f14962ca: явный `parent` работает и на патче существующего типа,
        // `parent: null` — прикрепление под корневой тип.
        const ontologyText = toolText(ontologyTopic);
        assert.match(ontologyText, /Адресация и создание элементов/);
        assert.match(ontologyText, /`parent` — id существующего/);
        assert.match(ontologyText, /`null` — прикрепить тип под\s*\n?корневой/);
        assert.match(ontologyText, /id ему\s*\n?генерирует сервер|генерирует сервер/);
        // 16766f82: тема обязана говорить, что явный `parent_link_type_id`
        // работает и на патче существующего свойства-связи (`null` — под
        // корневой тип связи, пропущенный ключ родителя не трогает).
        assert.match(ontologyText, /`parent_link_type_id` работает и на патче/);
        assert.match(ontologyText, /`null` — прикрепить под корневой тип связи/);

        const queryTopic = await handle.client.callTool({
          name: 'etn.guide',
          arguments: { topic: 'thoughts.query' },
        });
        assert.equal(queryTopic.isError, undefined, toolText(queryTopic));
        assert.match(toolText(queryTopic), /any_of/);

        // Ошибка e05d4688: описание `etn.thoughts.write` ссылается на
        // `etn.how_to_write_batch` — тема обязана находиться в обеих формах.
        const writeTopic = await handle.client.callTool({
          name: 'etn.guide',
          arguments: { topic: 'how_to_write_batch' },
        });
        assert.equal(writeTopic.isError, undefined, toolText(writeTopic));
        assert.match(toolText(writeTopic), /target_ref/);
        assert.match(toolText(writeTopic), /on_duplicate/);
        assert.match(toolText(writeTopic), /MCP_MAX_THOUGHTS_PER_WRITE/);

        const writeTopicEtn = await handle.client.callTool({
          name: 'etn.guide',
          arguments: { topic: 'etn.how_to_write_batch' },
        });
        assert.equal(writeTopicEtn.isError, undefined, toolText(writeTopicEtn));
        assert.equal(toolText(writeTopicEtn), toolText(writeTopic));

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

  it('etn.ops: допакованные действия d379e091 (trash / links.restore / properties.resolve / ontology.delete)', async () => {
    const ctx = await buildMcpContext();
    let net2Id: string | null = null;
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      const c = handle.client;
      const net = ctx.networkId;
      try {
        // ---- thoughts.trash: в корзину и обратно (обратимо, без confirm) ----
        const thought = await createThoughtViaWrite(c, net, {
          title: 'Корзина через ops',
          link: { direction: 'parent', target_thought_id: ctx.homeId },
        });
        assert.equal(
          (
            await callOp(c, 'thoughts.trash', {
              network_id: net,
              thought_id: thought.id,
              trashed: true,
            })
          ).isError,
          undefined,
        );
        const trash = toolJson<{ thoughts: Array<{ id: string }> }>(
          await callOp(c, 'trash.list', { network_id: net }),
        );
        assert.ok(trash.thoughts.some((t) => t.id === thought.id), 'мысль должна быть в корзине');
        assert.equal(
          (
            await callOp(c, 'thoughts.trash', {
              network_id: net,
              thought_id: thought.id,
              trashed: false,
            })
          ).isError,
          undefined,
        );

        // ---- links.restore: связь-свойство в корзину и обратно ----
        const source = await createThoughtViaWrite(c, net, { title: 'Источник связи' });
        const target = await createThoughtViaWrite(c, net, { title: 'Цель связи' });
        const linkId = toolJson<{ link_id: string }>(
          await c.callTool({
            name: 'etn.properties.add',
            arguments: {
              network_id: net,
              owner_type: 'thought',
              owner_id: source.id,
              key: 'Потомки',
              value: target.id,
            },
          }),
        ).link_id;
        await callOp(c, 'properties.remove', {
          network_id: net,
          owner_type: 'thought',
          owner_id: source.id,
          key: 'Потомки',
          value: target.id,
        });
        assert.equal(
          (await callOp(c, 'links.restore', { network_id: net, link_id: linkId })).isError,
          undefined,
        );

        // ---- properties.resolve: служебный резолв cross_network_ref ----
        // Целевая мысль — во ВТОРОЙ сети. Значение-адрес пишем ЧЕСТНО через
        // `etn.thoughts.write` (свойство вида `cross_network_ref`, задача
        // 7849008a): запись делает живой резолв цели и заполняет снапшот имени.
        // Прямой вставки в БД больше не нужно — разделённый с чтением столбец
        // `value_text` чинится в `storageColumn` (ошибка 052c84b2). Здесь же
        // проверяется действие `properties.resolve` над записанным значением.
        const net2 = await new NetworkServiceImpl(ctx.sys, ctx.dataDir, createLogger('silent')).createNetwork(
          ctx.adminId,
          'Вторая сеть (resolve)',
        );
        net2Id = net2.id;
        const targetIn2 = await createThoughtViaWrite(c, net2.id, { title: 'Цель во второй сети' });

        // Реестр: свойство `cross_network_ref` и его привязка к типу владельца
        // (иначе `setPropertyValue` отвергнет значение как внетиповое).
        const ontol = toolJson<{ properties?: Array<{ id: string }> }>(
          await c.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: net,
              thought_types: [{ ref: 'xt', name: 'XRefHolder' }],
              properties: [{ ref: 'xr', name: 'кросс-ссылка', value_type: 'cross_network_ref' }],
              type_properties: [{ owner: 'thought_type', type_ref: 'xt', property_ref: 'xr' }],
            },
          }),
        );
        assert.ok(ontol.properties?.[0]?.id, 'свойство cross_network_ref не создано');

        const address = formatCrossNetworkAddress(net2.id, targetIn2.id);
        const holder = await createThoughtViaWrite(c, net, {
          title: 'Владелец ссылки',
          type: 'XRefHolder',
          properties: { 'кросс-ссылка': address },
        });

        // Чтение записанного значения: карточка владельца отдаёт разобранную
        // кросс-ссылку (адрес + снапшот имени, без вскрытия чужой базы).
        const holderCard = toolJson<{
          properties: Array<{
            property_name?: string;
            value?: Array<{ network_id?: string; thought_id?: string; unresolved?: boolean }>;
          }>;
        }>(
          await c.callTool({ name: 'etn.thoughts.get', arguments: { network_id: net, thought_id: holder.id } }),
        );
        const stored = holderCard.properties.find((p) => p.property_name === 'кросс-ссылка')?.value;
        assert.equal(stored?.length, 1, 'карточка владельца должна отдать одну кросс-ссылку');
        assert.equal(stored[0]?.network_id, net2.id);
        assert.equal(stored[0]?.thought_id, targetIn2.id);
        assert.equal(stored[0]?.unresolved, false);

        const resolvedRaw = await callOp(c, 'properties.resolve', {
          network_id: net,
          owner_type: 'thought',
          owner_id: holder.id,
          key: 'кросс-ссылка',
        });
        const resolved = toolJson<{ values: Array<{ title_snapshot: string; unresolved: boolean }> }>(
          resolvedRaw,
        );
        assert.equal(resolved.values.length, 1, 'резолв должен вернуть одно значение');
        assert.equal(resolved.values[0]!.unresolved, false, toolText(resolvedRaw));
        assert.equal(resolved.values[0]!.title_snapshot, 'Цель во второй сети');

        // ---- ontology.delete: confirm-отказ и успех с confirm ----
        const typeToDelete = toolJson<{ thought_types: Array<{ id: string }> }>(
          await c.callTool({
            name: 'etn.ontology.write',
            arguments: { network_id: net, thought_types: [{ ref: 'dt', name: 'DeleteMeType' }] },
          }),
        ).thought_types[0]!;

        const refused = await callOp(c, 'ontology.delete', {
          network_id: net,
          kind: 'thought_type',
          id: typeToDelete.id,
        });
        assert.equal(refused.isError, true, 'деструктив без confirm должен быть отвергнут');
        assert.match(toolText(refused), /VALIDATION_ERROR/);
        assert.match(toolText(refused), /confirm/);

        const deleted = await callOp(
          c,
          'ontology.delete',
          { network_id: net, kind: 'thought_type', id: typeToDelete.id },
          true,
        );
        assert.equal(deleted.isError, undefined, toolText(deleted));
        assert.equal(toolJson<{ deleted: boolean }>(deleted).deleted, true);
      } finally {
        await handle.close();
      }
    } finally {
      if (net2Id !== null) closeNetworkDb(net2Id);
      await closeMcpContext(ctx);
    }
  });
});
