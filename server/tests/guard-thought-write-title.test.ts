/**
 * Сторож: заголовок хроно-записи НЕ затирает заголовок мысли (ошибка
 * 8b329dc8-80d7-41e2-9894-3a53269b9e96).
 *
 * **Инцидент.** У задачи разработки 6d8db38b (версия 0.12.1) поле `title`
 * оказалось равным фразе из отчёта верификатора. Разбор показал: пути записи
 * хроно-комментариев (`comment-service.createComment`/`updateComment`, батч
 * `etn.thoughts.write` через `upsertThoughtBundle`, клиентские
 * `etn.comments.create/update`) держат `comments.title` и `thoughts.title` в
 * РАЗНЫХ колонках и перепутать их кодом нельзя. Опасность — в контракте батча:
 * item-level `title` переименовывает САМУ мысль, а заголовок хроно-записи
 * задаётся `chronicle[].title`; агент, писавший отчёт, положил название отчёта
 * в item-level `title` и переименовал задачу.
 *
 * Сторож фиксирует две вещи:
 *   1. ФУНКЦИОНАЛЬНЫЙ инвариант: запись хронологического комментария с
 *      заголовком не меняет заголовок мысли-владельца; при этом легитимное
 *      переименование мысли item-level `title` работает как прежде.
 *   2. Контрактную формулировку: описание инструмента `etn.thoughts.write` и
 *      текст `etn.how_to_write_batch` обязаны ПРЯМО различать item-level
 *      `title` (переименование мысли) и `chronicle[].title` (заголовок записи),
 *      чтобы рассинхрон описания и кода не прошёл незамеченным (прецедент —
 *      ошибка a6cbcdc3 про `chronicle[].use_time`).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  buildMcpContext,
  callWrite,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
} from './mcp-helpers.js';

/** Прочитать заголовок мысли через MCP. */
async function thoughtTitle(
  client: Awaited<ReturnType<typeof connectMcpClient>>['client'],
  networkId: string,
  thoughtId: string,
): Promise<string> {
  const got = await client.callTool({
    name: 'etn.thoughts.get',
    arguments: { network_id: networkId, thought_id: thoughtId },
  });
  return toolJson<{ title: string }>(got).title;
}

/** Прочитать заголовок комментария через MCP. */
async function commentTitle(
  client: Awaited<ReturnType<typeof connectMcpClient>>['client'],
  networkId: string,
  commentId: string,
): Promise<string | null> {
  const got = await client.callTool({
    name: 'etn.comments.get',
    arguments: { network_id: networkId, comment_id: commentId },
  });
  return toolJson<{ title: string | null }>(got).title;
}

describe(
  'guard: хроно-запись не затирает заголовок мысли (8b329dc8)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('chronicle[].title не меняет заголовок мысли; item-level title его переименовывает', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const original = `Задача ${randomUUID()}`;
          const created = await callWrite(handle.client, ctx.networkId, [
            { ref: 't', thought: { title: original } },
          ]);
          const thoughtId = created.items[0]!.id;

          // 1. Хроно-запись С заголовком: заголовок уходит в запись, мысль цела.
          const recordTitle = `Проверка субагентом-тестировщиком: принято (${randomUUID()})`;
          const write = await callWrite(handle.client, ctx.networkId, [
            {
              thought_id: thoughtId,
              chronicle: [{ title: recordTitle, body_md: 'отчёт' }],
            },
          ]);
          const commentId = write.items[0]!.chronicle![0]!.id;

          assert.equal(
            await thoughtTitle(handle.client, ctx.networkId, thoughtId),
            original,
            'запись хроно-записи с title НЕ должна менять title мысли',
          );
          assert.equal(
            await commentTitle(handle.client, ctx.networkId, commentId),
            recordTitle,
            'заголовок хроно-записи обязан лечь в саму запись',
          );

          // 2. Легитимное переименование мысли item-level `title` — как прежде.
          const renamed = `Переименовано ${randomUUID()}`;
          await callWrite(handle.client, ctx.networkId, [
            { thought_id: thoughtId, title: renamed },
          ]);
          assert.equal(
            await thoughtTitle(handle.client, ctx.networkId, thoughtId),
            renamed,
            'item-level title обязан переименовывать мысль',
          );
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('контракт обязан различать item-level title и chronicle[].title', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const { tools } = await handle.client.listTools();
          const write = tools.find((t) => t.name === 'etn.thoughts.write');
          assert.ok(write !== undefined, 'etn.thoughts.write must be registered');
          const description = write.description ?? '';
          assert.ok(
            description.includes('chronicle[].title'),
            'описание etn.thoughts.write обязано называть chronicle[].title (заголовок записи)',
          );
          assert.ok(
            description.includes('ПЕРЕИМЕНОВЫВАЕТ'),
            'описание etn.thoughts.write обязано предупреждать, что item-level title переименовывает мысль',
          );

          // Тот же текст — в пошаговой инструкции (единый источник how-to.ts).
          const prompt = await handle.client.getPrompt({
            name: 'etn.how_to_write_batch',
            arguments: { network_id: ctx.networkId },
          });
          const first = prompt.messages[0]?.content;
          const promptText =
            typeof first === 'object' && first !== null && 'text' in first
              ? (first as { text: string }).text
              : '';
          assert.ok(
            promptText.includes('chronicle[].title') && promptText.includes('ПЕРЕИМЕНОВЫВАЕТ'),
            'etn.how_to_write_batch обязан различать item-level title и chronicle[].title',
          );
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });
  },
);
