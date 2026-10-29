/**
 * MCP prompts (task F5, docs/05-mcp-server.md §5; `etn.how_to_*` — task
 * 940a499d, ADR b2eebf8b level 1).
 *
 * Parameterised templates for typical agent jobs. Each returns a plain
 * text prompt describing the workflow in terms of the server's own tools and
 * `etn://` resources, so the host LLM can execute it end-to-end. Prompts are
 * pure text — they perform no data access and need no membership checks.
 *
 * Контракт аргументов (ошибка b2223e98): протокол `prompts/get` передаёт
 * аргументы как `Record<string, string>` — клиентский SDK проверяет их как
 * словарь строк, серверный парсит zod-схему ИЗ СТРОК. Массив или число в
 * `argsSchema` недостижимы по проводу ни с клиента, ни с сервера, поэтому
 * `seed_ids` и `radius` объявлены строками, а разбор (JSON-массив,
 * разделители, диапазон) делает обработчик. Прямой вызов production-
 * регистрации в обход провода по-прежнему принимает прежние массив/число —
 * ради обратной совместимости.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { McpRuntime } from './context.js';
import { writeBatchHowToText } from './how-to.js';

/** Wrap prompt text into a single user-role message result. */
function promptResult(text: string): GetPromptResult {
  return { messages: [{ role: 'user', content: { type: 'text', text } }] };
}

/** Предел числа ядер подграфа в `etn.generate_report` (было и остаётся 1..20). */
export const MAX_PROMPT_SEED_IDS = 20;

/** Диапазон `radius` промптов `etn.detect_duplicates` / `etn.generate_report`. */
export const PROMPT_RADIUS_MIN = 1;
export const PROMPT_RADIUS_MAX = 5;
export const PROMPT_RADIUS_DEFAULT = 2;

/**
 * Ввод `seed_ids`: по протоколу MCP — строка; массив допустим только при
 * прямом вызове production-регистрации в обход провода (обратная совместимость).
 */
export type SeedIdsInput = string | readonly string[];

/** Ошибка валидации аргумента промпта: код `-32602`, сообщение — что не так. */
function invalidArg(message: string): McpError {
  return new McpError(ErrorCode.InvalidParams, message);
}

/**
 * Разобрать `seed_ids` в список id. Принимает JSON-массив строк
 * (`["id1","id2"]`), список через запятую/пробелы/переводы строк и смесь
 * обоих видов в одной строке. Пробелы обрезаются, пустые значения и
 * дубликаты отбрасываются с сохранением порядка; после разбора — 1..20 id.
 */
export function parseSeedIds(input: SeedIdsInput): string[] {
  if (typeof input !== 'string' && !Array.isArray(input)) {
    throw invalidArg(`seed_ids: ожидается строка или массив строк, получено ${jsonType(input)}`);
  }
  const tokens = typeof input === 'string' ? splitSeedIds(input) : [...input];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const [index, token] of tokens.entries()) {
    if (typeof token !== 'string') {
      throw invalidArg(`seed_ids[${index}]: ожидается строковый id, получено ${jsonType(token)}`);
    }
    const id = token.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) {
    throw invalidArg('seed_ids: пустой список — передайте хотя бы один id');
  }
  if (ids.length > MAX_PROMPT_SEED_IDS) {
    throw invalidArg(`seed_ids: ${ids.length} id — предел ${MAX_PROMPT_SEED_IDS}`);
  }
  return ids;
}

/**
 * Разобрать `radius`: целое 1..5. Строка — проводной вид, число — прежний
 * прямой вызов регистрации; `undefined` — дефолт 2.
 */
export function parseRadiusArg(input: string | number | undefined): number {
  if (input === undefined) return PROMPT_RADIUS_DEFAULT;
  const range = `${PROMPT_RADIUS_MIN}..${PROMPT_RADIUS_MAX}`;
  let value: number;
  if (typeof input === 'number') {
    value = input;
  } else if (/^[+-]?\d+$/u.test(input.trim())) {
    value = Number(input.trim());
  } else {
    value = Number.NaN;
  }
  if (!Number.isInteger(value)) {
    throw invalidArg(`radius: ожидается целое число ${range}, получено ${JSON.stringify(input)}`);
  }
  if (value < PROMPT_RADIUS_MIN || value > PROMPT_RADIUS_MAX) {
    throw invalidArg(`radius: ${value} — вне диапазона ${range}`);
  }
  return value;
}

