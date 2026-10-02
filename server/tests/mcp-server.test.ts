/**
 * MCP smoke tests (task F1 DoD): a connected client enumerates tools,
 * resources and prompts, and can use basic read operations (F3 resources,
 * F5 prompts) through the SDK protocol over the in-memory transport.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MCP_PROMPT_NAMES,
  MCP_TOOL_ANNOTATIONS,
  MCP_TOOL_NAMES,
} from '@etn/shared';

import { openNetworkDb } from '../src/db/network-db.js';
import {
  createThoughtType,
} from '../src/domain/thought-type-service.js';
import { createTypeProperty } from '../src/domain/property-service.js';
import {
  callOp,
  closeMcpContext,
  buildMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  toolText,
} from './mcp-helpers.js';

// Test user for authorship columns (task 5ef8b5bb)

/**
 * Strip annotation fields the MCP SDK's `ToolAnnotationsSchema` does NOT
 * round-trip through the wire. Used by the canonical-registry test
 * (задача 053751b5, 0.7.2): both sides are filtered to the SDK-known keys
 * before deepEqual.
 */
function filterToSdkAnnotations(
  ann: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (ann === undefined) return {};
  const out: Record<string, unknown> = {};
  for (const key of [
    'title',
    'readOnlyHint',
    'destructiveHint',
    'idempotentHint',
    'openWorldHint',
  ]) {
    if (key in ann) out[key] = ann[key];
  }
  return out;
}
const USER = 'test-user';

