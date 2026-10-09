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
  createThoughtViaWrite,
  nativeAvailable,
  toolJson,
  toolText,
  upsertPermanentViaWrite,
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
        await createThoughtViaWrite(handle.client, ctx.networkId, { title: 'Задача №1', type: 'задача', link: { direction: 'parent', target_thought_id: ctx.homeId } });
        await createThoughtViaWrite(handle.client, ctx.networkId, { title: 'Ошибка №1', type: 'ошибка', link: { direction: 'parent', target_thought_id: ctx.homeId } });
        await createThoughtViaWrite(handle.client, ctx.networkId, { title: 'Заметка №1', link: { direction: 'parent', target_thought_id: ctx.homeId } });

        // Одно имя — фильтр по «задача».
        const oneName = toolJson<{
          total: number;
          hits: Array<{ title: string }>;
          resolved_types?: Array<{ input: string; id: string; name: string }>;
        }>(
          await handle.client.callTool({
            name: 'etn.thoughts.query',
            arguments: { network_id: ctx.networkId, count: true, type: ['задача'] },
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
            arguments: { network_id: ctx.networkId, count: true, type: ['ЗАДАЧА'] },
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
            arguments: { network_id: ctx.networkId, count: true, type: ['задача', 'ошибка'] },
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
        assert.match(text, /ETN error \[VALIDATION_ERROR\]: provide at most one of type_id or type/);
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
        const a = await createThoughtViaWrite(handle.client, ctx.networkId, { title: 'Задача A', type: 'задача', link: { direction: 'parent', target_thought_id: ctx.homeId } });
        const b = await createThoughtViaWrite(handle.client, ctx.networkId, { title: 'Задача B', type: 'задача', link: { direction: 'parent', target_thought_id: ctx.homeId } });
        await createThoughtViaWrite(handle.client, ctx.networkId, { title: 'Задача C', type: 'задача', link: { direction: 'parent', target_thought_id: ctx.homeId } });
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
              count: true,
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
              count: true,
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
        assert.match(text, /ETN error \[VALIDATION_ERROR\]: provide at most one of property_id or property/);

        // Адресация по property_id даёт тот же результат, что по имени
        // (ошибка 090d0242, 0.12.1): обе формы резолвятся в одно свойство.
        const byId = toolJson<{ total: number; hits: Array<{ title: string }> }>(
          await handle.client.callTool({
            name: 'etn.thoughts.query',
            arguments: {
              network_id: ctx.networkId,
              count: true,
              type: ['задача'],
              properties: [
                { property_id: filtered.resolved_properties![0]!.id, operator: 'eq', value: 'в реализации' },
              ],
            },
          }),
        );
        assert.equal(byId.total, 1);
        assert.equal(byId.hits[0]?.title, 'Задача A');

        // Несуществующее имя свойства — `NOT_FOUND` с указанием поля (ошибки
        // 090d0242/f4580fff, 0.12.1; ранее — молчаливое расширение отбора,
        // затем асимметричный VALIDATION_ERROR). Код выровнен по конвенции
        // резолва имён реестровых сущностей — как у типа.
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

        // Паритет с резолвом ИМЕНИ типа: несуществующий `type` — тот же код
        // `NOT_FOUND` (конвенция типа/свойства; ошибка f4580fff, 0.12.1).
        const missingType = await handle.client.callTool({
          name: 'etn.thoughts.query',
          arguments: { network_id: ctx.networkId, type: ['нет-такого-типа'] },
        });
        assert.equal(missingType.isError, true);
        assert.match(toolText(missingType), /NOT_FOUND/);

        // Несуществующий property_id — тоже `NOT_FOUND`, а не расширение
        // отбора до всей сети (ошибки 4f17cb73/f4580fff, 0.12.1).
        const unknownId = await handle.client.callTool({
          name: 'etn.thoughts.query',
          arguments: {
            network_id: ctx.networkId,
            properties: [
              { property_id: '11111111-1111-4111-8111-111111111111', operator: 'eq', value: 'x' },
            ],
          },
        });
        assert.equal(unknownId.isError, true);
        assert.match(toolText(unknownId), /NOT_FOUND/);
        assert.match(toolText(unknownId), /11111111-1111-4111-8111-111111111111/);

        // Неизвестное поле условия БЕЗ адреса (напр. `key` вместо `property`) —
        // VALIDATION_ERROR (ошибка 090d0242, 0.12.1): условие не выпадает молча.
        const unknownField = await handle.client.callTool({
          name: 'etn.thoughts.query',
          arguments: {
            network_id: ctx.networkId,
            properties: [
              { key: 'статус', operator: 'eq', value: 'в реализации' },
            ],
          },
        });
        assert.equal(unknownField.isError, true);
        assert.match(toolText(unknownField), /VALIDATION_ERROR/);

        // Неизвестное поле условия ПРИ валидном адресе (ошибка f4580fff,
        // 0.12.1) — тоже явная VALIDATION_ERROR, а не молчаливое вырезание:
        // лишний `key` не должен теряться, даже когда property_id разрешается.
        const unknownFieldWithAddress = await handle.client.callTool({
          name: 'etn.thoughts.query',
          arguments: {
            network_id: ctx.networkId,
            properties: [
              {
                property_id: filtered.resolved_properties![0]!.id,
                key: 'статус',
                operator: 'eq',
                value: 'в реализации',
              },
            ],
          },
        });
        assert.equal(unknownFieldWithAddress.isError, true);
        assert.match(toolText(unknownFieldWithAddress), /VALIDATION_ERROR/);
        assert.match(toolText(unknownFieldWithAddress), /key/);
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
        await createThoughtViaWrite(handle.client, ctx.networkId, { title: 'Ищу задачу', type: 'задача', link: { direction: 'parent', target_thought_id: ctx.homeId } });
        await createThoughtViaWrite(handle.client, ctx.networkId, { title: 'Ищу заметку', link: { direction: 'parent', target_thought_id: ctx.homeId } });

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
        assert.match(text, /ETN error \[VALIDATION_ERROR\]: provide at most one of type_id or type/);

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
        await upsertPermanentViaWrite(handle.client, ctx.networkId, ctx.homeId, big);

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
        const created = await createThoughtViaWrite(handle.client, ctx.networkId, { title: 'Без постоянного', link: { direction: 'parent', target_thought_id: ctx.homeId } });
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
