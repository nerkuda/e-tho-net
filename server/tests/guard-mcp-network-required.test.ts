/**
 * Сторож: обязательность сети в MCP-инструментах видна агенту ДО вызова.
 *
 * Ошибка 99f27451: живой smoke-тест показал, что `etn.thoughts.find_duplicates`
 * (а также `etn.thoughts.search` / `etn.thoughts.query`) без сети в аргументах
 * падают в рантайме с `VALIDATION_ERROR` «Нужно указать network_id или
 * network_ids», но в рекламируемом `inputSchema` эти поля не помечены
 * `required` и описания об этом не говорят. Агент узнавал о требовании только
 * из ошибки вызова.
 *
 * Причина структурная: в этих инструментах сеть задаётся формой «одно из двух»
 * (`network_id` XOR `network_ids`), а JSON Schema не умеет выражать «хотя бы
 * одно из перечисленных required». Поэтому обязательность здесь обязана нести
 * ОПИСАНИЕ полей (`.describe()`), и этот сторож краснеет, если:
 *  - у инструмента сеть обязательна в рантайме, но `required` её не содержит и
 *    описание на «одно из двух» не указывает;
 *  - кто-то снял описание, не переведя инструмент на `required`.
 *
 * Сверка идёт по РЕАЛЬНО рекламируемому каталогу (`tools/list` production-сервера),
 * а не по сырым контрактам: контракт `etn.thoughts.write` регистрируется только
 * при сборке сервера, и агент видит именно сконвертированную `inputSchema`.
 * Рантайм-поведение берём из того же контракта, что валидирует вызов
 * (`contractFor` в `contracts.ts`).
 *
 * Правило действует вместе со сторожем (AGENTS.md §2 п.5).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MCP_TOOL_NAMES } from '@etn/shared';

import { contractFor } from '../src/contracts.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
} from './mcp-helpers.js';

/** Минимальный срез JSON Schema инструмента, который нам нужен. */
interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonProp>;
  required?: string[];
}

interface JsonProp {
  type?: string;
  description?: string;
  enum?: unknown[];
  anyOf?: JsonProp[];
  oneOf?: JsonProp[];
  minItems?: number;
}

const NETWORK_KEYS = ['network_id', 'network_ids'] as const;

/** Есть ли сетевое требование среди issue рантайм-валидации. */
function hasNetworkIssue(issues: Array<{ path?: Array<string | number>; message: string }>): boolean {
  return issues.some((issue) => {
    const head = issue.path === undefined ? undefined : String(issue.path[0]);
    if (head !== undefined && (NETWORK_KEYS as readonly string[]).includes(head)) return true;
    return /network_ids?/.test(issue.message);
  });
}

/** Правдоподобная заглушка для значения required-поля по его JSON Schema. */
function dummyFor(prop: JsonProp | undefined): unknown {
  if (prop === undefined) return 'x';
  if (prop.enum !== undefined && prop.enum.length > 0) return prop.enum[0];
  if (prop.anyOf !== undefined) return dummyFor(prop.anyOf[0]);
  if (prop.oneOf !== undefined) return dummyFor(prop.oneOf[0]);
  switch (prop.type) {
    case 'array':
      return ['x'];
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'object':
      return {};
    default:
      return 'x';
  }
}

/** Собрать вход из всех required-полей, КРОМЕ сетевых, чтобы изолировать
 *  проверку сети от остальных обязательных аргументов (zod не гоняет
 *  refinements, когда базовый объект не прошёл разбор). */
function baseWithoutNetwork(schema: JsonSchema): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  for (const key of schema.required ?? []) {
    if ((NETWORK_KEYS as readonly string[]).includes(key)) continue;
    base[key] = dummyFor(schema.properties?.[key]);
  }
  return base;
}

describe('guard: MCP — обязательность сети видна в схеме/описании', { skip: !nativeAvailable() }, () => {
  it('у инструментов с обязательной сетью требование выражено required или описанием (XOR)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const { tools } = await handle.client.listTools();
        const byName = new Map(tools.map((t) => [t.name, t]));

        const violations: string[] = [];
        let checked = 0;

        for (const name of MCP_TOOL_NAMES) {
          const tool = byName.get(name);
          assert.ok(tool !== undefined, `инструмент ${name} отсутствует в tools/list`);
          const contract = contractFor(name);
          assert.ok(contract !== undefined, `у инструмента ${name} нет контракта в contractsByName`);

          const schema = tool.inputSchema as unknown as JsonSchema;
          const props = schema.properties ?? {};
          const required = schema.required ?? [];
          const hasNetworkProp = NETWORK_KEYS.some((k) => k in props);

          if (required.includes('network_id')) {
            // Плоский случай: сеть — обычное обязательное поле, видна в required.
            checked += 1;
            continue;
          }
          if (!hasNetworkProp) {
            // Сети среди параметров нет вовсе (`etn.guide`, `etn.ops`) — нечего проверять.
            continue;
          }

          // Сеть присутствует, но не в required: либо XOR-обязательна, либо
          // действительно опциональна. Различаем по фактической валидации.
          const base = baseWithoutNetwork(schema);
          const parsed = contract.schema.safeParse(base);
          if (parsed.success) {
            checked += 1;
            continue; // опциональна по смыслу (`etn.networks.write`, `etn.metrics.tools`)
          }
          const issues = parsed.error.issues as unknown as Array<{
            path?: Array<string | number>;
            message: string;
          }>;
          if (!hasNetworkIssue(issues)) {
            // Упало на другом поле, до проверки сети не дошли — не наш случай.
            continue;
          }

          // XOR-обязательна: подтверждаем, что любая из двух форм сеть закрывает.
          const withSingle = contract.schema.safeParse({ ...base, network_id: 'x' });
          const withMany = contract.schema.safeParse({ ...base, network_ids: ['x'] });
          if (!withSingle.success || !withMany.success) {
            violations.push(
              `  • ${name}: сеть обязательна в рантайме, но ни \`network_id\`, ни \`network_ids\` не закрывают её в одиночку`,
            );
            continue;
          }

          // Контракт XOR: агент должен узнать об этом из описания полей, потому
          // что required этого не выражает.
          const idDesc = props.network_id?.description;
          const idsDesc = props.network_ids?.description;
          const idOk = typeof idDesc === 'string' && idDesc.includes('network_ids');
          const idsOk = typeof idsDesc === 'string' && idsDesc.includes('network_id');
          if (!idOk || !idsOk) {
            violations.push(
              `  • ${name}: сеть XOR-обязательна, но описание полей не указывает на альтернативу ` +
                `(network_id.describe ${idOk ? 'ok' : 'missing'}, network_ids.describe ${idsOk ? 'ok' : 'missing'})`,
            );
          }
          checked += 1;
        }

        assert.ok(checked >= 20, `ожидалось проверить много инструментов, проверено ${checked}`);
        assert.deepEqual(
          violations,
          [],
          'Нарушена согласованность «схема ↔ рантайм» по обязательности сети (ошибка 99f27451).\n' +
            'Обязательность сети обязана быть видна агенту до вызова: либо в `required` (плоский\n' +
            'случай), либо в описании поля для XOR (`network_id`/`network_ids`).\n' +
            violations.join('\n'),
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
