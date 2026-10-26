/**
 * Wire-контракт MCP-промптов (ошибка b2223e98).
 *
 * Протокол `prompts/get` передаёт аргументы как `Record<string, string>`:
 * клиентский SDK проверяет их как словарь строк, серверный — парсит zod-схему
 * из строк. Поэтому массив/число в `argsSchema` недостижимы ни с одной
 * стороны, и промпт с таким аргументом падает всегда:
 *   - массив в аргументах — `expected string, received array` (клиент);
 *   - строка — `expected array/number, received string` (сервер).
 *
 * Здесь промпты вызываются ТОЛЬКО через реальную MCP-сессию production-фабрики
 * (`buildMcpContext` + `connectMcpClient`): проверяется достижимость каждого
 * промпта и разбор строковых форм `seed_ids`/`radius`. Юнит-тесты самих
 * разборщиков — `mcp-prompt-args.test.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { MCP_PROMPT_NAMES } from '@etn/shared';

import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
} from './mcp-helpers.js';

/** Единственное текстовое сообщение промпта. */
function promptText(result: GetPromptResult): string {
  const message = result.messages[0];
  assert.ok(message !== undefined, 'промпт вернул пустой ответ');
  assert.equal(message.content.type, 'text');
  return message.content.text;
}

/** Значение `seed_ids=[...]`, которое промпт вставляет в текст. */
function seedIdsFragment(ids: readonly string[]): string {
  return `seed_ids=[${ids.map((id) => JSON.stringify(id)).join(', ')}]`;
}

/** Аргументы каждого промпта в wire-форме — только строки. */
const WIRE_ARGS: Record<(typeof MCP_PROMPT_NAMES)[number], (net: string, thought: string) => Record<string, string>> = {
  'etn.summarize_thought': (net, thought) => ({ network_id: net, thought_id: thought }),
  'etn.suggest_links': (net, thought) => ({ network_id: net, thought_id: thought }),
  'etn.detect_duplicates': (net, thought) => ({
    network_id: net,
    seed_thought_id: thought,
    radius: '2',
  }),
  'etn.generate_report': (net, thought) => ({
    network_id: net,
    topic: 'проверка ссылок',
    seed_ids: thought,
    radius: '2',
  }),
  'etn.how_to_merge_partial': (net) => ({ network_id: net, layer_id: 'probe-layer' }),
  'etn.how_to_purge': (net) => ({ network_id: net }),
  'etn.how_to_write_batch': (net) => ({ network_id: net }),
};

/** Ожидание ошибки валидации аргументов (`-32602`) с фрагментами текста. */
async function assertInvalid(promise: Promise<unknown>, ...patterns: RegExp[]): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    const error = err as { code?: number; message?: string };
    assert.equal(error.code, ErrorCode.InvalidParams, `код ошибки: ${error.message}`);
    for (const pattern of patterns) assert.match(error.message ?? '', pattern);
    return true;
  });
}

