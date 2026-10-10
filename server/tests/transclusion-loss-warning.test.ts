/**
 * ТП2 «Трансклюзии комментариев», задача `ed796c43` — предупреждение при
 * записи, теряющей трансклюзии (требование `822a9149`).
 *
 * Проверяется сквозной серверный механизм, общий для MCP и REST: перед
 * применением правки `body_md` сервер парсером `@etn/markdown` сравнивает
 * МНОЖЕСТВА id трансклюзий «до → после»; исчезновение любого ранее
 * существовавшего id даёт предупреждение `TRANSCLUSION_LOST` со списком
 * источников, но запись НЕ отклоняется.
 *
 * Покрытые пути записи:
 *   * `etn.comments.update` (MCP) — возвращает `warnings`;
 *   * `etn.comments.edit` (MCP, секционная правка) — возвращает `warnings`;
 *   * `etn.thoughts.write` c `comment` (MCP, батч) — `warnings` батча/элемента;
 *   * `PATCH /networks/{nid}/comments/{id}` (REST) — `meta.warnings`.
 *
 * Кейсы: полная потеря (прочитанная развёртка записана обратно), потеря одной
 * из нескольких, замена id `A → B`, запись без потерь (предупреждения нет).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openNetworkDb } from '../src/db/network-db.js';
import { createLinkType } from '../src/domain/link-type-service.js';
import { createTypeProperty } from '../src/domain/property-service.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';

import {
  buildMcpContext,
  callWrite,
  closeMcpContext,
  connectMcpClient,
  createThoughtViaWrite,
  nativeAvailable,
  toolJson,
  upsertPermanentViaWrite,
} from './mcp-helpers.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable as restNativeAvailable,
} from './rest-helpers.js';

interface TransclusionLostWarningDto {
  code: string;
  sources: string[];
}

interface CommentsGetByThought {
  thought_id: string;
  permanent: { id: string; body_md: string } | null;
}

interface CommentUpdateResult {
  id: string;
  version: number;
  warnings?: TransclusionLostWarningDto[];
}

interface CommentEditResult {
  id: string;
  version: number;
  warnings?: TransclusionLostWarningDto[];
}

/** Одна мысль с постоянным комментарием; возвращает её id. */
async function makeThoughtWithComment(
  client: Parameters<typeof upsertPermanentViaWrite>[0],
  networkId: string,
  title: string,
  bodyMd: string,
): Promise<string> {
  const created = await createThoughtViaWrite(client, networkId, { title });
  await upsertPermanentViaWrite(client, networkId, created.id, bodyMd);
  return created.id;
}

/** Прочитать СЫРОЕ (неразвёрнутое) тело постоянного комментария из хранилища. */
function rawPermanentBody(dataDir: string, networkId: string, thoughtId: string): string {
  const ndb = openNetworkDb(dataDir, networkId);
  const row = ndb
    .prepare(
      `SELECT body_md FROM comments_v
        WHERE owner_type = 'thought' AND owner_id = ? AND kind = 'permanent' LIMIT 1`,
    )
    .get(thoughtId) as { body_md: string } | undefined;
  return row?.body_md ?? '';
}

