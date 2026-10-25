/**
 * Сторож: агентские тексты MCP ссылаются только на существующие инструменты
 * (ошибка 60f085b4-60dc-4d4b-a788-d45f9006a0bd).
 *
 * Класс дефекта: `description` инструмента, промпт или тема `etn.guide`
 * отправляет агента к инструменту, которого нет в `tools/list` — инструмент
 * снят (поглощён `etn.thoughts.write` или перенесён в `etn.ops`). Агент
 * строит план по такому указанию и упирается в `NOT_FOUND`/неизвестное имя.
 * Исходный случай: `etn.thoughts.find_duplicates` требовал «Always call before
 * `etn.thoughts.create`» (снят в 0.8.2). Рецидив: промпт
 * `etn.how_to_merge_partial` вёл в `etn.layers.merge`/`etn.layers.diff` —
 * эти операции живут только как `etn.ops { action: "layers.*" }`.
 *
 * Проверяются все агентские поверхности, которые видит модель:
 *   - `tools/list` (имена и `description`);
 *   - `prompts/list` (имена и `description`) и тело каждого промпта;
 *   - `etn.guide` без темы (реестр) и каждая тема (`etn.guide { topic }`).
 *
 * Разрешены ссылки только на живой набор: `MCP_TOOL_NAMES`, `MCP_PROMPT_NAMES`
 * и темы справочника. Историческая справка допустима, если ссылка явно
 * помечена как снятая: строка (или абзац после строки-маркера) содержит
 * «миграция», «заменён», «снят», «удалён» или «поглощён». Такой маркер —
 * единственный способ упомянуть несуществующий инструмент; голая инструкция
 * «вызови `etn.layers.merge`» краснеет.
 *
 * Сторож поднимает реальную MCP-сессию (`buildMcpContext` +
 * `connectMcpClient`) поверх production-фабрики, поэтому видит ровно то, что
 * увидят агенты. Пропускается без нативного биндинга `better-sqlite3`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MCP_PROMPT_NAMES, MCP_TOOL_NAMES } from '@etn/shared';

import { registerPrompts } from '../src/mcp/prompts.js';
import { GUIDE_TOPIC_NAMES, OPS_ACTION_NAMES } from '../src/mcp/tools/ops-catalog.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolText,
} from './mcp-helpers.js';

/** Ссылка на инструмент в полной форме `etn.<группа>.<имя>`. */
const TOOL_REF = /etn\.[a-z_]+(?:\.[a-z_]+)+/g;

/** Маркеры исторической справки: такой абзац вправе называть снятый инструмент. */
const REMOVAL_MARKERS =
  /миграц|заменен|заменён|поглощ|(?<![\p{L}])снят[\p{L}]{0,4}(?![\p{L}])|удален|удалён/iu;

/** Живые имена, на которые агентские тексты вправе ссылаться. */
const LIVE_REFS: ReadonlySet<string> = new Set<string>([
  ...MCP_TOOL_NAMES,
  ...MCP_PROMPT_NAMES,
  ...GUIDE_TOPIC_NAMES.map((topic) => `etn.${topic}`),
]);

/** Одна агентская поверхность: откуда текст и сам текст. */
interface AgentText {
  source: string;
  text: string;
}

/**
 * Ссылки на несуществующие инструменты. Строка-ссылка легальна, если несёт
 * маркер снятия сама либо идёт внутри абзаца, начатого таким маркером
 * (абзац разделяется пустой строкой).
 */
function danglingRefs({ source, text }: AgentText): string[] {
  const bad: string[] = [];
  let historical = false;
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      historical = false;
      continue;
    }
    const marker = REMOVAL_MARKERS.test(line);
    if (marker) historical = true;
    for (const match of line.matchAll(TOOL_REF)) {
      const ref = match[0];
      if (LIVE_REFS.has(ref)) continue;
      if (marker || historical) continue;
      bad.push(`${source}: ${ref} — «${line.trim()}»`);
    }
  }
  return bad;
}

/**
 * Тела промптов снимаются с production-регистрации, а не через `prompts/get`:
 * протокол передаёт аргументы промпта только строками, а `etn.generate_report`
 * объявляет `seed_ids` массивом (отдельная ошибка протокольного контракта),
 * поэтому wire-вызов этого промпта падает до тела. Захват регистрации видит
 * РОВНО авторский текст промптов — независимо от ограничения транспорта.
 */
function capturedPrompts(networkId: string, thoughtId: string): AgentText[] {
  const captured: Array<{
    name: string;
    config: { title?: string; description?: string };
    callback: (args: Record<string, unknown>) => { messages: Array<{ content: { type: string; text?: string } }> };
  }> = [];
  const fake = {
    registerPrompt: (name: string, config: never, callback: never) => {
      captured.push({ name, config, callback });
    },
  };
  registerPrompts(fake as unknown as McpServer, undefined as never);
  const args = {
    network_id: networkId,
    thought_id: thoughtId,
    seed_thought_id: thoughtId,
    seed_ids: [thoughtId],
    topic: 'проверка ссылок',
  };
  return captured.flatMap(({ name, config, callback }) => {
    const texts: AgentText[] = [
      { source: `prompts/list ${name}.title`, text: config.title ?? '' },
      { source: `prompts/list ${name}.description`, text: config.description ?? '' },
    ];
    for (const message of callback(args).messages) {
      if (message.content.type === 'text') {
        texts.push({ source: `prompt ${name}`, text: message.content.text ?? '' });
      }
    }
    return texts;
  });
}

describe('guard: агентские тексты MCP не ссылаются на снятые инструменты (60f085b4)', { skip: !nativeAvailable() }, () => {
  it('tools/list, промпты и etn.guide называют только живые инструменты', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const texts: AgentText[] = [];

        const { tools } = await handle.client.listTools();
        for (const tool of tools) {
          const title = (tool as { title?: string }).title;
          texts.push({ source: `tools/list ${tool.name}.description`, text: tool.description ?? '' });
          if (title !== undefined) texts.push({ source: `tools/list ${tool.name}.title`, text: title });
        }

        texts.push(...capturedPrompts(ctx.networkId, ctx.homeId));

        const registry = await handle.client.callTool({ name: 'etn.guide', arguments: {} });
        texts.push({ source: 'etn.guide registry', text: toolText(registry) });
        for (const topic of [...OPS_ACTION_NAMES, ...GUIDE_TOPIC_NAMES]) {
          const result = await handle.client.callTool({ name: 'etn.guide', arguments: { topic } });
          texts.push({ source: `etn.guide topic ${topic}`, text: toolText(result) });
        }

        const bad = texts.flatMap(danglingRefs);
        assert.deepEqual(
          bad,
          [],
          `агентские тексты MCP ссылаются на снятые инструменты (${bad.length}):\n${bad.join('\n')}`,
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.thoughts.find_duplicates отправляет к живому etn.thoughts.write (исходный дефект)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const { tools } = await handle.client.listTools();
        const tool = tools.find((candidate) => candidate.name === 'etn.thoughts.find_duplicates');
        assert.ok(tool !== undefined, 'etn.thoughts.find_duplicates отсутствует в tools/list');
        assert.match(tool.description ?? '', /`etn\.thoughts\.write`/);
        assert.doesNotMatch(tool.description ?? '', /etn\.thoughts\.create/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