describe('MCP prompts: аргументы prompts/get — строки (b2223e98)', { skip: !nativeAvailable() }, () => {
  it('каждый промпт достижим через prompts/get со строковыми аргументами', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const { prompts } = await handle.client.listPrompts();
        // Набор промптов и набор аргументов в тесте обязаны совпадать: новый
        // промпт без строковых аргументов уронит этот тест, а не пройдёт молча.
        assert.deepEqual(prompts.map((prompt) => prompt.name).sort(), [...MCP_PROMPT_NAMES].sort());
        for (const prompt of prompts) {
          const build = WIRE_ARGS[prompt.name as keyof typeof WIRE_ARGS];
          assert.ok(build !== undefined, `нет wire-аргументов для промпта ${prompt.name}`);
          const result = await handle.client.getPrompt({
            name: prompt.name,
            arguments: build(ctx.networkId, ctx.homeId),
          });
          assert.ok(promptText(result).length > 0, `промпт ${prompt.name} вернул пустой текст`);
        }
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.generate_report: seed_ids JSON-массивом строкой', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const ids = [ctx.homeId, '22222222-2222-4222-8222-222222222222'];
        const text = promptText(
          await handle.client.getPrompt({
            name: 'etn.generate_report',
            arguments: {
              network_id: ctx.networkId,
              topic: 'JSON-массив',
              seed_ids: JSON.stringify(ids),
            },
          }),
        );
        assert.ok(text.includes(seedIdsFragment(ids)), `в теле нет ${seedIdsFragment(ids)}`);
        assert.ok(text.includes('radius=2'), 'радиус по умолчанию должен быть 2');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.generate_report: seed_ids через запятые, пробелы и переводы строк', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const ids = [ctx.homeId, 'id-two', 'id-three'];
        const text = promptText(
          await handle.client.getPrompt({
            name: 'etn.generate_report',
            arguments: {
              network_id: ctx.networkId,
              topic: 'разделители',
              seed_ids: ` ${ids[0]} ,\n\t${ids[1]}  ${ids[2]}\n`,
            },
          }),
        );
        assert.ok(text.includes(seedIdsFragment(ids)), `в теле нет ${seedIdsFragment(ids)}`);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.generate_report: смешанный вид — JSON-массивы и разделители в одной строке', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const first = JSON.stringify([ctx.homeId, 'id-two']);
        const text = promptText(
          await handle.client.getPrompt({
            name: 'etn.generate_report',
            arguments: {
              network_id: ctx.networkId,
              topic: 'смешанный вид',
              seed_ids: `${first} id-three, [ "id-four" ]`,
            },
          }),
        );
        assert.ok(
          text.includes(seedIdsFragment([ctx.homeId, 'id-two', 'id-three', 'id-four'])),
          'смешанный ввод должен дать все четыре id в порядке появления',
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.generate_report: дубликаты отбрасываются, порядок сохраняется', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const text = promptText(
          await handle.client.getPrompt({
            name: 'etn.generate_report',
            arguments: {
              network_id: ctx.networkId,
              topic: 'дубликаты',
              seed_ids: `id-a,id-b, id-a\nid-b id-a`,
            },
          }),
        );
        assert.ok(text.includes(seedIdsFragment(['id-a', 'id-b'])), 'ожидалось ровно два id');
        assert.equal(text.split('"id-a"').length - 1, 1, 'id-a должен встречаться один раз');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.generate_report: один id и ровно 20 id принимаются, 21 — нет', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const single = promptText(
          await handle.client.getPrompt({
            name: 'etn.generate_report',
            arguments: { network_id: ctx.networkId, topic: 'один', seed_ids: ctx.homeId },
          }),
        );
        assert.ok(single.includes(seedIdsFragment([ctx.homeId])));

        const twenty = Array.from(
          { length: 20 },
          (_unused, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        );
        const ok = promptText(
          await handle.client.getPrompt({
            name: 'etn.generate_report',
            arguments: { network_id: ctx.networkId, topic: 'двадцать', seed_ids: twenty.join(',') },
          }),
        );
        assert.ok(ok.includes(seedIdsFragment(twenty)), 'двадцать id должны попасть в тело целиком');

        await assertInvalid(
          handle.client.getPrompt({
            name: 'etn.generate_report',
            arguments: {
              network_id: ctx.networkId,
              topic: 'двадцать один',
              seed_ids: [...twenty, 'id-extra'].join(' '),
            },
          }),
          /seed_ids/,
          /21/,
          /20/,
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.generate_report: невалидный seed_ids — понятная ошибка, а не пустой отчёт', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const cases: Array<{ label: string; seedIds: string; patterns: RegExp[] }> = [
          { label: 'пустая строка', seedIds: '', patterns: [/seed_ids/, /пуст/] },
          { label: 'только пробелы', seedIds: ' \n\t ', patterns: [/seed_ids/, /пуст/] },
          { label: 'пустой JSON-массив', seedIds: '[]', patterns: [/seed_ids/, /пуст/] },
          {
            label: 'незакрытый JSON-массив',
            seedIds: '["id-1","id-2"',
            patterns: [/seed_ids/, /незакрыт/i],
          },
          {
            label: 'битый JSON-массив',
            seedIds: '["id-1" "id-2"]',
            patterns: [/seed_ids/, /битый JSON/i, /кавычк/i],
          },
          {
            label: 'id без кавычек в JSON',
            seedIds: '[id-1,id-2]',
            patterns: [/seed_ids/, /битый JSON/i],
          },
          {
            label: 'не строковый элемент JSON',
            seedIds: '["id-1", 2]',
            patterns: [/seed_ids\[1\]/, /строков/i, /число/i],
          },
        ];
        for (const probe of cases) {
          await assertInvalid(
            handle.client.getPrompt({
              name: 'etn.generate_report',
              arguments: {
                network_id: ctx.networkId,
                topic: probe.label,
                seed_ids: probe.seedIds,
              },
            }),
            ...probe.patterns,
          );
        }
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.generate_report: radius строкой 1..5, вне диапазона — ошибка', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        for (const radius of ['1', '5', '3']) {
          const text = promptText(
            await handle.client.getPrompt({
              name: 'etn.generate_report',
              arguments: {
                network_id: ctx.networkId,
                topic: `радиус ${radius}`,
                seed_ids: ctx.homeId,
                radius,
              },
            }),
          );
          assert.ok(text.includes(`radius=${radius},`), `в теле нет radius=${radius}`);
        }
        for (const radius of ['0', '6']) {
          await assertInvalid(
            handle.client.getPrompt({
              name: 'etn.generate_report',
              arguments: {
                network_id: ctx.networkId,
                topic: 'радиус',
                seed_ids: ctx.homeId,
                radius,
              },
            }),
            /radius/,
            /1\.\.5/,
          );
        }
        for (const radius of ['abc', '2.5', '']) {
          await assertInvalid(
            handle.client.getPrompt({
              name: 'etn.generate_report',
              arguments: {
                network_id: ctx.networkId,
                topic: 'радиус',
                seed_ids: ctx.homeId,
                radius,
              },
            }),
            /radius/,
            /целое число/,
          );
        }
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.detect_duplicates: radius строкой, дефолт 2', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const def = promptText(
          await handle.client.getPrompt({
            name: 'etn.detect_duplicates',
            arguments: { network_id: ctx.networkId, seed_thought_id: ctx.homeId },
          }),
        );
        assert.ok(def.includes('radius=2'), 'радиус по умолчанию должен быть 2');

        const explicit = promptText(
          await handle.client.getPrompt({
            name: 'etn.detect_duplicates',
            arguments: { network_id: ctx.networkId, seed_thought_id: ctx.homeId, radius: '4' },
          }),
        );
        assert.ok(explicit.includes('radius=4'), 'строка «4» должна дать radius=4');

        await assertInvalid(
          handle.client.getPrompt({
            name: 'etn.detect_duplicates',
            arguments: { network_id: ctx.networkId, seed_thought_id: ctx.homeId, radius: '9' },
          }),
          /radius/,
          /1\.\.5/,
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
