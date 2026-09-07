/**
 * MCP prompts (task F5, docs/05-mcp-server.md §5; `etn.how_to_*` — task
 * 940a499d, ADR b2eebf8b level 1).
 *
 * Parameterised templates for typical agent jobs. Each returns a plain
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
 * Register the `etn.*` prompt templates on a fresh {@link McpServer}:
 * the four workflow templates of task F5 plus the procedural `etn.how_to_*`
 * explainers of the progressive-disclosure ADR (task 940a499d, ADR b2eebf8b
 * level 1) — detailed how-to knowledge for the rare complex operations that
 * must not bloat `tools/list` descriptions.
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

  // -------------------------------------------------------------------------
  // `etn.how_to_*` — процедурные промпты уровня 1 (ADR b2eebf8b, задача
  // 940a499d): подробное «как делать» для редких сложных операций. Описание
  // инструмента ссылается на промпт одной строкой; при ошибке сервер
  // возвращает имя промпта в `details.how_to` (уровень 2).
  // -------------------------------------------------------------------------

  mcp.registerPrompt(
    'etn.how_to_merge_partial',
    {
      title: 'Как делать частичное слияние слоя (etn.layers.merge с tables)',
      description:
        'Пошаговая инструкция: замкнутость выборки tables, конфликты base_version, reserve-слой для отката.',
      argsSchema: {
        network_id: z.string().min(1),
        layer_id: z.string().min(1).optional(),
      },
    },
    (args) => {
      const layerRef = args.layer_id ?? '<layer_id>';
      return promptResult(
        [
          `Как слить слой в родителя целиком или частично (etn.layers.merge, сеть ${args.network_id}).`,
          ``,
          `1. Осмотрись: \`etn.layers.list\` — возьми layer_id и убедись, что у слоя есть родитель (основу и служебные слои слить нельзя).`,
          `2. Посмотри, что в слое: \`etn.layers.diff { network_id: ${JSON.stringify(args.network_id)}, layer_id: ${JSON.stringify(layerRef)} }\` — структурная разница (links: added/removed/type_changed/reparented/reorder_collapsed; overridden — физические строки слоя). Текстовую разницу даст \`etn.layers.diff_doc\` — используй обе.`,
          `3. Полное слияние: \`etn.layers.merge { network_id, layer_id }\` — без tables переносятся все изменения слоя.`,
          `4. Частичное слияние: добавь \`tables: { "<таблица>": ["<id строк>"] }\`. Таблицы ветвимы: thoughts, thought_synonyms, links, thought_types, link_types, properties, type_properties, type_property_overrides, property_values, comments, comment_targets, attachments. Ключи — ЛОГИЧЕСКИЕ id строк (те же, что в diff.override и в обычных инструментах).`,
          ``,
          `Замкнутость (missing_closure): если выбранная строка ссылается на другую строку (связь — на мысль, комментарий — на владельца и т.п.), ссылка должна быть либо тоже выбрана, либо уже существовать в родителе. Ошибка перечисляет недостающие ссылки в details.missing_closure — добавь их в tables и повтори.`,
          ``,
          `Конфликты (conflicts): если родитель изменил строку после создания слоя (base_version ≠ текущая версия родителя), ВСЯ операция отклоняется — частичного применения не бывает. details.conflicts перечисляет расхождения (таблица, id, expected_base_version, current_version). Разреши конфликт вручную (приведи слой к новой версии родителя) и повтори слияние.`,
          ``,
          `Reserve-слой: если слияние что-то перезаписывает или удаляет, сервер автоматически создаёт служебный резервный слой с состоянием до слияния (reserve_layer_id в ответе). Откат ручной: скопируй нужное из резерва, затем удали резерв. Вставки-only слияние резерва не создаёт.`,
          `Успешный ответ: { applied, skipped, reorder_collapsed, reserve_layer_id, purged }. skipped — связи, чей конец исчез физически (§6.4): слияние всё равно успешно.`,
          `После слияния проверь остаток: повторный \`etn.layers.diff\` покажет, что ещё не слито; пустой слой можно удалить \`etn.layers.delete\`.`,
        ].join('\n'),
      );
    },
  );

  mcp.registerPrompt(
    'etn.how_to_purge',
    {
      title: 'Как удалять двухфазно (trash → deletion_check → purge)',
      description:
        'Пошаговая инструкция двухфазного удаления: пометка в корзину, проверка блокировок, физическая чистка.',
      argsSchema: {
        network_id: z.string().min(1),
      },
    },
    (args) => {
      return promptResult(
        [
          `Как физически удалять мысли и связи в сети ${args.network_id} (двухфазное удаление, S13).`,
          ``,
          `Фаза 1 — пометка (обратима):`,
          `1. \`etn.thoughts.trash { network_id, thought_id, trashed: true }\` (или \`etn.links.trash\`) — строка уходит в корзину, исчезая из обычных выборок, но физически остаётся. Вернуть: \`trashed: false\`.`,
          `2. Посмотри корзину целиком: \`etn.trash.list\` — каждая строка уже с готовой проверкой блокировки (blocked/blocking), без отдельных вызовов deletion_check.`,
          ``,
          `Что блокирует физическое удаление:`,
          `- использование мысли как значения thought_ref-свойства другой мысли (снять: \`etn.thoughts.usage_clear\` или убрать свойство у владельца);`,
          `- удержание живой теневой строкой рабочего слоя (holding_layers в blocking; сначала разбери/слей слой через etn.layers.merge);`,
          `- будущие сироты: физическое удаление мысли с детьми не удаляет детей, но о них сообщит проверка (orphaned_children).`,
          `Точечная проверка без корзины: \`etn.thoughts.deletion_check { network_id, thought_ids: [...] }\` / \`etn.links.deletion_check\`.`,
          ``,
          `Фаза 2 — физическая чистка:`,
          `3. \`etn.trash.purge { network_id }\` — «удалить всё, что возможно»: физически стирает каждую помеченную строку без блокировок, заблокированные молча пропускает. Ответ { purged, skipped }.`,
          `4. Если что-то осталось в skipped — разбери блокировки по списку above и повтори purge.`,
          ``,
          `Прямое \`etn.thoughts.delete\` / \`etn.links.delete\` — физическое удаление сразу; оно само прогоняет ту же проверку блокировок и падает с details.blocking (плюс details.how_to с именем этого промпта), если удаление заблокировано. Защищённые мысли (HOME) не удаляются вовсе.`,
        ].join('\n'),
      );
    },
  );
}
