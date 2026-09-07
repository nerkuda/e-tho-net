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

  // `etn.how_to_write_batch` (задача 053751b5, 0.7.2) — пошаговая инструкция
  // для батчевой записи `etn.thoughts.write`. Локальные `ref`/`target_ref`,
  // циклы, лимиты, миграция с поглощённых инструментов.
  mcp.registerPrompt(
    'etn.how_to_write_batch',
    {
      title: 'Как делать батч-запись мыслей через etn.thoughts.write',
      description:
        'Пошаговая инструкция для `etn.thoughts.write`: локальные `ref`, `target_ref`, циклы, лимиты, миграция с поглощённых инструментов.',
      argsSchema: {
        network_id: z.string().min(1),
      },
    },
    (args) => {
      return promptResult(
        [
          `Как записывать связный фрагмент графа одной транзакцией через \`etn.thoughts.write\` в сети ${args.network_id} (задача 053751b5, 0.7.2).`,
          ``,
          `1. Зачем: один вызов покрывает сценарии \`etn.thoughts.create\`/\`update\`/\`set_active\`/\`upsert_bundle\`, \`etn.links.create\`, \`etn.properties.set\`, \`etn.comments.upsert\` — те инструменты помечены \`deprecated_since: '0.7.2'\`, \`registerTools\` их в \`tools/list\` больше не выдаёт (но код остался на случай отката и для старых клиентов в период миграции).`,
          ``,
          `2. Параметр верхнего уровня: \`thoughts[]\` — массив от 1 до \`MCP_MAX_THOUGHTS_PER_WRITE\` (= 50, живёт в \`@etn/shared\`). Превышение → \`VALIDATION_ERROR\` до транзакции. Один слот write-бюджета на ВЕСЬ вызов, одна строка \`audit_log\` (\`thought_count\`/\`link_count\`/\`item_count\` в details), одна транзакция.`,
          ``,
          `3. Локальные \`ref\`: каждая позиция \`thoughts[]\` либо адресует существующую мысль (\`thought_id\`), либо описывает новую (\`thought\` с \`title\`/\`synonyms\`/\`type\`/\`active\`). Ровно одно из двух (XOR) — иначе \`VALIDATION_ERROR\`. Если задано \`thought\` — обязательно объяви \`ref\`; имя действует ТОЛЬКО внутри батча и должно быть уникальным (повтор → \`VALIDATION_ERROR\`). На этапе \`thought\` сервис сначала ищет дубликаты (\`find_duplicates\`), и \`on_duplicate\` решает исход: \`fail\` (по умолчанию, \`details.candidates\`), \`reuse\` (привязывает остальное к существующей), \`update\` (правит title/synonyms/type/active).`,
          ``,
          `4. \`comment\` — постоянный (create-or-update), \`chronicle[]\` — добавляемые хронологические записи (append-only, никогда не перезаписываются). \`properties\` — карта \`ключ → значение\`; ключ — имя из реестра сети (NOT_FOUND если не зарегистрирован). \`attachments[]\` — обычные url/file вложения.`,
          ``,
          `5. Связи — \`links[]\`: каждая ссылка адресует цель либо \`target_id\` (существующая мысль), либо \`target_ref\` (ref внутри этого же батча). Ровно одно из двух; неизвестный \`target_ref\` → \`VALIDATION_ERROR\` ДО записи (видно в \`details.known_refs\`). Циклы \`A → B → A\` корректны: на фазе 2 все мысли уже созданы, на фазе 3 связи разрешаются в реальные id. \`direction\`: \`parent\` — подвешиваем текущую мысль ПОД цель; \`child\` — текущая мысль становится родителем цели. \`type\` (имя) XOR \`type_id\`.`,
          ``,
          `6. На связи тоже можно писать знание в той же транзакции: \`links[].properties\` (карта свойств связи) и \`links[].comment\` (постоянный комментарий связи). Неудача внутри свойств откатывает всю транзакцию — никаких полузаписанных графов.`,
          ``,
          `7. Активность: на каждой реально изменённой сущности сервер эмитит свой \`thought.created\`/\`thought.updated\`/\`comment.created\`/\`comment.updated\`/\`link.created\`/\`attachment.created\` через тот же \`emitAgentActivityEvent\`, что и раньше — другие участники сети видят их в реальном времени. \`warnings\` агрегированы по всему батчу; каждый элемент несёт \`ref\` или \`thought_id\`.`,
          ``,
          `8. Шаблон вызова:`,
          `   \`\`\``,
          `   {`,
          `     "network_id": "${args.network_id}",`,
          `     "thoughts": [`,
          `       { "ref": "adr", "thought": { "title": "ADR-001", "type": "ADR", "active": true },`,
          `         "comment": { "body_md": "## Context\\n..." },`,
          `         "chronicle": [ { "body_md": "согласовано", "valid_from": "2026-09-06" } ],`,
          `         "properties": { "статус": "согласовано" },`,
          `         "links": [ { "direction": "child", "target_ref": "context",`,
          `                     "type": "применяется к", "comment": { "body_md": "..." } } ] },`,
          `       { "ref": "context", "thought": { "title": "Контекст" },`,
          `         "links": [ { "direction": "child", "target_ref": "adr" } ] }`,
          `     ]`,
          `   }`,
          `   \`\`\``,
          `   Цикл \`adr → context → adr\` через \`target_ref\` корректен: обе мысли создаются на фазе 2, обе связи — на фазе 3.`,
          ``,
          `9. Миграция со старых инструментов:`,
          `- \`etn.thoughts.create\` → один элемент \`thought\` в \`thoughts[]\`.`,
          `- \`etn.thoughts.update\` → \`thought_id\` + при необходимости \`thought\` с новыми полями. \`active: false\` на HOME → \`VALIDATION_ERROR\`.`,
          `- \`etn.thoughts.set_active\` → \`thought_id\` + \`thought: { ..., active: false }\`.`,
          `- \`etn.thoughts.upsert_bundle\` → один элемент со всеми подполями; \`on_duplicate\` поведёт себя так же.`,
          `- \`etn.links.create\` → один элемент с \`links[0]\`. Свойства/комментарий на связи теперь идут инлайн, а не отдельными вызовами.`,
          `- \`etn.properties.set\` → \`properties\` картой в нужном \`thoughts[]\`-элементе (или \`links[].properties\` для свойств на связи).`,
          `- \`etn.comments.upsert\` (постоянный) → \`comment\`; (хронологический) → \`chronicle[]\`.`,
        ].join('\n'),
      );
    },
  );
}
