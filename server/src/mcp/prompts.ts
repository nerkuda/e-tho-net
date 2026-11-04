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
    throw invalidArg(`seed_ids: expected a string or an array of strings, got ${jsonType(input)}`);
  }
  const tokens = typeof input === 'string' ? splitSeedIds(input) : [...input];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const [index, token] of tokens.entries()) {
    if (typeof token !== 'string') {
      throw invalidArg(`seed_ids[${index}]: expected a string id, got ${jsonType(token)}`);
    }
    const id = token.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) {
    throw invalidArg('seed_ids: empty list — pass at least one id');
  }
  if (ids.length > MAX_PROMPT_SEED_IDS) {
    throw invalidArg(`seed_ids: ${ids.length} ids — the limit is ${MAX_PROMPT_SEED_IDS}`);
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
    throw invalidArg(`radius: expected an integer ${range}, got ${JSON.stringify(input)}`);
  }
  if (value < PROMPT_RADIUS_MIN || value > PROMPT_RADIUS_MAX) {
    throw invalidArg(`radius: ${value} is out of range ${range}`);
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
        `seed_ids: malformed JSON array "${shorten(fragment)}": ${(err as Error).message}` +
          ' — ids must be strings in double quotes',
      );
    }
    for (const [index, element] of (parsed as unknown[]).entries()) {
      if (typeof element !== 'string') {
        throw invalidArg(`seed_ids[${index}]: expected a string id, got ${jsonType(element)}`);
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
      if (depth < 0) throw invalidArg('seed_ids: extra closing bracket "]"');
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
  if (depth !== 0) throw invalidArg('seed_ids: unterminated JSON array — no closing "]"');
  if (inString) throw invalidArg('seed_ids: unterminated double quote');
  if (current.trim() !== '') fragments.push(current.trim());
  return fragments;
}

/** Тип значения — для сообщений о неверном вводе. */
function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'object') return 'object';
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
      title: 'Thought summary',
      description:
        'Build a short summary of a thought and its context: read the thought, its neighbors and comments.',
      argsSchema: {
        network_id: z.string().min(1),
        thought_id: z.string().min(1),
      },
    },
    (args) => {
      const { network_id, thought_id } = args;
      return promptResult(
        [
          'Build a short summary of a thought in the ETN network and its context.',
          ``,
          'Do the following:',
          `1. Read the thought: resource \`etn://networks/${network_id}/thoughts/${thought_id}\`.`,
          `2. Read the neighbors: \`etn://networks/${network_id}/thoughts/${thought_id}/neighbors\`.`,
          `3. Read the comments: \`etn://networks/${network_id}/thoughts/${thought_id}/comments\`.`,
          '4. Describe the essence of the thought, its role in the network, key links and recent chronological entries.',
          ``,
          'Output — Markdown in English, at most 200 words. Do not change any data.',
        ].join('\n'),
      );
    },
  );

  mcp.registerPrompt(
    'etn.suggest_links',
    {
      title: 'Suggest links',
      description:
        "Suggest possible links for a thought based on its neighbors' texts and the network content.",
      argsSchema: {
        network_id: z.string().min(1),
        thought_id: z.string().min(1),
      },
    },
    (args) => {
      const { network_id, thought_id } = args;
      return promptResult(
        [
          'Suggest possible links for a thought in the ETN network.',
          ``,
          'Do the following:',
          `1. Read the thought: \`etn://networks/${network_id}/thoughts/${thought_id}\`.`,
          `2. Study its neighbors: \`etn://networks/${network_id}/thoughts/${thought_id}/neighbors\`.`,
          '3. Find candidates by search: the `etn.thoughts.search` tool (scope=names) over keywords from the thought title and texts.',
          `4. For each candidate justify the link and suggest a type (look at \`etn://networks/${network_id}/link-types\`).`,
          ``,
          'Output — a list of 3–10 suggestions in the format: target → link type → rationale.',
          'Do not create links yourself — only suggest them.',
        ].join('\n'),
      );
    },
  );

  mcp.registerPrompt(
    'etn.detect_duplicates',
    {
      title: 'Find duplicates',
      description:
        'Find merge candidates in a subtree: build a subgraph and run the titles through find_duplicates.',
      argsSchema: {
        network_id: z.string().min(1),
        seed_thought_id: z.string().min(1),
        radius: z
          .string()
          .optional()
          .describe('subgraph radius: an integer 1..5 as a string (default 2)'),
      },
    },
    (args) => {
      const radius = parseRadiusArg(args.radius);
      return promptResult(
        [
          'Find merge candidates (duplicates) in an ETN network subgraph.',
          ``,
          'Do the following:',
          `1. Build the subgraph: \`etn.thoughts.subgraph\` with seed_ids=[${JSON.stringify(args.seed_thought_id)}], radius=${radius}.`,
          '2. For each subgraph thought call `etn.thoughts.find_duplicates` with its title and synonyms.',
          '3. Keep matches rated "exact" or "by synonym".',
          ``,
          'Output — a Markdown table: thought pair → match type → recommendation (merge/rename/keep).',
          'Do not change data — report only.',
        ].join('\n'),
      );
    },
  );

  mcp.registerPrompt(
    'etn.generate_report',
    {
      title: 'Subgraph report',
      description:
        'Build a Markdown document on a subgraph for a given topic: context, chronology, conclusions.',
      argsSchema: {
        network_id: z.string().min(1),
        topic: z.string().min(1),
        seed_ids: z
          .string()
          .describe(
            'subgraph seed ids as a string: a JSON array (["id1","id2"]) or a comma/space separated list; 1..20',
          ),
        radius: z
          .string()
          .optional()
          .describe('subgraph radius: an integer 1..5 as a string (default 2)'),
      },
    },
    (args) => {
      const radius = parseRadiusArg(args.radius);
      const seedIds = parseSeedIds(args.seed_ids);
      return promptResult(
        [
          `Build a Markdown report on the topic "${args.topic}" based on the ETN network data.`,
          ``,
          'Do the following:',
          `1. Build the context: \`etn.thoughts.subgraph\` with seed_ids=[${seedIds
            .map((id) => JSON.stringify(id))
            .join(', ')}], radius=${radius}, include_comments=true.`,
          `2. If needed, extend the context with \`etn.thoughts.search\` and the type resources: \`etn://networks/${args.network_id}/thought-types\`, \`etn://networks/${args.network_id}/link-types\`.`,
          '3. Compose a structured document: goal, key thoughts, links, chronology, conclusions and open questions.',
          ``,
          'Output — ready Markdown in English. If you want to keep the report, write a chronological comment on the root thought via `etn.thoughts.write` (the `chronicle` field of the batch item).',
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
      title: 'How to do a partial layer merge (etn.ops, action layers.merge)',
      description:
        'Step-by-step: `tables` selection closure, base_version conflicts, the reserve layer for rollback.',
      argsSchema: {
        network_id: z.string().min(1),
        layer_id: z.string().min(1).optional(),
      },
    },
    (args) => {
      const layerRef = args.layer_id ?? '<layer_id>';
      return promptResult(
        [
          `How to merge a layer into its parent fully or partially (\`etn.ops { action: "layers.merge" }\`, network ${args.network_id}).`,
          ``,
          '1. Look around: `etn.layers.list` — take the layer_id and make sure the layer has a parent (the base and service layers cannot be merged).',
          `2. Look at what is in the layer: \`etn.ops { action: "layers.diff", params: { network_id: ${JSON.stringify(args.network_id)}, layer_id: ${JSON.stringify(layerRef)} } }\` — the structural difference (links: added/removed/type_changed/reparented/reorder_collapsed; overridden — physical rows of the layer). The text difference comes from \`etn.ops { action: "layers.diff_doc", params: { network_id, layer_id } }\` — use both.`,
          '3. Full merge: `etn.ops { action: "layers.merge", params: { network_id, layer_id }, confirm: true }` — without tables all layer changes are transferred.',
          '4. Partial merge: add `tables: { "<table>": ["<row ids>"] }` to params. Tables are branchable: thoughts, thought_synonyms, links, thought_types, link_types, properties, type_properties, type_property_overrides, property_values, comments, comment_targets, attachments. Keys are LOGICAL row ids (the same as in diff.override and in the regular tools).',
          ``,
          'Closure (missing_closure): if a selected row references another row (a link — a thought, a comment — an owner, etc.), the reference must either be selected too or already exist in the parent. The error lists the missing references in details.missing_closure — add them to tables and retry.',
          ``,
          'Conflicts (conflicts): if the parent changed a row after the layer was created (base_version ≠ the current parent version), the WHOLE operation is rejected — partial application never happens. details.conflicts lists the discrepancies (table, id, expected_base_version, current_version). Resolve the conflict manually (bring the layer to the new parent version) and retry the merge.',
          ``,
          'Reserve layer: if the merge overwrites or deletes anything, the server automatically creates a service reserve layer with the state before the merge (reserve_layer_id in the response). Rollback is manual: copy what you need from the reserve, then delete the reserve. An insert-only merge creates no reserve.',
          'Successful response: { applied, skipped, reorder_collapsed, reserve_layer_id, purged }. skipped — links whose end disappeared physically (§6.4): the merge still succeeds.',
          'After the merge check the remainder: a repeated `etn.ops { action: "layers.diff" }` shows what is not merged yet; an empty layer can be deleted with `etn.ops { action: "layers.delete", params: { network_id, layer_id }, confirm: true }`.',
        ].join('\n'),
      );
    },
  );

  mcp.registerPrompt(
    'etn.how_to_purge',
    {
      title: 'How to delete in two phases (trash → block check → purge)',
      description:
        'Step-by-step two-phase deletion: mark to the basket, check blocks, physically purge.',
      argsSchema: {
        network_id: z.string().min(1),
      },
    },
    (args) => {
      return promptResult(
        [
          `How to physically delete thoughts and links in network ${args.network_id} (two-phase deletion, S13).`,
          ``,
          'Phase 1 — marking (reversible):',
          '1. `etn.ops { action: "thoughts.trash", params: { network_id, thought_id, trashed: true } }` — the thought goes to the basket, disappearing from regular queries but physically staying. To restore: the same action with `trashed: false`.',
          '2. Look at the whole basket: `etn.ops { action: "trash.list", params: { network_id } }` — each row already has a computed block check (blocked/blocking), no separate block check needed.',
          ``,
          'What blocks a physical delete:',
          '- the thought being used as a link-property target of another thought (clear: `etn.ops { action: "usage_clear", params: { network_id, thought_id } }` or remove the link at the owner);',
          '- holding by a live shadow row of a working layer (holding_layers in blocking; first analyse/merge the layer: `etn.ops { action: "layers.merge" }`);',
          '- future orphans: a physical delete of a thought with children does not delete the children, but the check reports them (orphaned_children).',
          'A point check without the basket: `etn.ops { action: "thoughts.deletion_check", params: { network_id, thought_ids: [...] } }`.',
          ``,
          'Phase 2 — physical purge:',
          '3. `etn.ops { action: "trash.purge", params: { network_id }, confirm: true }` — "delete everything possible": physically erases every marked row without blocks and silently skips blocked ones. Response { purged, skipped }.',
          '4. If anything remains in skipped — resolve the blocks from the list above and repeat the purge.',
          ``,
          'A direct `etn.ops { action: "thoughts.delete", params: { network_id, thought_id }, confirm: true }` — physical deletion at once; it runs the same block check itself and fails with details.blocking (plus details.how_to with this prompt name) if the deletion is blocked. Protected thoughts (HOME) are never deleted.',
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
      title: 'How to do a thought batch write via etn.thoughts.write',
      description:
        'Step-by-step for `etn.thoughts.write`: local `ref`, `target_ref`, cycles, limits, migration from the absorbed tools.',
      argsSchema: {
        network_id: z.string().min(1),
      },
    },
    (args) => promptResult(writeBatchHowToText(args.network_id)),
  );
}