describe(
  'MCP: предупреждение при записи, теряющей трансклюзии (ed796c43, 822a9149)',
  { skip: !nativeAvailable() },
  () => {
    it('запись прочитанной развёртки обратно: TRANSCLUSION_LOST, но запись применена', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const sourceId = await makeThoughtWithComment(
            handle.client,
            ctx.networkId,
            'Источник',
            'Тело источника.',
          );
          const containerId = await makeThoughtWithComment(
            handle.client,
            ctx.networkId,
            'Контейнер',
            `Начало.\n\n![[#${sourceId}]]\n\nКонец.`,
          );

          // MCP-клиент читает РАЗВЁРНУТОЕ тело (ссылки уже заменены текстом).
          const read = toolJson<CommentsGetByThought>(
            await handle.client.callTool({
              name: 'etn.comments.get',
              arguments: { network_id: ctx.networkId, thought_id: containerId },
            }),
          );
          const expanded = read.permanent!.body_md;
          assert.ok(expanded.includes('Тело источника.'), 'развёртка не сработала');
          assert.ok(!expanded.includes('![['), 'в выдаче осталась ссылка трансклюзии');

          // Запись развёртки обратно теряет живую вставку — ждём предупреждение.
          const updated = toolJson<CommentUpdateResult>(
            await handle.client.callTool({
              name: 'etn.comments.update',
              arguments: {
                network_id: ctx.networkId,
                comment_id: read.permanent!.id,
                changes: { body_md: expanded },
              },
            }),
          );
          assert.deepEqual(
            updated.warnings,
            [{ code: 'TRANSCLUSION_LOST', sources: [sourceId] }],
            `неверное предупреждение: ${JSON.stringify(updated.warnings)}`,
          );

          // Запись всё же применена: в хранилище — статичная копия без ссылки.
          const stored = rawPermanentBody(ctx.dataDir, ctx.networkId, containerId);
          assert.equal(stored, expanded, 'запись не применилась');
          assert.ok(!stored.includes('![['), 'живая вставка не была заменена копией');
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('потеря одной из нескольких: в предупреждении только исчезнувший id', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const a = await makeThoughtWithComment(handle.client, ctx.networkId, 'A', 'Текст A.');
          const b = await makeThoughtWithComment(handle.client, ctx.networkId, 'B', 'Текст B.');
          const containerId = await makeThoughtWithComment(
            handle.client,
            ctx.networkId,
            'Контейнер',
            `![[#${a}]]\n\n![[#${b}]]`,
          );
          const read = toolJson<CommentsGetByThought>(
            await handle.client.callTool({
              name: 'etn.comments.get',
              arguments: { network_id: ctx.networkId, thought_id: containerId },
            }),
          );

          // Оставляем ссылку на A, теряем B: новое тело — ссылка A + статичный текст B.
          const updated = toolJson<CommentUpdateResult>(
            await handle.client.callTool({
              name: 'etn.comments.update',
              arguments: {
                network_id: ctx.networkId,
                comment_id: read.permanent!.id,
                changes: { body_md: `![[#${a}]]\n\nТекст B.` },
              },
            }),
          );
          assert.deepEqual(updated.warnings, [
            { code: 'TRANSCLUSION_LOST', sources: [b] },
          ]);
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('замена ссылки A → B: предупреждение называет потерянный A', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const a = await makeThoughtWithComment(handle.client, ctx.networkId, 'A', 'Текст A.');
          const b = await makeThoughtWithComment(handle.client, ctx.networkId, 'B', 'Текст B.');
          const containerId = await makeThoughtWithComment(
            handle.client,
            ctx.networkId,
            'Контейнер',
            `![[#${a}]]`,
          );
          const read = toolJson<CommentsGetByThought>(
            await handle.client.callTool({
              name: 'etn.comments.get',
              arguments: { network_id: ctx.networkId, thought_id: containerId },
            }),
          );
          const updated = toolJson<CommentUpdateResult>(
            await handle.client.callTool({
              name: 'etn.comments.update',
              arguments: {
                network_id: ctx.networkId,
                comment_id: read.permanent!.id,
                changes: { body_md: `![[#${b}]]` },
              },
            }),
          );
          assert.deepEqual(updated.warnings, [
            { code: 'TRANSCLUSION_LOST', sources: [a] },
          ]);
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('запись без потерь предупреждений не даёт', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const sourceId = await makeThoughtWithComment(
            handle.client,
            ctx.networkId,
            'Источник',
            'Тело источника.',
          );
          const containerId = await makeThoughtWithComment(
            handle.client,
            ctx.networkId,
            'Контейнер',
            `![[#${sourceId}]]`,
          );
          const read = toolJson<CommentsGetByThought>(
            await handle.client.callTool({
              name: 'etn.comments.get',
              arguments: { network_id: ctx.networkId, thought_id: containerId },
            }),
          );
          // Сохраняем чужую ссылку как есть, добавляя текст — потерь нет.
          const updated = toolJson<CommentUpdateResult>(
            await handle.client.callTool({
              name: 'etn.comments.update',
              arguments: {
                network_id: ctx.networkId,
                comment_id: read.permanent!.id,
                changes: { body_md: `![[#${sourceId}]]\n\nДописано.` },
              },
            }),
          );
          assert.equal(updated.warnings, undefined, 'ложное предупреждение при записи без потерь');
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('etn.comments.edit (секционная правка) тоже предупреждает', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const sourceId = await makeThoughtWithComment(
            handle.client,
            ctx.networkId,
            'Источник',
            'Тело источника.',
          );
          const containerId = await makeThoughtWithComment(
            handle.client,
            ctx.networkId,
            'Контейнер',
            `## Вставка\n![[#${sourceId}]]\n\n## Хвост\nконец`,
          );
          const read = toolJson<CommentsGetByThought>(
            await handle.client.callTool({
              name: 'etn.comments.get',
              arguments: { network_id: ctx.networkId, thought_id: containerId },
            }),
          );
          const edited = toolJson<CommentEditResult>(
            await handle.client.callTool({
              name: 'etn.comments.edit',
              arguments: {
                network_id: ctx.networkId,
                comment_id: read.permanent!.id,
                ops: [{ op: 'replace_section', section: 'Вставка', text: 'без ссылки' }],
              },
            }),
          );
          assert.deepEqual(edited.warnings, [
            { code: 'TRANSCLUSION_LOST', sources: [sourceId] },
          ]);
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('батч etn.thoughts.write с comment тоже предупреждает', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const sourceId = await makeThoughtWithComment(
            handle.client,
            ctx.networkId,
            'Источник',
            'Тело источника.',
          );
          const containerId = await makeThoughtWithComment(
            handle.client,
            ctx.networkId,
            'Контейнер',
            `![[#${sourceId}]]`,
          );
          // Пишем комментарий батчем, теряя живую вставку (прочитанная развёртка).
          const result = await callWrite(handle.client, ctx.networkId, [
            { thought_id: containerId, comment: { body_md: 'Только текст, без вставки.' } },
          ]);
          const batchWarnings = result.warnings as TransclusionLostWarningDto[];
          const codes = batchWarnings.map((w) => w.code);
          assert.ok(
            codes.includes('TRANSCLUSION_LOST'),
            `батч не предупредил о потере: ${JSON.stringify(result.warnings)}`,
          );
          const lost = batchWarnings.find((w) => w.code === 'TRANSCLUSION_LOST')!;
          assert.deepEqual(lost.sources, [sourceId]);
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('etn.properties.add на ЖИВОМ ребре с новым комментарием предупреждает', async () => {
      const ctx = await buildMcpContext();
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const linkType = createLinkType(
          ndb,
          { name_forward: 'TEST ed796c43 связывает', name_reverse: 'TEST ed796c43 связан' },
          ctx.adminId,
        );
        const type = createThoughtType(ndb, { name: 'TEST ed796c43 носитель' }, ctx.adminId);
        const prop = createTypeProperty(
          ndb,
          'thought_type',
          type.id,
          {
            key: 'TEST ed796c43 связывает',
            value_type: 'link',
            config: { link_type_id: linkType.id, direction: 'out' },
          },
          ctx.adminId,
        );
        const key = (
          ndb.prepare('SELECT name FROM properties_v WHERE id = ?').get(prop.property_id) as {
            name: string;
          }
        ).name;

        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const sourceId = await makeThoughtWithComment(
            handle.client,
            ctx.networkId,
            'Источник',
            'Тело источника.',
          );
          const owner = await createThoughtViaWrite(handle.client, ctx.networkId, {
            title: 'Носитель',
            type_id: type.id,
          });
          const target = await createThoughtViaWrite(handle.client, ctx.networkId, {
            title: 'Цель',
          });

          // Первый add создаёт живое ребро с комментарием-трансклюзией — потерь нет.
          const firstArgs = {
            network_id: ctx.networkId,
            owner_type: 'thought',
            owner_id: owner.id,
            key,
            value: target.id,
          };
          const first = toolJson<{ link_id: string; created: boolean; warnings?: unknown }>(
            await handle.client.callTool({
              name: 'etn.properties.add',
              arguments: { ...firstArgs, comment: `![[#${sourceId}]]` },
            }),
          );
          assert.equal(first.created, true, 'первый add должен создать ребро');
          assert.equal(first.warnings, undefined, 'ложное предупреждение при создании');

          // Повторный add на ЖИВОМ ребре перезаписывает комментарий без ссылки —
          // потеря живой трансклюзии, ребро остаётся (created: false).
          const second = toolJson<{
            link_id: string;
            created: boolean;
            warnings?: TransclusionLostWarningDto[];
          }>(
            await handle.client.callTool({
              name: 'etn.properties.add',
              arguments: { ...firstArgs, comment: 'статичный текст' },
            }),
          );
          assert.equal(second.created, false, 'повторный add не создаёт ребро');
          assert.deepEqual(second.warnings, [
            { code: 'TRANSCLUSION_LOST', sources: [sourceId] },
          ]);
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('восстановление ребра из корзины с теряющим комментарием предупреждает', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const sourceId = await makeThoughtWithComment(
            handle.client,
            ctx.networkId,
            'Источник',
            'Тело источника.',
          );
          const owner = await createThoughtViaWrite(handle.client, ctx.networkId, {
            title: 'Владелец',
          });
          const target = await createThoughtViaWrite(handle.client, ctx.networkId, {
            title: 'Цель',
          });

          // Ребро с постоянным комментарием-трансклюзией.
          const created = toolJson<{ items: Array<{ links: Array<{ id: string }> }> }>(
            await handle.client.callTool({
              name: 'etn.thoughts.write',
              arguments: {
                network_id: ctx.networkId,
                thoughts: [
                  {
                    thought_id: owner.id,
                    links: [
                      {
                        direction: 'child',
                        target_id: target.id,
                        comment: { body_md: `![[#${sourceId}]]` },
                      },
                    ],
                  },
                ],
              },
            }),
          );
          const linkId = created.items[0]!.links[0]!.id;

          // Отправить ребро в корзину МЯГКО (постоянный комментарий сохраняется):
          // прямое помечивание `marked_for_deletion` в базовом слое, как это
          // делает корзина/снятие цели свойства-связи.
          const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
          ndb
            .prepare(
              `UPDATE links SET marked_for_deletion = 1, marked_for_deletion_at = ?, marked_for_deletion_by = ?
                WHERE id = ?`,
            )
            .run(new Date().toISOString(), ctx.adminId, linkId);

          // Повторная запись той же тройки восстанавливает ребро и перезаписывает
          // комментарий без ссылки — потеря трансклюзии (требование 822a9149).
          const restored = toolJson<{
            items: Array<{ warnings: TransclusionLostWarningDto[] }>;
            warnings: TransclusionLostWarningDto[];
          }>(
            await handle.client.callTool({
              name: 'etn.thoughts.write',
              arguments: {
                network_id: ctx.networkId,
                thoughts: [
                  {
                    thought_id: owner.id,
                    links: [
                      {
                        direction: 'child',
                        target_id: target.id,
                        comment: { body_md: 'статичный текст' },
                      },
                    ],
                  },
                ],
              },
            }),
          );
          const itemLost = restored.items[0]!.warnings.find(
            (w) => w.code === 'TRANSCLUSION_LOST',
          );
          assert.ok(itemLost, `нет предупреждения на элементе: ${JSON.stringify(restored.items[0])}`);
          assert.deepEqual(itemLost.sources, [sourceId]);
          const batchLost = restored.warnings.find((w) => w.code === 'TRANSCLUSION_LOST');
          assert.ok(batchLost, `нет предупреждения в батче: ${JSON.stringify(restored.warnings)}`);
          assert.deepEqual(batchLost.sources, [sourceId]);
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });
  },
);

describe(
  'REST: предупреждение при записи, теряющей трансклюзии (ed796c43, 822a9149)',
  restNativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('PATCH теряющий трансклюзию возвращает meta.warnings; без потерь — молчит', async () => {
      const ctx = await buildRestContext();
      try {
        const source = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts`,
          headers: authHeaders(ctx),
          payload: { title: 'Источник' },
        });
        assert.equal(source.statusCode, 201, source.body);
        const sourceId = (source.json().data as { id: string }).id;

        const container = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts`,
          headers: authHeaders(ctx),
          payload: { title: 'Контейнер' },
        });
        assert.equal(container.statusCode, 201, container.body);
        const containerId = (container.json().data as { id: string }).id;

        // Постоянные комментарии: источник — текст, контейнер — живая вставка.
        await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${sourceId}/comments`,
          headers: authHeaders(ctx),
          payload: { kind: 'permanent', body_md: 'Тело источника.' },
        });
        const boxComment = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${containerId}/comments`,
          headers: authHeaders(ctx),
          payload: { kind: 'permanent', body_md: `Начало.\n\n![[#${sourceId}]]\n\nКонец.` },
        });
        assert.equal(boxComment.statusCode, 201, boxComment.body);
        const comment = boxComment.json().data as { id: string; version: number };

        // PATCH сохраняет ссылку — потерь нет, предупреждения быть не должно.
        const safe = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/comments/${comment.id}`,
          headers: { ...authHeaders(ctx), 'if-match': String(comment.version) },
          payload: { body_md: `Начало.\n\n![[#${sourceId}]]\n\nДописано.` },
        });
        assert.equal(safe.statusCode, 200, safe.body);
        const safeMeta = safe.json().meta as { warnings?: TransclusionLostWarningDto[] };
        assert.equal(safeMeta.warnings, undefined, 'ложное предупреждение без потерь');

        // PATCH теряет живую вставку (статичная копия) — meta.warnings.
        const lost = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/comments/${comment.id}`,
          headers: {
            ...authHeaders(ctx),
            'if-match': String((safe.json().data as { version: number }).version),
          },
          payload: { body_md: 'Начало.\n\nТело источника.\n\nКонец.' },
        });
        assert.equal(lost.statusCode, 200, lost.body);
        const lostMeta = lost.json().meta as { warnings?: TransclusionLostWarningDto[] };
        assert.deepEqual(lostMeta.warnings, [
          { code: 'TRANSCLUSION_LOST', sources: [sourceId] },
        ]);

        // Запись применена (GET подтверждает статичную копию в хранилище).
        const read = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/comments/${comment.id}`,
          headers: authHeaders(ctx),
        });
        assert.equal(read.statusCode, 200, read.body);
        const body = (read.json().data as { body_md: string }).body_md;
        assert.ok(!body.includes('![['), 'живая вставка не была заменена копией');
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
