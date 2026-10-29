/**
 * Сторож: агентские тексты MCP ссылаются только на существующие инструменты
 * (ошибка 60f085b4-60dc-4d4b-a788-d45f9006a0bd).
 *
 * Класс дефекта: `description` инструмента, промпта, темы `etn.guide` или
 * MCP-ресурса отправляет агента к инструменту, которого нет в `tools/list` —
 * инструмент снят (поглощён `etn.thoughts.write` или перенесён в `etn.ops`).
 * Агент строит план по такому указанию и упирается в `NOT_FOUND`/неизвестное
 * имя. Исходный случай: `etn.thoughts.find_duplicates` требовал «Always call
 * before `etn.thoughts.create`» (снят в 0.8.2). Рецидивы: промпт
 * `etn.how_to_merge_partial` вёл в `etn.layers.merge`/`etn.layers.diff` —
 * эти операции живут только как `etn.ops { action: "layers.*" }`; описание
 * ресурса `etn.trash` ссылалось на снятый `etn.trash.list` (возврат
 * верификатора, круг 1).
 *
 * Проверяются все агентские поверхности, которые видит модель:
 *   - `tools/list` (имена и `description`);
 *   - `prompts/list` (имена и `description`) и тело каждого промпта;
 *   - `resources/list` и `resources/templates/list` (имена, title,
 *     description, `uriTemplate` шаблонов);
 *   - `etn.guide` без темы (реестр) и каждая тема (`etn.guide { topic }`).
 *
 * Разрешены ссылки только на живой набор: `MCP_TOOL_NAMES`,
 * `MCP_PROMPT_NAMES`, имена MCP-ресурсов и темы справочника. Историческая
 * справка допустима, только если ссылка явно помечена формулировкой снятия:
 * «миграция», «заменён(ы)», «поглощён» или «снят из постоянного набора»
 * (строка-маркер распространяется на абзац до пустой строки — так живёт
 * таблица миграции в `etn.how_to_write_batch`). Голые «удалён»/«снят»/
 * «удаление»/«снятие» маркером НЕ считаются: рядом с бытовым словом ссылка
 * на несуществующий инструмент обязана краснеть.
 *
 * Сторож поднимает реальную MCP-сессию (`buildMcpContext` +
 * `connectMcpClient`) поверх production-фабрики, поэтому видит ровно то, что
 * увидят агенты. Пропускается без нативного биндинга `better-sqlite3`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { MCP_PROMPT_NAMES, MCP_TOOL_NAMES } from '@etn/shared';

import { GUIDE_TOPIC_NAMES, OPS_ACTION_NAMES } from '../src/mcp/tools/ops-catalog.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolText,
  wirePromptArguments,
} from './mcp-helpers.js';

/** Ссылка на инструмент в полной форме `etn.<группа>.<имя>`. */
const TOOL_REF = /etn\.[a-z_]+(?:\.[a-z_]+)+/g;

/**
 * Маркеры исторической справки — только явная формулировка снятия инструмента.
 * Бытовая лексика («удаление», «снятие», «помеченные на удаление») маркером не
 * является: иначе висячая ссылка в такой фразе остаётся незамеченной.
 */
const REMOVAL_MARKERS =
  /миграц|заменен|заменён|поглощ|снят[а-яё]*\s+из\s+постоянного\s+набора/iu;

/** Живые имена инструментов и промптов, на которые вправе ссылаться тексты. */
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
 * (абзац разделяется пустой строкой). `live` — живой набор имён: инструменты,
 * промпты, темы справочника и имена MCP-ресурсов.
 */
function danglingRefs({ source, text }: AgentText, live: ReadonlySet<string> = LIVE_REFS): string[] {
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
      if (live.has(ref)) continue;
      if (marker || historical) continue;
      bad.push(`${source}: ${ref} — «${line.trim()}»`);
    }
  }
  return bad;
}

/**
 * Тексты промптов снимаются wire-вызовом `prompts/get` в реальной
 * MCP-сессии — ровно то, что видит агент. До исправления ошибки b2223e98
 * захват шёл с production-регистрации в обход протокола: `seed_ids`
 * `etn.generate_report` был объявлен массивом, wire-вызов падал до тела.
 * Теперь промпты достижимы, и сторож ловит не только висячие ссылки, но и
 * нестроковый контракт аргументов (падение `getPrompt`).
 */