describe('MCP server (F1 smoke)', { skip: !nativeAvailable() }, () => {
  it('lists all tools from the shared catalogue', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const { tools } = await handle.client.listTools();
        const names = tools.map((t) => t.name).sort();
        assert.deepEqual(names, [...MCP_TOOL_NAMES].sort());
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  // Ошибка 18d7774a: `etn.instructions` регистрировался с `z.union([...])`, и
  // MCP-SDK публиковал пустую схему (`{ type: "object", properties: {} }`) —
  // агент, следующий витрине, звал инструмент без аргументов и получал
  // `Invalid input` на обязательном `network_id`. Схема инструмента обязана
  // совпадать с фактическим контрактом.
  it('etn.instructions publishes its parameters with a required network_id', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const { tools } = await handle.client.listTools();
        const tool = tools.find((t) => t.name === 'etn.instructions');
        assert.ok(tool !== undefined, 'etn.instructions отсутствует в каталоге');
        const schema = tool.inputSchema as {
          properties?: Record<string, unknown>;
          required?: string[];
        };
        const properties = Object.keys(schema.properties ?? {});
        assert.ok(
          properties.includes('network_id'),
          `схема не объявляет network_id: [${properties.join(', ')}]`,
        );
        assert.deepEqual(schema.required, ['network_id']);
        for (const optional of ['instruction_id', 'keywords']) {
          assert.ok(
            properties.includes(optional),
            `схема не объявляет опциональный ${optional}`,
          );
        }
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  // Общая страховка того же класса регрессий: любой инструмент, у которого
  // есть параметры, обязан объявлять их в публикуемой схеме. Пустая схема
  // допустима только для инструментов, которые параметров действительно не
  // принимают.
  it('every parameterised tool publishes a non-empty inputSchema', async () => {
    const PARAMETERLESS = new Set(['etn.networks.list']);
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const { tools } = await handle.client.listTools();
        const empty = tools
          .filter((t) => !PARAMETERLESS.has(t.name))
          .filter((t) => {
            const schema = t.inputSchema as { properties?: Record<string, unknown> };
            return Object.keys(schema.properties ?? {}).length === 0;
          })
          .map((t) => t.name);
        assert.deepEqual(empty, [], `инструменты с пустой схемой: ${empty.join(', ')}`);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('lists the 13 etn:// resources (1 static + 12 templated)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const listed = await handle.client.listResources();
        const templates = await handle.client.listResourceTemplates();
        // MCP splits static resources and URI templates into two lists.
        const uris = [
          ...listed.resources.map((r) => r.uri),
          ...templates.resourceTemplates.map((r) => r.uriTemplate),
        ].sort();
        assert.equal(uris.length, 13);
        assert.ok(uris.includes('etn://networks'));
        assert.ok(uris.includes('etn://networks/{network_id}/thoughts/{thought_id}'));
        assert.ok(uris.includes('etn://networks/{network_id}/thoughts/{thought_id}/usage'));
        assert.ok(uris.includes('etn://networks/{network_id}/thoughts/{thought_id}/backlinks'));
        assert.ok(uris.includes('etn://networks/{network_id}/thought-types/{type_id}'));
        assert.ok(uris.includes('etn://networks/{network_id}/trash'));
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('lists the prompt templates', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const { prompts } = await handle.client.listPrompts();
        const names = prompts.map((p) => p.name).sort();
        assert.deepEqual(names, [...MCP_PROMPT_NAMES].sort());
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.networks.list returns the network of the key user', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await callOp(handle.client, 'networks.list', {});
        assert.equal(result.isError, undefined);
        const networks = toolJson<Array<{ id: string }>>(result);
        assert.equal(networks.length, 1);
        assert.equal(networks[0]?.id, ctx.networkId);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('reads the HOME thought through the etn.thought resource (F3)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const read = await handle.client.readResource({
          uri: `etn://networks/${ctx.networkId}/thoughts/${ctx.homeId}`,
        });
        const block = read.contents[0];
        assert.ok(block !== undefined && 'text' in block);
        const thought = JSON.parse(block.text) as {
          id: string;
          title: string;
          properties: unknown[];
        };
        assert.equal(thought.id, ctx.homeId);
        assert.equal(thought.title, 'HOME');
        // Структурные «Родители»/«Потомки» присутствуют у каждой мысли (count 0);
        // скалярных свойств у HOME нет.
        const props = thought.properties as Array<{
          value_type: string;
          count?: number;
          structural?: boolean;
        }>;
        assert.deepEqual(props.filter((p) => p.value_type !== 'link'), []);
        assert.ok(props.some((p) => p.structural === true && p.count === 0));
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.thought resource: полный постоянный комментарий и метрика чтения — как у etn.thoughts.get (937480ca)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // Мысль с длинным постоянным комментарием (> COMMENT_PREVIEW_CHARS).
        const longBody = 'z'.repeat(3000);
        const created = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [
              { ref: 't', thought: { title: 'С большим комментарием' }, comment: { body_md: longBody } },
            ],
          },
        });
        assert.equal(created.isError, undefined, toolText(created));
        const thoughtId = toolJson<{ items: Array<{ id: string }> }>(created).items[0]!.id;

        // Ресурс отдаёт meta.permanent в полной форме — без chars_*/truncated.
        const read = await handle.client.readResource({
          uri: `etn://networks/${ctx.networkId}/thoughts/${thoughtId}`,
        });
        const block = read.contents[0];
        assert.ok(block !== undefined && 'text' in block);
        const card = JSON.parse(block.text) as {
          id: string;
          meta: {
            permanent: { id: string; body_md: string } | null;
          };
        };
        assert.equal(card.id, thoughtId);
        assert.ok(card.meta.permanent !== null, 'permanent должен быть полным');
        assert.equal(card.meta.permanent.body_md, longBody);
        assert.equal(
          (card.meta.permanent as unknown as { truncated?: boolean }).truncated,
          undefined,
          'поле truncated отсутствует в полной форме',
        );

        // Метрика чтения: чтение ресурса увеличило счётчик мысли.
        const metrics = await callOp(handle.client, 'metrics.reads', { network_id: ctx.networkId, kind: 'top', limit: 200 });
        const items = toolJson<{ items: Array<{ thought_id: string; reads_count: number }> }>(metrics).items;
        const row = items.find((i) => i.thought_id === thoughtId);
        assert.ok(row !== undefined, 'мысль должна попасть в метрику чтения');
        assert.ok((row.reads_count ?? 0) >= 1);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('reads comments as Markdown through the comments resource (F3)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const read = await handle.client.readResource({
          uri: `etn://networks/${ctx.networkId}/thoughts/${ctx.homeId}/comments`,
        });
        const block = read.contents[0];
        assert.ok(block !== undefined && 'text' in block);
        assert.equal(block.mimeType, 'text/markdown');
        assert.match(block.text, /# Комментарии: HOME/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('getPrompt returns a parameterised text template (F5)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.getPrompt({
          name: 'etn.summarize_thought',
          arguments: { network_id: ctx.networkId, thought_id: ctx.homeId },
        });
        const message = result.messages[0];
        assert.ok(message !== undefined);
        assert.ok(message.content.type === 'text');
        assert.match(message.content.text, /etn:\/\/networks\//);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('fails a tool call whose input violates the schema', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.thoughts.get',
          arguments: { network_id: ctx.networkId },
        });
        assert.equal(result.isError, true);
        assert.match(toolText(result), /ETN error|Unexpected error|Invalid/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.thought-type resource returns effective (inherited) properties with registry property_id (f14cd5f1)', async () => {
    // The resource used to expose only the type's own bindings; since 0.6.5
    // it must mirror `etn.types.list` and include inherited ones — agents
    // pointed at the resource by the docs need the same shape as the tool.
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const parent = createThoughtType(ndb, { name: 'ResParent' }, ctx.adminId);
      const child = createThoughtType(
        ndb,
        { name: 'ResChild', parent_id: parent.id },
        ctx.adminId,
      );
      const def = createTypeProperty(ndb, 'thought_type', parent.id, {
        key: 'status',
        value_type: 'text',
      }, USER);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const read = await handle.client.readResource({
          uri: `etn://networks/${ctx.networkId}/thought-types/${child.id}`,
        });
        const block = read.contents[0];
        assert.ok(block !== undefined && 'text' in block);
        const type = JSON.parse(block.text) as {
          id: string;
          properties: Array<{
            key: string;
            property_id: string;
            inherited: boolean;
            defined_on: string;
            value_type: string;
          }>;
        };
        assert.equal(type.id, child.id);
        // The child has no own bindings — but the resource must still list the
        // inherited property because that's what `etn.types.list` does.
        const inherited = type.properties.find((p) => p.key === 'status');
        assert.ok(inherited, 'inherited property must be present');
        assert.equal(inherited.property_id, def.property_id);
        assert.equal(inherited.inherited, true);
        assert.equal(inherited.defined_on, parent.id);
        assert.equal(inherited.value_type, 'text');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('tools/list surfaces MCP annotations from the canonical registry (O7)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const { tools } = await handle.client.listTools();
        const byName = new Map(tools.map((t) => [t.name, t]));

        // Every tool from the catalogue must be present AND carry exactly the
        // annotations declared in `MCP_TOOL_ANNOTATIONS` — a regression
        // guard against (a) a new tool silently shipped without hints or
        // (b) a hint accidentally dropped from an existing registration.
        for (const name of MCP_TOOL_NAMES) {
          const tool = byName.get(name);
          assert.ok(tool, `tools/list must contain ${name}`);
          // Filter both sides to the SDK-known keys before deepEqual.
          const wire = filterToSdkAnnotations(tool.annotations);
          const canon = filterToSdkAnnotations(
            MCP_TOOL_ANNOTATIONS[name] as Record<string, unknown> | undefined,
          );
          assert.deepEqual(
            wire,
            canon,
            `annotations for ${name} must match the canonical registry`,
          );
        }

        // Spot-check the three hint classes against real tool entries so a
        // blanket deepEqual cannot hide a flipped boolean.
        const get = byName.get('etn.thoughts.get')!;
        assert.equal(get.annotations?.readOnlyHint, true);
        assert.equal(get.annotations?.destructiveHint, undefined);
        assert.equal(get.annotations?.idempotentHint, undefined);

        const del = byName.get('etn.ontology.delete');
        assert.equal(del, undefined, 'ontology.delete снят в etn.ops (задача d379e091)');

        const trash = byName.get('etn.thoughts.trash');
        assert.equal(trash, undefined, 'thoughts.trash снят в etn.ops (задача d379e091)');

        const restore = byName.get('etn.links.restore');
        assert.equal(restore, undefined, 'links.restore снят в etn.ops (задача d379e091)');

        const propResolve = byName.get('etn.properties.resolve');
        assert.equal(propResolve, undefined, 'properties.resolve снят в etn.ops (задача d379e091)');

        const propAdd = byName.get('etn.properties.add')!;
        assert.equal(propAdd.annotations?.idempotentHint, true);

        // Sanity check: count coverage matches the registry so a future
        // addition does not silently leak a tool without a hint.
        const annotated = MCP_TOOL_NAMES.filter(
          (n) => MCP_TOOL_ANNOTATIONS[n] !== undefined,
        ).length;
        const hintReadOnly = MCP_TOOL_NAMES.filter(
          (n) => MCP_TOOL_ANNOTATIONS[n]?.readOnlyHint === true,
        ).length;
        const hintDestructive = MCP_TOOL_NAMES.filter(
          (n) => MCP_TOOL_ANNOTATIONS[n]?.destructiveHint === true,
        ).length;
        const hintIdempotent = MCP_TOOL_NAMES.filter(
          (n) => MCP_TOOL_ANNOTATIONS[n]?.idempotentHint === true,
        ).length;
        // S10 added 8 layer tools: 3 read (list, diff, diff_doc — readOnlyHint),
        // 2 destructive (delete, merge) and 2 idempotent (update, select) —
        // `create` has no hint (matches `thoughts.create`/`links.create`).
        // Task a88acf20 adds 4 object-lock tools: 1 read (`list` — readOnlyHint),
        // 2 destructive (`release`, `clear`) and 1 idempotent (`acquire`
        // продлевает свой захват).
        // Task f2eca5a4 adds 1 activity-log tool: read (`list` — readOnlyHint).
        // Task 6bcccd2b adds 2 activity-maintenance tools: rollup + truncate —
        // оба `destructiveHint: true` (необратимые операции с журналом).
        // Task 940a499d adds 1 read tool (`etn.metrics.tools` — readOnlyHint)
        // over the previous 45/27/10/8 counts.
        // Task 6d45ab37 (P1-паритет MCP↔REST) добавляет 6 инструментов:
        //   * resolve (readOnlyHint) — +1 readOnly;
        //   * bulk_update (явные destructiveHint: false + idempotentHint: false) — не считается ни в readOnly, ни в destructive/idempotent;
        //   * chronicle.query (readOnlyHint) — +1 readOnly;
        //   * members.list (readOnlyHint) — +1 readOnly;
        //   * attachments.update (idempotentHint) — +1 idempotent;
        //   * attachments.delete (destructiveHint) — +1 destructive.
        // Task ba024a45 / 0.7.2 добавляет 3 инструмента:
        //   * `etn.instructions` (readOnlyHint) — +1 readOnly;
        //   * `etn.networks.write` (idempotentHint) — +1 idempotent;
        //   * `etn.networks.delete` (destructiveHint) — +1 destructive.
        // Task 053751b5 / 0.7.2 добавляет `etn.thoughts.write` (idempotentHint)
        // — +1 annotated, +1 idempotent. P3 (задача e488f4c1): +4
        // (`copy_subtree`, `mentions_scan`, `import.dry_run`,
        // `import.subgraph`) → 67. Задача c1fa71d4 / 0.7.3: +1
        // (`etn.views.run`, readOnlyHint) → 68.
        // Задача 937480ca / 0.8.2 удаляет 6 поглощённых инструментов
        // (`etn.thoughts.create`/`update`/`set_active`/`upsert_bundle`,
        // `etn.properties.set`, `etn.comments.upsert`): −3 idempotent
        // (set_active, properties.set, upsert_bundle), −6 annotated
        // (без изменения readOnly/destructive). 0.8.3 (задача 7849008a):
        // +1 инструмент `etn.properties.resolve` с `idempotentHint: true`
        // → 61/33/13/12.
        // 0.8.3 (задача 86ef2ff4): редкие операции сняты в `etn.guide`/`etn.ops`,
        // поэтому витрина сокращена. Аннотированы 27 из 29 инструментов
        // (`etn.ops` — диспетчер без тул-уровневых подсказок; `comments.update`
        // исторически без аннотации): 17 readOnly, 1 destructive, 7 idempotent.
        // 0.8.3 (задача d379e091): ещё 4 инструмента сняты в `etn.ops` —
        // `ontology.delete` (−1 destructive), `thoughts.trash`/`links.restore`/
        // `properties.resolve` (−3 idempotent) → 23 из 25: 17 readOnly,
        // 0 destructive (витрина деструктивных инструментов пуста), 4 idempotent.
        // 0.11.1 (задача 8f6857f8, «Публикации»): +22 инструмента, все
        // аннотированы → 45. readOnly: 6 чтения + 2 экспорта (сборка без
        // записи в БД) = +8 → 25. destructive: `publications.delete` и
        // `shelves.delete` (purge) = +2 → 2. idempotent: order, exclusions,
        // trash, restore, shelves.trash, shelves.restore, shelves.assign = +7 → 11.
        // 0.11.1 (задача e754527d, круг 2): +`etn.publications.accept`
        // (MCP-двойник REST accept) — idempotent → +1: 46 аннотированных, 12 idempotent.
        // 0.11.1 (задача 00160da1): +`etn.publications.deletionCheck` и
        // `etn.shelves.deletionCheck` (MCP-паритет REST deletion-check) —
        // оба readOnly → 48 аннотированных, readOnly 25 → 27.
        assert.equal(annotated, 48);
        assert.equal(hintReadOnly, 27);
        assert.equal(hintDestructive, 2);
        assert.equal(hintIdempotent, 12);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
