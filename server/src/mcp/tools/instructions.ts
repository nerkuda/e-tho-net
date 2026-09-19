/**
 * instructions.ts — MCP-инструменты области «registerInstructionsTool».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';

import { Instructions } from '../../contracts.js';
import { EtnError, MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import { openMemberNetwork, runTool } from '../context.js';
import { getNetworkInstructions } from '../../domain/instructions-service.js';

export function registerInstructionsTool(mcp: McpServer, rt: McpRuntime): void {
  // ---------------------------------------------------------------------------
  // этон.instructions — витрина инструкций сети (ADR 717f04df, спека 14b0cc4f).
  //
  // Три режима через дискриминированное объединение:
  //   * `{ network_id, instruction_id }` — полный текст одной инструкции
  //     (постоянный комментарий мысли целиком, без обрезки);
  //   * `{ network_id, keywords }` — фильтр по title+synonyms мини-синтаксом;
  //   * `{ network_id }` — все актуальные инструкции сети.
  //
  // Если роль `instructions` не задана, ответ — `{ has_instructions: false, instructions: [] }`
  // (без ошибки). Только актуальные мысли; помеченные на удаление исключаются;
  // учитываются подтипы роли (L21-иерархия типов); читается текущий слой сессии.
  // ---------------------------------------------------------------------------
  // ВАЖНО (ошибка 18d7774a): схема инструмента — ОДИН объект, а не
  // `z.union([...])`. MCP-SDK публикует в `inputSchema` только объектные схемы
  // (`normalizeObjectSchema` в `server/zod-compat.js` отдаёт `undefined` на
  // всём, у чего нет `shape`), и union вырождался в пустой
  // `{ type: "object", properties: {} }`: агент видел инструмент без
  // параметров, звал его без аргументов и получал `Invalid input` на
  // обязательном `network_id`. Валидация при этом работала (SDK откатывается
  // на исходную схему), поэтому расхождение было видно только в витрине.
  // Взаимоисключение режимов выражено `.refine()`: в zod 4 он возвращает тот
  // же `ZodObject`, `shape` не теряется и схема публикуется целиком.
  mcp.registerTool(
    'etn.instructions',
    {
      title: 'Витрина инструкций сети',
      description:
        'Read the network\'s instructions. Three modes: `{ network_id, instruction_id }` returns the FULL ' +
        'permanent comment (no truncation); `{ network_id, keywords }` filters by title+synonyms (mini-syntax: ' +
        'whitespace-AND, `-word` exclusion); `{ network_id }` returns every active instruction. When the network ' +
        'has not declared the `instructions` role → `{ has_instructions: false, instructions: [] }`.',
      inputSchema: Instructions.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.instructions'],
    },
    (args) =>
      runTool(async () => {
        const network = rt.deps.systemDb.getNetworkById(args.network_id);
        if (network === null) {
          throw new EtnError('NOT_FOUND', `Сеть ${args.network_id} не найдена.`, {
            network_id: args.network_id,
          });
        }
        // Слой сессии (ошибка 3f535ae8): витрина обязана читать ту же сеть,
        // что и остальные инструменты — `openMemberNetwork` резолвит слой
        // ключа и проверяет доступ. Без выбранного слоя это основа.
        const ndb = openMemberNetwork(rt, args.network_id);
        return {
          network_id: args.network_id,
          ...getNetworkInstructions(
            ndb,
            network.type_roles.instructions ?? null,
            args.network_id,
            {
              ...(args.instruction_id !== undefined
                ? { instructionId: args.instruction_id }
                : {}),
              ...(args.keywords !== undefined ? { keywords: args.keywords } : {}),
              ...(args.limit !== undefined ? { limit: args.limit } : {}),
              ...(args.offset !== undefined ? { offset: args.offset } : {}),
            },
          ),
        };
      }),
  );

  // =========================================================================
  // `etn.ontology.write` / `etn.ontology.delete` — задача cc9ca65e, 0.7.2.
  //
  // Управление онтологией сети (типы мыслей/связей, реестр свойств,
  // привязки свойств к типам) одной транзакцией.
  //
  // * `etn.ontology.write` — идемпотентный upsert пакетами `thought_types[]` /
  //   `link_types[]` / `properties[]` / `type_properties[]`. Локальные `ref`/
  //   `parent_ref`/`type_ref`/`property_ref` действуют только внутри батча.
  //   Повторный вызов с теми же аргументами не меняет состояние (action =
  //   `unchanged` на каждом элементе).
  // * `etn.ontology.delete` — деструктивное удаление одной сущности; без
  //   `force` отвергается на используемых элементах со счётчиками в
  //   `details`. Элемент, занятый в `type_roles` сети, отвергается даже
  //   с `force`.
  //
  // На каждый вызов — одна запись бюджета и одна строка `audit_log`. Real-time
  // события — по одному на изменённую сущность (`thought-type.*`,
  // `link-type.*`, `property-registry.*`, `property-definition.*`).
  // =========================================================================

}