async function promptTexts(
  client: Client,
  networkId: string,
  thoughtId: string,
): Promise<AgentText[]> {
  const texts: AgentText[] = [];
  const { prompts } = await client.listPrompts();
  for (const prompt of prompts) {
    texts.push({ source: `prompts/list ${prompt.name}.title`, text: prompt.title ?? '' });
    texts.push({
      source: `prompts/list ${prompt.name}.description`,
      text: prompt.description ?? '',
    });
    for (const argument of prompt.arguments ?? []) {
      if (argument.description !== undefined) {
        texts.push({
          source: `prompts/list ${prompt.name}.arguments.${argument.name}`,
          text: argument.description,
        });
      }
    }
    const result = await client.getPrompt({
      name: prompt.name,
      arguments: wirePromptArguments(prompt.name, networkId, thoughtId),
    });
    for (const message of result.messages) {
      if (message.content.type === 'text') {
        texts.push({ source: `prompt ${prompt.name}`, text: message.content.text });
      }
    }
  }
  return texts;
}

describe('guard: агентские тексты MCP не ссылаются на снятые инструменты (60f085b4)', { skip: !nativeAvailable() }, () => {
  it('tools/list, промпты, ресурсы и etn.guide называют только живые инструменты', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const texts: AgentText[] = [];
        const resourceNames: string[] = [];

        const { tools } = await handle.client.listTools();
        for (const tool of tools) {
          const title = (tool as { title?: string }).title;
          texts.push({ source: `tools/list ${tool.name}.description`, text: tool.description ?? '' });
          if (title !== undefined) texts.push({ source: `tools/list ${tool.name}.title`, text: title });
        }

        texts.push(...(await promptTexts(handle.client, ctx.networkId, ctx.homeId)));

        // MCP-ресурсы — такая же агентская поверхность, как tools/list:
        // описание шаблона уходит агенту в resources/templates/list.
        const { resources } = await handle.client.listResources();
        for (const resource of resources) {
          resourceNames.push(resource.name);
          const title = (resource as { title?: string }).title;
          texts.push({ source: `resources/list ${resource.name}.description`, text: resource.description ?? '' });
          if (title !== undefined) texts.push({ source: `resources/list ${resource.name}.title`, text: title });
        }
        const { resourceTemplates } = await handle.client.listResourceTemplates();
        for (const template of resourceTemplates) {
          resourceNames.push(template.name);
          const title = (template as { title?: string }).title;
          texts.push({
            source: `resources/templates/list ${template.name}.description`,
            text: template.description ?? '',
          });
          if (title !== undefined) {
            texts.push({ source: `resources/templates/list ${template.name}.title`, text: title });
          }
          texts.push({
            source: `resources/templates/list ${template.name}.uriTemplate`,
            text: template.uriTemplate,
          });
        }

        const registry = await handle.client.callTool({ name: 'etn.guide', arguments: {} });
        texts.push({ source: 'etn.guide registry', text: toolText(registry) });
        for (const topic of [...OPS_ACTION_NAMES, ...GUIDE_TOPIC_NAMES]) {
          const result = await handle.client.callTool({ name: 'etn.guide', arguments: { topic } });
          texts.push({ source: `etn.guide topic ${topic}`, text: toolText(result) });
        }

        // Ссылка на другой MCP-ресурс (например `etn.thought.neighbors`) — живая ссылка.
        const live = new Set<string>([...LIVE_REFS, ...resourceNames]);
        const bad = texts.flatMap((text) => danglingRefs(text, live));
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

  it('мутационная самопроверка: висячая ссылка в тексте ресурса и бытовое «удаление» краснеют', () => {
    // Вставка несуществующего инструмента в описание ресурса — сторож обязан
    // покраснеть именно на этой поверхности (возврат верификатора, круг 1).
    const resourceProbe = danglingRefs({
      source: 'resources/templates/list etn.trash.description',
      text: 'Помеченные на удаление мысли и связи сети, см. `etn.trash.list`.',
    });
    assert.equal(resourceProbe.length, 1);
    assert.match(resourceProbe[0] ?? '', /etn\.trash\.list/);

    // Бытовая лексика «удаление»/«снятие» — не маркер снятия инструмента.
    assert.equal(
      danglingRefs({
        source: 'tools/list etn.layers.list.description',
        text: 'Помеченные на удаление слои показываются вместе с `etn.layers.ghost_probe`.',
      }).length,
      1,
    );
    assert.equal(
      danglingRefs({
        source: 'probe',
        text: 'Снятие пометки не затрагивает `etn.layers.ghost_probe`.',
      }).length,
      1,
    );

    // Явные формулировки снятия — легальная историческая справка.
    assert.deepEqual(
      danglingRefs({
        source: 'probe',
        text: 'Снят из постоянного набора: `etn.layers.merge`.',
      }),
      [],
    );
    assert.deepEqual(
      danglingRefs({
        source: 'probe',
        text: ['9. Миграция со старых инструментов:', '- `etn.thoughts.create` → `thought`.', ''].join('\n'),
      }),
      [],
    );
    assert.deepEqual(
      danglingRefs({
        source: 'probe',
        text: 'Эти операции заменены батчем: `etn.thoughts.create`, `etn.links.create`.',
      }),
      [],
    );
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