/** Токены `seed_ids`: JSON-массивы разворачиваются, остальное — литеральные id. */
function splitSeedIds(raw: string): string[] {
  const tokens: string[] = [];
  for (const fragment of splitSeedFragments(raw)) {
    if (!fragment.startsWith('[')) {
      tokens.push(fragment);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fragment);
    } catch (err) {
      throw invalidArg(
        `seed_ids: битый JSON-массив «${shorten(fragment)}»: ${(err as Error).message}` +
          ' — id должны быть строками в двойных кавычках',
      );
    }
    for (const [index, element] of (parsed as unknown[]).entries()) {
      if (typeof element !== 'string') {
        throw invalidArg(`seed_ids[${index}]: ожидается строковый id, получено ${jsonType(element)}`);
      }
      tokens.push(element);
    }
  }
  return tokens;
}

/**
 * Фрагменты строки `seed_ids`: разделители — запятая и пробельные символы, но
 * только ВНЕ JSON-массивов (скобки и кавычки учитываются), поэтому
 * `[ "id1" , "id2" ] id3` даёт фрагменты `[ "id1" , "id2" ]` и `id3`.
 */
function splitSeedFragments(raw: string): string[] {
  const fragments: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of raw) {
    if (inString) {
      current += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      current += char;
      continue;
    }
    if (char === '[') {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ']') {
      depth -= 1;
      if (depth < 0) throw invalidArg('seed_ids: лишняя закрывающая скобка «]»');
      current += char;
      continue;
    }
    if (depth === 0 && (char === ',' || /\s/u.test(char))) {
      if (current.trim() !== '') fragments.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (depth !== 0) throw invalidArg('seed_ids: незакрытый JSON-массив — нет закрывающей «]»');
  if (inString) throw invalidArg('seed_ids: незакрытая двойная кавычка');
  if (current.trim() !== '') fragments.push(current.trim());
  return fragments;
}

/** Тип значения по-русски — для сообщений о неверном вводе. */
function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'массив';
  if (typeof value === 'number') return 'число';
  if (typeof value === 'boolean') return 'логическое значение';
  if (typeof value === 'object') return 'объект';
  return typeof value;
}

