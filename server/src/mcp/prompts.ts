/**
 * MCP prompts (task F5, docs/05-mcp-server.md §5).
 *
 * Four parameterised templates for typical agent jobs. Each returns a plain
 * text prompt describing the workflow in terms of the server's own tools and
 * `etn://` resources, so the host LLM can execute it end-to-end. Prompts are
 * pure text — they perform no data access and need no membership checks.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { McpRuntime } from './context.js';

/** Wrap prompt text into a single user-role message result. */
function promptResult(text: string): GetPromptResult {
  return { messages: [{ role: 'user', content: { type: 'text', text } }] };
}

/**
 * Register the four `etn.*` prompt templates (05 §5) on a fresh {@link McpServer}.
 */
export function registerPrompts(mcp: McpServer, _rt: McpRuntime): void {
  mcp.registerPrompt(
    'etn.summarize_thought',
    {
      title: 'Резюме мысли',
      description:
        'Собрать краткое резюме мысли и её контекста: прочитать мысль, её соседей и комментарии.',
      argsSchema: {
        network_id: z.string().min(1),
        thought_id: z.string().min(1),
      },
    },
    (args) => {
      const { network_id, thought_id } = args;
      return promptResult(
        [
          `Составь краткое резюме мысли сети ETN и её контекста.`,
          ``,
          `Сделай следующее:`,
          `1. Прочитай мысль: ресурс \`etn://networks/${network_id}/thoughts/${thought_id}\`.`,
          `2. Прочитай соседей: \`etn://networks/${network_id}/thoughts/${thought_id}/neighbors\`.`,
          `3. Прочитай комментарии: \`etn://networks/${network_id}/thoughts/${thought_id}/comments\`.`,
          `4. Опиши суть мысли, её роль в сети, ключевые связи и свежие хронологические записи.`,
          ``,
          `Вывод — Markdown на русском языке, не более 200 слов. Не изменяй данные.`,
        ].join('\n'),
      );
    },
  );

  mcp.registerPrompt(
    'etn.suggest_links',
    {
      title: 'Предложить связи',
      description:
        'Предложить возможные связи для мысли на основе текстов её соседей и содержимого сети.',
      argsSchema: {
        network_id: z.string().min(1),
        thought_id: z.string().min(1),
      },
    },
    (args) => {
      const { network_id, thought_id } = args;
      return promptResult(
        [
          `Предложи возможные связи для мысли сети ETN.`,
          ``,
          `Сделай следующее:`,
          `1. Прочитай мысль: \`etn://networks/${network_id}/thoughts/${thought_id}\`.`,
          `2. Изучи её соседей: \`etn://networks/${network_id}/thoughts/${thought_id}/neighbors\`.`,
          `3. Найди кандидатов поиском: инструмент \`etn.thoughts.search\` (scope=names) по ключевым словам из названия и текстов мысли.`,
          `4. Для каждого кандидата обоснуй связь и предложи тип (загляни в \`etn://networks/${network_id}/link-types\`).`,
          ``,
          `Вывод — список из 3–10 предложений в формате: цель → тип связи → обоснование.`,
          `Не создавай связи самостоятельно — только предложи.`,
        ].join('\n'),
      );
    },
  );

  mcp.registerPrompt(
    'etn.detect_duplicates',
    {
      title: 'Найти дубликаты',
      description:
        'Найти кандидатов на слияние в поддереве: собрать подграф и прогнать названия через find_duplicates.',
      argsSchema: {
        network_id: z.string().min(1),
        seed_thought_id: z.string().min(1),
        radius: z.number().int().min(1).max(5).optional(),
      },
    },
    (args) => {
      const radius = args.radius ?? 2;
      return promptResult(
        [
          `Найди кандидатов на слияние (дубликаты) в подграфе сети ETN.`,
          ``,
          `Сделай следующее:`,
          `1. Собери подграф: \`etn.thoughts.subgraph\` с seed_ids=[${JSON.stringify(args.seed_thought_id)}], radius=${radius}.`,
          `2. Для каждой мысли подграфа вызови \`etn.thoughts.find_duplicates\` с её названием и синонимами.`,
          `3. Отфильтруй совпадения с оценкой «точное» или «по синониму».`,
          ``,
          `Вывод — Markdown-таблица: пара мыслей → тип совпадения → рекомендация (слить/переименовать/оставить).`,
          `Не изменяй данные — только отчёт.`,
        ].join('\n'),
      );
    },
  );

  mcp.registerPrompt(
    'etn.generate_report',
    {
      title: 'Отчёт по подграфу',
      description:
        'Собрать Markdown-документ по подграфу на заданную тему: контекст, хронология, выводы.',
      argsSchema: {
        network_id: z.string().min(1),
        topic: z.string().min(1),
        seed_ids: z.array(z.string().min(1)).min(1).max(20),
        radius: z.number().int().min(1).max(5).optional(),
      },
    },
    (args) => {
      const radius = args.radius ?? 2;
      return promptResult(
        [
          `Собери Markdown-отчёт по теме «${args.topic}» на основе данных сети ETN.`,
          ``,
          `Сделай следующее:`,
          `1. Собери контекст: \`etn.thoughts.subgraph\` с seed_ids=[${args.seed_ids
            .map((id) => JSON.stringify(id))
            .join(', ')}], radius=${radius}, include_comments=true.`,
          `2. При необходимости дополни контекст поиском \`etn.thoughts.search\` и ресурсами типов: \`etn://networks/${args.network_id}/thought-types\`, \`etn://networks/${args.network_id}/link-types\`.`,
          `3. Составь структурированный документ: цель, ключевые мысли, связи, хронология, выводы и открытые вопросы.`,
          ``,
          `Вывод — готовый Markdown на русском языке. Если хочешь сохранить отчёт — создай хронологический комментарий у корневой мысли через \`etn.comments.upsert\` (kind=chronological).`,
        ].join('\n'),
      );
    },
  );
}
