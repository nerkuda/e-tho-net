/**
 * MCP filter-name resolution + full permanent comment in `etn.thoughts.get`
 * (задачи d5ab1630 и 3ea09a54).
 *
 * Covers:
 *   * `etn.thoughts.query` accepts `type[]` (имена) и `property` (имя)
 *     рядом с `type_id`/`property_id`; XOR-схема отклоняет смешение, `NOT_FOUND`
 *     поднимается для несуществующих имён, ответ несёт эхо `resolved_types`/
 *     `resolved_properties`;
 *   * `etn.thoughts.search` принимает `type` (одно имя), XOR с `type_id`,
 *     `NOT_FOUND` для неизвестного имени;
 *   * `etn.thoughts.get` возвращает `meta.permanent` полностью (без
 *     `chars_*`/`truncated`); `null` для мысли без постоянного комментария.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 *
 * Setup note: `etn.types.create` через MCP-фасад сейчас не предусмотрен,
 * поэтому типы и реестровые свойства создаются напрямую через доменные
 * сервисы — единственный путь для реестра (см. mcp-telemetry.test.ts).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  toolText,
} from './mcp-helpers.js';
import { openNetworkDb } from '../src/db/network-db.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { createTypeProperty, setPropertyValue } from '../src/domain/property-service.js';

describe('MCP filter names (d5ab1630)', { skip: !nativeAvailable() }, () => {
  it('etn.thoughts.query: type[] resolves names without an explicit types.list call', async () => {
    const ctx = await buildMcpContext();
    try {
      // Seed типы напрямую через домен.
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      createThoughtType(ndb, { name: 'задача' }, ctx.adminId);
      createThoughtType(ndb, { name: 'ошибка' }, ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // Создаём мысли через MCP — `type: 'задача'` резолвится в id
        // под капотом, без отдельного `etn.types.list`.
        await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: {
            network_id: ctx.networkId,
            title: 'Задача №1',
            type: 'задача',
            link: { direction: 'parent', target_thought_id: ctx.homeId },
          },
        });
        await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: {
            network_id: ctx.networkId,
            title: 'Ошибка №1',
            type: 'ошибка',
            link: { direction: 'parent', target_thought_id: ctx.homeId },
          },
        });
        await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: {
            network_id: ctx.networkId,
            title: 'Заметка №1',
            link: { direction: 'parent', target_thought_id: ctx.homeId },
          },
        });

        // Одно имя — фильтр по «задача».
        const oneName = toolJson<{
          total: number;
          hits: Array<{ title: string }>;
          resolved_types?: Array<{ input: string; id: string; name: string }>;
        }>(
          await handle.client.callTool({
            name: 'etn.thoughts.query',
            arguments: { network_id: ctx.networkId, type: ['задача'] },
          }),
        );
        assert.equal(oneName.total, 1, 'должна найтись ровно одна мысль типа «задача»');
        assert.equal(oneName.hits[0]?.title, 'Задача №1');
        assert.equal(oneName.resolved_types?.length, 1);
        assert.equal(oneName.resolved_types![0]!.input, 'задача');
        assert.equal(oneName.resolved_types![0]!.name, 'задача');
        // Регистр не важен — `name_key` нормализован в БД.
        const upper = toolJson<{ total: number }>(
          await handle.client.callTool({
            name: 'etn.thoughts.query',
            arguments: { network_id: ctx.networkId, type: ['ЗАДАЧА'] },
          }),
        );
        assert.equal(upper.total, 1);

        // Два имени — фильтр по «задача» + «ошибка» (OR-семантика типа).
        const twoNames = toolJson<{
          total: number;
          hits: Array<{ title: string }>;
          resolved_types?: Array<{ input: string; id: string; name: string }>;
        }>(
          await handle.client.callTool({
            name: 'etn.thoughts.query',
            arguments: { network_id: ctx.networkId, type: ['задача', 'ошибка'] },
          }),
        );
        assert.equal(twoNames.total, 2);
        assert.equal(twoNames.resolved_types?.length, 2);
        const titles = twoNames.hits.map((h) => h.title).sort();
        assert.deepEqual(titles, ['Задача №1', 'Ошибка №1']);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.thoughts.query: unknown type name → NOT_FOUND', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.thoughts.query',
          arguments: { network_id: ctx.networkId, type: ['несуществующий-тип'] },
        });
        assert.equal(result.isError, true);
        const text = toolText(result);
        assert.match(text, /NOT_FOUND/);
        assert.match(text, /несуществующий-тип/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.thoughts.query: type + type_id together → 422 (Zod XOR)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.thoughts.query',
          arguments: {
            network_id: ctx.networkId,
            type: ['задача'],
            type_id: ['00000000-0000-4000-8000-000000000001'],
          },
        });
        assert.equal(result.isError, true);
        const text = toolText(result);
        // Zod-валидация рубит запрос до домена: «Invalid arguments» +
        // сообщение `.refine()`. Этого достаточно — MCP-агент видит и
        // причину, и формулировку конфликта.
        assert.match(text, /Invalid arguments/);
        assert.match(text, /type_id or type/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.thoughts.query: property (name) resolves into property_id; xor with property_id → 422', async () => {
    const ctx = await buildMcpContext();
    try {
      // Seed тип + реестровое свойство «статус».
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const задача = createThoughtType(ndb, { name: 'задача' }, ctx.adminId);
      createTypeProperty(
        ndb,
        'thought_type',
        задача.id,
        { key: 'статус', value_type: 'text' },
        ctx.adminId,
      );

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const a = toolJson<{ id: string }>(
          await handle.client.callTool({
            name: 'etn.thoughts.create',
            arguments: {
              network_id: ctx.networkId,
              title: 'Задача A',
              type: 'задача',
              link: { direction: 'parent', target_thought_id: ctx.homeId },
            },
          }),
        );
        const b = toolJson<{ id: string }>(
          await handle.client.callTool({
            name: 'etn.thoughts.create',
            arguments: {
              network_id: ctx.networkId,
              title: 'Задача B',
              type: 'задача',
              link: { direction: 'parent', target_thought_id: ctx.homeId },
            },
          }),
        );
        await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: {
            network_id: ctx.networkId,
            title: 'Задача C',
            type: 'задача',
            link: { direction: 'parent', target_thought_id: ctx.homeId },
          },
        });
        setPropertyValue(ndb, 'thought', a.id, 'статус', 'в реализации', ctx.adminId);
        setPropertyValue(ndb, 'thought', b.id, 'статус', 'готово', ctx.adminId);

        // Фильтр по `property: "статус"`, `eq "в реализации"` — должна
        // найтись только Задача A.
        const filtered = toolJson<{
          total: number;
          hits: Array<{ title: string }>;
          resolved_properties?: Array<{ input: string; id: string; name: string }>;
        }>(
          await handle.client.callTool({
            name: 'etn.thoughts.query',
            arguments: {
              network_id: ctx.networkId,
              type: ['задача'],
              properties: [{ property: 'статус', operator: 'eq', value: 'в реализации' }],
            },
          }),
        );
        assert.equal(filtered.total, 1);
        assert.equal(filtered.hits[0]?.title, 'Задача A');
        assert.equal(filtered.resolved_properties?.length, 1);
        assert.equal(filtered.resolved_properties![0]!.input, 'статус');
        assert.equal(filtered.resolved_properties![0]!.name, 'статус');

        // Регистр имени — `name_key` нормализован.
        const upper = toolJson<{ total: number }>(
          await handle.client.callTool({
            name: 'etn.thoughts.query',
            arguments: {
              network_id: ctx.networkId,
              type: ['задача'],
              properties: [{ property: 'СТАТУС', operator: 'eq', value: 'готово' }],
            },
          }),
        );
        assert.equal(upper.total, 1);

        // Одновременно `property_id` + `property` — Zod 422.
        const conflict = await handle.client.callTool({
          name: 'etn.thoughts.query',
          arguments: {
            network_id: ctx.networkId,
            properties: [
              {
                property_id: filtered.resolved_properties![0]!.id,
                property: 'статус',
                operator: 'eq',
                value: 'готово',
              },
            ],
          },
        });
        assert.equal(conflict.isError, true);
        const text = toolText(conflict);
        assert.match(text, /Invalid arguments/);
        assert.match(text, /property_id or property/);

        // Несуществующее имя свойства — NOT_FOUND.
        const missing = await handle.client.callTool({
          name: 'etn.thoughts.query',
          arguments: {
            network_id: ctx.networkId,
            properties: [
              { property: 'несуществующее-свойство', operator: 'eq', value: 'x' },
            ],
          },
        });
        assert.equal(missing.isError, true);
        assert.match(toolText(missing), /NOT_FOUND/);
        // Подсказка, какое поле не найдено.
        assert.match(toolText(missing), /несуществующее-свойство/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.thoughts.search: type (name) filters by type, xor with type_id → 422', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      createThoughtType(ndb, { name: 'задача' }, ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: {
            network_id: ctx.networkId,
            title: 'Ищу задачу',
            type: 'задача',
            link: { direction: 'parent', target_thought_id: ctx.homeId },
          },
        });
        await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: {
            network_id: ctx.networkId,
            title: 'Ищу заметку',
            link: { direction: 'parent', target_thought_id: ctx.homeId },
          },
        });

        // По имени типа — только мысли типа «задача».
        const ok = toolJson<{
          by_names: Array<{ title: string }>;
          resolved_type?: { input: string; id: string; name: string };
        }>(
          await handle.client.callTool({
            name: 'etn.thoughts.search',
            arguments: { network_id: ctx.networkId, query: 'Ищу', type: 'задача' },
          }),
        );
        assert.equal(ok.by_names.length, 1);
        assert.equal(ok.by_names[0]?.title, 'Ищу задачу');
        assert.deepEqual(ok.resolved_type, {
          input: 'задача',
          id: ok.resolved_type!.id,
          name: 'задача',
        });

        // XOR с type_id — Zod 422.
        const conflict = await handle.client.callTool({
          name: 'etn.thoughts.search',
          arguments: {
            network_id: ctx.networkId,
            query: 'Ищу',
            type: 'задача',
            type_id: '00000000-0000-4000-8000-000000000002',
          },
        });
        assert.equal(conflict.isError, true);
        const text = toolText(conflict);
        assert.match(text, /Invalid arguments/);
        assert.match(text, /type_id or type/);

        // Неизвестное имя — NOT_FOUND.
        const missing = await handle.client.callTool({
          name: 'etn.thoughts.search',
          arguments: {
            network_id: ctx.networkId,
            query: 'Ищу',
            type: 'несуществующий-тип',
          },
        });
        assert.equal(missing.isError, true);
        assert.match(toolText(missing), /NOT_FOUND/);
        assert.match(toolText(missing), /несуществующий-тип/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});

describe('etn.thoughts.get full permanent comment (3ea09a54)', { skip: !nativeAvailable() }, () => {
  it('returns the full body_md without chars_*/truncated', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // 5000 символов — больше, чем COMMENT_PREVIEW_CHARS (2000).
        const big = 'x'.repeat(5000);
        await handle.client.callTool({
          name: 'etn.comments.upsert',
          arguments: {
            network_id: ctx.networkId,
            owner_type: 'thought',
            owner_id: ctx.homeId,
            kind: 'permanent',
            body_md: big,
          },
        });

        const got = toolJson<{
          meta: {
            permanent:
              | {
                  id: string;
                  body_md: string;
                  valid_from: string;
                  created_at: string;
                  updated_at: string;
                }
              | null;
          };
        }>(
          await handle.client.callTool({
            name: 'etn.thoughts.get',
            arguments: { network_id: ctx.networkId, thought_id: ctx.homeId },
          }),
        );
        assert.ok(got.meta.permanent !== null, 'permanent должен быть');
        const perm = got.meta.permanent!;
        assert.equal(perm.body_md.length, 5000, 'полный текст без обрезки');
        // Превью-поля НЕ должны присутствовать в full-форме.
        assert.equal(
          (perm as unknown as { chars_returned?: number }).chars_returned,
          undefined,
          'нет поля chars_returned',
        );
        assert.equal(
          (perm as unknown as { chars_total?: number }).chars_total,
          undefined,
          'нет поля chars_total',
        );
        assert.equal(
          (perm as unknown as { truncated?: boolean }).truncated,
          undefined,
          'нет поля truncated',
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('meta.permanent is null for thoughts without a permanent comment', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // Свежая мысль без постоянного комментария.
        const created = toolJson<{ id: string }>(
          await handle.client.callTool({
            name: 'etn.thoughts.create',
            arguments: {
              network_id: ctx.networkId,
              title: 'Без постоянного',
              link: { direction: 'parent', target_thought_id: ctx.homeId },
            },
          }),
        );
        const got = toolJson<{
          meta: { permanent: unknown };
        }>(
          await handle.client.callTool({
            name: 'etn.thoughts.get',
            arguments: { network_id: ctx.networkId, thought_id: created.id },
          }),
        );
        assert.equal(got.meta.permanent, null);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