/** Укоротить фрагмент ввода для сообщения об ошибке. */
function shorten(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
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
        radius: z
          .string()
          .optional()
          .describe('радиус подграфа: целое число 1..5 строкой (по умолчанию 2)'),
      },
    },
    (args) => {
      const radius = parseRadiusArg(args.radius);
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
        seed_ids: z
          .string()
          .describe(
            'id ядер подграфа строкой: JSON-массив (["id1","id2"]) или список через запятую/пробелы; 1..20',
          ),
        radius: z
          .string()
          .optional()
          .describe('радиус подграфа: целое число 1..5 строкой (по умолчанию 2)'),
      },
    },
    (args) => {
      const radius = parseRadiusArg(args.radius);
      const seedIds = parseSeedIds(args.seed_ids);
      return promptResult(
        [
          `Собери Markdown-отчёт по теме «${args.topic}» на основе данных сети ETN.`,
          ``,
          `Сделай следующее:`,
          `1. Собери контекст: \`etn.thoughts.subgraph\` с seed_ids=[${seedIds
            .map((id) => JSON.stringify(id))
            .join(', ')}], radius=${radius}, include_comments=true.`,
          `2. При необходимости дополни контекст поиском \`etn.thoughts.search\` и ресурсами типов: \`etn://networks/${args.network_id}/thought-types\`, \`etn://networks/${args.network_id}/link-types\`.`,
          `3. Составь структурированный документ: цель, ключевые мысли, связи, хронология, выводы и открытые вопросы.`,
          ``,
          `Вывод — готовый Markdown на русском языке. Если хочешь сохранить отчёт — запиши хронологический комментарий у корневой мысли через \`etn.thoughts.write\` (поле \`chronicle\` в элементе батча).`,
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
      title: 'Как делать частичное слияние слоя (etn.ops, action layers.merge)',
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
          `Как слить слой в родителя целиком или частично (\`etn.ops { action: "layers.merge" }\`, сеть ${args.network_id}).`,
          ``,
          `1. Осмотрись: \`etn.layers.list\` — возьми layer_id и убедись, что у слоя есть родитель (основу и служебные слои слить нельзя).`,
          `2. Посмотри, что в слое: \`etn.ops { action: "layers.diff", params: { network_id: ${JSON.stringify(args.network_id)}, layer_id: ${JSON.stringify(layerRef)} } }\` — структурная разница (links: added/removed/type_changed/reparented/reorder_collapsed; overridden — физические строки слоя). Текстовую разницу даст \`etn.ops { action: "layers.diff_doc", params: { network_id, layer_id } }\` — используй обе.`,
          `3. Полное слияние: \`etn.ops { action: "layers.merge", params: { network_id, layer_id }, confirm: true }\` — без tables переносятся все изменения слоя.`,
          `4. Частичное слияние: добавь в params \`tables: { "<таблица>": ["<id строк>"] }\`. Таблицы ветвимы: thoughts, thought_synonyms, links, thought_types, link_types, properties, type_properties, type_property_overrides, property_values, comments, comment_targets, attachments. Ключи — ЛОГИЧЕСКИЕ id строк (те же, что в diff.override и в обычных инструментах).`,
          ``,
          `Замкнутость (missing_closure): если выбранная строка ссылается на другую строку (связь — на мысль, комментарий — на владельца и т.п.), ссылка должна быть либо тоже выбрана, либо уже существовать в родителе. Ошибка перечисляет недостающие ссылки в details.missing_closure — добавь их в tables и повтори.`,
          ``,
          `Конфликты (conflicts): если родитель изменил строку после создания слоя (base_version ≠ текущая версия родителя), ВСЯ операция отклоняется — частичного применения не бывает. details.conflicts перечисляет расхождения (таблица, id, expected_base_version, current_version). Разреши конфликт вручную (приведи слой к новой версии родителя) и повтори слияние.`,
          ``,
          `Reserve-слой: если слияние что-то перезаписывает или удаляет, сервер автоматически создаёт служебный резервный слой с состоянием до слияния (reserve_layer_id в ответе). Откат ручной: скопируй нужное из резерва, затем удали резерв. Вставки-only слияние резерва не создаёт.`,
          `Успешный ответ: { applied, skipped, reorder_collapsed, reserve_layer_id, purged }. skipped — связи, чей конец исчез физически (§6.4): слияние всё равно успешно.`,
          `После слияния проверь остаток: повторный \`etn.ops { action: "layers.diff" }\` покажет, что ещё не слито; пустой слой можно удалить \`etn.ops { action: "layers.delete", params: { network_id, layer_id }, confirm: true }\`.`,
        ].join('\n'),
      );
    },
  );

  mcp.registerPrompt(
    'etn.how_to_purge',
    {
      title: 'Как удалять двухфазно (trash → проверка блокировок → purge)',
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
          `1. \`etn.ops { action: "thoughts.trash", params: { network_id, thought_id, trashed: true } }\` — мысль уходит в корзину, исчезая из обычных выборок, но физически остаётся. Вернуть: тот же action с \`trashed: false\`.`,
          `2. Посмотри корзину целиком: \`etn.ops { action: "trash.list", params: { network_id } }\` — каждая строка уже с готовой проверкой блокировки (blocked/blocking), без отдельной проверки блокировок.`,
          ``,
          `Что блокирует физическое удаление:`,
          `- использование мысли как цели свойства-связи другой мысли (снять: \`etn.ops { action: "usage_clear", params: { network_id, thought_id } }\` или убрать связь у владельца);`,
          `- удержание живой теневой строкой рабочего слоя (holding_layers в blocking; сначала разбери/слей слой: \`etn.ops { action: "layers.merge" }\`);`,
          `- будущие сироты: физическое удаление мысли с детьми не удаляет детей, но о них сообщит проверка (orphaned_children).`,
          `Точечная проверка без корзины: \`etn.ops { action: "thoughts.deletion_check", params: { network_id, thought_ids: [...] } }\`.`,
          ``,
          `Фаза 2 — физическая чистка:`,
          `3. \`etn.ops { action: "trash.purge", params: { network_id }, confirm: true }\` — «удалить всё, что возможно»: физически стирает каждую помеченную строку без блокировок, заблокированные молча пропускает. Ответ { purged, skipped }.`,
          `4. Если что-то осталось в skipped — разбери блокировки по списку above и повтори purge.`,
          ``,
          `Прямое \`etn.ops { action: "thoughts.delete", params: { network_id, thought_id }, confirm: true }\` — физическое удаление сразу; оно само прогоняет ту же проверку блокировок и падает с details.blocking (плюс details.how_to с именем этого промпта), если удаление заблокировано. Защищённые мысли (HOME) не удаляются вовсе.`,
        ].join('\n'),
      );
    },
  );

  // `etn.how_to_write_batch` (задача 053751b5, 0.7.2) — пошаговая инструкция
  // для батчевой записи `etn.thoughts.write`. Локальные `ref`/`target_ref`,
  // циклы, лимиты, миграция с поглощённых инструментов (удалены в 0.8.2).
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
    (args) => promptResult(writeBatchHowToText(args.network_id)),
  );
}
